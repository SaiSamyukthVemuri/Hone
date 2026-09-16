"use client";

import { useActionState } from "react";
import {
  CAPACITY_PANEL,
  ALLOWANCE_MAX,
  ALLOWANCE_MIN,
  isExhausted,
  remainingLabel,
  usageLabel,
  type InvitationCapacity,
} from "@/lib/waitlist/invitation-capacity";
import { buttonClasses } from "@/components/ui/button";
import type { CapacityActionResult } from "@/app/(app)/settings/waitlist/capacity-actions";
import { fieldControlClass } from "@/components/ui/field";

/** The (previousState, formData) => nextState shape `useActionState` binds. */
export type CapacityFormAction = (
  prev: CapacityActionResult | null,
  formData: FormData,
) => Promise<CapacityActionResult>;

/**
 * The owner's invitation-capacity control, above the queue.
 *
 * SPEAKS THE PRACTITIONER'S LANGUAGE, NOT THE DATABASE'S. The underlying object
 * is a `studio_waitlist_admission_round`; that phrase appears nowhere a
 * practitioner can read it. The question this panel asks is the decision the
 * owner actually makes — how many new clients they are ready to invite.
 *
 * NOTHING IS INFERRED. There is no default allowance, no capacity opened
 * automatically when waitlist mode is enabled, and no allowance derived from
 * calendar openings. The owner types a number and presses a button, or no
 * capacity exists.
 */
export function InvitationCapacityPanel({
  capacity,
  startAction,
  closeAction,
  error,
  initialStartState = null,
  initialCloseState = null,
}: {
  capacity: InvitationCapacity;
  startAction: CapacityFormAction;
  closeAction: CapacityFormAction;
  /** A message from the server render, if any. Action results take precedence. */
  error?: string | null;
  /**
   * The state each form starts from.
   *
   * A REAL `useActionState` PARAMETER, not a test hook: the hook's second
   * argument IS the initial state, and defaulting it to null is what "nothing
   * pressed yet" means. It is injectable because this repo renders components
   * through renderToStaticMarkup, which cannot press a button -- so without it
   * the wiring between a returned refusal and the rendered error could only be
   * asserted in two halves that never meet.
   */
  initialStartState?: CapacityActionResult | null;
  initialCloseState?: CapacityActionResult | null;
}) {
  const open = capacity.state === "open" ? capacity.capacity : null;

  // ONE STATE PER FORM, because a start refusal and a close refusal are
  // different answers and must not overwrite each other.
  const [startState, startFormAction, startPending] = useActionState(
    startAction,
    initialStartState,
  );
  const [closeState, closeFormAction, closePending] = useActionState(
    closeAction,
    initialCloseState,
  );

  // THE MOST RECENT ANSWER WINS. A pressed button that refused is what the owner
  // needs to read; the server-render message is only the fallback.
  const actionError =
    (startState && !startState.ok ? startState.message : null) ??
    (closeState && !closeState.ok ? closeState.message : null) ??
    error ??
    null;

  return (
    <section
      data-testid="invitation-capacity"
      className="flex flex-col gap-3 rounded-md border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <h3 className="text-base font-medium">{CAPACITY_PANEL.title}</h3>

      {open === null ? (
        <>
          <p data-testid="capacity-empty-body" className="text-sm text-neutral-500">
            {capacity.state === "unknown"
              ? "We couldn't check your invitation capacity just now. Reload the page before inviting."
              : CAPACITY_PANEL.emptyBody}
          </p>
          {capacity.state !== "unknown" && (
            <form action={startFormAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-neutral-500">{CAPACITY_PANEL.allowanceLabel}</span>
                <input
                  type="number"
                  name="allowance"
                  inputMode="numeric"
                  min={ALLOWANCE_MIN}
                  max={ALLOWANCE_MAX}
                  required
                  data-testid="capacity-allowance"
                  className={fieldControlClass()}
                />
              </label>
              <button
                type="submit"
                data-testid="capacity-start"
                disabled={startPending}
                className={buttonClasses({ variant: "primary", size: "md" })}
              >
                {CAPACITY_PANEL.startLabel}
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          <p data-testid="capacity-usage" className="text-sm">
            <span className="font-medium">{usageLabel(open)}</span>
            <span className="text-neutral-500"> · {remainingLabel(open)}</span>
          </p>
          {isExhausted(open) && (
            <p data-testid="capacity-exhausted" className="text-sm text-neutral-500">
              {/* The next step is the owner's DECISION. This never opens another
                  capacity on their behalf. */}
              You&rsquo;ve used all invitations in this batch. Close this capacity and start a new
              one when you&rsquo;re ready to invite more people.
            </p>
          )}
          <form action={closeFormAction}>
            <button
              type="submit"
              data-testid="capacity-close"
              disabled={closePending}
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              {CAPACITY_PANEL.closeLabel}
            </button>
          </form>
        </>
      )}

      {actionError && (
        // THE REFUSAL THE OWNER JUST CAUSED. Practitioner-safe copy only -- the
        // action layer translates every database code before it reaches here.
        <p data-testid="capacity-error" role="alert" className="text-sm text-danger">
          {actionError}
        </p>
      )}
    </section>
  );
}
