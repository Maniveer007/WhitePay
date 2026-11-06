"use client";
import { useRouter } from "next/navigation";

export function LedgerCsv() {
  return (
    <button className="btn secondary sm" onClick={async () => {
      const r = await fetch("/bff/ledger.csv");
      if (!r.ok) return;
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await r.blob()), download: "whitepay-ledger.csv" });
      a.click(); URL.revokeObjectURL(a.href);
    }}>Export CSV</button>
  );
}

export function ResolveButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <button className="btn ghost sm" onClick={async () => {
      const note = prompt("Resolution note (e.g. matched to order #123, refunded tx …)");
      if (note === null) return;
      const r = await fetch(`/bff/exceptions/${encodeURIComponent(id)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) });
      if (r.ok) router.refresh();
    }}>Mark resolved</button>
  );
}
