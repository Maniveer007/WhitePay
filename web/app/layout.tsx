import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "WhitePay: accept USDT without giving up custody", template: "%s · WhitePay" },
  description: "Payments, invoices and subscriptions in USDT on Whitechain. Customers pay from their own wallet straight to yours, and smart contracts enforce the rules.",
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = { themeColor: "#3b4cf0", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
