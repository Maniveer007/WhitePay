"use client";
import { usePathname, useRouter } from "next/navigation";

export type NavGroup = { title?: string; items: [string, string][] };

export function SideNav({ groups }: { groups: NavGroup[] }) {
  const path = usePathname();
  return (
    <>
      {groups.map((g, i) => (
        <div key={i}>
          {g.title ? <div className="group">{g.title}</div> : null}
          {g.items.map(([href, label]) => {
            const on = href === "/console" ? path === href : path.startsWith(href);
            return <a key={href} href={href} className={`item ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>{label}</a>;
          })}
        </div>
      ))}
    </>
  );
}

export function SignOut({ to = "/" }: { to?: string }) {
  const router = useRouter();
  return (
    <button className="btn ghost sm" onClick={async () => { await fetch("/auth/logout", { method: "POST" }); router.push(to); router.refresh(); }}>
      Sign out
    </button>
  );
}

/** Switch between businesses (an accountant or consultant who belongs to several). */
export function BusinessSwitcher({ current, businesses }: { current: string; businesses: { uid: string; name: string }[] }) {
  const router = useRouter();
  if (businesses.length < 2) return null;
  return (
    <select aria-label="Switch business" value={current} style={{ margin: "6px 0 8px" }}
      onChange={async (e) => { await fetch("/auth/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchantUid: e.target.value }) }); router.push("/console"); router.refresh(); }}>
      {businesses.map((b) => <option key={b.uid} value={b.uid}>{b.name}</option>)}
    </select>
  );
}
