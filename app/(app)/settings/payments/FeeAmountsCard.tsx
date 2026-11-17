"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { Button } from "@/components/ui/button";
import { FOCUS_RING, cx } from "@/components/ui/control-base";
import { FieldLabel, fieldControlClass } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { fixedFeeCentsIssue, formatBasisPoints, isValidPercentBp } from "@/lib/billing/manual-fee-percent";
import { parseManualFeeRuleValue, type ManualFeeRule } from "@/lib/billing/manual-fee-rule";
import { saveManualFeeRuleAction, setManualFeeEnabledAction, type FeeSettingResult, type FeeType } from "./fee-settings-actions";

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
  currencyLabel: "CAD" | "USD" | null;
};

type Message = { kind: "ok" | "error"; text: string } | null;
const FAILURE = "We couldn't save that setting. Please try again.";
const dollarsInput = (cents: number | null) => cents === null ? "" : (cents / 100).toFixed(2);
const percentInput = (bp: number | null) => bp === null ? "" : formatBasisPoints(bp).replace(/%$/, "");
const usable = (rule: ManualFeeRule) => rule.mode === "percent" ? isValidPercentBp(rule.percentBp) : fixedFeeCentsIssue(rule.cents) === null;
const sameRule = (a: ManualFeeRule, b: ManualFeeRule) => a.enabled === b.enabled && a.mode === b.mode && a.cents === b.cents && a.percentBp === b.percentBp;

function FeeRuleCard({ feeType, title, description, slug, initial, initialCents, currencyLabel }: {
  feeType: FeeType;
  title: string;
  description: string;
  slug: "late-cancel" | "no-show";
  initial: TypeProps;
  initialCents: number | null;
  currencyLabel: Props["currencyLabel"];
}) {
  const router = useRouter();
  const serverRule: ManualFeeRule = { enabled: initial.enabled, mode: initial.mode, cents: initialCents, percentBp: initial.percentBp };
  const [saved, setSaved] = useState(serverRule);
  const [mode, setMode] = useState(saved.mode);
  // Independent drafts: choosing Fixed never turns a typed 75% into $75.
  const [fixedText, setFixedText] = useState(dollarsInput(saved.cents));
  const [percentText, setPercentText] = useState(percentInput(saved.percentBp));
  const [expanded, setExpanded] = useState(feeType === "late_cancel" || saved.enabled || usable(saved));
  const [pending, startTransition] = useTransition();
  const [savingRule, setSavingRule] = useState(false);
  const inFlight = useRef(false);
  const observedServerRule = useRef(serverRule);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const valueText = mode === "fixed" ? fixedText : percentText;
  const parsedDraft = parseManualFeeRuleValue(mode, valueText);
  const savedValue = saved.mode === "fixed" ? saved.cents : saved.percentBp;
  const dirty = mode !== saved.mode || !parsedDraft.ok || parsedDraft.value !== savedValue;
  const canEnable = !dirty && usable(saved) && (saved.mode !== "fixed" || currencyLabel !== null);
  useUnsavedChangesGuard(`payment-fees-${slug}`, dirty);

  useEffect(() => {
    const incoming: ManualFeeRule = { enabled: initial.enabled, mode: initial.mode, cents: initialCents, percentBp: initial.percentBp };
    // Ignore the old props while our acknowledgement is waiting for refresh. Apply an actual new server snapshot
    // after pending settles, keeping the other fee's unsaved draft (and any edits in this card) intact.
    if (pending || sameRule(observedServerRule.current, incoming)) return;
    observedServerRule.current = incoming;
    if (!dirty) {
      setMode(incoming.mode);
      setFixedText(dollarsInput(incoming.cents));
      setPercentText(percentInput(incoming.percentBp));
    }
    if (incoming.enabled || usable(incoming)) setExpanded(true);
    if (!sameRule(saved, incoming)) {
      setSaved(incoming);
      setMessage({ kind: "ok", text: dirty ? "The saved rule changed elsewhere. Your unsaved edits are preserved; review them before saving." : "Updated to the latest saved rule." });
    }
  }, [initial.enabled, initial.mode, initial.percentBp, initialCents, pending, dirty, saved]);

  const summary = usable(saved)
    ? saved.mode === "percent"
      ? `${formatBasisPoints(saved.percentBp!)} of the session price`
      : `$${dollarsInput(saved.cents)} ${currencyLabel ?? "(currency unconfirmed)"}`
    : "No rule saved yet";

  function run(action: () => Promise<FeeSettingResult>, onSuccess: () => void, isRuleSave = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSavingRule(isRuleSave);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setMessage({ kind: "error", text: result.error });
          return;
        }
        onSuccess();
        router.refresh();
      } catch {
        setMessage({ kind: "error", text: FAILURE });
      } finally {
        inFlight.current = false;
        setSavingRule(false);
      }
    });
  }

  function saveRule(event: React.FormEvent) {
    event.preventDefault();
    setFieldError(null);
    if (mode === "fixed" && currencyLabel === null) {
      setFieldError("Confirm your studio's payment currency in Payment setup before saving an amount.");
      return;
    }
    if (!parsedDraft.ok) {
      setFieldError(parsedDraft.error);
      return;
    }
    if (saved.enabled && (parsedDraft.value === null || parsedDraft.value === 0)) {
      setFieldError("Turn this fee off before clearing or zeroing its rule.");
      return;
    }
    const next: ManualFeeRule = { ...saved, mode, ...(mode === "fixed" ? { cents: parsedDraft.value } : { percentBp: parsedDraft.value }) };
    run(() => saveManualFeeRuleAction({ feeType, mode, valueText, expected: saved }), () => {
      setSaved(next);
      if (mode === "fixed") setFixedText(dollarsInput(next.cents));
      else setPercentText(percentInput(next.percentBp));
      setMessage({ kind: "ok", text: saved.enabled ? "Rule saved. The fee remains on." : "Rule saved. The fee is still off." });
    }, true);
  }

  function changeEnabled(intended: boolean) {
    // Capture once, before the async request; never re-read a controlled checkbox after await.
    const expected = saved;
    run(() => setManualFeeEnabledAction({ feeType, enabled: intended, expectedEnabled: expected.enabled, ...(intended ? { expectedRule: expected } : {}) }), () => {
      setSaved({ ...expected, enabled: intended });
      setConfirmEnable(false);
      setMessage({ kind: "ok", text: intended ? "Saved as on. Availability is checked separately below." : "Fee turned off. New charges of this type are stopped." });
    });
  }

  return (
    <section aria-labelledby={`${slug}-heading`} data-testid={`${slug}-fee-section`} className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
        <div className="min-w-0">
          <h3 id={`${slug}-heading`} className="text-base font-medium text-fg">{title}</h3>
          <p className="mt-1 text-sm text-fg-muted">{description}</p>
        </div>
        <label className={cx("relative inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2 rounded-md", pending && "cursor-wait")}>
          <span className="text-xs text-fg-muted">{pending && !savingRule ? "Updating…" : saved.enabled ? "On" : "Off"}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`Allow ${title.toLowerCase()}s`}
            aria-describedby={`${slug}-state`}
            checked={saved.enabled}
            disabled={pending || (!saved.enabled && !canEnable)}
            onChange={(event) => {
              const intended = event.target.checked;
              setMessage(null);
              if (intended) setConfirmEnable(true);
              else changeEnabled(false);
            }}
            data-testid={`${slug}-fee-enabled`}
            className="peer sr-only"
          />
          <span aria-hidden="true" className="relative h-6 w-10 rounded-full bg-neutral-200 transition-colors after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-neutral-900 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-900 peer-focus-visible:ring-offset-2 peer-disabled:opacity-40 dark:bg-neutral-700 dark:peer-checked:bg-neutral-400 motion-reduce:transition-none motion-reduce:after:transition-none" />
        </label>
      </div>

      {!expanded ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
          <p className="text-sm text-fg-muted">No rule configured. This fee is off.</p>
          <Button onClick={() => setExpanded(true)} data-testid={`${slug}-configure`}>Configure fee</Button>
        </div>
      ) : (
        <form onSubmit={saveRule} noValidate className="flex flex-col gap-4 border-t border-line px-5 py-5 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <fieldset disabled={pending} className="min-w-0">
              <legend className="mb-2 text-xs font-medium text-fg-muted">Calculate fee as</legend>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1">
                {(["percent", "fixed"] as const).map((option) => (
                  <label key={option} className="relative min-w-0 cursor-pointer">
                    <input type="radio" name={`${slug}-mode`} value={option} checked={mode === option} onChange={() => { setMode(option); setFieldError(null); setMessage(null); }} data-testid={`${slug}-fee-mode-${option}`} className="peer sr-only" />
                    <span className="flex min-h-[44px] items-center justify-center rounded-md px-2 text-sm text-fg-muted peer-checked:bg-surface peer-checked:text-fg peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-neutral-900 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50">{option === "percent" ? "Percentage" : "Fixed amount"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <FieldLabel label={mode === "percent" ? "Percentage" : "Amount"}>
              <span className="flex items-center gap-2">
                {mode === "fixed" && <span aria-hidden="true" className="text-fg-muted">$</span>}
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`${title} ${mode === "percent" ? "percentage" : "amount"}`}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={`${slug}-hint${fieldError ? ` ${slug}-error` : ""}`}
                  value={valueText}
                  onChange={(event) => { if (mode === "fixed") setFixedText(event.target.value); else setPercentText(event.target.value); setFieldError(null); setMessage(null); }}
                  disabled={pending}
                  data-testid={`${slug}-fee-${mode === "percent" ? "percent" : "amount"}`}
                  className={fieldControlClass({ className: "min-w-0" })}
                />
                <span className="shrink-0 text-xs text-fg-muted" data-testid={mode === "fixed" ? "fee-currency" : undefined}>{mode === "percent" ? "%" : currencyLabel ?? "currency not confirmed"}</span>
              </span>
            </FieldLabel>
          </div>
          <p id={`${slug}-hint`} className="text-xs leading-relaxed text-fg-muted">
            {mode === "percent" ? "Based on the appointment’s session price, including any client-specific price, before tax." : `A fixed fee in your studio’s ${currencyLabel ?? "unconfirmed"} payment currency. Maximum $200.00.`}
            {" "}You review the exact amount before charging.
          </p>
          {fieldError && <p id={`${slug}-error`} role="alert" className="text-sm text-danger-fg">{fieldError}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-fg-muted">{dirty ? "Unsaved changes" : usable(saved) ? `Saved · ${summary}` : "Save a rule before turning this fee on."}</p>
            <Button type="submit" variant="primary" pending={pending && savingRule} disabled={pending || !dirty} data-testid={`${slug}-fee-save`}>Save rule</Button>
          </div>
        </form>
      )}
      <div id={`${slug}-state`} className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-sunken px-5 py-3 text-xs sm:px-6" data-testid={`${slug}-fee-enabled-status`}>
        <StatusPill>{saved.enabled ? "Saved as on" : "Off"}</StatusPill>
        <span className="text-fg-muted">{!saved.enabled ? "No fees can be charged." : sameRule(saved, serverRule) ? `${initial.status.effective}.` : "Checking availability… Refresh the page if this does not update."}</span>
        {!saved.enabled && dirty && <span className="text-fg-muted">Saving a rule keeps it off.</span>}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {message && !confirmEnable && <p role={message.kind === "error" ? "alert" : "status"} className={cx("px-5 py-3 text-sm sm:px-6", message.kind === "error" ? "text-danger-fg" : "text-fg-muted")}>{message.text}</p>}
      </div>
      <ConfirmDialog
        open={confirmEnable}
        title={`Turn on ${title.toLowerCase()}s?`}
        description={`Saved rule: ${summary}. This allows manual charges when payment requirements are met. Nothing is charged automatically. Each charge still needs your confirmation on an appointment.`}
        confirmLabel="Turn on fee"
        pending={pending}
        error={message?.kind === "error" ? message.text : null}
        onCancel={() => { setConfirmEnable(false); setMessage(null); }}
        onConfirm={() => changeEnabled(true)}
      />
    </section>
  );
}

export function FeeAmountsCard({ initialLateCancelCents, initialNoShowCents, lateCancel, noShow, currencyLabel }: Props) {
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-sm text-fg-muted">Set the rule, then choose whether to allow the fee. Saving never turns it on.</p>
      <FeeRuleCard feeType="late_cancel" title="Late cancellation fee" description="For appointments cancelled at short notice." slug="late-cancel" initial={lateCancel} initialCents={initialLateCancelCents} currencyLabel={currencyLabel} />
      <FeeRuleCard feeType="no_show" title="No-show fee" description="For appointments the client doesn’t attend." slug="no-show" initial={noShow} initialCents={initialNoShowCents} currencyLabel={currencyLabel} />
      <details className="rounded-lg border border-line px-5 py-1 sm:px-6">
        <summary className={cx("flex min-h-[44px] cursor-pointer items-center rounded-md text-sm font-medium", FOCUS_RING)}>How manual fees work</summary>
        <div className="space-y-3 pb-4 text-sm leading-relaxed text-fg-muted">
          <p>Both fees are off until you turn them on. Money is not charged here. Nothing is ever charged automatically, and saving here never charges anyone.</p>
          <p>Charge a fee from an appointment only when the client has a card on file and a signed card authorization. Review the exact amount before confirming each charge.</p>
          <p>Turning a fee off stops new charges of that type, including fees prepared but not yet sent. Payments already sent are not affected. Session payments are unaffected.</p>
          <p>Changes are recorded with who made them and when. Payment readiness and studio availability are checked separately from your saved on/off choice.</p>
        </div>
      </details>
    </div>
  );
}
