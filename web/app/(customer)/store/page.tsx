import type { Metadata } from "next";
import { StoreClient } from "./StoreClient";

export const metadata: Metadata = { title: "Demo store" };

export default function StorePage() {
  return <main className="container customer-wide"><StoreClient /></main>;
}
