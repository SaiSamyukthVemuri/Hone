// Compact receipt-status line for the practitioner card. Keeps payment success
// separate from receipt-delivery status: a paid charge whose receipt failed
// still reads "Paid", with "Receipt not sent" + a retry slot below — the charge
// is never made to look failed because delivery failed. Never shows the full
// email (masking happens in the presenter); the `children` slot carries the
// existing retry action, unchanged.

import type { ReceiptLine } from "@/lib/payments/payment-summary-presenter";

export function ReceiptStatus({
  line,
  children,
}: {
  line: ReceiptLine;
  children?: React.ReactNode;
}) {
  if (line.kind === "none") return null;
  const text =
    line.kind === "sent"
      ? line.masked
        ? `Receipt sent to ${line.masked}`
        : "Receipt sent"
      : line.kind === "sending"
        ? "Sending receipt…"
        : "Receipt not sent";
  const tone =
    line.kind === "failed"
      ? "text-amber-700 dark:text-amber-300"
      : "text-neutral-600 dark:text-neutral-400";
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-xs ${tone}`}>
        {/* status conveyed by text, not colour alone */}
        {line.kind === "failed" ? "⚠ " : ""}
        {text}
      </p>
      {children}
    </div>
  );
}
