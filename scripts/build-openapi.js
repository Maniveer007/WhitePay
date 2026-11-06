// Builds docs/openapi.json, the single source of truth for the HTTP API and every SDK.
// Run: node scripts/build-openapi.js
const fs = require("fs");
const path = require("path");

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema, description = "OK") => ({ description, content: { "application/json": { schema } } });
const err = { $ref: "#/components/responses/Error" };
const id = (name, description) => ({ name, in: "path", required: true, schema: { type: "string" }, description });
const page = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 100 } },
  { name: "starting_after", in: "query", schema: { type: "string" }, description: "Cursor: the id of the last item of the previous page (see the WhitePay-Next-Cursor header)." },
];
const secured = [{ bearer: [] }];
const pub = [];

const spec = {
  openapi: "3.1.0",
  info: {
    title: "WhitePay API", version: "2026-11-01",
    description: "Non-custodial USDT payments on Whitechain. Amounts in USDT are strings of base units (6 decimals). " +
      "Fiat amounts on invoices are integers in minor units (cents/paise). Every response carries a WhitePay-Version header. " +
      "Webhooks are signed: header `X-WhitePay-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + rawBody)>`.",
  },
  servers: [{ url: "http://localhost:3000/api/v1", description: "Local / self-hosted" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "Merchant secret API key (wp_test_… / wp_live_…). Server-side only. It decides which merchant every call acts for." },
      platform: { type: "http", scheme: "bearer", description: "Platform operator key (PLATFORM_KEY) for onboarding merchants." },
    },
    responses: { Error: json(ref("Error"), "Error") },
    parameters: { IdempotencyKey: { name: "Idempotency-Key", in: "header", schema: { type: "string", maxLength: 255 }, description: "Retries with the same key return the original response instead of creating a duplicate." } },
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } } },
      CreatePayment: {
        type: "object", required: ["amount"], properties: {
          amount: { type: "number", exclusiveMinimum: 0, description: "Fiat (or USDT) amount, e.g. 49.99" },
          currency: { type: "string", enum: ["USD", "EUR", "INR", "GBP", "USDT"], default: "USD" },
          orderRef: { type: "string", description: "Your order id. One payment per orderRef." },
          description: { type: "string", maxLength: 200 },
          policy: { type: "string", enum: ["seen", "safe", "finalized", "auto"], default: "safe", description: "Finality level at which payment.fulfillable fires." },
          ttl: { type: "integer", description: "Quote lifetime in seconds (default 900)." },
        },
      },
      Payment: {
        type: "object", properties: {
          id: { type: "string", example: "pay_9a05c8eb15bde4e0" }, intentId: { type: "string", description: "bytes32 used onchain" },
          status: { type: "string", enum: ["created", "expired", "seen", "safe", "finalized", "reorged", "partially_refunded", "refunded"] },
          finality: { type: "string" }, fulfillable: { type: "boolean" }, policy: { type: "string" },
          amount: { type: "string", description: "USDT base units" }, refunded: { type: "string" }, token: { type: "string" },
          fiatAmount: { type: "number" }, currency: { type: "string" }, rate: { type: "number" },
          orderRef: { type: ["string", "null"] }, description: { type: ["string", "null"] }, expiry: { type: "integer" },
          payer: { type: ["string", "null"] }, txHash: { type: ["string", "null"] }, blockNumber: { type: ["integer", "null"] },
          gasless: { type: "boolean" }, checkoutUrl: { type: "string" },
          refunds: { type: "array", items: { type: "object", properties: { tx: { type: "string" }, amount: { type: "string" }, reason: { type: "string" }, operator: { type: "string" }, to: { type: "string" }, status: { type: "string" } } } },
        },
      },
      InvoiceItem: { type: "object", required: ["description", "unitPrice"], properties: { description: { type: "string" }, qty: { type: "number", default: 1 }, unitPrice: { type: "number", description: "Major units, e.g. 1200.50" }, taxPercent: { type: "number", default: 0 } } },
      CreateInvoice: {
        type: "object", required: ["clientName", "items"], properties: {
          clientName: { type: "string" }, clientEmail: { type: "string" }, clientTaxId: { type: "string" }, poRef: { type: "string" },
          currency: { type: "string", enum: ["USD", "EUR", "INR", "GBP", "USDT"], default: "USD" },
          items: { type: "array", minItems: 1, maxItems: 100, items: ref("InvoiceItem") },
          terms: { type: "string", enum: ["due_on_receipt", "net_15", "net_30", "net_60"], default: "net_30" },
          dueDate: { type: "integer", description: "Unix time; overrides terms" }, issueDate: { type: "integer" },
          allowPartial: { type: "boolean" }, minPartial: { type: "number" }, lateFeePercent: { type: "number" },
          earlyDiscountPercent: { type: "number" }, earlyDiscountDays: { type: "integer" }, notes: { type: "string" }, draft: { type: "boolean" },
        },
      },
      Invoice: {
        type: "object", properties: {
          id: { type: "string", example: "inv_982af8254a59a2e5" }, number: { type: "string" },
          status: { type: "string", enum: ["draft", "open", "partially_paid", "overdue", "paid", "void"] }, currency: { type: "string" },
          total: { type: "integer", description: "minor units" }, paid: { type: "integer" }, balance: { type: "integer" }, lateFee: { type: "integer" },
          discountAvailable: { type: "integer" }, payNowFull: { type: "integer" }, dueDate: { type: "integer" }, url: { type: "string" },
          payments: { type: "array", items: { type: "object" } },
        },
      },
      WebhookEvent: { type: "object", required: ["id", "type", "created", "data"], properties: { id: { type: "string" }, type: { type: "string", example: "payment.fulfillable" }, created: { type: "integer" }, data: { type: "object" } } },
    },
  },
  paths: {
    "/payments": {
      post: { operationId: "createPayment", summary: "Create a payment (signed, expiring USDT quote)", security: secured, parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: { required: true, content: { "application/json": { schema: ref("CreatePayment") } } },
        responses: { 201: json(ref("Payment"), "Created"), 200: json(ref("Payment"), "Existing payment for this orderRef / Idempotency-Key"), default: err } },
      get: { operationId: "listPayments", summary: "List payments, newest first", security: secured, parameters: page, responses: { 200: json({ type: "array", items: ref("Payment") }), default: err } },
    },
    "/payments/{id}": { get: { operationId: "getPayment", summary: "Get a payment (public: used by checkout)", security: pub, parameters: [id("id", "pay_… id")], responses: { 200: json(ref("Payment")), default: err } } },
    "/payments/{id}/requote": { post: { operationId: "requotePayment", summary: "Fresh quote for an expired, unpaid payment", security: pub, parameters: [id("id")], responses: { 200: json(ref("Payment")), default: err } } },
    "/invoices": {
      post: { operationId: "createInvoice", summary: "Create an invoice", security: secured, requestBody: { required: true, content: { "application/json": { schema: ref("CreateInvoice") } } }, responses: { 201: json(ref("Invoice"), "Created"), default: err } },
      get: { operationId: "listInvoices", summary: "List invoices", security: secured, parameters: page, responses: { 200: json({ type: "array", items: ref("Invoice") }), default: err } },
    },
    "/invoices/aging": { get: { operationId: "invoiceAging", summary: "Accounts-receivable aging per currency (minor units)", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/invoices/{id}": { get: { operationId: "getInvoice", summary: "Get an invoice (public: the client's view)", security: pub, parameters: [id("id")], responses: { 200: json(ref("Invoice")), default: err } } },
    "/invoices/{id}/pay": { post: { operationId: "payInvoice", summary: "Start a full or partial payment toward an invoice", security: pub, parameters: [id("id")],
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { full: { type: "boolean" }, amount: { type: "number", description: "major units, partial" } } } } } },
      responses: { 201: json({ type: "object", properties: { checkoutUrl: { type: "string" }, amount: { type: "integer" }, discount: { type: "integer" } } }), default: err } } },
    "/invoices/{id}/void": { post: { operationId: "voidInvoice", summary: "Void an unpaid invoice", security: secured, parameters: [id("id")], responses: { 200: json(ref("Invoice")), default: err } } },
    "/invoices/{id}/remind": { post: { operationId: "remindInvoice", summary: "Send an invoice.reminder webhook now", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/refund-requests": { get: { operationId: "listRefundRequests", summary: "Customer refund requests", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/refund-requests/{id}/reject": { post: { operationId: "rejectRefundRequest", summary: "Reject a refund request", security: secured, parameters: [id("id")],
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } }, responses: { 200: json({ type: "object" }), default: err } } },
    "/subscriptions": { get: { operationId: "listSubscriptions", summary: "Subscriptions (indexed from chain)", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/exceptions": { get: { operationId: "listExceptions", summary: "Funds received outside WhitePay (direct transfers, wrong token)", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/ledger": { get: { operationId: "listLedger", summary: "Double-entry ledger lines (latest 500)", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/reconcile": { get: { operationId: "reconcile", summary: "Re-derive totals from chain logs and compare with the ledger", security: secured, responses: { 200: json({ type: "object", properties: { ok: { type: "boolean" } } }), default: err } } },
    "/webhooks": { get: { operationId: "listWebhookDeliveries", summary: "Webhook delivery log", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/webhooks/{id}/replay": { post: { operationId: "replayWebhook", summary: "Re-deliver a webhook", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/plans": { get: { operationId: "listPlans", summary: "Public price list (active plans). ?merchant=<on-chain id>", security: pub,
      parameters: [{ name: "merchant", in: "query", schema: { type: "integer" } }], responses: { 200: json({ type: "array", items: { type: "object" } }) } } },
    "/plans/all": { get: { operationId: "listAllPlans", summary: "All of this merchant's plans incl. retired", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/plans/{id}/name": { post: { operationId: "namePlan", summary: "Set a plan's display name (off-chain)", security: secured, parameters: [id("id")],
      requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } }, responses: { 200: json({ type: "object" }), default: err } } },
    "/subscriptions/metrics": { get: { operationId: "subscriptionMetrics", summary: "MRR, ARR, status counts, 30-day churn, failed-payment recovery", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/customers/{address}/subscriptions": { get: { operationId: "customerSubscriptions", summary: "A wallet's own subscriptions (public; on-chain data)", security: pub, parameters: [id("address")], responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/notifications": { get: { operationId: "listNotifications", summary: "Notification outbox (email, WhatsApp, Slack, Telegram)", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/notifications/{id}/retry": { post: { operationId: "retryNotification", summary: "Retry a failed notification", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/merchants/me": {
      get: { operationId: "getMerchant", summary: "This API key's merchant (status, on-chain id, owner, payout, branding; nextStep while pending)", security: secured, responses: { 200: json({ type: "object" }), default: err } },
      post: { operationId: "updateMerchant", summary: "Update branding, webhook URL and notification destinations", security: secured,
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, color: { type: "string" }, taxId: { type: "string" }, address: { type: "string" }, webhookUrl: { type: "string" },
          notify: { type: "object", properties: { slackWebhookUrl: { type: "string" }, telegramChatId: { type: "string" }, whatsappTo: { type: "string" }, email: { type: "string" } } } } } } } },
        responses: { 200: json({ type: "object" }), default: err } },
    },
    "/merchants/me/rotate-key": { post: { operationId: "rotateApiKey", summary: "Issue a new API key; the old one stops working immediately", security: secured, responses: { 200: json({ type: "object", properties: { apiKey: { type: "string" } } }), default: err } } },
    "/platform/merchants": {
      post: { operationId: "createMerchant", summary: "Platform: onboard a merchant (returns API key, webhook secret and signer ONCE)", security: [{ platform: [] }],
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, color: { type: "string" }, webhookUrl: { type: "string" }, mode: { type: "string", enum: ["test", "live"] } } } } } },
        responses: { 201: json({ type: "object" }, "Created"), default: err } },
      get: { operationId: "listMerchants", summary: "Platform: list merchants", security: [{ platform: [] }], responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } },
    },
    "/subscriptions/{id}/refund-quote": { get: { operationId: "getSubscriptionRefundQuote", summary: "Suggested refund for the unused part of the current period, and the most that can still be refunded. The merchant wallet executes it with refundSubscription()", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/splitters/{address}": { get: { operationId: "getSplitter", summary: "Public: a PayoutSplitter's rules, held balance and whether it is a merchant's payout wallet (read from the chain)", security: [], parameters: [id("address")], responses: { 200: json({ type: "object" }), default: err } } },
    "/splitter-artifact": { get: { operationId: "getSplitterArtifact", summary: "Public: compiled PayoutSplitter (ABI + bytecode) and the platform's suggested fee", security: [], responses: { 200: json({ type: "object" }), default: err } } },
    "/saas/plans": { get: { operationId: "listSaasPlans", summary: "Public: plans, prices, limits, and whether signup is open", security: [], responses: { 200: json({ type: "object" }), default: err } } },
    "/saas/usage": { get: { operationId: "getSaasUsage", summary: "This account's plan, limits and usage for the current month", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/saas/upgrade": { post: { operationId: "upgradePlan", summary: "Buy or renew a plan in USDT; returns a checkout and the plan activates once the payment is final", security: secured,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["plan"], properties: { plan: { type: "string" }, months: { type: "integer", minimum: 1, maximum: 12 } } } } } },
      responses: { 201: json({ type: "object" }, "Created"), default: err } } },
    "/platform/overview": { get: { operationId: "platformOverview", summary: "Platform: tenants by plan, MRR, volume this month", security: [{ platform: [] }], responses: { 200: json({ type: "object" }), default: err } } },
    "/platform/tenants": { get: { operationId: "platformTenants", summary: "Platform: tenants with plan, status and usage", security: [{ platform: [] }], responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/platform/tenants/{uid}/suspend": { post: { operationId: "suspendTenant", summary: "Platform: make a tenant read-only (payments in flight keep being processed)", security: [{ platform: [] }], parameters: [id("uid")], responses: { 200: json({ type: "object" }), default: err } } },
    "/platform/tenants/{uid}/resume": { post: { operationId: "resumeTenant", summary: "Platform: lift a suspension", security: [{ platform: [] }], parameters: [id("uid")], responses: { 200: json({ type: "object" }), default: err } } },
    "/platform/tenants/{uid}/plan": { post: { operationId: "setTenantPlan", summary: "Platform: grant a plan without payment", security: [{ platform: [] }], parameters: [id("uid")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["plan"], properties: { plan: { type: "string" }, days: { type: "integer" } } } } } }, responses: { 200: json({ type: "object" }), default: err } } },
    "/recurring-invoices": {
      get: { operationId: "listRecurringInvoices", summary: "Recurring invoice schedules", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } },
      post: { operationId: "createRecurringInvoice", summary: "Create a schedule: a validated invoice template plus weekly | monthly | quarterly | yearly", security: secured,
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["frequency", "template"], properties: { frequency: { type: "string", enum: ["weekly", "monthly", "quarterly", "yearly"] }, every: { type: "integer" }, startDate: { type: "integer" }, endDate: { type: "integer" }, maxRuns: { type: "integer" }, template: { type: "object", description: "Same fields as POST /invoices" } } } } } },
        responses: { 201: json({ type: "object" }), default: err } } },
    "/recurring-invoices/{id}/pause": { post: { operationId: "pauseRecurringInvoice", summary: "Pause a schedule", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/recurring-invoices/{id}/resume": { post: { operationId: "resumeRecurringInvoice", summary: "Resume a schedule (skips missed periods instead of back-billing)", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/recurring-invoices/{id}/cancel": { post: { operationId: "cancelRecurringInvoice", summary: "Cancel a schedule", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/invoices/{id}/credit-notes": { post: { operationId: "createCreditNote", summary: "Issue a credit note that reduces what the client owes", security: secured, parameters: [id("id")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "number" }, reason: { type: "string", enum: ["adjustment", "returned_goods", "pricing_error", "goodwill", "cancelled_service", "other"] }, note: { type: "string" } } } } } },
      responses: { 201: json({ type: "object" }), default: err } } },
    "/credit-notes": { get: { operationId: "listCreditNotes", summary: "Credit notes", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/statements": { get: { operationId: "getStatement", summary: "Statement for a period: json, xlsx, pdf, csv, or a Xero / QuickBooks journal file", security: secured,
      parameters: [{ name: "from", in: "query", schema: { type: "integer" } }, { name: "to", in: "query", schema: { type: "integer" } }, { name: "format", in: "query", schema: { type: "string", enum: ["json", "xlsx", "pdf", "csv", "xero", "quickbooks"] } }],
      responses: { 200: { description: "OK (JSON or a file)" }, default: err } } },
    "/periods": { get: { operationId: "listPeriods", summary: "Closed accounting periods, with drift detection", security: secured, responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/periods/close": { post: { operationId: "closePeriod", summary: "Close an ended period: snapshot hash, and back-dated documents into it are refused", security: secured,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["from", "to"], properties: { from: { type: "integer" }, to: { type: "integer" }, label: { type: "string" } } } } } }, responses: { 201: json({ type: "object" }), default: err } } },
    "/periods/{id}/reopen": { post: { operationId: "reopenPeriod", summary: "Reopen a closed period (a reason is required and recorded)", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/auditor-key": { post: { operationId: "createAuditorKey", summary: "Issue a read-only auditor key (shown once; replaces any previous one)", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/auditor-key/revoke": { post: { operationId: "revokeAuditorKey", summary: "Revoke the auditor key", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/events": { get: { operationId: "listEvents", summary: "Webhook events as a pollable feed (used by `whitepay listen`)", security: secured, parameters: [{ name: "after_id", in: "query", schema: { type: "integer" } }], responses: { 200: json({ type: "array", items: { type: "object" } }), default: err } } },
    "/webhook-secret": { get: { operationId: "getWebhookSecret", summary: "Your webhook signing secret (not available to the auditor key)", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/test-clock": { get: { operationId: "getTestClock", summary: "Test clock state (local development chain only)", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/test-clock/advance": { post: { operationId: "advanceTestClock", summary: "Move the server and local-chain clocks forward (seconds or days)", security: secured, responses: { 200: json({ type: "object" }), default: err } } },
    "/meters/{id}": { get: { operationId: "getMeter", summary: "A seat/usage meter the payer opened for this merchant", security: secured, parameters: [id("id")], responses: { 200: json({ type: "object" }), default: err } } },
    "/meters/{id}/usage": { post: { operationId: "reportUsage", summary: "Report usage; the contract charges the payer's own unit price within their budget. reportId makes it idempotent", security: secured, parameters: [id("id")],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["units", "reportId"], properties: { units: { type: "integer" }, reportId: { type: "string" } } } } } }, responses: { 201: json({ type: "object" }), default: err } } },
    "/extensions": { get: { operationId: "getExtensions", summary: "Optional contracts in this deployment (agent policies, metering)", security: pub, responses: { 200: json({ type: "object" }), default: err } } },
    "/agents/policy": { get: { operationId: "getAgentPolicy", summary: "An owner's spending policy for an agent address (public on-chain data)", security: pub,
      parameters: [{ name: "owner", in: "query", required: true, schema: { type: "string" } }, { name: "agent", in: "query", required: true, schema: { type: "string" } }], responses: { 200: json({ type: "object" }), default: err } } },
    "/x402/demo": { get: { operationId: "x402Demo", summary: "Example HTTP 402 paywall: answers 402 with a signed WhitePay quote until paid (X-PAYMENT header)", security: pub, responses: { 200: json({ type: "object" }), 402: json({ type: "object" }, "Payment required"), default: err } } },
    "/status": { get: { operationId: "getStatus", summary: "Indexer, RPC and sequencer health", security: pub, responses: { 200: json({ type: "object" }) } } },
  },
  webhooks: {
    event: { post: { summary: "Every event (payment.*, invoice.*, refund_request.*, subscription.*, exception.*, merchant.*)", requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } }, responses: { 200: { description: "Acknowledge with any 2xx" } } } },
  },
};

fs.writeFileSync(path.join(__dirname, "../docs/openapi.json"), JSON.stringify(spec, null, 2) + "\n");
console.log("wrote docs/openapi.json:", Object.keys(spec.paths).length, "paths");
