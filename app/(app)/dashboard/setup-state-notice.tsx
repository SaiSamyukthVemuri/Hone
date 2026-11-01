import Link from "next/link";
import type { SetupCardState } from "@/lib/dashboard/setup-card-model";

// The two owner setup states the booking-setup checklist does not cover.
// Presentational and read-only: links only, no write.
//
//   paused_by_owner  New-client booking is off or waitlist-only BY THE OWNER'S
//                    CHOICE. Stated as a fact with a link to change it; never as
//                    a to-do, and never with "complete your setup" wording.
//   finish_launch    Booking is ready; the launch checklist (emails, aftercare
//                    text, policies) still has items.

const CARD =
  "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800";
const LINK =
  "shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100 dark:hover:bg-neutral-900";

export function SetupStateNotice({ state }: { state: SetupCardState }) {
  if (state.kind === "paused_by_owner") {
    const first = state.choices[0];
    return (
      <section
        aria-label="New-client booking"
        data-testid="setup-paused-by-owner"
        className={CARD}
      >
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-sm font-medium">New-client booking is off</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {first?.label ?? "This studio is not taking new clients directly."}{" "}
            That is your setting, not unfinished setup.
          </p>
        </div>
        <Link href={first?.href ?? "/settings/booking"} className={LINK}>
          Change setting
        </Link>
      </section>
    );
  }
  if (state.kind === "finish_launch") {
    return (
      <section aria-label="Finish setup" data-testid="setup-finish-launch" className={CARD}>
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-sm font-medium">Booking is ready</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            A few launch items are still open: confirmation emails, aftercare
            text or your policies.
          </p>
        </div>
        <Link href="/settings/launch" className={LINK}>
          Finish setup
        </Link>
      </section>
    );
  }
  return null;
}
