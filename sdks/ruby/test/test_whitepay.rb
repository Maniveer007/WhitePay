require "minitest/autorun"
require "json"
require_relative "../lib/whitepay"

VECTORS = JSON.parse(File.read(File.expand_path("../../testdata/webhook-vectors.json", __dir__)))

class WebhookVectorsTest < Minitest::Test
  VECTORS["cases"].each do |c|
    define_method("test_vector_#{c['name']}") do
      run = -> { WhitePay.verify_webhook(c["body"], c["header"], c["secret"], tolerance: VECTORS["tolerance"], now: c["now"]) }
      if c["valid"]
        assert_equal "payment.fulfillable", run.call["type"]
      else
        e = assert_raises(WhitePay::Error) { run.call }
        assert_equal "invalid_signature", e.code
      end
    end
  end
end

class LiveAPITest < Minitest::Test
  BASE = ENV["WHITEPAY_BASE_URL"]
  def test_flow
    skip "set WHITEPAY_BASE_URL to run" unless BASE
    wp = WhitePay::Client.new(ENV.fetch("WHITEPAY_API_KEY", "wp_test_demo"), base_url: BASE)
    e = assert_raises(WhitePay::Error) { WhitePay::Client.new("wrong", base_url: BASE, max_retries: 0).list_payments }
    assert_equal [401, "unauthorized"], [e.status, e.code]

    idem = "rb-#{Time.now.to_f}"
    a = wp.create_payment({ amount: 12.5, currency: "USD", description: "SDK test" }, idempotency_key: idem)
    b = wp.create_payment({ amount: 12.5, currency: "USD", description: "SDK test" }, idempotency_key: idem)
    assert_equal a["id"], b["id"]
    assert_equal "12500000", wp.get_payment(a["id"])["amount"]

    wp.create_payment({ amount: 1 })
    p1 = wp.list_payments(limit: 1)
    assert_equal 1, p1.size
    assert p1.has_more && p1.next_cursor
    refute_equal p1[0]["id"], wp.list_payments(limit: 1, starting_after: p1.next_cursor)[0]["id"]

    inv = wp.create_invoice({ clientName: "SDK client", items: [{ description: "Work", qty: 1, unitPrice: 100, taxPercent: 18 }] })
    assert_equal 11800, inv["total"]
    assert_equal "open", wp.get_invoice(inv["id"])["status"]
    assert_includes wp.pay_invoice(inv["id"])["checkoutUrl"], "pay_"
    e = assert_raises(WhitePay::Error) { wp.get_payment("pay_does_not_exist") }
    assert_equal [404, "not_found"], [e.status, e.code]

    ci = wp.create_invoice({ clientName: "Credit client", items: [{ description: "Work", qty: 1, unitPrice: 100 }] })
    cn = wp.create_credit_note(ci["id"], amount: 30, reason: "pricing_error")
    assert_equal 7000, cn["invoice"]["balance"]
    e = assert_raises(WhitePay::Error) { wp.create_credit_note(ci["id"], amount: 500) }
    assert_equal "invalid_amount", e.code
    assert wp.credit_notes.any? { |n| n["id"] == cn["id"] }
    rec = wp.create_recurring_invoice({ frequency: "monthly", template: { clientName: "Retainer", items: [{ description: "Retainer", unitPrice: 50 }] } })
    assert_equal 1, rec["runs"]
    assert_equal "paused", wp.pause_recurring_invoice(rec["id"])["status"]
    assert_equal "cancelled", wp.cancel_recurring_invoice(rec["id"])["status"]
    assert wp.statement.key?("summary")
    assert_kind_of Array, wp.periods
    assert_equal false, wp.agent_policy("0x" + "1" * 40, "0x" + "2" * 40)["active"]
    assert_includes [true, false], wp.test_clock["enabled"]
  end
end
