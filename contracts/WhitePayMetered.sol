// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWhitePayMerchants {
    function merchants(uint256 id) external view returns (address owner, address payout, address pendingPayout, address pendingOwner, uint64 payoutEta, bool exists);
    function quoteSigners(uint256 id, address who) external view returns (bool);
    function allowedToken(address token) external view returns (bool);
    function paused() external view returns (bool);
}

/// @title WhitePayMetered
/// @notice Seat-based and usage-based billing with limits the payer sets and the contract enforces.
///         The payer opens a meter that fixes: price per seat, seat count, price per usage unit, a usage budget per
///         period, a lifetime cap and an end date. After that:
///           - seats are billed once per period by anyone (a keeper), `seatPrice * seats`;
///           - usage is reported by the merchant's owner or quote signer and charged at the payer's unit price,
///             never above the per-period budget or the lifetime cap, and each report id is applied once.
///         The merchant therefore cannot bill a price the payer did not agree to, or more than the payer's budget.
///         Funds go payer → merchant payout wallet directly; this contract never holds tokens.
contract WhitePayMetered is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Meter {
        uint256 merchantId;
        address payer;
        address token;
        uint128 seatPrice;       // per seat per period
        uint128 unitPrice;       // per usage unit
        uint128 usageBudget;     // max usage charges per period
        uint128 cap;             // lifetime cap across seats and usage
        uint128 charged;
        uint128 usedInWindow;
        uint64 period;
        uint64 windowStart;      // start of the current usage window
        uint64 nextSeatCharge;
        uint64 end;
        uint32 seats;
        uint32 pendingSeats;     // reduction applied at the next seat charge
        bool cancelled;
    }

    IWhitePayMerchants public immutable core;
    uint256 public meterCount;
    mapping(uint256 => Meter) internal meters;
    mapping(uint256 => mapping(bytes32 => bool)) public reported;

    /// @dev Everything the payer fixes when opening a meter.
    struct Terms {
        uint128 seatPrice;
        uint32 seats;
        uint128 unitPrice;
        uint128 usageBudget;
        uint64 period;
        uint128 cap;
        uint64 end;
    }
    event MeterOpened(uint256 indexed meterId, uint256 indexed merchantId, address indexed payer, address token, Terms terms);
    event SeatsCharged(uint256 indexed meterId, uint256 seats, uint256 amount, uint256 totalCharged, uint256 nextCharge);
    event SeatsChanged(uint256 indexed meterId, uint256 fromSeats, uint256 toSeats, uint256 proratedCharge, bool immediate);
    event UsageCharged(uint256 indexed meterId, bytes32 indexed reportId, uint256 units, uint256 amount, uint256 totalCharged);
    event MeterCancelled(uint256 indexed meterId, address by);

    error NotPayer();
    error NotMerchant();
    error InvalidTerms();
    error Inactive();
    error TooEarly();
    error CapReached();
    error BudgetExceeded();
    error AlreadyReported();
    error TokenNotAllowed();
    error IsPaused();

    constructor(address core_) { core = IWhitePayMerchants(core_); }

    function open(uint256 merchantId, address token, Terms calldata t) external returns (uint256 id) {
        if (!_exists(merchantId) || t.period == 0 || t.end <= block.timestamp || t.cap == 0) revert InvalidTerms();
        if (t.seatPrice == 0 && t.unitPrice == 0) revert InvalidTerms();
        if (t.seatPrice > 0 && t.seats == 0) revert InvalidTerms();
        if (t.unitPrice > 0 && t.usageBudget == 0) revert InvalidTerms();
        if (uint256(t.seatPrice) * t.seats > t.cap) revert InvalidTerms();
        if (!core.allowedToken(token)) revert TokenNotAllowed();
        id = ++meterCount;
        Meter storage m = meters[id];
        m.merchantId = merchantId;
        m.payer = msg.sender;
        m.token = token;
        m.seatPrice = t.seatPrice;
        m.unitPrice = t.unitPrice;
        m.usageBudget = t.usageBudget;
        m.cap = t.cap;
        m.period = t.period;
        m.windowStart = uint64(block.timestamp);
        m.nextSeatCharge = uint64(block.timestamp);
        m.end = t.end;
        m.seats = t.seats;
        emit MeterOpened(id, merchantId, msg.sender, token, t);
    }

    function getMeter(uint256 id) external view returns (Meter memory) { return meters[id]; }

    // Each helper decodes the 6-field merchant tuple on its own, which keeps callers' stack small.
    function _payout(uint256 merchantId) internal view returns (address payout) {
        (, payout, , , , ) = core.merchants(merchantId);
    }
    function _owner(uint256 merchantId) internal view returns (address o) {
        (o, , , , , ) = core.merchants(merchantId);
    }
    function _exists(uint256 merchantId) internal view returns (bool e) {
        (, , , , , e) = core.merchants(merchantId);
    }

    /// @notice Bill the seats for the current period. Permissionless. Late billing never double-charges.
    function chargeSeats(uint256 id) external nonReentrant {
        Meter storage m = meters[id];
        if (core.paused()) revert IsPaused();
        if (m.payer == address(0) || m.cancelled || m.seatPrice == 0 || block.timestamp > m.end) revert Inactive();
        if (block.timestamp < m.nextSeatCharge) revert TooEarly();
        if (m.pendingSeats != 0) { m.seats = m.pendingSeats; m.pendingSeats = 0; }
        if (m.seats == 0) revert Inactive();
        uint256 amt = uint256(m.seatPrice) * m.seats;
        if (uint256(m.charged) + amt > m.cap) revert CapReached();
        m.charged += uint128(amt);
        uint64 next = m.nextSeatCharge + m.period;
        m.nextSeatCharge = next > block.timestamp ? next : uint64(block.timestamp) + m.period;
        IERC20(m.token).safeTransferFrom(m.payer, _payout(m.merchantId), amt);
        emit SeatsCharged(id, m.seats, amt, m.charged, m.nextSeatCharge);
    }

    /// @notice Payer changes seats. Adding seats bills the rest of the current period pro rata now (within the cap);
    ///         removing seats takes effect at the next seat charge.
    function setSeats(uint256 id, uint32 newSeats) external nonReentrant {
        Meter storage m = meters[id];
        if (m.payer != msg.sender) revert NotPayer();
        if (m.cancelled || m.seatPrice == 0 || newSeats == 0) revert Inactive();
        uint32 cur = m.pendingSeats != 0 ? m.pendingSeats : m.seats;
        if (newSeats > m.seats) {
            uint256 prorated = m.nextSeatCharge > block.timestamp
                ? (uint256(m.seatPrice) * (newSeats - m.seats) * (m.nextSeatCharge - block.timestamp)) / m.period : 0;
            if (uint256(m.charged) + prorated > m.cap) revert CapReached();
            emit SeatsChanged(id, cur, newSeats, prorated, true);
            m.seats = newSeats;
            m.pendingSeats = 0;
            if (prorated > 0) {
                m.charged += uint128(prorated);
                IERC20(m.token).safeTransferFrom(m.payer, _payout(m.merchantId), prorated);
            }
        } else {
            m.pendingSeats = newSeats == m.seats ? 0 : newSeats;
            emit SeatsChanged(id, cur, newSeats, 0, false);
        }
    }

    /// @notice Merchant reports usage. `reportId` makes the call idempotent so a retry cannot double-bill.
    function chargeUsage(uint256 id, uint256 units, bytes32 reportId) external nonReentrant {
        Meter storage m = meters[id];
        if (core.paused()) revert IsPaused();
        if (m.payer == address(0) || m.cancelled || m.unitPrice == 0 || block.timestamp > m.end) revert Inactive();
        if (msg.sender != _owner(m.merchantId) && !core.quoteSigners(m.merchantId, msg.sender)) revert NotMerchant();
        if (units == 0 || reportId == bytes32(0)) revert InvalidTerms();
        if (reported[id][reportId]) revert AlreadyReported();
        reported[id][reportId] = true;
        uint256 amt = units * m.unitPrice;
        if (block.timestamp >= m.windowStart + m.period) { // roll the usage window forward on period boundaries
            m.windowStart += uint64(((block.timestamp - m.windowStart) / m.period) * m.period);
            m.usedInWindow = 0;
        }
        if (uint256(m.usedInWindow) + amt > m.usageBudget) revert BudgetExceeded();
        if (uint256(m.charged) + amt > m.cap) revert CapReached();
        m.usedInWindow += uint128(amt);
        m.charged += uint128(amt);
        IERC20(m.token).safeTransferFrom(m.payer, _payout(m.merchantId), amt);
        emit UsageCharged(id, reportId, units, amt, m.charged);
    }

    /// @notice Payer can stop everything at any time. Works while the core contract is paused.
    function cancel(uint256 id) external {
        Meter storage m = meters[id];
        if (m.payer != msg.sender) revert NotPayer();
        m.cancelled = true;
        emit MeterCancelled(id, msg.sender);
    }
}
