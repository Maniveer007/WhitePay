import type { Metadata } from "next";
import { PortalClient } from "./PortalClient";

export const metadata: Metadata = { title: "My account" };

export default async function PortalPage({ searchParams }: { searchParams: Promise<{ address?: string }> }) {
  const { address } = await searchParams;
  return <main className="container customer-wide"><PortalClient initialAddress={address ?? null} /></main>;
}
