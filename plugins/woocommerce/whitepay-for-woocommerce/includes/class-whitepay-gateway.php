<?php
defined('ABSPATH') || exit;

class WhitePay_Gateway extends WC_Payment_Gateway
{
    public function __construct()
    {
        $this->id = 'whitepay';
        $this->method_title = 'WhitePay (USDT)';
        $this->method_description = 'Non-custodial USDT payments on Whitechain. Funds go from the customer straight to your payout wallet.';
        $this->has_fields = false;
        $this->supports = ['products'];
        $this->init_form_fields();
        $this->init_settings();
        $this->title = $this->get_option('title', 'Pay with USDT');
        $this->description = $this->get_option('description', 'Pay with USDT from your wallet. You will be redirected to a secure checkout.');
        $this->enabled = $this->get_option('enabled', 'no');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
        add_action('woocommerce_api_whitepay', [$this, 'handle_webhook']);
    }

    public function init_form_fields(): void
    {
        $this->form_fields = [
            'enabled' => ['title' => 'Enable', 'type' => 'checkbox', 'label' => 'Enable WhitePay', 'default' => 'no'],
            'title' => ['title' => 'Title', 'type' => 'text', 'default' => 'Pay with USDT'],
            'description' => ['title' => 'Description', 'type' => 'textarea', 'default' => 'Pay with USDT from your wallet. You will be redirected to a secure checkout.'],
            'base_url' => ['title' => 'WhitePay host', 'type' => 'text', 'default' => 'https://pay.example.com', 'description' => 'Where your WhitePay server runs, without /api.'],
            'api_key' => ['title' => 'API key', 'type' => 'password', 'description' => 'Your WhitePay merchant API key (wp_live_… or wp_test_…).'],
            'webhook_secret' => ['title' => 'Webhook secret', 'type' => 'password', 'description' => 'Signing secret for webhooks. Webhook URL to register: ' . esc_url(WC()->api_request_url('whitepay'))],
            'policy' => ['title' => 'Release goods at', 'type' => 'select', 'default' => 'auto', 'options' => [
                'auto' => 'Automatic, by order value', 'seen' => 'Seen (instant, riskier)', 'safe' => 'Safe (posted to L1)', 'finalized' => 'Finalized (L1 final)']],
            'currency' => ['title' => 'Currency override', 'type' => 'text', 'description' => 'Leave empty to use the shop currency. Must be one WhitePay supports (USD, EUR, INR, GBP, USDT).'],
        ];
    }

    private function api(string $method, string $path, ?array $body = null): array
    {
        $res = wp_remote_request(rtrim((string) $this->get_option('base_url'), '/') . '/api/v1' . $path, [
            'method' => $method,
            'timeout' => 20,
            'headers' => [
                'Authorization' => 'Bearer ' . $this->get_option('api_key'),
                'Content-Type' => 'application/json',
                // Retries (customer double-clicks, network retries) can never create a second payment for the same order.
                'Idempotency-Key' => 'woo-' . md5($method . $path . wp_json_encode($body)),
            ],
            'body' => $body === null ? null : wp_json_encode($body),
        ]);
        if (is_wp_error($res)) {
            throw new RuntimeException($res->get_error_message());
        }
        $data = json_decode(wp_remote_retrieve_body($res), true) ?: [];
        if (wp_remote_retrieve_response_code($res) >= 400) {
            throw new RuntimeException($data['error']['message'] ?? 'WhitePay request failed');
        }
        return $data;
    }

    public function process_payment($order_id): array
    {
        $order = wc_get_order($order_id);
        try {
            $currency = strtoupper($this->get_option('currency') ?: $order->get_currency());
            $payment = $this->api('POST', '/payments', [
                'amount' => (float) $order->get_total(),
                'currency' => $currency,
                'orderRef' => 'woo_' . $order->get_id(), // the webhook maps a payment back to its order through this
                'description' => sprintf('Order #%s', $order->get_order_number()),
                'policy' => $this->get_option('policy', 'auto'),
            ]);
        } catch (Throwable $e) {
            wc_add_notice('Payment could not be started: ' . esc_html($e->getMessage()), 'error');
            return ['result' => 'failure'];
        }
        $order->update_meta_data('_whitepay_payment_id', $payment['id']);
        $order->update_status('pending', 'Waiting for USDT payment ' . $payment['id']);
        $order->save();
        WC()->cart->empty_cart();
        $url = rtrim((string) $this->get_option('base_url'), '/') . '/pay.html?i=' . rawurlencode($payment['id']);
        return ['result' => 'success', 'redirect' => $url];
    }

    /** Refunds are on-chain (the merchant wallet pays the customer back), so they are issued from the WhitePay dashboard. */
    public function process_refund($order_id, $amount = null, $reason = '')
    {
        return new WP_Error('whitepay_refund', 'Refund this payment from the WhitePay dashboard (it is an on-chain transfer from your wallet). Then mark the order refunded here.');
    }

    public function handle_webhook(): void
    {
        $raw = file_get_contents('php://input') ?: '';
        $sig = $_SERVER['HTTP_X_WHITEPAY_SIGNATURE'] ?? '';
        if (!WhitePay_Webhook::verify($raw, $sig, (string) $this->get_option('webhook_secret'))) {
            status_header(400);
            exit('invalid signature');
        }
        $event = json_decode($raw, true);
        $data = $event['data'] ?? [];
        $ref = (string) ($data['orderRef'] ?? '');
        if (!str_starts_with($ref, 'woo_')) {
            status_header(200); // not one of ours (another integration on the same merchant)
            exit('ignored');
        }
        $order = wc_get_order((int) substr($ref, 4));
        if (!$order || $order->get_meta('_whitepay_payment_id') !== ($data['id'] ?? null)) {
            status_header(200);
            exit('unknown order');
        }
        switch ($event['type'] ?? '') {
            case 'payment.fulfillable': // the merchant's chosen finality has been reached: safe to ship
                if (!$order->is_paid()) {
                    $order->payment_complete($data['txHash'] ?? '');
                    $order->add_order_note('USDT payment confirmed on-chain: ' . ($data['txHash'] ?? ''));
                }
                break;
            case 'payment.reorged': // the chain reorganised the payment away: hold the order
                if (!$order->has_status('on-hold')) {
                    $order->update_status('on-hold', 'The payment was removed by a chain reorganisation. Do not ship until it is paid again.');
                }
                break;
        }
        status_header(200);
        exit('ok');
    }
}
