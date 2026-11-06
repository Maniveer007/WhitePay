// Translation parity: every language has every key the English source has, no strays, and {placeholders} match.
//   web/lib/i18n/messages.json   customer pages (keyed messages + "x:" exact-phrase translations)
//   server/i18n/mail.json        email wording
// "x:" entries are exact English phrases; every language must carry the same set (English maps each phrase to itself).
const path = require("path");
const vars = (s) => JSON.stringify((String(s).match(/\{\w+\}/g) || []).sort());
let bad = 0;
function check(name, file) {
  const D = require(path.join(__dirname, "../..", file)), en = D.en, langs = Object.keys(D).filter((l) => l !== "en");
  const keyed = Object.keys(en).filter((k) => !k.startsWith("x:"));
  const phrases = (l) => Object.keys(D[l]).filter((k) => k.startsWith("x:")).sort();
  const refPhrases = JSON.stringify(phrases("en"));
  for (const l of ["en", ...langs]) {
    const d = D[l], missing = keyed.filter((k) => !(k in d)), extra = Object.keys(d).filter((k) => !k.startsWith("x:") && !(k in en));
    const ph = keyed.filter((k) => k in d && vars(en[k]) !== vars(d[k]));
    const phrasesAgree = JSON.stringify(phrases(l)) === refPhrases;
    const ok = !missing.length && !extra.length && !ph.length && phrasesAgree;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} ${l}  ${Object.keys(d).length} keys` + (missing.length ? `  missing: ${missing.join(", ")}` : "") + (extra.length ? `  extra: ${extra.join(", ")}` : "")
      + (ph.length ? `  placeholder mismatch: ${ph.join(", ")}` : "") + (phrasesAgree ? "" : "  phrase set differs"));
  }
}
check("web", "web/lib/i18n/messages.json");
check("mail", "server/i18n/mail.json");
process.exit(bad ? 1 : 0);
