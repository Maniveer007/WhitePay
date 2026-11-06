<?php
declare(strict_types=1);

namespace WhitePay;

/** WhitePay PHP SDK (curl + json only). Mirrors public/openapi.json. Results are associative arrays. */
final class Client
{
    private string $baseUrl;

    public function __construct(private string $apiKey, string $baseUrl = 'http://localhost:3000/api/v1', private int $maxRetries = 2, private int $timeout = 15)
    {
        if ($apiKey === '') {
            throw new \InvalidArgumentException('apiKey is required');
        }
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    // ── Payments ──
    public function createPayment(array $params, ?string $idempotencyKey = null): array { return $this->request('POST', '/payments', $params, $idempotencyKey)['body']; }
    public function getPayment(string $id): array { return $this->request('GET', '/payments/' . rawurlencode($id))['body']; }
    /** @return array{data: array, hasMore: bool, nextCursor: ?string} */
    public function listPayments(?int $limit = null, ?string $startingAfter = null): array { return $this->page('/payments', $limit, $startingAfter); }
    public function requotePayment(string $id): array { return $this->request('POST', '/payments/' . rawurlencode($id) . '/requote', [])['body']; }

    // ── Invoices ── (params use the API's camelCase names: clientName, items[{description, qty, unitPrice, taxPercent}], …)
    public function createInvoice(array $params, ?string $idempotencyKey = null): array { return $this->request('POST', '/invoices', $params, $idempotencyKey)['body']; }
    public function getInvoice(string $id): array { return $this->request('GET', '/invoices/' . rawurlencode($id))['body']; }
    public function listInvoices(?int $limit = null, ?string $startingAfter = null): array { return $this->page('/invoices', $limit, $startingAfter); }
    /** $amount === null pays the full balance. */
    public function payInvoice(string $id, ?float $amount = null): array
    {
        return $this->request('POST', '/invoices/' . rawurlencode($id) . '/pay', $amount === null ? ['full' => true] : ['amount' => $amount])['body'];
    }
    public function voidInvoice(string $id): array { return $this->request('POST', '/invoices/' . rawurlencode($id) . '/void', [])['body']; }
    public function remindInvoice(string $id): array { return $this->request('POST', '/invoices/' . rawurlencode($id) . '/remind', [])['body']; }
    public function invoiceAging(): array { return $this->request('GET', '/invoices/aging')['body']; }

    // ── Credit notes ── ($amount is in major units; $reason defaults to "adjustment")
    public function createCreditNote(string $invoiceId, float $amount, string $reason = 'adjustment', ?string $note = null): array
    {
        return $this->request('POST', '/invoices/' . rawurlencode($invoiceId) . '/credit-notes', array_filter(['amount' => $amount, 'reason' => $reason, 'note' => $note], fn ($v) => $v !== null))['body'];
    }
    public function listCreditNotes(): array { return $this->request('GET', '/credit-notes')['body']; }

    // ── Recurring invoices ── (params: frequency weekly|monthly|quarterly|yearly, template (same fields as createInvoice), every, startDate, endDate, maxRuns)
    public function createRecurringInvoice(array $params): array { return $this->request('POST', '/recurring-invoices', $params)['body']; }
    public function listRecurringInvoices(): array { return $this->request('GET', '/recurring-invoices')['body']; }
    public function pauseRecurringInvoice(string $id): array { return $this->request('POST', '/recurring-invoices/' . rawurlencode($id) . '/pause', [])['body']; }
    public function resumeRecurringInvoice(string $id): array { return $this->request('POST', '/recurring-invoices/' . rawurlencode($id) . '/resume', [])['body']; }
    public function cancelRecurringInvoice(string $id): array { return $this->request('POST', '/recurring-invoices/' . rawurlencode($id) . '/cancel', [])['body']; }

    // ── Finance ──
    /** JSON statement for [from, to) in unix seconds. Excel/PDF/CSV/Xero/QuickBooks files use the same endpoint with ?format=. */
    public function statement(?int $from = null, ?int $to = null): array
    {
        return $this->request('GET', '/statements?format=json' . ($from ? "&from=$from" : '') . ($to ? "&to=$to" : ''))['body'];
    }
    public function listPeriods(): array { return $this->request('GET', '/periods')['body']; }
    public function closePeriod(int $from, int $to, ?string $label = null): array
    {
        return $this->request('POST', '/periods/close', array_filter(['from' => $from, 'to' => $to, 'label' => $label], fn ($v) => $v !== null))['body'];
    }
    public function reopenPeriod(int $id, string $reason): array { return $this->request('POST', "/periods/$id/reopen", ['reason' => $reason])['body']; }
    /** Read-only key for an auditor; the new key is shown once. */
    public function createAuditorKey(): array { return $this->request('POST', '/auditor-key', [])['body']; }
    public function revokeAuditorKey(): array { return $this->request('POST', '/auditor-key/revoke', [])['body']; }

    // ── Seat and usage meters, agents, test clock ──
    public function getMeter(int $id): array { return $this->request('GET', "/meters/$id")['body']; }
    /** $reportId is your idempotency key: the same id is billed once. */
    public function reportUsage(int $meterId, int $units, string $reportId): array { return $this->request('POST', "/meters/$meterId/usage", ['units' => $units, 'reportId' => $reportId])['body']; }
    public function agentPolicy(string $owner, string $agent): array { return $this->request('GET', '/agents/policy?owner=' . rawurlencode($owner) . '&agent=' . rawurlencode($agent))['body']; }
    /** Local development chain only. */
    public function testClock(): array { return $this->request('GET', '/test-clock')['body']; }
    public function advanceTestClock(int $seconds): array { return $this->request('POST', '/test-clock/advance', ['seconds' => $seconds])['body']; }

    // ── Operations ──
    public function refundRequests(): array { return $this->request('GET', '/refund-requests')['body']; }
    public function rejectRefundRequest(int $id, string $note = ''): array { return $this->request('POST', "/refund-requests/$id/reject", ['note' => $note])['body']; }
    public function subscriptions(): array { return $this->request('GET', '/subscriptions')['body']; }
    public function exceptions(): array { return $this->request('GET', '/exceptions')['body']; }
    public function replayWebhook(int $id): array { return $this->request('POST', "/webhooks/$id/replay", [])['body']; }
    public function reconcile(): array { return $this->request('GET', '/reconcile')['body']; }
    public function status(): array { return $this->request('GET', '/status')['body']; }

    /**
     * Low-level request with retries. POSTs always carry an Idempotency-Key so retries can't double-charge.
     * @return array{body: mixed, headers: array<string,string>}
     */
    public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
    {
        $key = $method === 'POST' ? ($idempotencyKey ?? bin2hex(random_bytes(16))) : null;
        for ($attempt = 0; ; $attempt++) {
            $headers = [];
            $ch = curl_init($this->baseUrl . $path);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => $this->timeout,
                CURLOPT_HTTPHEADER => array_values(array_filter([
                    'Authorization: Bearer ' . $this->apiKey,
                    'Content-Type: application/json',
                    'User-Agent: whitepay-php/0.1.0',
                    $key ? 'Idempotency-Key: ' . $key : null,
                ])),
                CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$headers): int {
                    $p = explode(':', $line, 2);
                    if (count($p) === 2) {
                        $headers[strtolower(trim($p[0]))] = trim($p[1]);
                    }
                    return strlen($line);
                },
            ]);
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode((object) $body, JSON_THROW_ON_ERROR));
            }
            $raw = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);
            if ($raw === false) {
                if ($attempt < $this->maxRetries) { usleep(250000 << $attempt); continue; }
                throw new WhitePayException(0, 'network_error', $curlErr);
            }
            if (($status === 429 || $status >= 500) && $attempt < $this->maxRetries) { usleep(250000 << $attempt); continue; }
            $data = $raw === '' ? null : json_decode($raw, true);
            if ($status >= 300) {
                $e = is_array($data) && isset($data['error']) ? $data['error'] : [];
                throw new WhitePayException($status, $e['code'] ?? 'http_error', $e['message'] ?? "HTTP $status");
            }
            return ['body' => $data, 'headers' => $headers];
        }
    }

    private function page(string $path, ?int $limit, ?string $startingAfter): array
    {
        $q = http_build_query(array_filter(['limit' => $limit, 'starting_after' => $startingAfter], fn ($v) => $v !== null));
        $r = $this->request('GET', $q === '' ? $path : "$path?$q");
        return ['data' => $r['body'], 'hasMore' => ($r['headers']['whitepay-has-more'] ?? '') === 'true', 'nextCursor' => $r['headers']['whitepay-next-cursor'] ?? null];
    }
}
