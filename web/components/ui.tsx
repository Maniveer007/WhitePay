import type { ReactNode } from "react";
import { humanize } from "@/lib/format";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>
      {actions ? <div className="row" style={{ alignItems: "center" }}>{actions}</div> : null}
    </div>
  );
}

export function Card({ title, subtitle, children, actions }: { title?: string; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div><h2 style={{ margin: 0 }}>{title}</h2>{subtitle ? <p className="mut small" style={{ margin: "4px 0 0" }}>{subtitle}</p> : null}</div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return <div className="stat"><div className="label">{label}</div><div className="value">{value}</div>{hint ? <div className="mut small">{hint}</div> : null}</div>;
}

export type Tone = "ok" | "bad" | "warn" | "brand" | "";
export function Badge({ tone = "", children }: { tone?: Tone; children: ReactNode }) { return <span className={`badge ${tone}`}>{children}</span>; }

const TONES: Record<string, Tone> = {
  finalized: "ok", safe: "ok", paid: "ok", active: "ok", sent: "ok", delivered: "ok", refunded: "warn", partially_refunded: "warn", credited: "warn",
  seen: "brand", created: "", open: "brand", partially_paid: "brand", trialing: "brand", pending: "warn", paused: "warn", logged: "",
  failed: "bad", expired: "", reorged: "bad", overdue: "bad", past_due: "bad", unpaid: "bad", cancelled: "", void: "", rejected: "bad", suspended: "bad",
};
// Words a business owner uses, not words from the blockchain.
export const STATUS_LABEL: Record<string, string> = {
  created: "Awaiting payment", seen: "Paid, confirming", safe: "Paid", finalized: "Paid, final", partially_refunded: "Partly refunded", refunded: "Refunded",
  expired: "Expired", failed: "Failed", reorged: "Reversed by the network", open: "Open", partially_paid: "Partly paid", overdue: "Overdue", paid: "Paid", void: "Cancelled",
  credited: "Credited", trialing: "Free trial", past_due: "Payment failed", unpaid: "Unpaid", paused: "Paused", cancelled: "Cancelled", active: "Active", rejected: "Declined",
  pending: "Pending", sent: "Sent", logged: "Not sent (channel off)", suspended: "Suspended",
};
export function StatusBadge({ status }: { status: string }) { return <Badge tone={TONES[status] ?? ""}>{STATUS_LABEL[status] ?? humanize(status)}</Badge>; }

export function Notice({ kind = "", children }: { kind?: "ok" | "bad" | "warn" | ""; children: ReactNode }) { return <div className={`notice ${kind}`} role={kind === "bad" ? "alert" : "status"}>{children}</div>; }

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

export function Meter({ used, max }: { used: number; max: number | null }) {
  if (max === null) return <div className="mut small">{used.toLocaleString()} used · unlimited</div>;
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div>
      <div className="mut small">{used.toLocaleString()} of {max.toLocaleString()}</div>
      <div className={`meter ${used >= max ? "full" : ""}`} role="progressbar" aria-valuenow={used} aria-valuemax={max}><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <>
      <div className="table-wrap">
        <table><thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table>
      </div>
      {!hasRows && empty ? <Empty>{empty}</Empty> : null}
    </>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <a className="logo" href={href} aria-label="WhitePay home">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--brand)" /><path d="M7 11l4.2 11 4.8-8.6L20.8 22 25 11" fill="none" stroke="var(--brand-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      WhitePay
    </a>
  );
}
