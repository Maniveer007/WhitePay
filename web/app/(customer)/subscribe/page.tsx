import type { Metadata } from "next";
import { SubscribeClient } from "./SubscribeClient";

export const metadata: Metadata = { title: "Subscriptions" };

export default function SubscribePage() {
  return <main className="container customer-narrow"><SubscribeClient /></main>;
}
