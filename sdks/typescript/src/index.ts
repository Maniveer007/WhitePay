// WhitePay TypeScript SDK. Zero dependencies (fetch + node:crypto). Mirrors public/openapi.json.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface ClientOptions {
  baseUrl?: string;   // default http://localhost:3000/api/v1
  timeoutMs?: number; // default 15000
  maxRetries?: number; // network errors, 429 and 5xx; default 2
}
export interface CreatePaymentParams {
  amount: number; currency?: "USD" | "EUR" | "INR" | "GBP" | "USDT"; orderRef?: string; description?: string;
  policy?: "seen" | "safe" | "finalized" | "auto"; ttl?: number;
}
export interface Payment {
  id: string; intentId: string; status: string; finality: string; fulfillable: boolean; policy: string;
  amount: string; refunded: string; token: string; fiatAmount: number; currency: string; orderRef: string | null;
  description: string | null; expiry: number; payer: string | null; txHash: string | null; checkoutUrl?: string;
  [k: string]: unknown;
}
export interface InvoiceItem { description: string; qty?: number; unitPrice: number; taxPercent?: number }
export interface CreateInvoiceParams {
  clientName: string; items: InvoiceItem[]; clientEmail?: string; clientTaxId?: string; poRef?: string;
  currency?: "USD" | "EUR" | "INR" | "GBP" | "USDT"; terms?: "due_on_receipt" | "net_15" | "net_30" | "net_60";
  dueDate?: number; allowPartial?: boolean; minPartial?: number; lateFeePercent?: number;
  earlyDiscountPercent?: number; earlyDiscountDays?: number; notes?: string; draft?: boolean;
}
export interface Invoice { id: string; number: string; status: string; currency: string; total: number; paid: number; balance: number; [k: string]: unknown }
export interface CreateCreditNoteParams { amount: number; reason?: "adjustment" | "returned_goods" | "pricing_error" | "goodwill" | "cancelled_service" | "other"; note?: string }
export interface CreateRecurringInvoiceParams {
  frequency: "weekly" | "monthly" | "quarterly" | "yearly"; template: CreateInvoiceParams; every?: number; startDate?: number; endDate?: number; maxRuns?: number;
}
export type Obj = Record<string, unknown>;
export interface Page<T> { data: T[]; hasMore: boolean; nextCursor: string | null }
export interface WebhookEvent { id: string; type: string; created: number; data: Record<string, unknown> }

/** Every API error. `code` is stable and machine-readable (see openapi.json). */
export class WhitePayError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "WhitePayError"; this.status = status; this.code = code; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WhitePay {
  private apiKey: string; private baseUrl: string; private timeoutMs: number; private maxRetries: number;
  constructor(apiKey: string, opts: ClientOptions = {}) {
    if (!apiKey) throw new Error("apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000/api/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  /** Low-level request with retries. POSTs always carry an Idempotency-Key, so a retry can never double-charge. */
  async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<{ data: T; headers: Headers }> {
    const key = method === "POST" ? idempotencyKey ?? randomUUID() : undefined;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, {
          method, signal: AbortSignal.timeout(this.timeoutMs),
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (attempt < this.maxRetries) { await sleep(250 * 2 ** attempt); continue; }
        throw new WhitePayError(0, "network_error", (e as Error).message);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) { await sleep(250 * 2 ** attempt); continue; }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new WhitePayError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? res.statusText);
      return { data: json as T, headers: res.headers };
    }
  }
  private async page<T>(path: string, p: { limit?: number; startingAfter?: string } = {}): Promise<Page<T>> {
    const q = new URLSearchParams();
    if (p.limit) q.set("limit", String(p.limit));
    if (p.startingAfter) q.set("starting_after", p.startingAfter);
    const { data, headers } = await this.request<T[]>("GET", path + (q.size ? "?" + q : ""));
    return { data, hasMore: headers.get("whitepay-has-more") === "true", nextCursor: headers.get("whitepay-next-cursor") };
  }
  private async get<T>(path: string) { return (await this.request<T>("GET", path)).data; }
  private async post<T>(path: string, body?: unknown, idem?: string) { return (await this.request<T>("POST", path, body ?? {}, idem)).data; }
  private enc = (s: string) => encodeURIComponent(s);

  payments = {
    create: (p: CreatePaymentParams, o: { idempotencyKey?: string } = {}) => this.post<Payment>("/payments", p, o.idempotencyKey),
    get: (id: string) => this.get<Payment>(`/payments/${this.enc(id)}`),
    list: (p?: { limit?: number; startingAfter?: string }) => this.page<Payment>("/payments", p),
    requote: (id: string) => this.post<Payment>(`/payments/${this.enc(id)}/requote`),
  };
  invoices = {
    create: (p: CreateInvoiceParams, o: { idempotencyKey?: string } = {}) => this.post<Invoice>("/invoices", p, o.idempotencyKey),
    get: (id: string) => this.get<Invoice>(`/invoices/${this.enc(id)}`),
    list: (p?: { limit?: number; startingAfter?: string }) => this.page<Invoice>("/invoices", p),
    pay: (id: string, p: { full?: boolean; amount?: number } = { full: true }) => this.post<{ checkoutUrl: string; amount: number; discount: number }>(`/invoices/${this.enc(id)}/pay`, p),
    void: (id: string) => this.post<Invoice>(`/invoices/${this.enc(id)}/void`),
    remind: (id: string) => this.post<{ ok: boolean }>(`/invoices/${this.enc(id)}/remind`),
    aging: () => this.get<Record<string, Record<string, number>>>("/invoices/aging"),
  };
  refundRequests = {
    list: () => this.get<Record<string, unknown>[]>("/refund-requests"),
    reject: (id: number | string, note = "") => this.post<{ ok: boolean }>(`/refund-requests/${id}/reject`, { note }),
  };
  subscriptions = { list: () => this.get<Record<string, unknown>[]>("/subscriptions") };
  exceptions = { list: () => this.get<Record<string, unknown>[]>("/exceptions") };
  webhooks = {
    list: () => this.get<Record<string, unknown>[]>("/webhooks"),
    replay: (id: number | string) => this.post<{ ok: boolean }>(`/webhooks/${id}/replay`),
  };
  creditNotes = {
    create: (invoiceId: string, p: CreateCreditNoteParams) => this.post<Obj>(`/invoices/${this.enc(invoiceId)}/credit-notes`, p),
    list: () => this.get<Obj[]>("/credit-notes"),
  };
  recurringInvoices = {
    create: (p: CreateRecurringInvoiceParams) => this.post<Obj>("/recurring-invoices", p),
    list: () => this.get<Obj[]>("/recurring-invoices"),
    pause: (id: string) => this.post<Obj>(`/recurring-invoices/${this.enc(id)}/pause`),
    resume: (id: string) => this.post<Obj>(`/recurring-invoices/${this.enc(id)}/resume`),
    cancel: (id: string) => this.post<Obj>(`/recurring-invoices/${this.enc(id)}/cancel`),
  };
  /** JSON statement for [from, to) (unix seconds). Excel/PDF/CSV/Xero/QuickBooks files are downloaded from the same endpoint with ?format=. */
  statements = { get: (p: { from?: number; to?: number } = {}) => this.get<Obj>(`/statements?format=json${p.from ? "&from=" + p.from : ""}${p.to ? "&to=" + p.to : ""}`) };
  periods = {
    list: () => this.get<Obj[]>("/periods"),
    close: (p: { from: number; to: number; label?: string }) => this.post<Obj>("/periods/close", p),
    reopen: (id: number | string, reason: string) => this.post<Obj>(`/periods/${id}/reopen`, { reason }),
  };
  /** Read-only key for an auditor. The new key is shown once. */
  auditorKey = { create: () => this.post<{ auditorKey: string }>("/auditor-key"), revoke: () => this.post<{ ok: boolean }>("/auditor-key/revoke") };
  meters = {
    get: (id: number | string) => this.get<Obj>(`/meters/${id}`),
    /** reportId is your idempotency key: the same id is billed once. */
    reportUsage: (id: number | string, units: number, reportId: string) => this.post<{ ok: boolean; txHash: string }>(`/meters/${id}/usage`, { units, reportId }),
  };
  agents = { policy: (owner: string, agent: string) => this.get<Obj>(`/agents/policy?owner=${this.enc(owner)}&agent=${this.enc(agent)}`) };
  /** Test clock (local development chain only). */
  testClock = { get: () => this.get<Obj>("/test-clock"), advance: (p: { seconds?: number; days?: number }) => this.post<Obj>("/test-clock/advance", p) };
  ledger = () => this.get<Record<string, unknown>[]>("/ledger");
  reconcile = () => this.get<{ ok: boolean; chain: Record<string, string>; ledger: Record<string, string> }>("/reconcile");
  status = () => this.get<Record<string, unknown>>("/status");
}

/**
 * Verify an `X-WhitePay-Signature` header against the RAW request body (bytes as received, not re-serialized JSON).
 * Returns the parsed event, or throws WhitePayError("invalid_signature"). Accepts any matching v1 (secret rotation).
 */
export function verifyWebhook(rawBody: string | Uint8Array, header: string, secret: string, opts: { toleranceSec?: number; now?: number } = {}): WebhookEvent {
  const tol = opts.toleranceSec ?? 300, now = opts.now ?? Math.floor(Date.now() / 1000);
  const parts = String(header || "").split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const bad = (m: string) => new WhitePayError(400, "invalid_signature", m);
  if (!Number.isFinite(t)) throw bad("Missing timestamp");
  if (Math.abs(now - t) > tol) throw bad("Timestamp outside tolerance");
  const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const ok = parts.some(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "") && timingSafeEqual(Buffer.from(v, "hex"), expected));
  if (!ok) throw bad("No matching signature");
  return JSON.parse(body) as WebhookEvent;
}
