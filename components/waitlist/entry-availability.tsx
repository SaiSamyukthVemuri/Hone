"use client";

import { useActionState } from "react";

import type { WaitlistProfileActionResult } from "@/app/(app)/settings/waitlist/profile-actions";
import {
  AVAILABILITY_PREFERENCES,
  AVAILABILITY_PREFERENCE_LABEL,
  type AvailabilityPreference,
} from "@/lib/waitlist/join-profile";

/** The `(previousState, formData) => nextState` shape `useActionState` binds. */
export type AvailabilityFormAction = (
  prev: WaitlistProfileActionResult | null,
  formData: FormData,
) => Promise<WaitlistProfileActionResult>;

// ===========================================================================
// WAIT-04A — one person's stated availability, on their own row
// ===========================================================================
//
// WHAT THIS IS NOT. It is not a filter, not a score, and not a promise about
// when they will be seen. It records WHAT THEY SAID so an operator composing an
// invitation is not guessing — the offer scope (`scope_allowed_weekdays` on the
// invitation) remains a separate, practitioner-chosen fact, and these two must
// never be conflated: one is what the person told us, the other is what the
// studio is offering.
//
// NO DEFAULT SELECTION. When nothing has been recorded the control opens on a
// placeholder, not on "both". Pre-selecting the most permissive value would let
// a distracted press write an answer the person never gave, and "both" is the
// value most likely to be wrong for a real person with a job.
//
// SUBMIT-ON-CHANGE IS DELIBERATELY NOT USED. A select that writes as it changes
// records a value on the way past it while scrolling a phone. The explicit
// button is one more press and one fewer wrong answer.

/**
 * WHAT THE ROW KNOWS about this person's availability.
 *
 * THREE CASES, AND THE THIRD IS NOT THE SECOND. "Not recorded" is a claim about
 * the PERSON — they have not told us. "Unknown" is a fact about the READ — we
 * could not look. Collapsing them would tell an operator that someone never
 * answered when in truth the query failed, and the operator would then ask a
 * question that had already been answered.
 */
export type AvailabilityView =
  | { kind: "recorded"; preference: AvailabilityPreference; confirmedAtLabel: string | null }
  | { kind: "unrecorded" }
  | { kind: "unknown" };

export function EntryAvailability({
  entryId,
  entryName,
  availability,
  action,
  initialState = null,
}: {
  entryId: string;
  /** Names the person in the control's own label, so a queue of fifty rows has fifty distinguishable controls. */
  entryName: string;
  availability: AvailabilityView;
  action: AvailabilityFormAction;
  initialState?: WaitlistProfileActionResult | null;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const selectId = `availability-${entryId}`;
  const current = availability.kind === "recorded" ? availability.preference : null;

  return (
    <div className="flex flex-col gap-1" data-testid="entry-availability">
      {/* The `unknown` case renders NO status line at all. The control below
          still appears, because being unable to read what someone said is no
          reason to stop being able to record it. */}
      {availability.kind === "unrecorded" && (
        <p className="text-sm text-neutral-500" data-testid="availability-unrecorded">
          Availability not recorded
        </p>
      )}
      {availability.kind === "recorded" && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span data-testid="availability-current">
            Available {AVAILABILITY_PREFERENCE_LABEL[availability.preference].toLowerCase()}
          </span>
          {availability.confirmedAtLabel && (
            <>
              {" · "}
              <span className="text-neutral-500" data-testid="availability-confirmed">
                confirmed {availability.confirmedAtLabel}
              </span>
            </>
          )}
        </p>
      )}

      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="entry_id" value={entryId} />
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-xs text-neutral-500">
            {current === null ? "Record availability for" : "Update availability for"}{" "}
            {entryName}
          </label>
          <select
            id={selectId}
            name="preference"
            defaultValue={current ?? ""}
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            data-testid="availability-select"
          >
            {/* The placeholder is NOT a submittable value: it carries the empty
                string, which the server rejects as "choose one of three"
                rather than silently writing a default. */}
            <option value="">Choose…</option>
            {AVAILABILITY_PREFERENCES.map((preference) => (
              <option key={preference} value={preference}>
                {AVAILABILITY_PREFERENCE_LABEL[preference]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700"
          data-testid="availability-save"
        >
          {pending ? "Saving…" : current === null ? "Record" : "Update"}
        </button>
      </form>

      {state && !state.ok && (
        <p className="text-sm text-red-600" role="alert" data-testid="availability-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
