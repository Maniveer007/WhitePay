"""WhitePay Python SDK. Standard library only. Mirrors public/openapi.json."""
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

__all__ = ["WhitePay", "WhitePayError", "verify_webhook", "Page"]


class WhitePayError(Exception):
    """Every API error. `code` is stable and machine-readable."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

    def __repr__(self):
        return f"WhitePayError(status={self.status}, code={self.code!r}, message={self.message!r})"


class Page(list):
    """A list of results plus pagination info."""

    def __init__(self, items, has_more, next_cursor):
        super().__init__(items)
        self.has_more, self.next_cursor = has_more, next_cursor


class _Resource:
    def __init__(self, client):
        self._c = client


class _Payments(_Resource):
    def create(self, amount, currency="USD", idempotency_key=None, **kw):
        return self._c._post("/payments", {"amount": amount, "currency": currency, **kw}, idempotency_key)

    def get(self, payment_id):
        return self._c._get(f"/payments/{_q(payment_id)}")

    def list(self, limit=None, starting_after=None):
        return self._c._page("/payments", limit, starting_after)

    def requote(self, payment_id):
        return self._c._post(f"/payments/{_q(payment_id)}/requote", {})


class _Invoices(_Resource):
    def create(self, client_name, items, idempotency_key=None, **kw):
        """items: [{"description", "qty", "unitPrice", "taxPercent"}]; extra fields are the camelCase API names."""
        return self._c._post("/invoices", {"clientName": client_name, "items": items, **kw}, idempotency_key)

    def get(self, invoice_id):
        return self._c._get(f"/invoices/{_q(invoice_id)}")

    def list(self, limit=None, starting_after=None):
        return self._c._page("/invoices", limit, starting_after)

    def pay(self, invoice_id, amount=None):
        return self._c._post(f"/invoices/{_q(invoice_id)}/pay", {"amount": amount} if amount else {"full": True})

    def void(self, invoice_id):
        return self._c._post(f"/invoices/{_q(invoice_id)}/void", {})

    def remind(self, invoice_id):
        return self._c._post(f"/invoices/{_q(invoice_id)}/remind", {})

    def aging(self):
        return self._c._get("/invoices/aging")


class _RefundRequests(_Resource):
    def list(self):
        return self._c._get("/refund-requests")

    def reject(self, request_id, note=""):
        return self._c._post(f"/refund-requests/{request_id}/reject", {"note": note})


class _Webhooks(_Resource):
    def list(self):
        return self._c._get("/webhooks")

    def replay(self, delivery_id):
        return self._c._post(f"/webhooks/{delivery_id}/replay", {})


class _CreditNotes(_Resource):
    def create(self, invoice_id, amount, reason="adjustment", note=None):
        return self._c._post(f"/invoices/{_q(invoice_id)}/credit-notes", {"amount": amount, "reason": reason, **({"note": note} if note else {})})

    def list(self):
        return self._c._get("/credit-notes")


class _RecurringInvoices(_Resource):
    def create(self, frequency, template, every=1, **kw):
        """template: the same fields as invoices.create. kw: startDate, endDate, maxRuns."""
        return self._c._post("/recurring-invoices", {"frequency": frequency, "template": template, "every": every, **kw})

    def list(self):
        return self._c._get("/recurring-invoices")

    def pause(self, schedule_id):
        return self._c._post(f"/recurring-invoices/{_q(schedule_id)}/pause", {})

    def resume(self, schedule_id):
        return self._c._post(f"/recurring-invoices/{_q(schedule_id)}/resume", {})

    def cancel(self, schedule_id):
        return self._c._post(f"/recurring-invoices/{_q(schedule_id)}/cancel", {})


class _Statements(_Resource):
    def get(self, from_ts=None, to_ts=None):
        """JSON statement for [from, to) in unix seconds. Excel/PDF/CSV/Xero/QuickBooks files use the same endpoint with ?format=."""
        q = "".join(f"&{k}={v}" for k, v in (("from", from_ts), ("to", to_ts)) if v)
        return self._c._get("/statements?format=json" + q)


class _Periods(_Resource):
    def list(self):
        return self._c._get("/periods")

    def close(self, from_ts, to_ts, label=None):
        return self._c._post("/periods/close", {"from": from_ts, "to": to_ts, **({"label": label} if label else {})})

    def reopen(self, period_id, reason):
        return self._c._post(f"/periods/{period_id}/reopen", {"reason": reason})


class _AuditorKey(_Resource):
    def create(self):
        """Read-only key for an auditor. The new key is shown once."""
        return self._c._post("/auditor-key", {})

    def revoke(self):
        return self._c._post("/auditor-key/revoke", {})


class _Meters(_Resource):
    def get(self, meter_id):
        return self._c._get(f"/meters/{meter_id}")

    def report_usage(self, meter_id, units, report_id):
        """report_id is your idempotency key: the same id is billed once."""
        return self._c._post(f"/meters/{meter_id}/usage", {"units": units, "reportId": report_id})


class _Agents(_Resource):
    def policy(self, owner, agent):
        return self._c._get(f"/agents/policy?owner={_q(owner)}&agent={_q(agent)}")


class _TestClock(_Resource):
    """Local development chain only."""

    def get(self):
        return self._c._get("/test-clock")

    def advance(self, seconds=None, days=None):
        return self._c._post("/test-clock/advance", {"seconds": seconds} if seconds else {"days": days})


def _q(s):
    return urllib.parse.quote(str(s), safe="")


class WhitePay:
    def __init__(self, api_key, base_url="http://localhost:3000/api/v1", timeout=15, max_retries=2):
        if not api_key:
            raise ValueError("api_key is required")
        self._key, self._base, self._timeout, self._retries = api_key, base_url.rstrip("/"), timeout, max_retries
        self.payments, self.invoices = _Payments(self), _Invoices(self)
        self.refund_requests, self.webhooks = _RefundRequests(self), _Webhooks(self)
        self.credit_notes, self.recurring_invoices, self.statements = _CreditNotes(self), _RecurringInvoices(self), _Statements(self)
        self.periods, self.auditor_key, self.meters = _Periods(self), _AuditorKey(self), _Meters(self)
        self.agents, self.test_clock = _Agents(self), _TestClock(self)

    def subscriptions(self):
        return self._get("/subscriptions")

    def exceptions(self):
        return self._get("/exceptions")

    def ledger(self):
        return self._get("/ledger")

    def reconcile(self):
        return self._get("/reconcile")

    def status(self):
        return self._get("/status")

    # ── transport ──
    def request(self, method, path, body=None, idempotency_key=None):
        """Returns (data, headers). POSTs always send an Idempotency-Key, so retries can't double-charge."""
        headers = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json", "User-Agent": "whitepay-python/0.1.0"}
        if method == "POST":
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        data = None if body is None else json.dumps(body).encode()
        for attempt in range(self._retries + 1):
            req = urllib.request.Request(self._base + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as r:
                    return json.loads(r.read() or b"null"), dict(r.headers)
            except urllib.error.HTTPError as e:
                if (e.code == 429 or e.code >= 500) and attempt < self._retries:
                    time.sleep(0.25 * 2 ** attempt)
                    continue
                try:
                    err = json.loads(e.read()).get("error", {})
                except Exception:
                    err = {}
                raise WhitePayError(e.code, err.get("code", "http_error"), err.get("message", str(e))) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self._retries:
                    time.sleep(0.25 * 2 ** attempt)
                    continue
                raise WhitePayError(0, "network_error", str(e)) from None

    def _get(self, path):
        return self.request("GET", path)[0]

    def _post(self, path, body, idempotency_key=None):
        return self.request("POST", path, body, idempotency_key)[0]

    def _page(self, path, limit, starting_after):
        q = {k: v for k, v in {"limit": limit, "starting_after": starting_after}.items() if v}
        data, h = self.request("GET", path + ("?" + urllib.parse.urlencode(q) if q else ""))
        h = {k.lower(): v for k, v in h.items()}
        return Page(data, h.get("whitepay-has-more") == "true", h.get("whitepay-next-cursor"))


def verify_webhook(raw_body, header, secret, tolerance=300, now=None):
    """Verify X-WhitePay-Signature against the RAW body (bytes as received). Returns the event dict or raises WhitePayError."""
    now = int(time.time()) if now is None else now
    parts = [p.strip().split("=", 1) for p in str(header or "").split(",") if "=" in p]
    ts = next((v for k, v in parts if k == "t"), None)
    if ts is None or not ts.isdigit():
        raise WhitePayError(400, "invalid_signature", "Missing timestamp")
    if abs(now - int(ts)) > tolerance:
        raise WhitePayError(400, "invalid_signature", "Timestamp outside tolerance")
    body = raw_body.decode() if isinstance(raw_body, (bytes, bytearray)) else raw_body
    expected = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    if not any(k == "v1" and hmac.compare_digest(v, expected) for k, v in parts):
        raise WhitePayError(400, "invalid_signature", "No matching signature")
    return json.loads(body)
