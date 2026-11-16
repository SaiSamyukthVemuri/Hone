"use client";

import { useState, useTransition } from "react";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { SectionLabel } from "@/components/ui/section-label";
import { updateStudioFeeAmountsAction } from "./fee-amounts-actions";
import {
  setManualFeeEnabledAction,
  setManualFeeModeAction,
  setManualFeePercentAction,
  type FeeType,
} from "./fee-settings-actions";

// Owner-only cancellation / no-show fee settings (PR #145, 0351). Per fee type: on/off, fixed amount or percent of the
// appointment's session price, the amount, the percentage. Each control saves through its OWN server action, which is a
// compare-and-set against the value this page loaded, so a stale tab cannot overwrite a newer choice. Nothing here charges
// anyone; a charge is always a separate deliberate press on an appointment.

type TypeProps = {
  enabled: boolean;
  mode: "fixed" | "percent";
  percentBp: number | null;
  status: { saved: string; effective: string };
};

type Props = {
  initialLateCancelCents: number | null;
  initialNoShowCents: number | null;
  lateCancel: TypeProps;
  noShow: TypeProps;
  // "CAD" | "USD" from the studio's verified payment jurisdiction, resolved on the server. null = not confirmed.
  currencyLabel: "CAD" | "USD" | null;
};

function centsToDollarsInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}
function bpToPercentInput(bp: number | null): string {
  if (bp == null) return "";
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

type Msg = null | { kind: "ok"; text: string } | { kind: "error"; text: string };

function FeeTypeSection({
  feeType,
  title,
  slug,
  initial,
  initialCents,
  centsValue,
  setCentsValue,
  currencyLabel,
}: {
  feeType: FeeType;
  title: string;
  slug: "late-cancel" | "no-show";
  initial: TypeProps;
  initialCents: number | null;
  centsValue: string;
  setCentsValue: (v: string) => void;
  currencyLabel: Props["currencyLabel"];
}) {
  // What is SAVED (updated only after a save succeeds) vs what is typed.
  const [savedEnabled, setSavedEnabled] = useState(initial.enabled);
  const [savedMode, setSavedMode] = useState(initial.mode);
  const [savedBp, setSavedBp] = useState(initial.percentBp);
  const [percentText, setPercentText] = useState(bpToPercentInput(initial.percentBp));
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  void initialCents;

  useUnsavedChangesGuard(`payment-fees-percent-${slug}`, percentText !== bpToPercentInput(savedBp));

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, onOk: () => void, okText: string) {
    setMsg(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        setMsg({ kind: "error", text: r.error });
        return;
      }
      onOk();
      setMsg({ kind: "ok", text: okText });
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800" data-testid={`${slug}-fee-section`}>
      <SectionLabel>{title}</SectionLabel>

      <fieldset className="flex flex-col gap-1 text-sm" disabled={pending}>
        <legend className="sr-only">{title} calculation</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${slug}-mode`}
            checked={savedMode === "fixed"}
            onChange={() =>
              run(
                () => setManualFeeModeAction({ feeType, mode: "fixed", expectedMode: savedMode }),
                () => setSavedMode("fixed"),
                "Saved.",
              )
            }
            data-testid={`${slug}-fee-mode-fixed`}
          />
          <span>Fixed amount</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${slug}-mode`}
            checked={savedMode === "percent"}
            onChange={() =>
              run(
                () => setManualFeeModeAction({ feeType, mode: "percent", expectedMode: savedMode }),
                () => setSavedMode("percent"),
                "Saved.",
              )
            }
            data-testid={`${slug}-fee-mode-percent`}
          />
          <span>Percent of the appointment&apos;s session price</span>
        </label>
      </fieldset>

      {savedMode === "fixed" ? (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-neutral-500">Amount</span>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">$</span>
            <input
              type="text"
              inputMode="decimal"
              name={`${slug}_dollars`}
              value={centsValue}
              onChange={(e) => setCentsValue(e.target.value)}
              placeholder="0.00"
              className="w-32 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span className="text-neutral-500" data-testid="fee-currency">
              {currencyLabel ?? "currency not confirmed"}
            </span>
          </div>
        </label>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-neutral-500">Percentage of the session price</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={percentText}
                onChange={(e) => setPercentText(e.target.value)}
                placeholder="75"
                className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
                data-testid={`${slug}-fee-percent`}
              />
              <span className="text-neutral-500">%</span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => setManualFeePercentAction({ feeType, percentText, expectedBp: savedBp }),
                    () => {
                      const t = percentText.trim();
                      // Re-derive the saved value from the same text the server parsed.
                      const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t.replace(/%$/, "").trim());
                      setSavedBp(t === "" || !m ? null : Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0"));
                    },
                    "Saved.",
                  )
                }
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-neutral-700"
                data-testid={`${slug}-fee-percent-save`}
              >
                Save percentage
              </button>
            </div>
          </label>
          <p className="text-neutral-500">
            The fee is this percentage of the booked service&apos;s price (the client&apos;s custom price if they have one),
            before any tax. You see the exact amount before you confirm any charge.
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={savedEnabled}
          disabled={pending}
          onChange={(e) => {
            // Capture the intended value SYNCHRONOUSLY. This input is controlled: once the handler returns React restores
            // `checked` to the saved value, so reading e.target.checked after the await would read the OLD value, save ON, and
            // then record OFF (and send a stale expectedEnabled with the next save). One captured value feeds the request,
            // the success state and (through savedEnabled) the next expectedEnabled.
            const intended = e.target.checked;
            const expected = savedEnabled;
            run(
              () => setManualFeeEnabledAction({ feeType, enabled: intended, expectedEnabled: expected }),
              () => setSavedEnabled(intended),
              "Saved.",
            );
          }}
          data-testid={`${slug}-fee-enabled`}
        />
        <span>Allow {title.toLowerCase()}s</span>
      </label>
      <p className="-mt-2 ml-6 text-xs text-neutral-600 dark:text-neutral-400" data-testid={`${slug}-fee-enabled-status`}>
        {initial.status.saved}. {initial.status.effective}.
      </p>
      {msg?.kind === "ok" && <span className="text-xs text-emerald-700 dark:text-emerald-300">{msg.text} Refresh to see whether it is active.</span>}
      {msg?.kind === "error" && <span className="text-xs text-red-700 dark:text-red-300">{msg.text}</span>}
    </div>
  );
}

export function FeeAmountsCard({ initialLateCancelCents, initialNoShowCents, lateCancel, noShow, currencyLabel }: Props) {
  const [lateCents, setLateCents] = useState(centsToDollarsInput(initialLateCancelCents));
  const [noShowCents, setNoShowCents] = useState(centsToDollarsInput(initialNoShowCents));
  const [saved, setSaved] = useState({
    late: centsToDollarsInput(initialLateCancelCents),
    noShow: centsToDollarsInput(initialNoShowCents),
  });
  useUnsavedChangesGuard("payment-fees", lateCents !== saved.late || noShowCents !== saved.noShow);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<null | { kind: "ok" } | { kind: "error"; message: string }>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const fd = new FormData();
    // Amounts only. This form never carries a switch, a mode or a percentage.
    fd.set("late_cancel_dollars", lateCents);
    fd.set("no_show_dollars", noShowCents);
    startTransition(async () => {
      const r = await updateStudioFeeAmountsAction(fd);
      if (!r.ok) {
        setStatus({ kind: "error", message: r.error });
        return;
      }
      setSaved({ late: lateCents, noShow: noShowCents });
      setStatus({ kind: "ok" });
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">Cancellation and no-show fees</h3>
        <p className="text-xs text-neutral-500">
          Choose, for each fee, a fixed amount or a percentage of the appointment&apos;s session price. Money is not charged here.
        </p>
        <p className="rounded-md bg-neutral-50 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          Both fees are off until you turn them on. When a fee is on, you can charge it from an appointment, one deliberate
          press at a time, and only for a client with a card on file and a signed card authorization.
          Nothing is ever charged automatically, and saving here never charges anyone.
          Turning a fee off stops new charges of that type, including any you had prepared but not yet run. Payments already
          sent are not affected. Session payments are unaffected. Each switch, mode, percentage and amount saves on its own
          and is recorded with who changed it and when.
        </p>
      </div>

      <FeeTypeSection
        feeType="late_cancel"
        title="Late cancellation fee"
        slug="late-cancel"
        initial={lateCancel}
        initialCents={initialLateCancelCents}
        centsValue={lateCents}
        setCentsValue={setLateCents}
        currencyLabel={currencyLabel}
      />
      <FeeTypeSection
        feeType="no_show"
        title="No-show fee"
        slug="no-show"
        initial={noShow}
        initialCents={initialNoShowCents}
        centsValue={noShowCents}
        setCentsValue={setNoShowCents}
        currencyLabel={currencyLabel}
      />

      <form onSubmit={submit} className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? "Saving…" : "Save fixed amounts"}
        </button>
        {status?.kind === "ok" && <span className="text-xs text-emerald-700 dark:text-emerald-300">Saved.</span>}
        {status?.kind === "error" && <span className="text-xs text-red-700 dark:text-red-300">{status.message}</span>}
      </form>
    </section>
  );
}
