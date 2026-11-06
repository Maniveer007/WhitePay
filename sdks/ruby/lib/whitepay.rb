# WhitePay Ruby SDK. Standard library only. Mirrors public/openapi.json.
require "json"
require "net/http"
require "openssl"
require "securerandom"
require "uri"

module WhitePay
  # Every API error. `code` is stable and machine-readable.
  class Error < StandardError
    attr_reader :status, :code
    def initialize(status, code, message)
      super(message)
      @status, @code = status, code
    end
  end

  # An Array of results plus pagination info.
  class Page < Array
    attr_reader :has_more, :next_cursor
    def initialize(items, has_more, next_cursor)
      super(items)
      @has_more, @next_cursor = has_more, next_cursor
    end
  end

  class Client
    def initialize(api_key, base_url: "http://localhost:3000/api/v1", timeout: 15, max_retries: 2)
      raise ArgumentError, "api_key is required" if api_key.to_s.empty?
      @key, @base, @timeout, @retries = api_key, base_url.chomp("/"), timeout, max_retries
    end

    # ── Payments ──
    def create_payment(params, idempotency_key: nil) post("/payments", params, idempotency_key) end
    def get_payment(id) get("/payments/#{esc(id)}") end
    def list_payments(limit: nil, starting_after: nil) page("/payments", limit, starting_after) end
    def requote_payment(id) post("/payments/#{esc(id)}/requote", {}) end

    # ── Invoices ──  params use the API's camelCase names, e.g. clientName:, items: [{description:, unitPrice:, taxPercent:}]
    def create_invoice(params, idempotency_key: nil) post("/invoices", params, idempotency_key) end
    def get_invoice(id) get("/invoices/#{esc(id)}") end
    def list_invoices(limit: nil, starting_after: nil) page("/invoices", limit, starting_after) end
    def pay_invoice(id, amount: nil) post("/invoices/#{esc(id)}/pay", amount ? { amount: amount } : { full: true }) end
    def void_invoice(id) post("/invoices/#{esc(id)}/void", {}) end
    def remind_invoice(id) post("/invoices/#{esc(id)}/remind", {}) end
    def invoice_aging() get("/invoices/aging") end

    # ── Operations ──
    def refund_requests() get("/refund-requests") end
    def reject_refund_request(id, note: "") post("/refund-requests/#{id}/reject", { note: note }) end
    def subscriptions() get("/subscriptions") end
    def exceptions() get("/exceptions") end
    def webhook_deliveries() get("/webhooks") end
    def replay_webhook(id) post("/webhooks/#{id}/replay", {}) end
    # ── Credit notes, recurring invoices, finance, meters, agents, test clock ──
    def create_credit_note(invoice_id, amount:, reason: "adjustment", note: nil) post("/invoices/#{esc(invoice_id)}/credit-notes", { amount: amount, reason: reason, note: note }.compact) end
    def credit_notes() get("/credit-notes") end
    # params: frequency: ("weekly"|"monthly"|"quarterly"|"yearly"), template: {same fields as create_invoice}, every:, startDate:, endDate:, maxRuns:
    def create_recurring_invoice(params) post("/recurring-invoices", params) end
    def recurring_invoices() get("/recurring-invoices") end
    def pause_recurring_invoice(id) post("/recurring-invoices/#{esc(id)}/pause", {}) end
    def resume_recurring_invoice(id) post("/recurring-invoices/#{esc(id)}/resume", {}) end
    def cancel_recurring_invoice(id) post("/recurring-invoices/#{esc(id)}/cancel", {}) end
    # JSON statement for [from, to) in unix seconds. Excel/PDF/CSV/Xero/QuickBooks files use the same endpoint with ?format=.
    def statement(from: nil, to: nil) get("/statements?format=json#{from ? "&from=#{from}" : ""}#{to ? "&to=#{to}" : ""}") end
    def periods() get("/periods") end
    def close_period(from:, to:, label: nil) post("/periods/close", { from: from, to: to, label: label }.compact) end
    def reopen_period(id, reason:) post("/periods/#{id}/reopen", { reason: reason }) end
    # Read-only key for an auditor; the new key is shown once.
    def create_auditor_key() post("/auditor-key", {}) end
    def revoke_auditor_key() post("/auditor-key/revoke", {}) end
    def meter(id) get("/meters/#{id}") end
    # report_id is your idempotency key: the same id is billed once.
    def report_usage(meter_id, units:, report_id:) post("/meters/#{meter_id}/usage", { units: units, reportId: report_id }) end
    def agent_policy(owner, agent) get("/agents/policy?owner=#{esc(owner)}&agent=#{esc(agent)}") end
    # Test clock: local development chain only.
    def test_clock() get("/test-clock") end
    def advance_test_clock(seconds: nil, days: nil) post("/test-clock/advance", seconds ? { seconds: seconds } : { days: days }) end
    def ledger() get("/ledger") end
    def reconcile() get("/reconcile") end
    def status() get("/status") end

    # Low-level request with retries. POSTs always carry an Idempotency-Key so retries can't double-charge.
    def request(method, path, body = nil, idempotency_key = nil)
      uri = URI(@base + path)
      key = method == :post ? (idempotency_key || SecureRandom.uuid) : nil
      attempt = 0
      begin
        req = (method == :post ? Net::HTTP::Post : Net::HTTP::Get).new(uri)
        req["Authorization"] = "Bearer #{@key}"
        req["Content-Type"] = "application/json"
        req["User-Agent"] = "whitepay-ruby/0.1.0"
        req["Idempotency-Key"] = key if key
        req.body = JSON.generate(body) if body
        res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: @timeout, read_timeout: @timeout) { |h| h.request(req) }
        code = res.code.to_i
        if (code == 429 || code >= 500) && attempt < @retries
          attempt += 1; sleep(0.25 * 2**attempt); return request(method, path, body, key)
        end
        data = res.body.to_s.empty? ? nil : JSON.parse(res.body)
        unless code < 300
          e = (data.is_a?(Hash) && data["error"]) || {}
          raise Error.new(code, e["code"] || "http_error", e["message"] || res.message)
        end
        [data, res]
      rescue SocketError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout => e
        if attempt < @retries
          attempt += 1; sleep(0.25 * 2**attempt); retry
        end
        raise Error.new(0, "network_error", e.message)
      end
    end

    private

    def get(path) request(:get, path)[0] end
    def post(path, body, idem = nil) request(:post, path, body, idem)[0] end
    def esc(s) URI.encode_www_form_component(s.to_s) end
    def page(path, limit, starting_after)
      q = URI.encode_www_form({ limit: limit, starting_after: starting_after }.reject { |_, v| v.nil? })
      data, res = request(:get, q.empty? ? path : "#{path}?#{q}")
      Page.new(data, res["WhitePay-Has-More"] == "true", res["WhitePay-Next-Cursor"])
    end
  end

  # Constant-time string comparison (OpenSSL.fixed_length_secure_compare needs Ruby 2.7+).
  def self.secure_compare(a, b)
    return false unless a.bytesize == b.bytesize
    diff = 0
    a.bytes.zip(b.bytes) { |x, y| diff |= x ^ y }
    diff.zero?
  end

  # Verify X-WhitePay-Signature against the RAW body (bytes as received). Returns the event Hash or raises WhitePay::Error.
  def self.verify_webhook(raw_body, header, secret, tolerance: 300, now: Time.now.to_i)
    parts = header.to_s.split(",").map { |p| p.strip.split("=", 2) }.select { |kv| kv.size == 2 }
    ts = parts.find { |k, _| k == "t" }&.last
    raise Error.new(400, "invalid_signature", "Missing timestamp") unless ts&.match?(/\A\d+\z/)
    raise Error.new(400, "invalid_signature", "Timestamp outside tolerance") if (now - ts.to_i).abs > tolerance
    expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{ts}.#{raw_body}")
    ok = parts.any? { |k, v| k == "v1" && secure_compare(v, expected) }
    raise Error.new(400, "invalid_signature", "No matching signature") unless ok
    JSON.parse(raw_body)
  end
end
