import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/control-base";
import {
  PENDING_B2_NOTICE,
  STEP_BACKING,
  TTL_PRESETS,
  reviewSummary,
  validateDraft,
  type DraftStepId,
  type InvitationDraft,
} from "@/lib/waitlist/admission-model";

// ===========================================================================
// WAIT-03 B4 — the invitation composer
// ===========================================================================
//
// The brief's workflow, in order: choose people, service, booking horizon,
// allowed days, expiry, review, send.
//
// FOUR OF THOSE SEVEN STEPS HAVE NO SERVER CONTRACT. As of migration 0188 the
// only shipped command is
// `issue_new_client_waitlist_invitation(p_studio_id, p_entry_id,
// p_actor_user_id, p_ttl_hours)`. There is no service, horizon, weekday or date
// parameter anywhere. This component therefore renders those steps as what they
// are — intent the studio is recording for itself — and the review step states
// that in words rather than letting a filled-in field imply enforcement.
//
// That is the whole reason the composer exists before B2 rather than after: the
// shape of the collected intent is exactly the input B2 needs in order to decide
// which of it deserves a parameter. Building it as though the parameters already
// existed would hand B2 a design that quietly assumes its own conclusion.
//
// STATE IS A PROP. `step` and `draft` are supplied by the caller, so this
// component holds none and needs no client boundary — the same rule the Button
// primitive follows with `pending`.

const STEP_ORDER: ReadonlyArray<DraftStepId> = [
  "select",
  "service",
  "horizon",
  "days",
  "expiry",
  "review",
];

const STEP_TITLE: Record<DraftStepId, string> = {
  select: "Who to invite",
  service: "Service",
  horizon: "How far ahead they may book",
  days: "Days that suit the studio",
  expiry: "How long the invitation lasts",
  review: "Review",
};

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Marks a step whose value cannot reach the database yet. Rendered as a plain
 *  words-first badge, never a colour-only cue. */
function NotEnforcedBadge() {
  return (
    <span
      data-testid="step-not-enforced"
      className="inline-flex shrink-0 items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-fg-muted"
    >
      Not enforced yet
    </span>
  );
}

export function InviteComposerStep({
  step,
  draft,
}: {
  step: DraftStepId;
  draft: InvitationDraft;
}) {
  const pending = step !== "review" && STEP_BACKING[step] === "pending-b2";

  return (
    <section
      data-testid={`composer-step-${step}`}
      data-backing={step === "review" ? "review" : STEP_BACKING[step]}
      className="flex flex-col gap-3 px-4 py-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium text-fg">{STEP_TITLE[step]}</h2>
        {pending && <NotEnforcedBadge />}
      </div>

      {pending && (
        <p data-testid="step-pending-notice" className="text-sm leading-snug text-fg-muted">
          {PENDING_B2_NOTICE}
        </p>
      )}

      {step === "select" && (
        <p className="text-sm text-fg-muted">
          {draft.entryIds.length === 0
            ? "No one chosen yet."
            : draft.entryIds.length === 1
              ? "1 person chosen."
              : `${draft.entryIds.length} people chosen.`}
        </p>
      )}

      {step === "expiry" && (
        <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {TTL_PRESETS.map((preset) => (
            <li key={preset.hours} className="w-full sm:w-auto">
              <button
                type="button"
                data-testid={`ttl-preset-${preset.hours}`}
                aria-pressed={draft.ttlHours === preset.hours}
                className={cx(
                  buttonClasses({ variant: "secondary", size: "sm", fullWidth: true }),
                  "sm:w-auto",
                  // Selected state is a BORDER plus aria-pressed, not colour
                  // alone — the presets are otherwise identical boxes.
                  draft.ttlHours === preset.hours && "border-accent text-accent",
                )}
              >
                {preset.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === "days" && (
        <ul className="flex flex-wrap gap-2">
          {WEEKDAY_LABEL.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                data-testid={`weekday-${index}`}
                aria-pressed={draft.weekdays.includes(index)}
                className={cx(
                  buttonClasses({ variant: "secondary", size: "sm" }),
                  draft.weekdays.includes(index) && "border-accent text-accent",
                )}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {step === "review" && <ReviewPanel draft={draft} />}
    </section>
  );
}

/**
 * The review step, which is the one place a false promise would actually reach
 * the practitioner. Its whole job is keeping two lists apart: what the send will
 * DO, and what is only being written down.
 */
export function ReviewPanel({ draft }: { draft: InvitationDraft }) {
  const { enforced, notEnforced } = reviewSummary(draft);
  const validation = validateDraft(draft);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">What sending will do</h3>
        <ul data-testid="review-enforced" className="flex flex-col gap-1">
          {enforced.map((line) => (
            <li key={line} className="text-sm text-fg">
              {line}
            </li>
          ))}
        </ul>
      </div>

      {notEnforced.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-fg">
            Recorded, but not part of the invitation
          </h3>
          <ul data-testid="review-not-enforced" className="flex flex-col gap-1">
            {notEnforced.map((line) => (
              <li key={line} className="text-sm text-fg-muted">
                {line}
              </li>
            ))}
          </ul>
          <p className="text-xs leading-snug text-fg-muted">{PENDING_B2_NOTICE}</p>
        </div>
      )}

      {!validation.ok && (
        <ul data-testid="review-errors" className="flex flex-col gap-1">
          {Object.entries(validation.errors).map(([stepId, message]) => (
            <li key={stepId} className="text-sm text-danger">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InviteComposer({
  step,
  draft,
  connected = false,
}: {
  step: DraftStepId;
  draft: InvitationDraft;
  /** True only once B2's interface is frozen and wired. */
  connected?: boolean;
}) {
  const validation = validateDraft(draft);
  const onReview = step === "review";
  const sendBlocked = !connected || !validation.ok;
  const sendReason = !connected
    ? "Sending is not available in this release yet."
    : !validation.ok
      ? "Fix the highlighted steps before sending."
      : null;

  return (
    <div className="flex flex-col" data-testid="invite-composer">
      {/* The step rail wraps on a phone rather than scrolling sideways: a
          horizontally scrolled rail hides steps off-screen with no affordance,
          and this workflow's whole point is that the operator can see what they
          have and have not decided. */}
      <ol className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
        {STEP_ORDER.map((id, index) => (
          <li key={id}>
            <span
              data-testid={`composer-rail-${id}`}
              aria-current={id === step ? "step" : undefined}
              className={cx(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                id === step
                  ? "border-accent text-accent"
                  : "border-line-strong text-fg-muted",
              )}
            >
              <span aria-hidden="true">{index + 1}</span>
              {STEP_TITLE[id]}
            </span>
          </li>
        ))}
      </ol>

      <InviteComposerStep step={step} draft={draft} />

      {onReview && (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-end">
          {sendReason && (
            <span
              id="composer-send-reason"
              data-testid="composer-send-reason"
              className="text-xs leading-snug text-fg-muted"
            >
              {sendReason}
            </span>
          )}
          <button
            type="button"
            disabled={sendBlocked}
            data-testid="composer-send"
            aria-describedby={sendReason ? "composer-send-reason" : undefined}
            className={cx(
              buttonClasses({ variant: "primary", size: "md", fullWidth: true }),
              "sm:w-auto",
            )}
          >
            Send invitation
          </button>
        </div>
      )}
    </div>
  );
}
