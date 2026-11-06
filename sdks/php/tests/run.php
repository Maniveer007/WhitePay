<?php
// Dependency-free test runner: php tests/run.php. Set WHITEPAY_BASE_URL for the live API test.
declare(strict_types=1);
require __DIR__ . '/../src/WhitePayException.php';
require __DIR__ . '/../src/Client.php';
require __DIR__ . '/../src/Webhook.php';

use WhitePay\{Client, Webhook, WhitePayException};

$passed = $failed = 0;
function check(string $name, bool $ok): void { global $passed, $failed; $ok ? $passed++ : $failed++; echo ($ok ? 'ok   ' : 'FAIL ') . $name . PHP_EOL; }
function expectError(callable $f): ?WhitePayException { try { $f(); } catch (WhitePayException $e) { return $e; } return null; }

$v = json_decode(file_get_contents(__DIR__ . '/../../testdata/webhook-vectors.json'), true);
foreach ($v['cases'] as $c) {
    $run = fn () => Webhook::verify($c['body'], $c['header'], $c['secret'], $v['tolerance'], $c['now']);
    if ($c['valid']) check('webhook vector: ' . $c['name'], $run()['type'] === 'payment.fulfillable');
    else { $e = expectError($run); check('webhook vector: ' . $c['name'], $e !== null && $e->errorCode === 'invalid_signature'); }
}

$base = getenv('WHITEPAY_BASE_URL');
if (!$base) {
    echo "skip live API (set WHITEPAY_BASE_URL)\n";
} else {
    $wp = new Client(getenv('WHITEPAY_API_KEY') ?: 'wp_test_demo', $base);
    $e = expectError(fn () => (new Client('wrong', $base, 0))->listPayments(1));
    check('bad key → 401 unauthorized', $e !== null && $e->status === 401 && $e->errorCode === 'unauthorized');
    $idem = 'php-' . microtime(true);
    $p = ['amount' => 12.5, 'currency' => 'USD', 'description' => 'SDK test'];
    $a = $wp->createPayment($p, $idem); $b = $wp->createPayment($p, $idem);
    check('Idempotency-Key returns the same payment', $a['id'] === $b['id'] && $a['amount'] === '12500000');
    check('get payment', $wp->getPayment($a['id'])['amount'] === '12500000');
    $wp->createPayment(['amount' => 1]);
    $p1 = $wp->listPayments(1);
    check('pagination first page', count($p1['data']) === 1 && $p1['hasMore'] && $p1['nextCursor']);
    check('cursor advances', $wp->listPayments(1, $p1['nextCursor'])['data'][0]['id'] !== $p1['data'][0]['id']);
    $inv = $wp->createInvoice(['clientName' => 'SDK client', 'items' => [['description' => 'Work', 'qty' => 1, 'unitPrice' => 100, 'taxPercent' => 18]]]);
    check('invoice total 118.00', $inv['total'] === 11800);
    check('invoice open', $wp->getInvoice($inv['id'])['status'] === 'open');
    check('pay invoice → checkout', str_contains($wp->payInvoice($inv['id'])['checkoutUrl'], 'pay_'));
    $e = expectError(fn () => $wp->getPayment('pay_does_not_exist'));
    check('unknown payment → 404 not_found', $e !== null && $e->status === 404 && $e->errorCode === 'not_found');
    $ci = $wp->createInvoice(['clientName' => 'Credit client', 'items' => [['description' => 'Work', 'qty' => 1, 'unitPrice' => 100]]]);
    $cn = $wp->createCreditNote($ci['id'], 30.0, 'pricing_error');
    check('credit note leaves 70.00', $cn['invoice']['balance'] === 7000);
    $e = expectError(fn () => $wp->createCreditNote($ci['id'], 500.0));
    check('oversized credit note → invalid_amount', $e !== null && $e->errorCode === 'invalid_amount');
    $rec = $wp->createRecurringInvoice(['frequency' => 'monthly', 'template' => ['clientName' => 'Retainer', 'items' => [['description' => 'Retainer', 'unitPrice' => 50]]]]);
    check('recurring issues its first invoice', $rec['runs'] === 1);
    check('pause recurring', $wp->pauseRecurringInvoice($rec['id'])['status'] === 'paused');
    check('cancel recurring', $wp->cancelRecurringInvoice($rec['id'])['status'] === 'cancelled');
    check('statement has a summary', isset($wp->statement()['summary']));
    check('agent policy inactive', $wp->agentPolicy('0x' . str_repeat('1', 40), '0x' . str_repeat('2', 40))['active'] === false);
}
echo "$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
