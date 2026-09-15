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
import { fieldControlClass } from "@/components/ui/field";

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
}: {
  capacity: InvitationCapacity;
  startAction: (formData: FormData) => void | Promise<void>;
  closeAction: (formData: FormData) => void | Promise<void>;
  error?: string | null;
}) {
  const open = capacity.state === "open" ? capacity.capacity : null;

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
            <form action={startAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
          <form action={closeAction}>
            <button
              type="submit"
              data-testid="capacity-close"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              {CAPACITY_PANEL.closeLabel}
            </button>
          </form>
        </>
      )}

      {error && (
        <p data-testid="capacity-error" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
