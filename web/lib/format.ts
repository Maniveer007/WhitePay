// USDT has 6 decimals on Whitechain. Amounts arrive from the API as base-unit strings (never floats).
export const usdt = (u: string | number | bigint | null | undefined, max = 6): string => {
  if (u === null || u === undefined || u === "") return "0.00";
  const n = Number(u) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: max });
};
export const toUnits = (x: string | number): bigint => BigInt(Math.round(Number(x) * 1e6));
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const when = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const day = (ts?: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—");
/** Invoice amounts are integer minor units (cents). */
export const minor = (x: number, currency: string) => {
  try { return (x / 100).toLocaleString("en-US", { style: "currency", currency }); } catch { return `${(x / 100).toFixed(2)} ${currency}`; }
};
export const humanize = (s: string) => s.replace(/_/g, " ");
