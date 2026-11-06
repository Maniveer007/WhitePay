import type { NextConfig } from "next";

// The Express API (payments, indexer, webhooks) stays the system of record. This app is the front door:
// it serves the product website and consoles, and forwards anything it doesn't own (the /api/* endpoints, the embeddable
// checkout pages, widget.js, openapi.json) to the API, so one public origin serves everything.
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3000";

const config: NextConfig = {
  // Slim self-contained build for the Docker image (NEXT_STANDALONE=1). Plain `next start` is used everywhere else.
  output: process.env.NEXT_STANDALONE ? "standalone" : undefined,
  // This app lives inside the API's repository, which has its own lockfile: pin the root so builds don't pick the parent.
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  poweredByHeader: false,
  async rewrites() {
    // Customer pages kept their original URLs: payment links, emails, the widget, SDKs and the WooCommerce plugin all point at /pay.html etc.
    const legacy = Object.entries({ "pay.html": "pay", "invoice.html": "invoice", "receipt.html": "receipt", "portal.html": "portal", "subscribe.html": "subscribe", "index.html": "store", "widget-demo.html": "widget-demo" })
      .map(([from, to]) => ({ source: `/${from}`, destination: `/${to}` }));
    return { beforeFiles: legacy, afterFiles: [], fallback: [{ source: "/:path((?!_next/).*)", destination: `${API_ORIGIN}/:path` }] };
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
      ],
    }];
  },
};
export default config;
