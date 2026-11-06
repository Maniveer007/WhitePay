<?php
/**
 * Plugin Name: WhitePay for WooCommerce
 * Description: Accept non-custodial USDT payments on Whitechain. Orders are fulfilled from a signed webhook, never from the browser.
 * Version: 0.1.0
 * Requires PHP: 8.0
 * Requires Plugins: woocommerce
 * License: MIT
 */
defined('ABSPATH') || exit;

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }
    require_once __DIR__ . '/includes/class-whitepay-webhook.php';
    require_once __DIR__ . '/includes/class-whitepay-gateway.php';
    add_filter('woocommerce_payment_gateways', fn(array $g) => array_merge($g, [WhitePay_Gateway::class]));
});

// Checkout blocks: declare compatibility (the gateway redirects to WhitePay's hosted checkout, so the classic flow is used).
add_action('before_woocommerce_init', function () {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
    }
});
