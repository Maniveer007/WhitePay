export type Payment = {
  id: string; intentId: string; orderRef: string | null; description: string | null; fiatAmount: number; currency: string; amount: string; refunded: string;
  status: string; policy: string; fulfillable: boolean; payer: string | null; txHash: string | null; paidAt: number | null; createdAt: number; gasless: boolean;
};
export type Usage = {
  plan: { id: string; name: string; priceUsd: number; limits: { paymentsPerMonth: number | null; invoicesPerMonth: number | null; recurringSchedules: number | null; requestsPerMinute: number }; finance: boolean };
  planUntil: number | null; period: { from: number; to: number }; usage: { payments: number; invoices: number; recurring: number }; suspended: boolean; suspendedReason: string | null;
};
export type Invoice = {
  id: string; number: string; status: string; currency: string; client: { name: string; email?: string }; poRef?: string | null; total: number; lateFee: number; discountsApplied: number;
  paid: number; balance: number; dueDate: number; refundDue: number; refundPlan: { paymentId: string; intentId: string; fiat: number; usdt: string }[];
};
export const PAID_STATES = ["seen", "safe", "finalized", "partially_refunded", "refunded"];
export const refundable = (p: Pick<Payment, "amount" | "refunded">) => BigInt(p.amount) - BigInt(p.refunded || "0");
