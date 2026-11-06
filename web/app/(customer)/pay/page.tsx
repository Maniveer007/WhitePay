import type { Metadata } from "next";
import { PayClient } from "./PayClient";

export const metadata: Metadata = { title: "Checkout" };

export default async function PayPage({ searchParams }: { searchParams: Promise<{ i?: string; inv?: string }> }) {
  const { i, inv } = await searchParams;
  return (
    <main className="container customer-narrow">
      {i ? <PayClient id={i} inv={inv ?? null} /> : <div className="notice bad">This payment link is incomplete.</div>}
    </main>
  );
}
