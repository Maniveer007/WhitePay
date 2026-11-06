"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code drawn in the browser (nothing is sent to a third-party service). */
export function QrCode({ value, size = 160 }: { value: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(value, { margin: 1, width: size * 2 }).then(setSrc).catch(() => setSrc("")); }, [value, size]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="QR code for the payment link" width={size} height={size} style={{ background: "#fff", borderRadius: 8 }} /> : null;
}
