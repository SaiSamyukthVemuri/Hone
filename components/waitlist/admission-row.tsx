import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/control-base";
import type { AdmissionContext, WaitlistEntryStatus } from "@/lib/waitlist/admission-model";
import {
  controlState,
  entryActionSurface,
  practitionerStatusDetail,
  practitionerStatusLabel,
  type PractitionerActionItem,
} from "@/lib/waitlist/b4-invitation-draft";
import {
  RESEND_MINTS_A_NEW_LINK,
  type AdapterCapabilities,
} from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT-03 B4 — one waiting person, and the one thing to do about them
// ===========================================================================
//
// PRESENTATION ONLY. No "use client", no data fetching, no server action, no
// mutation. What may be offered is decided by `b4-invitation-draft`, which
// projects the live `admission-model`; this file chooses type, spacing and
// layout and nothing else.
//
// THE ROW A PRACTITIONER READS:
//
//     Sarah Jones                                    Waiting
//     Weekday availability
//     Waiting 41 days
//     [           Invite to book           ]
//
// ONE PRIMARY ACTION, FULL WIDTH. Not a menu of every lifecycle transition the
// database supports. The earlier revision rendered seven controls per row —
// Claim, Send invitation, Send a new invitation, Record expired, Release,
// Return to queue, Remove — most of them greyed, each with a sentence
// explaining which internal state forbade it. It was an accurate rendering of
// the state machine and the wrong screen: a practitioner scanning a queue is
// deciding who to invite, not adjudicating transitions.
//
// PRE-B2: NOTHING IS CONNECTED. `capabilities` is `null` until an adapter
// satisfying `WaitlistInvitationAdapter` exists, and every otherwise-available
// control renders disabled with a sentence that NAMES ITSELF — "“Invite to
// book” is not connected yet", never a generic line about sending. A row whose
// disabled Remove button explained itself with a sentence about sending was one
// of the three findings this redesign closes.

/** Ids must be unique per ENTRY, not per action.
 *
 *  A page renders many rows and the earlier revision emitted `id="reason-remove"`
 *  on all of them, so `aria-describedby` resolved to the FIRST match in the
 *  document and a screen reader announced another person's prerequisite on this
 *  person's control. Every id here is namespaced by the entry, and the entry id
 *  is reduced to id-safe characters and prefixed so the result is a valid,
 *  letter-initial identifier whatever the caller passes. */
function domId(entryId: string, suffix: string): string {
  return `wl-${entryId.replace(/[^A-Za-z0-9_-]/g, "-")}-${suffix}`;
}

export type AdmissionEntry = {
  id: string;
  name: string;
  /** Kept, though the product's row sketch shows only the name: a queue of
   *  strangers is exactly where two people share one, and this is the surface
   *  whose job is telling them apart. Rendered quietly, never as a heading. */
  email: string;
  /** The prospect's own stated availability, already summarised by the caller
   *  — "Weekday availability", "Evenings and weekends". `null` where they gave
   *  none, which renders nothing rather than an empty-looking line. */
  availabilityLabel: string | null;
  /** WHOLE DAYS IN THE QUEUE, COMPUTED SERVER-SIDE. This component performs no
   *  date arithmetic and no timezone work: "41 days" straddles a boundary that
   *  only the studio's own clock can settle, and a browser's guess at it would
   *  differ from the queue order the database actually used. */
  waitingDays: number;
  status: WaitlistEntryStatus;
  /** What the caller knows about the current invitation. Absent fields mean
   *  "not known", which several rulings deliberately treat as a refusal rather
   *  than as a negative — see the fail-closed notes in the model. */
  invitation?: AdmissionContext;
};

function StatusPill({
  status,
  context,
}: {
  status: WaitlistEntryStatus;
  context: AdmissionContext;
}) {
  // Status is carried by TEXT. Colour is reinforcement and never the carrier:
  // the states are not distinguishable by hue for a colour-blind practitioner,
  // and two of them ("Ready to return" and "Removed") are one decision apart in
  // consequence.
  const emphasised = status === "invited" || status === "expired";
  return (
    <span
      data-testid="admission-status"
      data-status={status}
      className={cx(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        emphasised ? "border-accent text-accent" : "border-line-strong text-fg-muted",
      )}
    >
      {practitionerStatusLabel(status, context)}
    </span>
  );
}

/** "Waiting 41 days", and the two edges either side of it. A row that reads
 *  "Waiting 0 days" on the morning someone joined is a small lie about how long
 *  they have been ignored. */
export function waitingLabel(days: number): string {
  if (days <= 0) return "Joined today";
  if (days === 1) return "Waiting 1 day";
  return `Waiting ${days} days`;
}

function ActionControl({
  entryId,
  item,
  capabilities,
  variant,
  note,
}: {
  entryId: string;
  item: PractitionerActionItem;
  capabilities: AdapterCapabilities | null;
  variant: "primary" | "secondary";
  /** A consequence worth stating even when the control is perfectly available
   *  — distinct from a refusal, which explains why it is not. */
  note?: string;
}) {
  const state = controlState(item, capabilities);
  const reasonId = state.reason ? domId(entryId, `reason-${item.action}`) : undefined;

  return (
    <div className="flex w-full flex-col gap-1">
      <button
        type="button"
        disabled={state.disabled}
        data-testid={`admission-action-${item.action}`}
        aria-describedby={reasonId}
        className={cx(
          buttonClasses({
            variant,
            size: variant === "primary" ? "md" : "sm",
            fullWidth: true,
          }),
          // One column on a phone; the secondary controls sit side by side only
          // where there is room. The primary stays full width at every size —
          // it is the row's whole purpose and never competes for a line.
          variant === "secondary" && "sm:w-auto",
        )}
      >
        {item.label}
      </button>
      {/* The reason sits WITH the control, not in a tooltip: a tooltip is
          unreachable by touch, which is the pointer this surface is most used
          with. */}
      {state.reason && (
        <span
          id={reasonId}
          data-testid={`admission-reason-${item.action}`}
          className="text-xs leading-snug text-fg-muted"
        >
          {state.reason}
        </span>
      )}
      {note && (
        <span
          data-testid={`admission-note-${item.action}`}
          className="text-xs leading-snug text-fg-muted"
        >
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * A destructive action behind a disclosure.
 *
 * `<details>` rather than a dialog: it is server-safe, needs no client
 * boundary, survives with JavaScript disabled, and is the pattern the live
 * waitlist surface already uses for removal. The consequence is stated in the
 * summary's own words — what stops working, and for whom — because "Are you
 * sure?" asks a question the practitioner has no way to answer.
 */
function DestructiveDisclosure({
  entryId,
  entryName,
  item,
  capabilities,
}: {
  entryId: string;
  entryName: string;
  item: PractitionerActionItem;
  capabilities: AdapterCapabilities | null;
}) {
  const state = controlState(item, capabilities);
  const reasonId = state.reason ? domId(entryId, `reason-${item.action}`) : undefined;
  const consequence =
    item.action === "cancel_invitation"
      // CANCELLING TAKES THEM OUT OF THE QUEUE. `cancelInvitation` ends at
      // `released`, and returning them is a SECOND, explicit act — so copy
      // promising they "keep their place" would leave a practitioner stopping
      // one step early with the person silently out of the active queue.
      ? `${entryName}'s booking link stops working straight away, and they come out of the queue. Return them to the waitlist to invite them again.`
      : `${entryName} is taken off the waitlist and loses their place in the queue. This cannot be undone.`;

  return (
    <details className="w-full sm:w-auto" data-testid={`admission-confirm-${item.action}`}>
      <summary
        data-testid={`admission-action-${item.action}`}
        aria-describedby={reasonId}
        className={cx(
          buttonClasses({ variant: "secondary", size: "sm", fullWidth: true }),
          "sm:w-auto",
          // A <summary> is not a <button>: the disabled attribute does nothing
          // on it, so an unavailable destructive action is rendered as plain
          // muted text with its reason rather than as a control that looks
          // pressable and is not.
          state.disabled && "pointer-events-none opacity-50",
        )}
      >
        {item.label}
      </summary>
      <div className="mt-2 flex flex-col gap-2 rounded-md border border-line-strong p-3">
        <p className="text-sm leading-snug text-fg">{consequence}</p>
        <button
          type="button"
          disabled={state.disabled}
          data-testid={`admission-confirm-submit-${item.action}`}
          className={buttonClasses({ variant: "danger", size: "sm", fullWidth: true })}
        >
          {item.label}
        </button>
      </div>
      {state.reason && (
        <span
          id={reasonId}
          data-testid={`admission-reason-${item.action}`}
          className="mt-1 block text-xs leading-snug text-fg-muted"
        >
          {state.reason}
        </span>
      )}
    </details>
  );
}

export function AdmissionActions({
  entryId,
  entryName,
  status,
  context = {},
  capabilities = null,
}: {
  entryId: string;
  entryName: string;
  status: WaitlistEntryStatus;
  context?: AdmissionContext;
  /** `null` until an adapter satisfying `WaitlistInvitationAdapter` is bound.
   *  There is no stub adapter in this repository, so this is the only value
   *  that exists today. */
  capabilities?: AdapterCapabilities | null;
}) {
  const surface = entryActionSurface(status, context);
  if (!surface.primary && surface.secondary.length === 0) return null;

  // A link the invitee can still use right now. Unknown facts count as "maybe",
  // and the warning is shown — telling someone a link might stop working is
  // recoverable; not telling them is not.
  const liveLinkExists =
    status === "invited" && !context.invitationRedeemed && context.invitationElapsed !== true;

  return (
    <div className="flex w-full flex-col gap-2" data-testid="admission-actions">
      {surface.primary && (
        <ActionControl
          entryId={entryId}
          item={surface.primary}
          capabilities={capabilities}
          variant="primary"
        />
      )}
      {surface.secondary.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          {surface.secondary.map((item) =>
            item.destructive ? (
              <DestructiveDisclosure
                key={item.action}
                entryId={entryId}
                entryName={entryName}
                item={item}
                capabilities={capabilities}
              />
            ) : (
              <ActionControl
                key={item.action}
                entryId={entryId}
                item={item}
                capabilities={capabilities}
                variant="secondary"
                note={
                  // Only where a WORKING link exists to be invalidated. On an
                  // invitation that has already run out there is nothing left
                  // to break, and the warning would be noise.
                  item.action === "resend_invitation" && liveLinkExists
                    ? RESEND_MINTS_A_NEW_LINK
                    : undefined
                }
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function AdmissionRow({
  entry,
  capabilities = null,
}: {
  entry: AdmissionEntry;
  capabilities?: AdapterCapabilities | null;
}) {
  const context = entry.invitation ?? {};
  return (
    <li
      data-testid="admission-row"
      data-entry-id={entry.id}
      // MOBILE FIRST, AND THE TABLET IS A THUMB. One column on a phone; the
      // action column moves beside the identity column only at `sm:`. There is
      // no `md:`/`lg:` step, because an iPad in portrait is 768px and still a
      // touch device — the controls keep their 44px floor at every width and
      // relax only on a fine pointer, which the primitive handles.
      className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* break-words, never truncate: a clipped name is a
              misidentification risk on the one surface whose job is telling
              two waiting people apart. */}
          <span className="break-words font-medium text-fg">{entry.name}</span>
          <StatusPill status={entry.status} context={context} />
        </div>
        {entry.availabilityLabel && (
          <span
            data-testid="admission-availability"
            className="break-words text-sm text-fg"
          >
            {entry.availabilityLabel}
          </span>
        )}
        <span
          data-testid="admission-standing"
          className="text-sm leading-snug text-fg-muted"
        >
          {entry.status === "waiting"
            ? waitingLabel(entry.waitingDays)
            : practitionerStatusDetail(entry.status, context)}
        </span>
        <span className="break-words text-xs text-fg-muted">{entry.email}</span>
      </div>

      {/* `sm:max-w-xs` keeps the action column from stretching the full width of
          a desktop table while the primary control stays full-width inside it. */}
      <div className="w-full sm:max-w-xs">
        <AdmissionActions
          entryId={entry.id}
          entryName={entry.name}
          status={entry.status}
          context={context}
          capabilities={capabilities}
        />
      </div>
    </li>
  );
}
