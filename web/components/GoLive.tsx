"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Contract } from "ethers";
import { connectWallet, friendlyError } from "@/lib/wallet";
import { PAY_ABI } from "@/lib/abi";
import { bff } from "@/lib/client";
import type { Me } from "@/lib/session";
import { Card, Notice } from "./ui";

/** A new account is "pending" until its owner wallet registers it onchain. This does that from the browser wallet. */
export function GoLive({ me }: { me: Me }) {
  const router = useRouter();
  const [payout, setPayout] = useState("");
  const [state, setState] = useState<{ kind: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const step = me.nextStep;

  async function waitActive() {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const now = await bff<Me>("merchants/me").catch(() => null);
      if (now?.status === "active") { router.refresh(); return true; }
    }
    return false;
  }

  async function register() {
    setBusy(true); setState(null);
    try {
      const { signer, address } = await connectWallet();
      const dest = (payout || address).trim();
      const c = new Contract(step!.contract, PAY_ABI, signer);
      setState({ kind: "warn", text: "Confirm the transaction in your wallet…" });
      await (await c.registerMerchant(dest, me.signerAddress)).wait();
      setState({ kind: "warn", text: "Registered. Waiting for WhitePay to see it onchain…" });
      if (!(await waitActive())) setState({ kind: "warn", text: "Registered onchain. It can take a minute to appear; refresh this page shortly." });
    } catch (e) { setState({ kind: "bad", text: friendlyError(e) }); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <h1>Finish setup</h1>
      <p className="mut">One step before you can take payments: register your owner wallet onchain. This wallet will own the account, so ideally use a Safe or hardware wallet. WhitePay never holds it.</p>
      <Card title="Register with your wallet">
        <div className="field">
          <label htmlFor="payout">Payout wallet</label>
          <input id="payout" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="Leave empty to use the connected wallet" dir="ltr" spellCheck={false} />
          <div className="hint">Customers' payments land here. You can change it later, with a timelock that protects you from a stolen key.</div>
        </div>
        {state ? <Notice kind={state.kind}>{state.text}</Notice> : null}
        <button className="btn" onClick={register} disabled={busy || !step}>{busy ? "Working…" : "Connect wallet and register"}</button>
      </Card>
      <Card title="Using a Safe or another tool?" subtitle="Send this call from the wallet that should own the account.">
        <div className="stack small">
          <div><label>Contract</label><div className="copy-box mono">{step?.contract}</div></div>
          <div><label>Function</label><div className="copy-box mono">registerMerchant(address payout, address quoteSigner)</div></div>
          <div><label>Quote signer (your account's signing address)</label><div className="copy-box mono">{me.signerAddress}</div></div>
        </div>
      </Card>
    </div>
  );
}
