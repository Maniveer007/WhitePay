const FEATURES = [
  ["Non-custodial by design", "Customers pay from their own wallet straight to your payout wallet. WhitePay never holds your funds, and a stolen API key can't redirect them: payout changes are timelocked onchain."],
  ["Exact, expiring quotes", "Every price is a signed quote the contract checks: exact amount, exact merchant, short expiry. No underpayments, no stale prices."],
  ["Gasless checkout", "Customers sign once and pay in USDT without holding the network's gas token. The platform relays the transaction."],
  ["Refunds that follow rules", "Full and partial refunds with mandatory reason codes. Staff get per-refund and daily limits that the contract enforces, and a pause can never block a refund."],
  ["Subscriptions and invoices", "Plans with trials, intro pricing and prorated upgrades. The payer sets the cap. Invoices with partial payments, credit notes, recurring schedules, late fees and dunning."],
  ["Accounting you can hand over", "An append-only double-entry ledger that reconciles to the chain. Excel, PDF, Xero and QuickBooks exports, period close, and a read-only key for your auditor."],
  ["Marketplaces", "Split every payment between a platform fee and the seller, hold the seller's share for a dispute window, and return held funds to a buyer."],
  ["Built for developers", "A versioned REST API with OpenAPI, SDKs for TypeScript, Python, Go, Ruby, Java and PHP, signed webhooks, a CLI that forwards webhooks to localhost, and a test clock."],
  ["Ready for AI agents", "Give an agent a spending policy: a per-payment limit, a daily limit, an expiry and an allowlist, enforced by the contract. An MCP server exposes the tools."],
] as const;

const FAQ = [
  ["Which network does it run on?", "Whitechain, an OP Stack chain, using USDT. The live deployment today is on the Whitechain testnet; use it to build and test your integration before mainnet."],
  ["Do my customers need crypto?", "They need a wallet with USDT. Checkout supports wallet and gasless payment, with deep links for popular wallets. Converting USDT to local currency is up to you or your exchange; WhitePay does not provide fiat payouts."],
  ["Do you hold my money?", "No. Payments go directly from the customer to the payout wallet you registered onchain. You can verify every payment and refund on the explorer."],
  ["What happens when I reach a plan limit?", "You can't create new payments, invoices or schedules until the next month or an upgrade. Customers can still pay what already exists, and refunds and webhooks keep working."],
  ["Can I try it without a wallet?", "Yes. Create a free account, get your API key, and use the demo store and test clock locally. You need a wallet when you go live, because your owner wallet registers the merchant onchain."],
] as const;

export default function Home() {
  return (
    <>
      <section className="hero container">
        <span className="eyebrow">Live on Whitechain testnet</span>
        <h1>Accept USDT without giving up custody</h1>
        <p className="lead">Payments, invoices and subscriptions where the customer pays straight to your wallet and smart contracts enforce the rules.</p>
        <div className="cta">
          <a className="btn lg" href="/signup">Start free</a>
          <a className="btn lg secondary" href="/pricing">See pricing</a>
        </div>
      </section>

      <section className="section alt" id="how">
        <div className="container">
          <h2>From signup to first payment in minutes</h2>
          <p className="sub">No contract to write and no node to run.</p>
          <div className="steps">
            <div className="step"><h3>Create your account</h3><p className="mut">Get an API key and a webhook secret straight away. Register your owner wallet onchain when you are ready to go live.</p></div>
            <div className="step"><h3>Create a payment</h3><p className="mut">Call the API or use the console to create a payment link, an invoice or a subscription plan.</p></div>
            <div className="step"><h3>Get paid and notified</h3><p className="mut">The customer pays from their wallet. You receive a signed webhook, and the ledger updates automatically.</p></div>
          </div>
        </div>
      </section>

      <section className="section" id="features">
        <div className="container">
          <h2>Everything a payments business needs</h2>
          <p className="sub">One platform for checkout, billing, refunds and the books.</p>
          <div className="features">
            {FEATURES.map(([t, d]) => <div className="feature" key={t}><h3>{t}</h3><p>{d}</p></div>)}
          </div>
        </div>
      </section>

      <section className="section alt">
        <div className="container" style={{ maxWidth: 820 }}>
          <h2>One request to take a payment</h2>
          <p className="sub">Create a payment, send the customer to the checkout URL, and wait for the webhook.</p>
          <pre className="code">{`curl -X POST https://YOUR-HOST/api/v1/payments \\
  -H "Authorization: Bearer $WHITEPAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order_1042" \\
  -d '{ "amount": 49, "currency": "USD", "orderRef": "order_1042" }'

# → { "id": "pay_…", "checkoutUrl": "/pay.html?i=pay_…", "status": "created", … }`}</pre>
        </div>
      </section>

      <section className="section">
        <div className="container" style={{ maxWidth: 820 }}>
          <h2>Questions</h2>
          <div className="faq">
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
          <div style={{ textAlign: "center", marginTop: 36 }}>
            <a className="btn lg" href="/signup">Create a free account</a>
          </div>
        </div>
      </section>
    </>
  );
}
