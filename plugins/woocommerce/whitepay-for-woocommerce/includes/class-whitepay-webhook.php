<?php
defined('ABSPATH') || exit;

/**
 * Verifies WhitePay webhooks exactly like the WhitePay SDKs do: raw body, `t=<unix>,v1=<hmac>` header,
 * HMAC-SHA256 over "{t}.{body}", constant-time comparison, 5 minute tolerance, any v1 may match (secret rotation).
 */
final class WhitePay_Webhook
{
    public const TOLERANCE = 300;

    public static function verify(string $rawBody, string $header, string $secret, ?int $now = null): bool
    {
        if ($secret === '' || $header === '') {
            return false;
        }
        $now ??= time();
        $t = null;
        $sigs = [];
        foreach (explode(',', $header) as $part) {
            $kv = explode('=', trim($part), 2);
            if (count($kv) !== 2) {
                continue;
            }
            if ($kv[0] === 't' && ctype_digit($kv[1])) {
                $t = (int) $kv[1];
            } elseif ($kv[0] === 'v1' && preg_match('/^[0-9a-f]{64}$/', $kv[1])) {
                $sigs[] = $kv[1];
            }
        }
        if ($t === null || abs($now - $t) > self::TOLERANCE) {
            return false;
        }
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
        foreach ($sigs as $s) {
            if (hash_equals($expected, $s)) {
                return true;
            }
        }
        return false;
    }
}
