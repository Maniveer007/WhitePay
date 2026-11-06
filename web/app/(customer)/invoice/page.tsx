import type { Metadata } from "next";
import { api } from "@/lib/api";
import { InvoiceClient, type PublicInvoice } from "./InvoiceClient";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoicePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const r = id ? await api<PublicInvoice>(`/api/invoices/${encodeURIComponent(id)}`) : null;
  return (
    <main className="container customer-wide">
      {r?.ok ? <InvoiceClient id={id!} initial={r.data} /> : <div className="notice bad">{r && !r.ok ? r.message : "This invoice link is incomplete."}</div>}
    </main>
  );
}
