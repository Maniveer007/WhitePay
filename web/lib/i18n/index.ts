// Customer-facing localization (checkout, invoices, receipts, portal, subscriptions): 7 languages, English fallback per key.
// Source: messages.json. Keys like "pay.payAmount" are keyed messages; keys starting "x:" are exact English phrases used by pages
// written in plain English (T("Demo store")). Non-English copy is machine-assisted and needs native-speaker review before production use.
import messages from "./messages.json";

export const LANGS = {
  en: { name: "English", locale: "en-IN", rtl: false },
  hi: { name: "हिन्दी", locale: "hi-IN", rtl: false },
  ta: { name: "தமிழ்", locale: "ta-IN", rtl: false },
  te: { name: "తెలుగు", locale: "te-IN", rtl: false },
  mr: { name: "मराठी", locale: "mr-IN", rtl: false },
  bn: { name: "বাংলা", locale: "bn-IN", rtl: false },
  ar: { name: "العربية", locale: "ar", rtl: true },
} as const;
export type Lang = keyof typeof LANGS;
export const LANG_COOKIE = "wp_lang";

const D = messages as Record<string, Record<string, string>>;
export const isLang = (x: unknown): x is Lang => typeof x === "string" && x in LANGS && !!D[x];

/** First usable language from: ?lang=, saved choice, browser languages. Falls back to English. */
export function pickLang(candidates: (string | null | undefined)[]): Lang {
  for (const c of candidates) {
    const k = String(c ?? "").toLowerCase().split("-")[0];
    if (isLang(k)) return k;
  }
  return "en";
}
/** "hi-IN,hi;q=0.9,en;q=0.8" → ["hi-IN", "hi", "en"] */
export const parseAcceptLanguage = (h: string | null | undefined) => String(h ?? "").split(",").map((p) => p.split(";")[0].trim()).filter(Boolean);

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : s);
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

export function makeI18n(lang: Lang) {
  const meta = LANGS[lang], numLocale = `${meta.locale}-u-nu-latn`; // amounts keep Latin digits (what wallets and explorers show), locale grouping
  /** t("pay.payAmount", { amount: "12.00" }) */
  const t = (key: string, vars?: Record<string, string | number>) => fill(D[lang]?.[key] ?? D.en?.[key] ?? key, vars);
  /** Like t(), but a missing key returns `fallback` instead of the key (for values that may be unknown, e.g. a new status). */
  const tr = (key: string, fallback: string) => D[lang]?.[key] ?? D.en?.[key] ?? fallback;
  /** Exact-phrase translation of plain English copy; no entry means it stays English. */
  const T = (phrase: string) => D[lang]?.["x:" + normalize(phrase)] ?? phrase;
  return {
    lang, dir: meta.rtl ? ("rtl" as const) : ("ltr" as const), locale: meta.locale, t, tr, T,
    num: (n: number | string, opts?: Intl.NumberFormatOptions) => Number(n).toLocaleString(numLocale, opts),
    date: (ts: number) => new Date(ts * 1000).toLocaleDateString(meta.locale, { year: "numeric", month: "short", day: "numeric" }),
    dateTime: (ts: number) => new Date(ts * 1000).toLocaleString(meta.locale),
    /** `minor` is in cents. USDT isn't an ISO currency, so it falls back to "12.00 USDT". */
    money(minor: number, ccy: string) {
      try { return (minor / 100).toLocaleString(numLocale, { style: "currency", currency: ccy }); }
      catch { return (minor / 100).toLocaleString(numLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + ccy; }
    },
  };
}
export type I18n = ReturnType<typeof makeI18n>;
