<?php
declare(strict_types=1);

namespace WhitePay;

/** Verifies X-WhitePay-Signature. Always pass the RAW body: file_get_contents('php://input'). */
final class Webhook
{
    /** Returns the decoded event, or throws WhitePayException(errorCode "invalid_signature"). Any matching v1 is accepted (secret rotation). */
    public static function verify(string $rawBody, string $header, string $secret, int $tolerance = 300, ?int $now = null): array
    {
        $now ??= time();
        $ts = null;
        $sigs = [];
        foreach (explode(',', $header) as $part) {
            $kv = explode('=', trim($part), 2);
            if (count($kv) !== 2) continue;
            if ($kv[0] === 't' && ctype_digit($kv[1])) $ts = (int) $kv[1];
            if ($kv[0] === 'v1') $sigs[] = $kv[1];
        }
        if ($ts === null) throw new WhitePayException(400, 'invalid_signature', 'Missing timestamp');
        if (abs($now - $ts) > $tolerance) throw new WhitePayException(400, 'invalid_signature', 'Timestamp outside tolerance');
        $expected = hash_hmac('sha256', $ts . '.' . $rawBody, $secret);
        foreach ($sigs as $s) {
            if (hash_equals($expected, $s)) { // constant-time
                return json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
            }
        }
        throw new WhitePayException(400, 'invalid_signature', 'No matching signature');
    }
}
