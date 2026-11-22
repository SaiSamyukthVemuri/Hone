import Link from "next/link";
import { ReplyContactDetails } from "@/components/waitlist/reply-contact";
import type { ReplyContact } from "@/lib/waitlist/reply-contact-pure";
import {
  answersFor,
  DECLINE_OUTCOME_NOTE,
  declinedAtLabel,
  DECLINED_SHOW_MAX,
  type DeclinedPerson,
} from "@/lib/waitlist/decline-visibility";
import type { FollowUpList } from "@/lib/waitlist/followups-owner";
import { OWNER_ANSWER_LABELS } from "@/components/waitlist/decline-follow-up-section";

// The people who declined, on the existing waitlist page. OWNER-ONLY BY CONSTRUCTION: it shows names, the people's own words and (behind a
// closed disclosure, through the EXISTING contact view) their contact details, so it is rendered only after the page's owner check.
// PRESENTATION ONLY: no read, no action, no form, no send. Opening a link or the disclosure changes nothing and messages no one.
// Contact details are not in the list, the address or the summary: only inside each person's own closed "Contact details".

export function DeclinedSection({
  people,
  total,
  timeZone,
  answersOn,
  followUps,
  contacts,
  entryFactsUnreadable,
  linkableStatuses,
  backHref,
}: {
  /** Every person who declined, newest first. Only the first DECLINED_SHOW_MAX are listed. */
  people: readonly DeclinedPerson[];
  /** Null when the decline records could not be read: the section says so, never "nobody declined". */
  total: number | null;
  timeZone: string;
  answersOn: boolean;
  followUps: FollowUpList | null;
  contacts: ReadonlyMap<string, ReplyContact> | null;
  entryFactsUnreadable: boolean;
  /** The entry states that have a section on this page, so a link is offered only where it can land. */
  linkableStatuses: ReadonlySet<string>;
  backHref: string;
}) {
  const shown = people.slice(0, DECLINED_SHOW_MAX);
  return (
    <section aria-labelledby="declined-people-heading" data-testid="declined-people" className="flex flex-col gap-3">
      <p className="text-sm">
        <Link href={backHref} className="underline" data-testid="declined-back">
          Back to the waitlist
        </Link>
      </p>
      <h2 id="declined-people-heading" tabIndex={-1} className="text-xl font-medium outline-none">
        People who declined {total === null ? null : <span className="tabular-nums">({total})</span>}
      </h2>
      <p className="text-sm text-neutral-500" data-testid="declined-outcome-note">
        {DECLINE_OUTCOME_NOTE}{" "}
        <Link href="/settings/waitlist/released" className="underline">
          Released and expired history
        </Link>
      </p>
      {total === null ? (
        <p role="status" className="text-sm" data-testid="declined-unknown">
          We couldn’t load the people who declined just now. Reload to try again.
        </p>
      ) : total === 0 ? (
        <p className="text-sm text-neutral-600" data-testid="declined-none">
          Nobody has declined the times offered.
        </p>
      ) : (
        <>
          {entryFactsUnreadable ? (
            <p role="status" className="text-sm" data-testid="declined-names-unreadable">
              We couldn’t load their names just now, so each row shows the decline only.
            </p>
          ) : null}
          {answersOn && followUps?.kind === "ok" && followUps.capped === true ? (
            <p className="text-xs text-neutral-600">Some answers may not be shown: the response list is capped.</p>
          ) : null}
          {total > shown.length ? (
            <p className="text-sm text-neutral-600" data-testid="declined-showing">
              Showing the {shown.length} most recent of {total}.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3" data-testid="declined-list">
            {shown.map((p) => {
              const a = answersFor(p.invitationId, answersOn, followUps);
              const canLink = p.entryStatus !== null && linkableStatuses.has(p.entryStatus);
              return (
                <li key={p.invitationId} data-entry-id={p.entryId} data-testid="declined-row" className="rounded-lg border border-line bg-surface p-4 text-sm">
                  <p className="font-medium" data-testid="declined-name">{p.name || "A person on the waitlist"}</p>
                  <p className="text-neutral-600" data-testid="declined-at">Declined {declinedAtLabel(p.declinedAt, timeZone)}</p>
                  {a.kind === "answers" ? (
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="declined-answers">
                      <dt className="text-neutral-600">{OWNER_ANSWER_LABELS.why}</dt>
                      <dd className="whitespace-pre-wrap break-words">{a.why}</dd>
                      <dt className="text-neutral-600">{OWNER_ANSWER_LABELS.better}</dt>
                      <dd className="whitespace-pre-wrap break-words">{a.better}</dd>
                    </dl>
                  ) : (
                    <p className="mt-1 text-neutral-600" data-testid="declined-answers-state" data-state={a.kind}>
                      {a.kind === "not_collected"
                        ? "Reasons and preferred times are not being collected yet."
                        : a.kind === "unreadable"
                          ? "We couldn’t load their answers just now."
                          : a.kind === "may_be_missing"
                            ? "Their answers may not be shown: the list is long."
                          : a.kind === "erased"
                            ? "Their answers have been removed from view."
                            : "No answers on record."}
                    </p>
                  )}
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {canLink ? (
                      <>
                        <Link href={`/settings/waitlist?section=${p.entryStatus}#entry-${p.entryId}`} className="underline" data-testid="declined-entry-link">
                          Open their waitlist entry
                        </Link>
                        <span className="text-xs text-neutral-600" data-testid="declined-entry-hint">
                          If this entry isn’t on the first page of its section, use the section’s pages to find it.
                        </span>
                      </>
                    ) : (
                      <span className="text-neutral-600" data-testid="declined-entry-state">
                        {p.entryStatus === null ? "Their entry could not be read." : "Their entry is no longer on the waitlist."}
                      </span>
                    )}
                  </p>
                  <details className="mt-2" data-testid="declined-contact">
                    <summary className="cursor-pointer underline">Contact details</summary>
                    <ReplyContactDetails entryId={p.entryId} contact={contacts?.get(p.entryId) ?? null} showEntryLink={false} />
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
