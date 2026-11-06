import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface PaymentStatus { id: string; status: string; fulfillable: boolean; [k: string]: unknown }
export interface CheckoutOptions { mode?: "popup" | "modal"; lang?: string; autoClose?: boolean; onStatus?(s: PaymentStatus): void; onPaid?(s: PaymentStatus): void; onClose?(): void }
export function loadWidget(host: string): Promise<unknown>;
export function openCheckout(host: string, target: string, opts?: CheckoutOptions): Promise<unknown>;
export function useWhitePay(host: string): { ready: boolean; error: Error | null; open(target: string, opts?: CheckoutOptions): Promise<unknown> };
export interface PayButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  host: string; paymentId?: string; invoiceId?: string; mode?: "popup" | "modal"; lang?: string;
  onPaid?(s: PaymentStatus): void; onStatus?(s: PaymentStatus): void; onClose?(): void; children?: ReactNode;
}
export function PayButton(props: PayButtonProps): JSX.Element;
