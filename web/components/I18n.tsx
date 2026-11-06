"use client";
import { createContext, useContext, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LANGS, LANG_COOKIE, makeI18n, type I18n, type Lang } from "@/lib/i18n";

const Ctx = createContext<I18n>(makeI18n("en"));

/** Gives client components the same translator the server used, so text never flashes from English to the visitor's language. */
export function I18nProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const value = useMemo(() => makeI18n(lang), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);

export function LanguageSwitcher() {
  const { lang, t } = useI18n();
  const router = useRouter();
  return (
    <select aria-label={t("lang")} value={lang} style={{ width: "auto", padding: "4px 8px" }}
      onChange={(e) => {
        document.cookie = `${LANG_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
        const u = new URL(location.href); u.searchParams.delete("lang"); // a stale ?lang= would override the choice
        router.replace(u.pathname + u.search); router.refresh();
      }}>
      {Object.entries(LANGS).map(([k, v]) => <option key={k} value={k} lang={k}>{v.name}</option>)}
    </select>
  );
}
