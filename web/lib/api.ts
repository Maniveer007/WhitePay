// Server-side client for the WhitePay API. Only used from Server Components and Route Handlers:
// the merchant's API key lives in an httpOnly cookie and never reaches browser JavaScript.
export const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3000";

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string };

export async function api<T = any>(path: string, opts: { key?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_ORIGIN}${path}`, {
      method: opts.method ?? "GET",
      cache: "no-store",
      headers: { "content-type": "application/json", ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, code: data?.error?.code ?? "error", message: data?.error?.message ?? res.statusText };
    return { ok: true, status: res.status, data: data as T };
  } catch {
    return { ok: false, status: 503, code: "api_unreachable", message: "The WhitePay API is not reachable right now." };
  }
}
