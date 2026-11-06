import { cookies, headers } from "next/headers";
import { LANG_COOKIE, makeI18n, parseAcceptLanguage, pickLang } from "./index";

/** The visitor's language on the server: ?lang= (passed on by proxy.ts), then their saved choice, then their browser, then English. */
export async function getI18n() {
  const h = await headers();
  const saved = (await cookies()).get(LANG_COOKIE)?.value;
  return makeI18n(pickLang([h.get("x-wp-lang"), saved, ...parseAcceptLanguage(h.get("accept-language"))]));
}
