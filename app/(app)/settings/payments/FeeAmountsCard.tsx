"use client";

import { useState, useTransition } from "react";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { updateStudioFeeAmountsAction } from "./fee-amounts-actions";

// Owner-only Cancellation/no-show fee amount settings (PR #145).
// Two dollar inputs. Either can be blank to clear the configured
// amount. Launch ceiling is $200 per type; the server action
// re-validates and writes both columns in one statement.

type Props = {
  initialLateCancelCents: number | null;
  initialNoShowCents: number | null;
  // Migration 0351: the owner's switches. Off unless explicitly turned on.
  initialLateCancelEnabled: boolean;
  initialNoShowEnabled: boolean;
  // Server-derived, from the same gate prepare and execute use: what is SAVED and what is ACTUALLY ACTIVE.
  lateStatus: { saved: string; effective: string };
  noShowStatus: { saved: string; effective: string };
  // "CAD" | "USD" from the studio's verified payment jurisdiction, resolved on
  // the server. null = not confirmed: the card says so instead of printing a
  // currency it does not know.
  currencyLabel: "CAD" | "USD" | null;
};

function centsToDollarsInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

export function FeeAmountsCard({
  initialLateCancelCents,
  initialNoShowCents,
  initialLateCancelEnabled,
  initialNoShowEnabled,
  lateStatus,
  noShowStatus,
  currencyLabel,
}: Props) {
  const [lateEnabled, setLateEnabled] = useState(initialLateCancelEnabled);
  const [noShowEnabled, setNoShowEnabled] = useState(initialNoShowEnabled);
  const [lateCancel, setLateCancel] = useState(
    centsToDollarsInput(initialLateCancelCents),
  );
  const [noShow, setNoShow] = useState(
    centsToDollarsInput(initialNoShowCents),
  );
  const [saved, setSaved] = useState({
    lateCancel: centsToDollarsInput(initialLateCancelCents),
    noShow: centsToDollarsInput(initialNoShowCents),
    lateEnabled: initialLateCancelEnabled,
    noShowEnabled: initialNoShowEnabled,
  });
  useUnsavedChangesGuard(
    "payment-fees",
    lateCancel !== saved.lateCancel ||
      noShow !== saved.noShow ||
      lateEnabled !== saved.lateEnabled ||
      noShowEnabled !== saved.noShowEnabled,
  );
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    null | { kind: "ok" } | { kind: "error"; message: string }
  >(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const fd = new FormData();
    fd.set("late_cancel_dollars", lateCancel);
    fd.set("no_show_dollars", noShow);
    fd.set("late_cancel_enabled", lateEnabled ? "true" : "false");
    fd.set("no_show_enabled", noShowEnabled ? "true" : "false");
    startTransition(async () => {
      const r = await updateStudioFeeAmountsAction(fd);
      if (!r.ok) {
        setStatus({ kind: "error", message: r.error });
        return;
      }
      setSaved({ lateCancel, noShow, lateEnabled, noShowEnabled });
      setStatus({ kind: "ok" });
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">
          Cancellation and no-show fee amounts
        </h3>
        <p className="text-xs text-neutral-500">
          Set the dollar amount the studio may charge per type. Leave a
          field blank to clear the amount. Money is not charged here.
        </p>
        <p className="rounded-md bg-neutral-50 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          Both fees are off until you turn them on. When a fee is on, you can
          charge it from an appointment, one deliberate press at a time, and
          only for a client with a card on file and a signed card
          authorization. Nothing is ever charged automatically, and saving
          here never charges anyone. Turning a fee off stops new charges of
          that type, including any you had prepared but not yet run. Payments
          already sent are not affected. Session payments are unaffected.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium uppercase tracking-wider text-neutral-500">
            Late cancellation fee
          </span>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={lateCancel}
              onChange={(e) => setLateCancel(e.target.value)}
              placeholder="0.00"
              className="w-32 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span className="text-neutral-500" data-testid="fee-currency">
              {currencyLabel ?? "currency not confirmed"}
            </span>
          </div>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={lateEnabled}
            onChange={(e) => setLateEnabled(e.target.checked)}
            data-testid="late-cancel-fee-enabled"
          />
          <span>Allow late cancellation fees</span>
        </label>
        <p className="-mt-2 ml-6 text-xs text-neutral-600 dark:text-neutral-400" data-testid="late-cancel-fee-enabled-status">
          {lateStatus.saved}. {lateStatus.effective}.
        </p>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium uppercase tracking-wider text-neutral-500">
            No-show fee
          </span>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={noShow}
              onChange={(e) => setNoShow(e.target.value)}
              placeholder="0.00"
              className="w-32 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span className="text-neutral-500" data-testid="fee-currency">
              {currencyLabel ?? "currency not confirmed"}
            </span>
          </div>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={noShowEnabled}
            onChange={(e) => setNoShowEnabled(e.target.checked)}
            data-testid="no-show-fee-enabled"
          />
          <span>Allow no-show fees</span>
        </label>
        <p className="-mt-2 ml-6 text-xs text-neutral-600 dark:text-neutral-400" data-testid="no-show-fee-enabled-status">
          {noShowStatus.saved}. {noShowStatus.effective}.
        </p>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Save fee amounts"}
          </button>
          {status?.kind === "ok" && (
            <span className="text-xs text-emerald-700 dark:text-emerald-300">
              Saved.
            </span>
          )}
          {status?.kind === "error" && (
            <span className="text-xs text-red-700 dark:text-red-300">
              {status.message}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
