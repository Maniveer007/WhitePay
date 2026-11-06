// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title WhitePay
/// @notice Non-custodial stablecoin payments. Funds go straight from payer to the
///         merchant's payout wallet. The contract enforces: exact amounts, expiring
///         quotes, refund caps, payer-controlled subscription limits and a timelocked
///         payout address, so a stolen API key cannot redirect money.
///         Circuit breaker: the admin can pause NEW money-in (pay / subscribe / charge) but can
///         never block refunds or customer cancellations.
/// @dev EIP-3009 (supported by Whitechain USDT). `to` must be msg.sender, so it can't be front-run at the token.
interface IERC3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;
}

contract WhitePay is EIP712, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ───────── Merchants ─────────
    struct Merchant {
        address owner;          // controls config (cold wallet / Safe)
        address payout;         // where money lands
        address pendingPayout;  // queued change (timelocked)
        address pendingOwner;   // two-step ownership transfer (e.g. move to a Safe)
        uint64 payoutEta;       // when pendingPayout can be applied
        bool exists;
    }

    uint256 public merchantCount;
    uint64 public immutable payoutDelay;
    mapping(uint256 => Merchant) public merchants;
    /// @dev API / quote-signing keys. They can only sign quotes, never move funds or change payout.
    mapping(uint256 => mapping(address => bool)) public quoteSigners;
    /// @dev Refund operators and their contract-enforced limits. The merchant owner is unlimited,
    ///      so a refund above an operator's limit has to be approved (executed) by the owner.
    struct RefundLimit {
        uint128 perRefund;  // max single refund (0 = not an operator)
        uint128 perDay;     // rolling UTC-day budget
        uint64 day;         // day index of usedToday
        uint128 usedToday;
    }
    mapping(uint256 => mapping(address => RefundLimit)) public refundLimits;
    mapping(address => bool) public allowedToken;
    bool public paused;
    /// @dev Contract allowed to call payFor (the agent spending-policy module). Zero = disabled.
    address public agentModule;
    event AgentModuleSet(address module);

    // ───────── Payments ─────────
    struct Payment {
        uint256 merchantId;
        address payer;
        address token;
        uint128 amount;
        uint128 refunded;
        uint64 paidAt;
        uint64 blockNumber;
    }
    mapping(bytes32 => Payment) public payments;

    struct Quote {
        uint256 merchantId;
        bytes32 intentId;
        address token;
        uint256 amount;
        uint64 expiry;
    }
    bytes32 public constant QUOTE_TYPEHASH =
        keccak256("Quote(uint256 merchantId,bytes32 intentId,address token,uint256 amount,uint64 expiry)");
    bytes32 public constant REFUND_ROUTE_TYPEHASH = keccak256("RefundRoute(bytes32 intentId,address to)");

    // ───────── Subscriptions ─────────
    struct Subscription {
        uint256 merchantId;
        address payer;
        address token;
        uint128 amount;       // per period
        uint128 cap;          // lifetime spending cap signed by the payer
        uint128 charged;
        uint64 period;
        uint64 nextCharge;
        uint64 end;
        bool cancelled;
    }
    uint256 public subCount;
    mapping(uint256 => Subscription) public subscriptions;

    /// @dev Merchant-defined price list. The merchant sets the price; the payer still sets the cap and end date.
    struct Plan {
        uint256 merchantId;
        address token;
        uint128 amount;       // regular price per period
        uint128 introAmount;  // price for the first `introCycles` charges
        uint64 period;
        uint64 trial;         // seconds before the first charge
        uint32 introCycles;
        bool active;          // retired plans keep existing subscribers but take no new ones
    }
    uint256 public planCount;
    mapping(uint256 => Plan) public plans;

    /// @dev Lifecycle state for plan-based subscriptions (kept apart from Subscription to stay ABI-compatible).
    struct SubState {
        uint256 planId;
        uint256 pendingPlanId; // downgrade waiting for the next period
        uint32 charges;
        address pausedBy;
    }
    mapping(uint256 => SubState) public subState;
    /// @dev Total refunded per subscription (charges aren't Payment records, so they have their own counter).
    mapping(uint256 => uint128) public subRefunded;

    // ───────── Events ─────────
    event MerchantRegistered(uint256 indexed merchantId, address indexed owner, address payout);
    event PayoutQueued(uint256 indexed merchantId, address payout, uint64 eta);
    event PayoutChanged(uint256 indexed merchantId, address payout);
    event QuoteSignerSet(uint256 indexed merchantId, address signer, bool allowed);
    event RefunderSet(uint256 indexed merchantId, address refunder, uint256 perRefund, uint256 perDay);
    event TokenAllowed(address token, bool allowed);
    event Paused(bool paused);
    event MerchantOwnershipOffered(uint256 indexed merchantId, address to);
    event MerchantOwnershipTransferred(uint256 indexed merchantId, address from, address to);
    event PaymentReceived(
        bytes32 indexed intentId, uint256 indexed merchantId, address indexed payer, address token, uint256 amount
    );
    event Refunded(
        bytes32 indexed intentId, address indexed to, uint256 amount, uint256 totalRefunded, bytes32 reason, address indexed operator
    );
    event SubscriptionCreated(
        uint256 indexed subId, uint256 indexed merchantId, address indexed payer, address token,
        uint256 amount, uint256 period, uint256 cap, uint256 end
    );
    event SubscriptionCharged(uint256 indexed subId, uint256 amount, uint256 totalCharged, uint256 nextCharge);
    event SubscriptionCancelled(uint256 indexed subId, address by);
    event SubscriptionRefunded(uint256 indexed subId, address indexed to, uint256 amount, uint256 totalRefunded, bytes32 reason, address indexed operator);
    event PlanCreated(uint256 indexed planId, uint256 indexed merchantId, address token, uint256 amount, uint256 period, uint256 trial, uint256 introAmount, uint256 introCycles);
    event PlanStatus(uint256 indexed planId, bool active);
    event PlanSubscribed(uint256 indexed subId, uint256 indexed planId, uint256 firstChargeAt);
    event SubscriptionPaused(uint256 indexed subId, address by);
    event SubscriptionResumed(uint256 indexed subId, address by, uint256 nextCharge);
    event PlanChanged(uint256 indexed subId, uint256 fromPlan, uint256 toPlan, uint256 proratedCharge, bool immediate);

    error NotMerchantOwner();
    error BadSigner();
    error Expired();
    error AlreadyPaid();
    error TokenNotAllowed();
    error AmountMismatch();
    error NotAuthorized();
    error RefundExceedsPayment();
    error BadRefundRoute();
    error TooEarly();
    error CapReached();
    error Inactive();
    error NoPending();
    error ZeroAddress();
    error IsPaused();
    error InvalidTerms();
    error SubIsPaused();
    error ReasonRequired();
    error RefundLimitExceeded();
    error NotAgentModule();

    constructor(address admin, address defaultToken, uint64 payoutDelay_) EIP712("WhitePay", "1") Ownable(admin) {
        payoutDelay = payoutDelay_;
        allowedToken[defaultToken] = true;
        emit TokenAllowed(defaultToken, true);
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier onlyMerchantOwner(uint256 id) {
        if (merchants[id].owner != msg.sender) revert NotMerchantOwner();
        _;
    }

    // ───────── Admin (token registry) ─────────
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice Emergency stop for new payments and charges. Refunds and cancellations keep working.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function setAgentModule(address module) external onlyOwner {
        agentModule = module;
        emit AgentModuleSet(module);
    }

    // ───────── Merchant config ─────────
    function registerMerchant(address payout, address quoteSigner) external returns (uint256 id) {
        if (payout == address(0)) revert ZeroAddress();
        id = ++merchantCount;
        merchants[id] = Merchant(msg.sender, payout, address(0), address(0), 0, true);
        emit MerchantRegistered(id, msg.sender, payout);
        if (quoteSigner != address(0)) {
            quoteSigners[id][quoteSigner] = true;
            emit QuoteSignerSet(id, quoteSigner, true);
        }
    }

    function setQuoteSigner(uint256 id, address signer, bool allowed) external onlyMerchantOwner(id) {
        quoteSigners[id][signer] = allowed;
        emit QuoteSignerSet(id, signer, allowed);
    }

    /// @notice Add, change or remove (perRefund = 0) a refund operator.
    function setRefunder(uint256 id, address refunder, uint128 perRefund, uint128 perDay) external onlyMerchantOwner(id) {
        if (perRefund > perDay) revert InvalidTerms();
        RefundLimit storage l = refundLimits[id][refunder];
        l.perRefund = perRefund;
        l.perDay = perDay;
        emit RefunderSet(id, refunder, perRefund, perDay);
    }

    function queuePayout(uint256 id, address newPayout) external onlyMerchantOwner(id) {
        if (newPayout == address(0)) revert ZeroAddress();
        Merchant storage m = merchants[id];
        m.pendingPayout = newPayout;
        m.payoutEta = uint64(block.timestamp) + payoutDelay;
        emit PayoutQueued(id, newPayout, m.payoutEta);
    }

    function applyPayout(uint256 id) external onlyMerchantOwner(id) {
        Merchant storage m = merchants[id];
        if (m.pendingPayout == address(0)) revert NoPending();
        if (block.timestamp < m.payoutEta) revert TooEarly();
        m.payout = m.pendingPayout;
        m.pendingPayout = address(0);
        m.payoutEta = 0;
        emit PayoutChanged(id, m.payout);
    }

    function offerOwnership(uint256 id, address to) external onlyMerchantOwner(id) {
        merchants[id].pendingOwner = to;
        emit MerchantOwnershipOffered(id, to);
    }

    function acceptOwnership(uint256 id) external {
        Merchant storage m = merchants[id];
        if (m.pendingOwner == address(0) || m.pendingOwner != msg.sender) revert NotAuthorized();
        emit MerchantOwnershipTransferred(id, m.owner, msg.sender);
        m.owner = msg.sender;
        m.pendingOwner = address(0);
    }

    function cancelPayout(uint256 id) external onlyMerchantOwner(id) {
        merchants[id].pendingPayout = address(0);
        merchants[id].payoutEta = 0;
    }

    // ───────── Pay ─────────
    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(QUOTE_TYPEHASH, q.merchantId, q.intentId, q.token, q.amount, q.expiry))
        );
    }

    /// @notice Pay an exact, merchant-signed, expiring quote. Payer must have approved `amount`.
    function pay(Quote calldata q, bytes calldata sig) external nonReentrant whenNotPaused {
        _payFrom(q, sig, msg.sender);
    }

    /// @notice Pay on behalf of `payer`. Only the registered agent module may call this, and it enforces the
    ///         payer's own spending policy (per-payment and daily limits, expiry, merchant allowlist) first.
    ///         The payment is recorded against `payer`, so refunds go back to them like any other payment.
    function payFor(Quote calldata q, bytes calldata sig, address payer) external nonReentrant whenNotPaused {
        if (msg.sender != agentModule || agentModule == address(0)) revert NotAgentModule();
        _payFrom(q, sig, payer);
    }

    function _payFrom(Quote calldata q, bytes calldata sig, address payer) internal {
        _checkQuote(q, sig);
        IERC20 t = IERC20(q.token);
        address payout = merchants[q.merchantId].payout;
        uint256 before = t.balanceOf(payout);
        t.safeTransferFrom(payer, payout, q.amount);
        if (t.balanceOf(payout) - before != q.amount) revert AmountMismatch(); // fee-on-transfer guard
        _record(q, payer);
    }

    /// @dev Payer's EIP-3009 authorization (v, r, s form).
    struct Auth {
        address payer;
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Gasless checkout: anyone (a relayer) submits the payer's EIP-3009 authorization.
    ///         The authorization's nonce MUST equal the quote digest, so the payer's one signature
    ///         is bound to this exact merchant, intent, token, amount and expiry and can't be reused.
    function payWithAuthorization(Quote calldata q, bytes calldata sig, Auth calldata a)
        external nonReentrant whenNotPaused
    {
        bytes32 digest = _checkQuote(q, sig);
        IERC20 t = IERC20(q.token);
        uint256 mine = t.balanceOf(address(this));
        IERC3009(q.token).receiveWithAuthorization(a.payer, address(this), q.amount, a.validAfter, a.validBefore, digest, a.v, a.r, a.s);
        if (t.balanceOf(address(this)) - mine != q.amount) revert AmountMismatch();
        _forward(t, merchants[q.merchantId].payout, q.amount); // same tx: the contract never keeps funds
        _record(q, a.payer);
    }

    function _checkQuote(Quote calldata q, bytes calldata sig) internal view returns (bytes32 digest) {
        if (block.timestamp > q.expiry) revert Expired();
        if (payments[q.intentId].paidAt != 0) revert AlreadyPaid();
        if (!allowedToken[q.token]) revert TokenNotAllowed();
        if (!merchants[q.merchantId].exists) revert NotMerchantOwner();
        digest = quoteDigest(q);
        if (!quoteSigners[q.merchantId][_recover(digest, sig)]) revert BadSigner();
    }

    function _forward(IERC20 t, address payout, uint256 amount) internal {
        uint256 before = t.balanceOf(payout);
        t.safeTransfer(payout, amount);
        if (t.balanceOf(payout) - before != amount) revert AmountMismatch();
    }

    function _record(Quote calldata q, address payer) internal {
        payments[q.intentId] = Payment(
            q.merchantId, payer, q.token, SafeCast.toUint128(q.amount), 0, uint64(block.timestamp), uint64(block.number)
        );
        emit PaymentReceived(q.intentId, q.merchantId, payer, q.token, q.amount);
    }

    // ───────── Refund ─────────
    /// @notice Refund up to what was paid, with a mandatory reason code. Funded by the caller's own
    ///         balance/allowance (owner wallet or a designated refund wallet).
    ///         Default destination is the original payer. If the payer cannot receive (blacklisted,
    ///         contract that rejects), pass an alternate `to` plus the payer's EIP-712/1271 signature.
    function refund(bytes32 intentId, uint256 amount, address to, bytes calldata payerSig, bytes32 reason)
        external nonReentrant
    {
        Payment storage p = payments[intentId];
        if (p.paidAt == 0) revert Inactive();
        address dest = p.payer;
        if (to != address(0) && to != p.payer) {
            bytes32 d = _hashTypedDataV4(keccak256(abi.encode(REFUND_ROUTE_TYPEHASH, intentId, to)));
            if (!SignatureChecker.isValidSignatureNow(p.payer, d, payerSig)) revert BadRefundRoute();
            dest = to;
        }
        _refund(intentId, p, amount, dest, reason);
    }

    /// @notice Bulk refund to original payers in one transaction. Same caps and operator limits apply
    ///         to every item; any failing item reverts the whole batch (no partial surprises).
    function refundBatch(bytes32[] calldata intentIds, uint256[] calldata amounts, bytes32 reason) external nonReentrant {
        if (intentIds.length != amounts.length || intentIds.length == 0) revert InvalidTerms();
        for (uint256 i; i < intentIds.length; ++i) {
            Payment storage p = payments[intentIds[i]];
            if (p.paidAt == 0) revert Inactive();
            _refund(intentIds[i], p, amounts[i], p.payer, reason);
        }
    }

    function _refund(bytes32 intentId, Payment storage p, uint256 amount, address dest, bytes32 reason) internal {
        if (reason == bytes32(0)) revert ReasonRequired();
        if (amount == 0) revert InvalidTerms();
        if (uint256(p.refunded) + amount > p.amount) revert RefundExceedsPayment();
        _authorizeRefund(p.merchantId, amount);
        p.refunded += uint128(amount); // safe: bounded by p.amount (uint128)
        IERC20(p.token).safeTransferFrom(msg.sender, dest, amount);
        emit Refunded(intentId, dest, amount, p.refunded, reason, msg.sender);
    }

    /// @notice Refund part of what a subscriber has been charged (for example the unused part of a period).
    ///         Same rules as a payment refund: mandatory reason, owner unlimited, operators limited, always back to the payer,
    ///         never more than was charged in total, and never blocked by a pause.
    function refundSubscription(uint256 subId, uint256 amount, bytes32 reason) external nonReentrant {
        Subscription storage s = subscriptions[subId];
        if (s.payer == address(0)) revert Inactive();
        if (reason == bytes32(0)) revert ReasonRequired();
        if (amount == 0) revert InvalidTerms();
        if (uint256(subRefunded[subId]) + amount > s.charged) revert RefundExceedsPayment();
        _authorizeRefund(s.merchantId, amount);
        subRefunded[subId] += uint128(amount); // bounded by s.charged (uint128)
        IERC20(s.token).safeTransferFrom(msg.sender, s.payer, amount);
        emit SubscriptionRefunded(subId, s.payer, amount, subRefunded[subId], reason, msg.sender);
    }

    /// @dev Owner: unlimited. Operator: per-refund max and daily budget, both enforced onchain.
    function _authorizeRefund(uint256 merchantId, uint256 amount) internal {
        if (merchants[merchantId].owner == msg.sender) return;
        RefundLimit storage l = refundLimits[merchantId][msg.sender];
        if (l.perRefund == 0) revert NotAuthorized();
        if (amount > l.perRefund) revert RefundLimitExceeded();
        uint64 today = uint64(block.timestamp / 1 days);
        if (l.day != today) { l.day = today; l.usedToday = 0; }
        if (uint256(l.usedToday) + amount > l.perDay) revert RefundLimitExceeded();
        l.usedToday += uint128(amount);
    }

    // ───────── Subscriptions ─────────
    /// @notice Payer authorises recurring pulls bounded by amount, period, end and a lifetime cap (custom terms).
    function subscribe(uint256 merchantId, address token, uint128 amount, uint64 period, uint64 end, uint128 cap)
        external whenNotPaused returns (uint256 id)
    {
        if (!merchants[merchantId].exists) revert NotMerchantOwner();
        if (amount == 0 || period == 0 || amount > cap || end <= block.timestamp) revert InvalidTerms();
        if (!allowedToken[token]) revert TokenNotAllowed();
        id = ++subCount;
        subscriptions[id] = Subscription(merchantId, msg.sender, token, amount, cap, 0, period, uint64(block.timestamp), end, false);
        emit SubscriptionCreated(id, merchantId, msg.sender, token, amount, period, cap, end);
    }

    // ── Plans (merchant price list) ──
    function createPlan(uint256 merchantId, address token, uint128 amount, uint64 period, uint64 trial, uint128 introAmount, uint32 introCycles)
        external onlyMerchantOwner(merchantId) returns (uint256 planId)
    {
        if (!allowedToken[token]) revert TokenNotAllowed();
        if (amount == 0 || period == 0 || introAmount > amount || (introCycles == 0 && introAmount != 0)) revert InvalidTerms();
        planId = ++planCount;
        plans[planId] = Plan(merchantId, token, amount, introAmount, period, trial, introCycles, true);
        emit PlanCreated(planId, merchantId, token, amount, period, trial, introAmount, introCycles);
    }

    function setPlanActive(uint256 planId, bool active) external onlyMerchantOwner(plans[planId].merchantId) {
        plans[planId].active = active;
        emit PlanStatus(planId, active);
    }

    /// @notice Subscribe to a merchant plan. Price comes from the plan; the payer sets the lifetime cap and end date.
    function subscribeToPlan(uint256 planId, uint128 cap, uint64 end) external whenNotPaused returns (uint256 id) {
        Plan storage p = plans[planId];
        if (!p.active) revert Inactive();
        uint128 first = p.introCycles > 0 ? p.introAmount : p.amount;
        if (cap < first || end <= block.timestamp + p.trial) revert InvalidTerms();
        id = ++subCount;
        uint64 firstAt = uint64(block.timestamp) + p.trial;
        subscriptions[id] = Subscription(p.merchantId, msg.sender, p.token, p.amount, cap, 0, p.period, firstAt, end, false);
        subState[id].planId = planId;
        emit SubscriptionCreated(id, p.merchantId, msg.sender, p.token, p.amount, p.period, cap, end);
        emit PlanSubscribed(id, planId, firstAt);
    }

    /// @notice Permissionless: any keeper can trigger a due charge. Never charges more than the payer's cap.
    function charge(uint256 id) external nonReentrant whenNotPaused {
        Subscription storage s = subscriptions[id];
        SubState storage x = subState[id];
        if (s.payer == address(0) || s.cancelled) revert Inactive();
        if (x.pausedBy != address(0)) revert SubIsPaused();
        if (block.timestamp < s.nextCharge) revert TooEarly();
        if (block.timestamp > s.end) revert Inactive();
        uint128 amt = s.amount;
        if (x.planId != 0) {
            if (x.pendingPlanId != 0) { // scheduled downgrade takes effect at the period boundary
                x.planId = x.pendingPlanId;
                x.pendingPlanId = 0;
                s.amount = plans[x.planId].amount;
                amt = s.amount;
            }
            Plan storage p = plans[x.planId];
            if (x.charges < p.introCycles) amt = p.introAmount;
        }
        if (uint256(s.charged) + amt > s.cap) revert CapReached();
        s.charged += amt;
        x.charges += 1;
        // Missed periods are never charged back-to-back: if the keeper was late, the next charge is one period from now.
        uint64 next = s.nextCharge + s.period;
        s.nextCharge = next > block.timestamp ? next : uint64(block.timestamp) + s.period;
        IERC20(s.token).safeTransferFrom(s.payer, merchants[s.merchantId].payout, amt);
        emit SubscriptionCharged(id, amt, s.charged, s.nextCharge);
    }

    /// @notice Pause charging. Payer or merchant owner. Does not need the other party.
    function pauseSubscription(uint256 id) external {
        Subscription storage s = subscriptions[id];
        if (msg.sender != s.payer && msg.sender != merchants[s.merchantId].owner) revert NotAuthorized();
        if (s.cancelled || subState[id].pausedBy != address(0)) revert Inactive();
        subState[id].pausedBy = msg.sender;
        emit SubscriptionPaused(id, msg.sender);
    }

    /// @notice Resume. A payer's pause can only be lifted by the payer (the merchant can't restart charges on its own).
    function resumeSubscription(uint256 id) external {
        Subscription storage s = subscriptions[id];
        SubState storage x = subState[id];
        if (x.pausedBy == address(0) || s.cancelled) revert Inactive();
        if (msg.sender != s.payer && !(x.pausedBy != s.payer && msg.sender == merchants[s.merchantId].owner)) revert NotAuthorized();
        x.pausedBy = address(0);
        if (s.nextCharge < block.timestamp) s.nextCharge = uint64(block.timestamp);
        emit SubscriptionResumed(id, msg.sender, s.nextCharge);
    }

    /// @notice Payer changes plan. Upgrades apply now with a prorated charge for the rest of the period (within the cap);
    ///         downgrades apply at the next period, so nothing already paid is lost.
    function changePlan(uint256 id, uint256 newPlanId) external nonReentrant whenNotPaused {
        Subscription storage s = subscriptions[id];
        SubState storage x = subState[id];
        Plan storage np = plans[newPlanId];
        if (s.payer != msg.sender) revert NotAuthorized();
        if (s.cancelled || x.planId == 0 || !np.active || newPlanId == x.planId) revert Inactive();
        if (np.merchantId != s.merchantId || np.token != s.token || np.period != s.period) revert InvalidTerms();
        uint256 from = x.planId;
        if (np.amount > s.amount) {
            uint256 prorated = s.nextCharge > block.timestamp
                ? (uint256(np.amount - s.amount) * (s.nextCharge - block.timestamp)) / s.period : 0;
            if (uint256(s.charged) + prorated > s.cap) revert CapReached();
            s.amount = np.amount;
            x.planId = newPlanId;
            x.pendingPlanId = 0;
            if (prorated > 0) {
                s.charged += uint128(prorated);
                IERC20(s.token).safeTransferFrom(s.payer, merchants[s.merchantId].payout, prorated);
            }
            emit PlanChanged(id, from, newPlanId, prorated, true);
        } else {
            x.pendingPlanId = newPlanId;
            emit PlanChanged(id, from, newPlanId, 0, false);
        }
    }

    /// @notice Customer can cancel at any time without merchant permission.
    function cancel(uint256 id) external {
        Subscription storage s = subscriptions[id];
        if (s.payer != msg.sender) revert NotAuthorized();
        s.cancelled = true;
        emit SubscriptionCancelled(id, msg.sender);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSigner();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSigner();
        return a;
    }
}
