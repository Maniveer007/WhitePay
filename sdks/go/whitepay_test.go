package whitepay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestWebhookVectors(t *testing.T) {
	raw, err := os.ReadFile("../testdata/webhook-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Tolerance int
		Cases     []struct {
			Name, Secret, Body, Header string
			Now                        int64
			Valid                      bool
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			ev, err := VerifyWebhook([]byte(c.Body), c.Header, c.Secret, time.Duration(v.Tolerance)*time.Second, c.Now)
			if c.Valid && (err != nil || ev["type"] != "payment.fulfillable") {
				t.Fatalf("expected valid, got %v", err)
			}
			var we *Error
			if !c.Valid && (!errors.As(err, &we) || we.Code != "invalid_signature") {
				t.Fatalf("expected invalid_signature, got %v", err)
			}
		})
	}
}

func TestLiveAPI(t *testing.T) {
	base := os.Getenv("WHITEPAY_BASE_URL")
	if base == "" {
		t.Skip("set WHITEPAY_BASE_URL to run")
	}
	key := os.Getenv("WHITEPAY_API_KEY")
	if key == "" {
		key = "wp_test_demo"
	}
	ctx := context.Background()
	wp := New(key)
	wp.BaseURL = base

	bad := New("wrong")
	bad.BaseURL, bad.MaxRetries = base, 0
	var we *Error
	if _, err := bad.ListPayments(ctx, 1, ""); !errors.As(err, &we) || we.Status != 401 || we.Code != "unauthorized" {
		t.Fatalf("want 401 unauthorized, got %v", err)
	}

	idem := fmt.Sprintf("go-%d", time.Now().UnixNano())
	a, err := wp.CreatePayment(ctx, CreatePaymentParams{Amount: 12.5, Currency: "USD", Description: "SDK test"}, idem)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := wp.CreatePayment(ctx, CreatePaymentParams{Amount: 12.5, Currency: "USD", Description: "SDK test"}, idem)
	if a["id"] != b["id"] || a["amount"] != "12500000" {
		t.Fatalf("idempotency: %v vs %v", a["id"], b["id"])
	}
	if g, _ := wp.GetPayment(ctx, a["id"].(string)); g["amount"] != "12500000" {
		t.Fatal("get mismatch")
	}
	_, _ = wp.CreatePayment(ctx, CreatePaymentParams{Amount: 1}, "")
	p1, err := wp.ListPayments(ctx, 1, "")
	if err != nil || len(p1.Data) != 1 || !p1.HasMore || p1.NextCursor == "" {
		t.Fatalf("pagination: %+v %v", p1, err)
	}
	if p2, _ := wp.ListPayments(ctx, 1, p1.NextCursor); p2.Data[0]["id"] == p1.Data[0]["id"] {
		t.Fatal("cursor did not advance")
	}
	inv, err := wp.CreateInvoice(ctx, CreateInvoiceParams{ClientName: "SDK client", Items: []InvoiceItem{{Description: "Work", Qty: 1, UnitPrice: 100, TaxPercent: 18}}}, "")
	if err != nil || inv["total"].(float64) != 11800 {
		t.Fatalf("invoice: %v %v", inv, err)
	}
	if g, _ := wp.GetInvoice(ctx, inv["id"].(string)); g["status"] != "open" {
		t.Fatal("invoice status")
	}
	if pi, err := wp.PayInvoice(ctx, inv["id"].(string), 0); err != nil || pi["checkoutUrl"] == "" {
		t.Fatalf("pay invoice: %v", err)
	}
	if _, err := wp.GetPayment(ctx, "pay_does_not_exist"); !errors.As(err, &we) || we.Status != 404 || we.Code != "not_found" {
		t.Fatalf("want 404 not_found, got %v", err)
	}

	ci, err := wp.CreateInvoice(ctx, CreateInvoiceParams{ClientName: "Credit client", Items: []InvoiceItem{{Description: "Work", Qty: 1, UnitPrice: 100}}}, "")
	if err != nil {
		t.Fatal(err)
	}
	cn, err := wp.CreateCreditNote(ctx, ci["id"].(string), 30, "pricing_error", "")
	if err != nil || cn["invoice"].(map[string]any)["balance"].(float64) != 7000 {
		t.Fatalf("credit note: %v %v", cn, err)
	}
	if _, err := wp.CreateCreditNote(ctx, ci["id"].(string), 500, "", ""); !errors.As(err, &we) || we.Code != "invalid_amount" {
		t.Fatalf("want invalid_amount, got %v", err)
	}
	if notes, err := wp.ListCreditNotes(ctx); err != nil || len(notes) == 0 {
		t.Fatalf("list credit notes: %v", err)
	}
	rec, err := wp.CreateRecurringInvoice(ctx, map[string]any{"frequency": "monthly", "template": map[string]any{"clientName": "Retainer", "items": []map[string]any{{"description": "Retainer", "unitPrice": 50}}}})
	if err != nil || rec["runs"].(float64) != 1 {
		t.Fatalf("recurring: %v %v", rec, err)
	}
	if r, _ := wp.PauseRecurringInvoice(ctx, rec["id"].(string)); r["status"] != "paused" {
		t.Fatal("pause")
	}
	if r, _ := wp.CancelRecurringInvoice(ctx, rec["id"].(string)); r["status"] != "cancelled" {
		t.Fatal("cancel")
	}
	if st, err := wp.Statement(ctx, 0, 0); err != nil || st["summary"] == nil {
		t.Fatalf("statement: %v", err)
	}
	if _, err := wp.ListPeriods(ctx); err != nil {
		t.Fatal(err)
	}
	if pol, err := wp.AgentPolicy(ctx, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"); err != nil || pol["active"] != false {
		t.Fatalf("agent policy: %v %v", pol, err)
	}
	if clk, err := wp.TestClock(ctx); err != nil || clk["enabled"] == nil {
		t.Fatalf("test clock: %v", err)
	}
}
