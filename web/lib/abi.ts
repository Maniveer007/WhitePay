export const ERC20 = [
  "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)",
];
export const PAY_ABI = [
  "function pay((uint256 merchantId,bytes32 intentId,address token,uint256 amount,uint64 expiry) q, bytes sig)",
  "function subscribe(uint256 merchantId,address token,uint128 amount,uint64 period,uint64 end,uint128 cap) returns (uint256)",
  "function subscribeToPlan(uint256 planId,uint128 cap,uint64 end) returns (uint256)",
  "function cancel(uint256 id)", "function charge(uint256 id)",
  "function pauseSubscription(uint256 id)", "function resumeSubscription(uint256 id)", "function changePlan(uint256 id,uint256 newPlanId)",
  "function payments(bytes32) view returns (uint256 merchantId,address payer,address token,uint128 amount,uint128 refunded,uint64 paidAt,uint64 blockNumber)",
  "event PaymentReceived(bytes32 indexed intentId,uint256 indexed merchantId,address indexed payer,address token,uint256 amount)",
  "event Refunded(bytes32 indexed intentId,address indexed to,uint256 amount,uint256 totalRefunded,bytes32 reason,address indexed operator)",
  "event SubscriptionCreated(uint256 indexed subId,uint256 indexed merchantId,address indexed payer,address token,uint256 amount,uint256 period,uint256 cap,uint256 end)",
  "error SubIsPaused()", "error Expired()", "error AlreadyPaid()",
  "function refund(bytes32 intentId,uint256 amount,address to,bytes payerSig,bytes32 reason)",
  "function refundBatch(bytes32[] intentIds,uint256[] amounts,bytes32 reason)",
  "function refundSubscription(uint256 subId,uint256 amount,bytes32 reason)",
  "function queuePayout(uint256 id,address newPayout)", "function applyPayout(uint256 id)",
  "function setRefunder(uint256 id,address refunder,uint128 perRefund,uint128 perDay)",
  "function registerMerchant(address payout,address quoteSigner) returns (uint256)",
  "function createPlan(uint256 merchantId,address token,uint128 amount,uint64 period,uint64 trial,uint128 introAmount,uint32 introCycles) returns (uint256)",
  "function setPlanActive(uint256 planId,bool active)",
  "error RefundLimitExceeded()", "error ReasonRequired()", "error NotAuthorized()", "error RefundExceedsPayment()", "error NotMerchantOwner()",
  "error CapReached()", "error SubIsPaused()", "error InvalidTerms()", "error Inactive()",
];
export const SPLITTER_ACTIONS = ["function sweep(address) returns (uint256)", "function release(address) returns (uint256)", "function returnHeld(address,address,uint256,bytes32)"];
export const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent", "product_not_received", "product_unacceptable", "other"];
