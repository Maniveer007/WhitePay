import type { Metadata } from "next";
import { getI18n } from "@/lib/i18n/server";
import { I18nProvider } from "@/components/I18n";
import { CustomerHeader } from "./CustomerHeader";

// Pages customers use: checkout, invoice, receipt, payer portal, subscriptions and the demo store. Translated into 7 languages.
// They keep their original URLs (/pay.html, /invoice.html …) through rewrites in next.config.ts, so old links, the widget and plugins keep working.
export const metadata: Metadata = { manifest: "/manifest.webmanifest" };

export default async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const i18n = await getI18n();
  return (
    <I18nProvider lang={i18n.lang}>
      <div lang={i18n.lang} dir={i18n.dir} className="customer">
        <CustomerHeader />
        {children}
      </div>
    </I18nProvider>
  );
}
