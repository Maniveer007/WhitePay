// Package whitepay is the Go SDK for WhitePay (non-custodial USDT payments on Whitechain).
// Standard library only. Mirrors public/openapi.json.
package whitepay

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Error is every API error. Code is stable and machine-readable.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("whitepay: %d %s: %s", e.Status, e.Code, e.Message)
}

// Client talks to the WhitePay API. Create one with New and reuse it.
type Client struct {
	APIKey     string
	BaseURL    string // default http://localhost:3000/api/v1
	HTTP       *http.Client
	MaxRetries int // network errors, 429 and 5xx; default 2
}

func New(apiKey string) *Client {
	return &Client{APIKey: apiKey, BaseURL: "http://localhost:3000/api/v1", HTTP: &http.Client{Timeout: 15 * time.Second}, MaxRetries: 2}
}

// Object is a decoded JSON object; fields follow openapi.json (e.g. p["id"], p["amount"]).
type Object = map[string]any

// Page is one page of a list plus its cursor.
type Page struct {
	Data       []Object
	HasMore    bool
	NextCursor string
}

type CreatePaymentParams struct {
	Amount      float64 `json:"amount"`
	Currency    string  `json:"currency,omitempty"`
	OrderRef    string  `json:"orderRef,omitempty"`
	Description string  `json:"description,omitempty"`
	Policy      string  `json:"policy,omitempty"`
	TTL         int     `json:"ttl,omitempty"`
}

type InvoiceItem struct {
	Description string  `json:"description"`
	Qty         float64 `json:"qty,omitempty"`
	UnitPrice   float64 `json:"unitPrice"`
	TaxPercent  float64 `json:"taxPercent,omitempty"`
}

type CreateInvoiceParams struct {
	ClientName           string        `json:"clientName"`
	Items                []InvoiceItem `json:"items"`
	ClientEmail          string        `json:"clientEmail,omitempty"`
	ClientTaxID          string        `json:"clientTaxId,omitempty"`
	PORef                string        `json:"poRef,omitempty"`
	Currency             string        `json:"currency,omitempty"`
	Terms                string        `json:"terms,omitempty"`
	DueDate              int64         `json:"dueDate,omitempty"`
	AllowPartial         bool          `json:"allowPartial,omitempty"`
	MinPartial           float64       `json:"minPartial,omitempty"`
	LateFeePercent       float64       `json:"lateFeePercent,omitempty"`
	EarlyDiscountPercent float64       `json:"earlyDiscountPercent,omitempty"`
	EarlyDiscountDays    int           `json:"earlyDiscountDays,omitempty"`
	Notes                string        `json:"notes,omitempty"`
}

func newKey() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Do performs a request with retries. POSTs always carry an Idempotency-Key so retries can't double-charge.
func (c *Client) Do(ctx context.Context, method, path string, body any, idempotencyKey string, out any) (http.Header, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	if method == http.MethodPost && idempotencyKey == "" {
		idempotencyKey = newKey()
	}
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "whitepay-go/0.1.0")
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}
		res, err := c.HTTP.Do(req)
		if err != nil {
			if attempt < c.MaxRetries && ctx.Err() == nil {
				time.Sleep(time.Duration(250<<attempt) * time.Millisecond)
				continue
			}
			return nil, &Error{Code: "network_error", Message: err.Error()}
		}
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if (res.StatusCode == 429 || res.StatusCode >= 500) && attempt < c.MaxRetries {
			time.Sleep(time.Duration(250<<attempt) * time.Millisecond)
			continue
		}
		if res.StatusCode >= 300 {
			var e struct {
				Error struct{ Code, Message string }
			}
			_ = json.Unmarshal(raw, &e)
			if e.Error.Code == "" {
				e.Error.Code, e.Error.Message = "http_error", res.Status
			}
			return res.Header, &Error{Status: res.StatusCode, Code: e.Error.Code, Message: e.Error.Message}
		}
		if out != nil {
			if err := json.Unmarshal(raw, out); err != nil {
				return res.Header, err
			}
		}
		return res.Header, nil
	}
}

func (c *Client) get(ctx context.Context, path string) (Object, error) {
	var o Object
	_, err := c.Do(ctx, http.MethodGet, path, nil, "", &o)
	return o, err
}
func (c *Client) post(ctx context.Context, path string, body any, idem string) (Object, error) {
	if body == nil {
		body = struct{}{}
	}
	var o Object
	_, err := c.Do(ctx, http.MethodPost, path, body, idem, &o)
	return o, err
}
func (c *Client) list(ctx context.Context, path string, limit int, startingAfter string) (*Page, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if startingAfter != "" {
		q.Set("starting_after", startingAfter)
	}
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var items []Object
	h, err := c.Do(ctx, http.MethodGet, path, nil, "", &items)
	if err != nil {
		return nil, err
	}
	return &Page{Data: items, HasMore: h.Get("WhitePay-Has-More") == "true", NextCursor: h.Get("WhitePay-Next-Cursor")}, nil
}
func esc(s string) string { return url.PathEscape(s) }

// Payments
func (c *Client) CreatePayment(ctx context.Context, p CreatePaymentParams, idempotencyKey string) (Object, error) {
	return c.post(ctx, "/payments", p, idempotencyKey)
}
func (c *Client) GetPayment(ctx context.Context, id string) (Object, error) {
	return c.get(ctx, "/payments/"+esc(id))
}
func (c *Client) ListPayments(ctx context.Context, limit int, startingAfter string) (*Page, error) {
	return c.list(ctx, "/payments", limit, startingAfter)
}
func (c *Client) RequotePayment(ctx context.Context, id string) (Object, error) {
	return c.post(ctx, "/payments/"+esc(id)+"/requote", nil, "")
}

// Invoices
func (c *Client) CreateInvoice(ctx context.Context, p CreateInvoiceParams, idempotencyKey string) (Object, error) {
	return c.post(ctx, "/invoices", p, idempotencyKey)
}
func (c *Client) GetInvoice(ctx context.Context, id string) (Object, error) {
	return c.get(ctx, "/invoices/"+esc(id))
}
func (c *Client) ListInvoices(ctx context.Context, limit int, startingAfter string) (*Page, error) {
	return c.list(ctx, "/invoices", limit, startingAfter)
}

// PayInvoice starts a payment toward an invoice: amount 0 means "pay the full balance".
func (c *Client) PayInvoice(ctx context.Context, id string, amount float64) (Object, error) {
	body := map[string]any{"full": true}
	if amount > 0 {
		body = map[string]any{"amount": amount}
	}
	return c.post(ctx, "/invoices/"+esc(id)+"/pay", body, "")
}
func (c *Client) VoidInvoice(ctx context.Context, id string) (Object, error) {
	return c.post(ctx, "/invoices/"+esc(id)+"/void", nil, "")
}
func (c *Client) RemindInvoice(ctx context.Context, id string) (Object, error) {
	return c.post(ctx, "/invoices/"+esc(id)+"/remind", nil, "")
}
func (c *Client) InvoiceAging(ctx context.Context) (Object, error) {
	return c.get(ctx, "/invoices/aging")
}

// Operations
func (c *Client) RejectRefundRequest(ctx context.Context, id int, note string) (Object, error) {
	return c.post(ctx, fmt.Sprintf("/refund-requests/%d/reject", id), map[string]string{"note": note}, "")
}
func (c *Client) Reconcile(ctx context.Context) (Object, error) { return c.get(ctx, "/reconcile") }
func (c *Client) Status(ctx context.Context) (Object, error)    { return c.get(ctx, "/status") }
func (c *Client) ReplayWebhook(ctx context.Context, id int) (Object, error) {
	return c.post(ctx, fmt.Sprintf("/webhooks/%d/replay", id), nil, "")
}

func (c *Client) getList(ctx context.Context, path string) ([]Object, error) {
	var items []Object
	_, err := c.Do(ctx, http.MethodGet, path, nil, "", &items)
	return items, err
}

// Credit notes. amount is in major units (e.g. 30 for 30.00); reason may be empty (defaults to "adjustment").
func (c *Client) CreateCreditNote(ctx context.Context, invoiceID string, amount float64, reason, note string) (Object, error) {
	body := map[string]any{"amount": amount}
	if reason != "" {
		body["reason"] = reason
	}
	if note != "" {
		body["note"] = note
	}
	return c.post(ctx, "/invoices/"+esc(invoiceID)+"/credit-notes", body, "")
}
func (c *Client) ListCreditNotes(ctx context.Context) ([]Object, error) { return c.getList(ctx, "/credit-notes") }

// Recurring invoices. params: frequency (weekly|monthly|quarterly|yearly), template (same fields as CreateInvoice), every, startDate, endDate, maxRuns.
func (c *Client) CreateRecurringInvoice(ctx context.Context, params map[string]any) (Object, error) {
	return c.post(ctx, "/recurring-invoices", params, "")
}
func (c *Client) ListRecurringInvoices(ctx context.Context) ([]Object, error) {
	return c.getList(ctx, "/recurring-invoices")
}
func (c *Client) PauseRecurringInvoice(ctx context.Context, id string) (Object, error) {
	return c.post(ctx, "/recurring-invoices/"+esc(id)+"/pause", nil, "")
}
func (c *Client) ResumeRecurringInvoice(ctx context.Context, id string) (Object, error) {
	return c.post(ctx, "/recurring-invoices/"+esc(id)+"/resume", nil, "")
}
func (c *Client) CancelRecurringInvoice(ctx context.Context, id string) (Object, error) {
	return c.post(ctx, "/recurring-invoices/"+esc(id)+"/cancel", nil, "")
}

// Finance. Statement returns the JSON statement for [from, to) in unix seconds (0 = unbounded). Excel, PDF, CSV and
// Xero/QuickBooks files come from the same endpoint with ?format=.
func (c *Client) Statement(ctx context.Context, from, to int64) (Object, error) {
	path := "/statements?format=json"
	if from > 0 {
		path += "&from=" + strconv.FormatInt(from, 10)
	}
	if to > 0 {
		path += "&to=" + strconv.FormatInt(to, 10)
	}
	return c.get(ctx, path)
}
func (c *Client) ListPeriods(ctx context.Context) ([]Object, error) { return c.getList(ctx, "/periods") }
func (c *Client) ClosePeriod(ctx context.Context, from, to int64, label string) (Object, error) {
	body := map[string]any{"from": from, "to": to}
	if label != "" {
		body["label"] = label
	}
	return c.post(ctx, "/periods/close", body, "")
}
func (c *Client) ReopenPeriod(ctx context.Context, id int, reason string) (Object, error) {
	return c.post(ctx, fmt.Sprintf("/periods/%d/reopen", id), map[string]string{"reason": reason}, "")
}

// CreateAuditorKey issues a read-only key for an auditor (shown once; replaces any previous one).
func (c *Client) CreateAuditorKey(ctx context.Context) (Object, error) { return c.post(ctx, "/auditor-key", nil, "") }
func (c *Client) RevokeAuditorKey(ctx context.Context) (Object, error) {
	return c.post(ctx, "/auditor-key/revoke", nil, "")
}

// Seat and usage meters. reportID is your idempotency key: the same id is billed once.
func (c *Client) GetMeter(ctx context.Context, id int) (Object, error) {
	return c.get(ctx, fmt.Sprintf("/meters/%d", id))
}
func (c *Client) ReportUsage(ctx context.Context, meterID int, units int64, reportID string) (Object, error) {
	return c.post(ctx, fmt.Sprintf("/meters/%d/usage", meterID), map[string]any{"units": units, "reportId": reportID}, "")
}

// AgentPolicy reads an owner's on-chain spending policy for an agent address.
func (c *Client) AgentPolicy(ctx context.Context, owner, agent string) (Object, error) {
	return c.get(ctx, "/agents/policy?owner="+url.QueryEscape(owner)+"&agent="+url.QueryEscape(agent))
}

// Test clock (local development chain only): move time forward by seconds.
func (c *Client) TestClock(ctx context.Context) (Object, error) { return c.get(ctx, "/test-clock") }
func (c *Client) AdvanceTestClock(ctx context.Context, seconds int64) (Object, error) {
	return c.post(ctx, "/test-clock/advance", map[string]any{"seconds": seconds}, "")
}

// VerifyWebhook checks an X-WhitePay-Signature header against the RAW request body and returns the event.
// tolerance <= 0 means 5 minutes; now == 0 means time.Now(). Any matching v1 is accepted (secret rotation).
func VerifyWebhook(rawBody []byte, header, secret string, tolerance time.Duration, now int64) (Object, error) {
	bad := func(m string) error { return &Error{Status: 400, Code: "invalid_signature", Message: m} }
	if tolerance <= 0 {
		tolerance = 5 * time.Minute
	}
	if now == 0 {
		now = time.Now().Unix()
	}
	var ts int64 = -1
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				ts = n
			}
		case "v1":
			sigs = append(sigs, v)
		}
	}
	if ts < 0 {
		return nil, bad("Missing timestamp")
	}
	if d := now - ts; d > int64(tolerance.Seconds()) || -d > int64(tolerance.Seconds()) {
		return nil, bad("Timestamp outside tolerance")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", ts, rawBody)
	expected := mac.Sum(nil)
	for _, s := range sigs {
		if got, err := hex.DecodeString(s); err == nil && hmac.Equal(got, expected) {
			var ev Object
			if err := json.Unmarshal(rawBody, &ev); err != nil {
				return nil, bad("Body is not JSON")
			}
			return ev, nil
		}
	}
	return nil, bad("No matching signature")
}
