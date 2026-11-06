"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Logo } from "@/components/ui";
import { LanguageSwitcher, useI18n } from "@/components/I18n";
import { NetworkBadge } from "@/components/NetworkBadge";

function Inner() {
  const embed = useSearchParams().get("embed") === "1"; // inside the checkout widget (popup or iframe): no site chrome
  const { t, T } = useI18n();
  const [degraded, setDegraded] = useState(false);
  useEffect(() => { if (!embed && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); }, [embed]); // installable app; needs https or localhost
  useEffect(() => { fetch("/api/status").then((r) => r.json()).then((s) => setDegraded(!!s.degraded)).catch(() => {}); }, []);
  if (embed) return null;
  return (
    <>
      <header className="site-header">
        <div className="container">
          <Logo />
          <nav className="nav" aria-label="Main">
            <a className="link hide-sm" href="/store">{t("nav.store")}</a>
            <a className="link hide-sm" href="/subscribe">{t("nav.subs")}</a>
            <a className="link" href="/portal">{T("My account")}</a>
            <NetworkBadge />
            <LanguageSwitcher />
          </nav>
        </div>
      </header>
      {degraded ? <div className="notice warn" style={{ margin: 0, borderRadius: 0, textAlign: "center" }}>{t("banner")}</div> : null}
    </>
  );
}
export function CustomerHeader() { return <Suspense fallback={null}><Inner /></Suspense>; }
