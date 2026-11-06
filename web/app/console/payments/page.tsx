import type { Metadata } from "next";
import { getJson } from "@/lib/data";
import type { Payment } from "@/lib/types";
import { PageHeader, Notice } from "@/components/ui";
import { PaymentsTable } from "./PaymentsTable";
import { CreateLink } from "./CreateLink";
import { requireArea } from "@/lib/session";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage() {
  const { canWrite } = await requireArea("payments");
  const readOnly = !canWrite;
  const { data, error } = await getJson<Payment[]>("/api/payments");
  return (
    <>
      <PageHeader title="Payments" subtitle="Every payment, its on-chain finality, and refunds." />
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {readOnly ? null : <CreateLink />}
      <PaymentsTable payments={data ?? []} readOnly={readOnly} />
    </>
  );
}
