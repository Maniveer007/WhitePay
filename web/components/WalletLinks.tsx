"use client";
import { useEffect, useState } from "react";
import { useI18n } from "./I18n";

/** "Open in a wallet app" deep links for phones, where there is no browser extension. Each app opens this page in its own browser. */
export function WalletLinks() {
  const { T } = useI18n();
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(location.href), []);
  if (!url) return null;
  const u = encodeURIComponent(url), bare = url.replace(/^https?:\/\//, "");
  const links: [string, string][] = [
    ["MetaMask", `https://metamask.app.link/dapp/${bare}`], ["Trust Wallet", `https://link.trustwallet.com/open_url?coin_id=60&url=${u}`],
    ["Coinbase Wallet", `https://go.cb-w.com/dapp?cb_url=${u}`], ["Rainbow", `https://rnbwapp.com/dapp?url=${u}`],
  ];
  return (
    <div className="notice">
      <div>{T("No wallet detected. Open this page in a wallet app:")}</div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>{links.map(([n, h]) => <a key={n} className="btn secondary sm" href={h} rel="noopener" dir="ltr">{n}</a>)}</div>
    </div>
  );
}
