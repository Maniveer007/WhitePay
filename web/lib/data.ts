import { api } from "./api";
import { getToken } from "./session";

/** Fetch with the signed-in person's session. Pages show `error` in a notice instead of crashing. */
export async function getJson<T = any>(path: string): Promise<{ data: T | null; error: string | null }> {
  const key = (await getToken()) ?? undefined;
  const r = await api<T>(path, { key });
  return r.ok ? { data: r.data, error: null } : { data: null, error: r.message };
}
