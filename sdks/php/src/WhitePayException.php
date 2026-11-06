<?php
declare(strict_types=1);

namespace WhitePay;

/** Every API error. `$code` is stable and machine-readable (see openapi.json). */
final class WhitePayException extends \RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message)
    {
        parent::__construct($message, $status);
    }
}
