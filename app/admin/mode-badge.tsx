import { modeBadgeForRow } from "@/lib/payments/payment-status-presenter";

// Shared admin payment-mode badge (PR B). ALWAYS badges from the ROW's own
// stripe_livemode via the shared presenter — never from the runtime — and a
// NULL/unknown mode renders "unknown", never silently "test". Red for live
// (real money), neutral for test, amber for unknown.
export function AdminModeBadge({
  livemode,
}: {
  livemode: boolean | null | undefined;
}) {
  const badge = modeBadgeForRow(livemode);
  const styles =
    badge === "Live"
      ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
      : badge === "Test"
        ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase ${styles}`}
    >
      {badge === "Live" ? "live mode" : badge === "Test" ? "test mode" : "unknown mode"}
    </span>
  );
}
