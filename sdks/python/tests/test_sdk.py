import json
import os
import pathlib
import sys
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from whitepay import WhitePay, WhitePayError, verify_webhook  # noqa: E402

VECTORS = json.loads((pathlib.Path(__file__).resolve().parents[2] / "testdata" / "webhook-vectors.json").read_text())
BASE, KEY = os.environ.get("WHITEPAY_BASE_URL"), os.environ.get("WHITEPAY_API_KEY", "wp_test_demo")


class WebhookVectors(unittest.TestCase):
    def test_vectors(self):
        for c in VECTORS["cases"]:
            with self.subTest(c["name"]):
                if c["valid"]:
                    self.assertEqual(verify_webhook(c["body"], c["header"], c["secret"], VECTORS["tolerance"], c["now"])["type"], "payment.fulfillable")
                else:
                    with self.assertRaises(WhitePayError) as e:
                        verify_webhook(c["body"], c["header"], c["secret"], VECTORS["tolerance"], c["now"])
                    self.assertEqual(e.exception.code, "invalid_signature")


@unittest.skipUnless(BASE, "set WHITEPAY_BASE_URL to run")
class LiveAPI(unittest.TestCase):
    def test_flow(self):
        wp = WhitePay(KEY, base_url=BASE)
        with self.assertRaises(WhitePayError) as e:
            WhitePay("wrong", base_url=BASE, max_retries=0).payments.list()
        self.assertEqual((e.exception.status, e.exception.code), (401, "unauthorized"))

        idem = f"py-{time.time()}"
        a = wp.payments.create(12.5, "USD", idempotency_key=idem, description="SDK test")
        b = wp.payments.create(12.5, "USD", idempotency_key=idem, description="SDK test")
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(wp.payments.get(a["id"])["amount"], "12500000")

        wp.payments.create(1)
        p1 = wp.payments.list(limit=1)
        self.assertEqual(len(p1), 1)
        self.assertTrue(p1.has_more and p1.next_cursor)
        self.assertNotEqual(wp.payments.list(limit=1, starting_after=p1.next_cursor)[0]["id"], p1[0]["id"])

        inv = wp.invoices.create("SDK client", [{"description": "Work", "qty": 1, "unitPrice": 100, "taxPercent": 18}])
        self.assertEqual(inv["total"], 11800)
        self.assertEqual(wp.invoices.get(inv["id"])["status"], "open")
        self.assertIn("pay_", wp.invoices.pay(inv["id"])["checkoutUrl"])
        with self.assertRaises(WhitePayError) as e:
            wp.payments.get("pay_does_not_exist")
        self.assertEqual((e.exception.status, e.exception.code), (404, "not_found"))
        self.assertIsInstance(wp.invoices.aging(), dict)

        ci = wp.invoices.create("Credit client", [{"description": "Work", "qty": 1, "unitPrice": 100}])
        cn = wp.credit_notes.create(ci["id"], 30, reason="pricing_error")
        self.assertEqual(cn["invoice"]["balance"], 7000)
        with self.assertRaises(WhitePayError) as e:
            wp.credit_notes.create(ci["id"], 500)
        self.assertEqual(e.exception.code, "invalid_amount")
        self.assertTrue(any(n["id"] == cn["id"] for n in wp.credit_notes.list()))
        rec = wp.recurring_invoices.create("monthly", {"clientName": "Retainer", "items": [{"description": "Retainer", "unitPrice": 50}]})
        self.assertEqual(rec["runs"], 1)
        self.assertEqual(wp.recurring_invoices.pause(rec["id"])["status"], "paused")
        self.assertEqual(wp.recurring_invoices.cancel(rec["id"])["status"], "cancelled")
        self.assertTrue(any(r["id"] == rec["id"] for r in wp.recurring_invoices.list()))
        self.assertIn("summary", wp.statements.get())
        self.assertIsInstance(wp.periods.list(), list)
        self.assertFalse(wp.agents.policy("0x" + "1" * 40, "0x" + "2" * 40)["active"])
        self.assertIsInstance(wp.test_clock.get()["enabled"], bool)


if __name__ == "__main__":
    unittest.main()
