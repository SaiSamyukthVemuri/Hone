"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldLabel, fieldControlClass } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { FOCUS_RING, cx } from "@/components/ui/control-base";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { parseManualFeeRuleValue } from "@/lib/billing/manual-fee-rule";
import { type CancellationFeeRules } from "@/lib/billing/cancellation-fee-rules";
import {
  saveCancellationFeeRulesAction,
  setCancellationFeeRulesEnabledAction,
} from "./cancellation-fee-actions";

type Draft = {
  hours: string;
  noticeMode: "fixed" | "percent";
  noticeFixed: string;
  noticePercent: string;
  sameMode: "fixed" | "percent";
  sameFixed: string;
  samePercent: string;
};
function draftFrom(r: CancellationFeeRules | null): Draft {
  const value = (mode: string, selected: string, v: number | undefined) =>
    mode === selected && v !== undefined ? String(v / 100) : "";
  return {
    hours: String(r?.notice_hours ?? 48),
    noticeMode: r?.notice_mode ?? "percent",
    noticeFixed: value(r?.notice_mode ?? "", "fixed", r?.notice_value),
    noticePercent: value(r?.notice_mode ?? "", "percent", r?.notice_value),
    sameMode: r?.same_day_mode ?? "percent",
    sameFixed: value(r?.same_day_mode ?? "", "fixed", r?.same_day_value),
    samePercent: value(r?.same_day_mode ?? "", "percent", r?.same_day_value),
  };
}
function rateLabel(
  mode: "fixed" | "percent",
  value: number,
  currency: string | null,
) {
  return mode === "percent"
    ? `${value / 100}%`
    : `$${(value / 100).toFixed(2)} ${currency ?? "(currency unconfirmed)"}`;
}

export function CancellationFeeRulesCard({
  initial,
  policyText,
  policyHash,
  currency,
  status,
  available,
}: {
  initial: CancellationFeeRules | null;
  policyText: string;
  policyHash: string;
  currency: "CAD" | "USD" | null;
  status: string;
  available: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => draftFrom(initial));
  const [baseline, setBaseline] = useState(() => draftFrom(initial));
  const [reviewed, setReviewed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const observedRevision = useRef(initial?.revision ?? 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const selected = (d: Draft) => [
    d.hours,
    d.noticeMode,
    d.noticeMode === "percent" ? d.noticePercent : d.noticeFixed,
    d.sameMode,
    d.sameMode === "percent" ? d.samePercent : d.sameFixed,
  ];
  const selectedDirty =
    JSON.stringify(selected(draft)) !== JSON.stringify(selected(baseline));
  const notice = parseManualFeeRuleValue(
    draft.noticeMode,
    draft.noticeMode === "fixed" ? draft.noticeFixed : draft.noticePercent,
  );
  const same = parseManualFeeRuleValue(
    draft.sameMode,
    draft.sameMode === "fixed" ? draft.sameFixed : draft.samePercent,
  );
  const hours = Number(draft.hours);
  const valid =
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= 168 &&
    notice.ok &&
    !!notice.value &&
    same.ok &&
    !!same.value;
  const needsPolicyReview = saved?.policy_snapshot_hash !== policyHash;
  useUnsavedChangesGuard("cancellation-fee-tiers", dirty);
  useEffect(() => {
    setReviewed(false);
  }, [policyHash]);
  useEffect(() => {
    if (pending || observedRevision.current === (initial?.revision ?? 0))
      return;
    observedRevision.current = initial?.revision ?? 0;
    setSaved(initial);
    if (!dirty) {
      const next = draftFrom(initial);
      setDraft(next);
      setBaseline(next);
    }
    setReviewed(false);
  }, [initial, pending, dirty]);
  function edit(next: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...next }));
    setReviewed(false);
    setMessage(null);
  }
  function run(
    work: () => ReturnType<typeof saveCancellationFeeRulesAction>,
    saving: boolean,
  ) {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      try {
        const result = await work();
        if (!result.ok) {
          setMessage(result.error);
          return;
        }
        setSaved(result.rules);
        if (saving)
          setBaseline((b) => ({
            ...b,
            hours: draft.hours,
            noticeMode: draft.noticeMode,
            sameMode: draft.sameMode,
            ...(draft.noticeMode === "percent"
              ? { noticePercent: draft.noticePercent }
              : { noticeFixed: draft.noticeFixed }),
            ...(draft.sameMode === "percent"
              ? { samePercent: draft.samePercent }
              : { sameFixed: draft.sameFixed }),
          }));
        setReviewed(false);
        setConfirm(false);
        setMessage(
          saving
            ? "Rules saved. Turn on cancellation fees when you’re ready."
            : result.rules.enabled
              ? "Cancellation fees saved as on. Checking payment readiness…"
              : "Cancellation fees turned off.",
        );
        router.refresh();
      } catch {
        setMessage("We couldn’t save this change. Refresh and try again.");
      } finally {
        busy.current = false;
      }
    });
  }
  const summary = saved
    ? `${rateLabel(saved.notice_mode, saved.notice_value, currency)} with less than ${saved.notice_hours} hours’ notice; ${rateLabel(saved.same_day_mode, saved.same_day_value, currency)} on the same day`
    : "";
  return (
    <section
      className="overflow-hidden rounded-lg border border-line bg-surface text-sm"
      aria-labelledby="cancellation-tiers-title"
    >
      <header className="flex items-start justify-between gap-4 border-b border-line p-5 sm:p-6">
        <div>
          <h2 id="cancellation-tiers-title" className="font-medium">
            Late cancellation fee
          </h2>
          <p className="mt-1 text-fg-muted">
            Set a notice window and a separate same-day rate.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={saved?.enabled === true}
          aria-label="Allow late cancellation fees"
          disabled={
            pending ||
            !available ||
            (!saved?.enabled &&
              (!saved ||
                selectedDirty ||
                needsPolicyReview ||
                currency === null))
          }
          className={cx(
            "flex min-h-[44px] shrink-0 items-center gap-2 rounded-md disabled:opacity-50",
            FOCUS_RING,
          )}
          onClick={() =>
            saved?.enabled
              ? run(
                  () =>
                    setCancellationFeeRulesEnabledAction({
                      expectedRevision: saved.revision,
                      enabled: false,
                    }),
                  false,
                )
              : setConfirm(true)
          }
        >
          <span className="text-xs text-fg-muted">
            {saved?.enabled ? "On" : "Off"}
          </span>
          <span
            aria-hidden="true"
            className={cx(
              "flex h-6 w-11 items-center rounded-full p-0.5",
              saved?.enabled
                ? "justify-end bg-fg"
                : "bg-surface-sunken border border-line",
            )}
          >
            <span className="h-4 w-4 rounded-full bg-surface" />
          </span>
        </button>
      </header>
      {!available ? (
        <p role="status" className="p-5 text-fg-muted">
          Cancellation fee setup is temporarily unavailable. Existing payments
          are unaffected.
        </p>
      ) : (
        <form
          className="space-y-6 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !valid ||
              !notice.ok ||
              !notice.value ||
              !same.ok ||
              !same.value ||
              !reviewed
            ) {
              setMessage(
                "Enter both rates and confirm they match your cancellation policy.",
              );
              return;
            }
            run(
              () =>
                saveCancellationFeeRulesAction({
                  expectedRevision: saved?.revision ?? 0,
                  noticeHours: hours,
                  noticeMode: draft.noticeMode,
                  noticeValue: notice.value!,
                  sameDayMode: draft.sameMode,
                  sameDayValue: same.value!,
                  policyHash,
                  policyReviewed: true,
                }),
              true,
            );
          }}
        >
          <div className="max-w-xs">
            <FieldLabel label="Notice window">
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="cancellation-notice-hours"
                  type="number"
                  min="1"
                  max="168"
                  step="1"
                  value={draft.hours}
                  disabled={pending}
                  onChange={(e) => edit({ hours: e.target.value })}
                  className={fieldControlClass()}
                />
                <span className="text-fg-muted">hours</span>
              </div>
            </FieldLabel>
            <p className="mt-2 text-xs text-fg-muted">
              Cancellations with this much notice or more have no fee.
            </p>
          </div>
          {(["notice", "same"] as const).map((tier) => {
            const isNotice = tier === "notice";
            const mode = isNotice ? draft.noticeMode : draft.sameMode;
            const fixed = isNotice ? draft.noticeFixed : draft.sameFixed;
            const percent = isNotice ? draft.noticePercent : draft.samePercent;
            return (
              <fieldset
                key={tier}
                disabled={pending}
                className="space-y-3 border-t border-line pt-5"
              >
                <legend className="pt-5 font-medium">
                  {isNotice
                    ? `Less than ${draft.hours || "…"} hours’ notice`
                    : "Same-day cancellation"}
                </legend>
                <p className="text-xs text-fg-muted">
                  {isNotice
                    ? "For a cancellation on an earlier calendar day, inside your notice window."
                    : "Overrides the notice-window rate when cancelled on the appointment’s date, in your studio’s timezone."}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <FieldLabel label="Calculate fee as">
                      <select
                        id={`${tier}-rate-mode`}
                        className={cx("mt-2", fieldControlClass())}
                        value={mode}
                        onChange={(e) =>
                          edit(
                            isNotice
                              ? {
                                  noticeMode: e.target.value as
                                    | "fixed"
                                    | "percent",
                                }
                              : {
                                  sameMode: e.target.value as
                                    | "fixed"
                                    | "percent",
                                },
                          )
                        }
                      >
                        <option value="percent">Percentage</option>
                        <option value="fixed">Fixed amount</option>
                      </select>
                    </FieldLabel>
                  </div>
                  <div>
                    <FieldLabel
                      label={
                        mode === "percent"
                          ? "Percentage (%)"
                          : `Amount (${currency ?? "currency unconfirmed"})`
                      }
                    >
                      <input
                        id={`${tier}-rate-value`}
                        inputMode="decimal"
                        className={cx("mt-2", fieldControlClass())}
                        value={mode === "percent" ? percent : fixed}
                        onChange={(e) =>
                          edit(
                            isNotice
                              ? mode === "percent"
                                ? { noticePercent: e.target.value }
                                : { noticeFixed: e.target.value }
                              : mode === "percent"
                                ? { samePercent: e.target.value }
                                : { sameFixed: e.target.value },
                          )
                        }
                      />
                    </FieldLabel>
                  </div>
                </div>
              </fieldset>
            );
          })}
          <p className="text-xs leading-relaxed text-fg-muted">
            Percentages use the appointment’s session price, including any
            client-specific price, before tax. You review the exact amount
            before charging. Nothing is charged automatically.
          </p>
          <details className="rounded-md border border-line px-4">
            <summary
              className={cx(
                "flex min-h-[44px] cursor-pointer items-center rounded text-sm font-medium",
                FOCUS_RING,
              )}
            >
              Review your cancellation policy
            </summary>
            <p className="whitespace-pre-wrap pb-4 text-sm leading-relaxed text-fg-muted">
              {policyText ||
                "Add your cancellation policy in Studio settings before saving these rules."}
            </p>
          </details>
          <label className="flex min-h-[44px] items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={pending || !policyText.trim()}
              onChange={(e) => setReviewed(e.target.checked)}
              className={cx("mt-1 h-4 w-4", FOCUS_RING)}
            />
            <span>
              I’ve reviewed the policy above. These rates and this notice window
              match what clients agree to.
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-fg-muted">
              Saving rules leaves cancellation fees off. Turn them on
              separately.
            </p>
            <Button
              type="submit"
              variant="primary"
              pending={pending}
              disabled={
                pending ||
                !valid ||
                !reviewed ||
                (!selectedDirty && !!saved && !needsPolicyReview)
              }
            >
              Save rules
            </Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-sunken px-5 py-3 text-xs sm:px-6">
        <StatusPill>{saved?.enabled ? "Saved as on" : "Off"}</StatusPill>
        <span className="text-fg-muted">
          {saved?.revision === initial?.revision
            ? status
            : "Checking availability…"}
        </span>
      </div>
      {message && (
        <p role="status" className="px-5 py-3 text-sm sm:px-6">
          {message}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        title="Turn on late cancellation fees?"
        description={`Saved rules: ${summary}. Clients must have acknowledged the matching policy and signed card authorization. You confirm every charge on an appointment. Nothing is charged now.`}
        confirmLabel="Turn on fee"
        pending={pending}
        error={message}
        onCancel={() => {
          setConfirm(false);
          setMessage(null);
        }}
        onConfirm={() => {
          if (saved)
            run(
              () =>
                setCancellationFeeRulesEnabledAction({
                  expectedRevision: saved.revision,
                  enabled: true,
                }),
              false,
            );
        }}
      />
    </section>
  );
}
