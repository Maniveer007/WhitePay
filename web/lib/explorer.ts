import { api } from "./api";

/** The chain explorer base URL (public config), or "" when none is configured. */
export async function chainExplorer(): Promise<string> {
  const r = await api<{ explorer?: string }>("/api/config");
  return r.ok ? (r.data.explorer ?? "") : "";
}
