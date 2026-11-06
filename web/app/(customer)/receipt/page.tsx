import type { Metadata } from "next";
import { ReceiptClient } from "./ReceiptClient";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({ searchParams }: { searchParams: Promise<{ i?: string }> }) {
  const { i } = await searchParams;
  return (
    <main className="container customer-narrow">
      {i ? <ReceiptClient id={i} /> : <div className="notice bad">This receipt link is incomplete.</div>}
    </main>
  );
}
