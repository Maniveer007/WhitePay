import type { Metadata } from "next";
import { WidgetDemo } from "./WidgetDemo";

export const metadata: Metadata = { title: "Checkout widget" };

export default function Page() { return <main className="container customer-wide"><WidgetDemo /></main>; }
