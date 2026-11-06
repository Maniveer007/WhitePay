import type { Metadata } from "next";
import { api } from "@/lib/api";

export const metadata: Metadata = { title: "Pricing", description: "Simple monthly plans, paid in USDT. Limits only stop new work, never your customers' payments." };

type Plan = { id: string; name: string; priceUsd: number; limits: { paymentsPerMonth: number | null; invoicesPerMonth: number | null; recurringSchedules: number | null; requestsPerMinute: number }; finance: boolean };
const n = (x: number | null) => (x === null ? "Unlimited" : x.toLocaleString("en-US"));

export default async function Pricing() {
  const r = await api<{ plans: Plan[]; signupOpen: boolean }>("/api/saas/plans");
  if (!r.ok) return <div className="container section"><h1>Pricing</h1><div className="notice warn">Plans can't be loaded right now. Please try again shortly.</div></div>;
  return (
    <div className="container section">
      <h1 style={{ textAlign: "center" }}>Simple plans, paid in USDT</h1>
      <p className="sub">Every plan includes the full API, signed webhooks, refunds, subscriptions and the embeddable checkout. Pay every 30 days from your own wallet; there is no card on file.</p>
      <div className="plans">
        {r.data.plans.map((p) => (
          <div className={`plan ${p.id === "growth" ? "pop" : ""}`} key={p.id}>
            <h3>{p.name}</h3>
            <div className="price">{p.priceUsd ? `$${p.priceUsd}` : "Free"}</div>
            <div className="mut small">{p.priceUsd ? "per 30 days, in USDT" : "no time limit"}</div>
            <ul>
              <li>{n(p.limits.paymentsPerMonth)} payments / month</li>
              <li>{n(p.limits.invoicesPerMonth)} invoices / month</li>
              <li>{p.limits.recurringSchedules === 0 ? "No recurring invoices" : `${n(p.limits.recurringSchedules)} recurring schedules`}</li>
              <li>{p.finance ? "Excel, PDF, Xero and QuickBooks exports, period close, auditor key" : "Ledger and CSV export"}</li>
              <li>{p.limits.requestsPerMinute.toLocaleString("en-US")} API requests / minute</li>
            </ul>
            <a className={`btn ${p.id === "growth" ? "" : "secondary"}`} href="/signup">{p.priceUsd ? `Start with ${p.name}` : "Start free"}</a>
          </div>
        ))}
      </div>
      <div className="faq" style={{ maxWidth: 760, margin: "48px auto 0" }}>
        <details><summary>How do upgrades work?</summary><p>Choose a plan in the console and pay the checkout in USDT. The plan switches on automatically once the payment is confirmed, and renewing extends it by 30 days per month paid.</p></details>
        <details><summary>What counts toward the limits?</summary><p>Payments and invoices you create in a calendar month (UTC), including those from recurring schedules. Customers paying existing payments, refunds and webhooks never count and are never blocked.</p></details>
        <details><summary>What if my plan expires?</summary><p>The account falls back to the Free plan. Nothing is deleted, and you can upgrade again at any time.</p></details>
      </div>
    </div>
  );
}
