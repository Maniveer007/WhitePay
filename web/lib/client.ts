"use client";
import { useCallback, useState } from "react";

/** Call the API through the cookie-attaching proxy. Throws an Error with the API's message on failure. */
export async function bff<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/bff/${path.replace(/^\//, "")}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? res.statusText);
  return data as T;
}

export async function bffAdmin<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/bff-admin/${path.replace(/^\//, "")}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? res.statusText);
  return data as T;
}

export type Flash = { kind: "ok" | "bad" | "warn"; text: string } | null;

/** Pending + message state for an async action. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string)): Promise<T | undefined> => {
    setPending(true); setFlash(null);
    try {
      const r = await fn();
      if (ok) setFlash({ kind: "ok", text: typeof ok === "function" ? ok(r) : ok });
      return r;
    } catch (e: any) { setFlash({ kind: "bad", text: e?.message ?? String(e) }); }
    finally { setPending(false); }
  }, []);
  return { pending, flash, setFlash, run };
}
