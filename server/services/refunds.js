// Refund constants shared by the API and the checkout page.


const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent", "product_not_received", "product_unacceptable", "other"];
/** What the payer signs (EIP-191) so only the wallet that paid can ask for its money back. */
const refundRequestMessage = (publicId, amount, reason) =>
  `WhitePay refund request\nPayment: ${publicId}\nAmount: ${amount}\nReason: ${reason}`;

module.exports = { REFUND_REASONS, refundRequestMessage };
