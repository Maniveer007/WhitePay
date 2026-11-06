# WhitePay for WooCommerce

Accept non-custodial USDT payments (Whitechain) in a WooCommerce shop.

1. Copy this folder to `wp-content/plugins/` and activate **WhitePay for WooCommerce**.
2. WooCommerce → Settings → Payments → WhitePay: enter your WhitePay host, API key and webhook secret.
3. In WhitePay, point your merchant webhook URL at `https://YOUR-SHOP/?wc-api=whitepay`.

How it works: checkout creates a WhitePay payment (`orderRef = woo_<order id>`) and redirects the customer to the hosted checkout.
The order is completed only when a **signed** `payment.fulfillable` webhook arrives (at the finality level you chose), and it goes on hold on
`payment.reorged`. Webhooks are verified with the raw body, a 5 minute timestamp window and a constant-time HMAC compare.

Refunds are on-chain transfers from your wallet, so they are issued from the WhitePay dashboard rather than from the WooCommerce refund button.

Status: written against the WooCommerce gateway API; **not yet run in a live WordPress** (no PHP runtime was available when it was built). Test it on a staging shop first.
