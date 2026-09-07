import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/control-base";
import {
  STATUS_LABEL,
  STATUS_MEANING,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";
// The full menu — the five wired lifecycle actions PLUS invite and reinvite,
// neither of which any server action carries. That is why it is imported from
// the B4 module rather than the live one: this component is the prototype's
// surface, and nothing under `app/` renders it.
import { allActionAvailability } from "@/lib/waitlist/b4-invitation-draft";

// ===========================================================================
// WAIT-03 B4 — one waitlist entry, its state, and what may be done to it
// ===========================================================================
//
// PRESENTATION ONLY. No "use client", no data fetching, no server action, no
// mutation. Everything it renders is decided by `admission-model`, which is
// pure; this file chooses type, spacing and layout and nothing else.
//
// WHY EVERY ACTION IS RENDERED, INCLUDING THE ONES THAT CANNOT RUN. Hiding an
// unavailable action teaches a practitioner that it does not exist. Showing it
// disabled, WITH the reason and the remedy, teaches them when it will. The
// reason is never composed here — it comes from the same function that decided
// availability, so a control and its explanation cannot drift apart.
//
// PRE-B2: NOTHING IS CONNECTED. B2 owns the server interface and is not frozen,
// so `connected` defaults to false and every otherwise-available action renders
// disabled with a plain statement that it is not wired yet. That is deliberately
// a DIFFERENT sentence from a lifecycle refusal: "you cannot do this yet"
// and "you cannot do this to someone who has already booked" are different
// facts, and collapsing them would be the same conflation this project rejected
// when a failed read was reported as a question nobody asked.

const NOT_CONNECTED_REASON =
  "Sending is not available in this release yet.";

export type AdmissionEntry = {
  id: string;
  name: string;
  email: string;
  /** Studio-local, already formatted by the caller. This component performs no
   *  timezone work: the studio's clock is server truth, not a browser guess. */
  joinedLabel: string;
  status: WaitlistEntryStatus;
};

function StatusPill({ status }: { status: WaitlistEntryStatus }) {
  // Status is conveyed by TEXT first. Colour is a reinforcement, never the
  // carrier — the six states are not distinguishable by hue alone for a
  // colour-blind practitioner, and several of them are one letter apart in
  // consequence ("Returned to queue" vs "Removed").
  const tone: Record<WaitlistEntryStatus, string> = {
    waiting: "border-line-strong text-fg-muted",
    claimed: "border-line-strong text-fg",
    invited: "border-accent text-accent",
    converted: "border-line-strong text-fg-muted",
    expired: "border-line-strong text-fg-muted",
    released: "border-line-strong text-fg-muted",
    removed: "border-line-strong text-fg-muted",
  };
  return (
    <span
      data-testid="admission-status"
      data-status={status}
      className={cx(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function AdmissionActions({
  status,
  connected = false,
}: {
  status: WaitlistEntryStatus;
  /** True only once B2's server interface is frozen and wired. Until then every
   *  available action still renders, and still refuses, with its own reason. */
  connected?: boolean;
}) {
  const items = allActionAvailability(status);
  return (
    <ul className="flex w-full flex-col gap-2 sm:w-auto" data-testid="admission-actions">
      {items.map((item) => {
        const blockedByRelease = item.available && !connected;
        const disabled = !item.available || blockedByRelease;
        const reason = item.available
          ? blockedByRelease
            ? NOT_CONNECTED_REASON
            : null
          : item.reason;

        return (
          <li key={item.action} className="flex w-full flex-col gap-1 sm:w-auto">
            <button
              type="button"
              disabled={disabled}
              data-testid={`admission-action-${item.action}`}
              aria-describedby={reason ? `reason-${item.action}` : undefined}
              className={cx(
                buttonClasses({ variant: "secondary", size: "sm", fullWidth: true }),
                "sm:w-auto",
              )}
            >
              {item.label}
            </button>
            {/* The reason sits WITH the control, not in a tooltip: a tooltip is
                unreachable by touch, which is the pointer this surface is most
                used with. */}
            {reason && (
              <span
                id={`reason-${item.action}`}
                data-testid={`admission-reason-${item.action}`}
                className="text-xs leading-snug text-fg-muted"
              >
                {reason}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AdmissionRow({
  entry,
  connected = false,
}: {
  entry: AdmissionEntry;
  connected?: boolean;
}) {
  return (
    <li
      data-testid="admission-row"
      data-entry-id={entry.id}
      // MOBILE FIRST, AND THE TABLET IS A THUMB. One column on a phone; the
      // action column moves beside the identity column only at `sm:`. There is
      // no `md:`/`lg:` step, because an iPad in portrait is 768px and still a
      // touch device — the controls keep their 44px floor at every width and
      // relax only on a fine pointer, which the primitive handles.
      className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* break-words, never truncate: a clipped name is a
              misidentification risk on the one surface whose job is telling
              two waiting people apart. */}
          <span className="break-words font-medium text-fg">{entry.name}</span>
          <StatusPill status={entry.status} />
        </div>
        <span className="break-words text-sm text-fg-muted">{entry.email}</span>
        <span className="text-xs text-fg-muted">Joined {entry.joinedLabel}</span>
        <span
          data-testid="admission-status-meaning"
          className="text-xs leading-snug text-fg-muted"
        >
          {STATUS_MEANING[entry.status]}
        </span>
      </div>

      <AdmissionActions status={entry.status} connected={connected} />
    </li>
  );
}
