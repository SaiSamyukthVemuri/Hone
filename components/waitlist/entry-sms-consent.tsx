"use client";

import { useActionState, useState } from "react";

import type { WaitlistConsentActionResult } from "@/app/(app)/settings/waitlist/consent-actions";
import {
  PRACTITIONER_CONSENT_FIELDS,
  PRACTITIONER_SMS_CONSENT_SCOPE_TEXT,
  SMS_CONSENT_EVIDENCE_MAX,
} from "@/lib/waitlist/prospect-sms-consent";

/** The `(previousState, formData) => nextState` shape `useActionState` binds. */
export type SmsConsentFormAction = (
  prev: WaitlistConsentActionResult | null,
  formData: FormData,
) => Promise<WaitlistConsentActionResult>;

// ===========================================================================
// 0208 — one person's SMS standing, on their own row, and the owner's way to
// record consent they gave outside Hone.
// ===========================================================================
//
// THE ROW SAYS ONLY WHAT IS ON RECORD. A consent the person gave on the form and
// one the studio recorded are different facts with different evidence, so they
// read differently. A recorded consent whose day is unknown says so, instead
// of presenting the recording date as the day they agreed.
//
// NO DEFAULTS IN THE FORM. The attestation is an unticked box and the date
// answer is a pair of unselected radios: a default would let a hurried press
// record an agreement, or a day, that nobody stated.
//
// THE FORM APPEARS ONLY WHERE RECORDING IS VALID: no consent yet, no STOP, a
// mobile on file, still on the waitlist. The command refuses every other case
// anyway; hiding the control keeps the owner from being offered an action the
// database will decline.

export type SmsConsentView =
  | { kind: "opted_out" }
  | {
      kind: "consented";
      source: "public_form" | "prospect_link" | "practitioner";
      /** When Hone came to hold the consent, in the studio's terms. */
      recordedOnLabel: string;
      /** Practitioner records only: the day they agreed, or null when unknown. */
      agreedOnLabel: string | null;
    }
  | { kind: "none"; recordable: true }
  | { kind: "none"; recordable: false; reason: "no_phone" | "not_active" };

function statusLine(view: SmsConsentView): string {
  switch (view.kind) {
    case "opted_out":
      return "Texts: opted out (replied STOP)";
    case "consented":
      if (view.source === "practitioner") {
        return `Texts: consent recorded by the studio on ${view.recordedOnLabel} · they agreed ${
          view.agreedOnLabel ? `on ${view.agreedOnLabel}` : "on a day not known"
        }`;
      }
      return view.source === "public_form"
        ? `Texts: agreed on the waitlist form on ${view.recordedOnLabel}`
        : `Texts: agreed through their waitlist link on ${view.recordedOnLabel}`;
    case "none":
      if (!view.recordable && view.reason === "no_phone") {
        return "Texts: no consent on record · no mobile number on file";
      }
      return "Texts: no consent on record";
  }
}

export function EntrySmsConsent({
  entryId,
  entryName,
  view,
  action,
  initialState = null,
}: {
  entryId: string;
  /** Names the person in the controls' own labels, so a long queue stays distinguishable. */
  entryName: string;
  view: SmsConsentView;
  action: SmsConsentFormAction;
  initialState?: WaitlistConsentActionResult | null;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [dateKnown, setDateKnown] = useState<"known" | "unknown" | null>(null);
  const ids = {
    attest: `sms-consent-attest-${entryId}`,
    evidence: `sms-consent-evidence-${entryId}`,
    evidenceHelp: `sms-consent-evidence-help-${entryId}`,
    date: `sms-consent-date-${entryId}`,
  };

  return (
    <div className="flex flex-col gap-1" data-testid="entry-sms-consent">
      <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="sms-consent-status">
        {statusLine(view)}
      </p>

      {view.kind === "none" && view.recordable && (
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
            Record SMS consent for {entryName}
          </summary>
          <form action={formAction} className="mt-2 flex flex-col gap-3" data-testid="sms-consent-form">
            <input type="hidden" name="entry_id" value={entryId} />

            <label htmlFor={ids.attest} className="flex items-start gap-2">
              <input
                id={ids.attest}
                type="checkbox"
                name={PRACTITIONER_CONSENT_FIELDS.attest}
                value="yes"
                className="mt-1 h-4 w-4 flex-none"
              />
              <span>
                {entryName} agreed to {PRACTITIONER_SMS_CONSENT_SCOPE_TEXT}.
              </span>
            </label>

            <div className="flex flex-col gap-1">
              <label htmlFor={ids.evidence} className="text-xs text-neutral-500">
                Where is the evidence of their agreement?
              </label>
              <input
                id={ids.evidence}
                type="text"
                name={PRACTITIONER_CONSENT_FIELDS.evidence}
                maxLength={SMS_CONSENT_EVIDENCE_MAX}
                aria-describedby={ids.evidenceHelp}
                className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <p id={ids.evidenceHelp} className="text-xs text-neutral-500">
                A short reference, such as where the signed form is kept, or how and when they told you.
              </p>
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs text-neutral-500">When did they agree?</legend>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={PRACTITIONER_CONSENT_FIELDS.dateKnown}
                    value="known"
                    checked={dateKnown === "known"}
                    onChange={() => setDateKnown("known")}
                    className="h-4 w-4"
                  />
                  I know the day
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={PRACTITIONER_CONSENT_FIELDS.dateKnown}
                    value="unknown"
                    checked={dateKnown === "unknown"}
                    onChange={() => setDateKnown("unknown")}
                    className="h-4 w-4"
                  />
                  Day not known
                </label>
              </div>
              {dateKnown === "known" && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.date} className="text-xs text-neutral-500">
                    Day they agreed
                  </label>
                  <input
                    id={ids.date}
                    type="date"
                    name={PRACTITIONER_CONSENT_FIELDS.givenOn}
                    className="w-fit rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </div>
              )}
            </fieldset>

            <button
              type="submit"
              disabled={pending}
              className="w-fit rounded-md border border-neutral-300 px-3 py-1.5 disabled:opacity-60 dark:border-neutral-700"
              data-testid="sms-consent-save"
            >
              {pending ? "Recording…" : "Record consent"}
            </button>
          </form>
        </details>
      )}

      {state && !state.ok && (
        <p className="text-sm text-red-600" role="alert" data-testid="sms-consent-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
