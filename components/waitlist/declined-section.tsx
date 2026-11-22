import Link from "next/link";
import { ReplyContactDetails } from "@/components/waitlist/reply-contact";
import type { ReplyContact } from "@/lib/waitlist/reply-contact-pure";
import {
  answersFor,
  DECLINE_OUTCOME_NOTE,
  declinedAtLabel,
  declinedPageHref,
  DECLINED_SHOW_MAX,
  type DeclinedPageWindow,
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
  scopedFollowUps,
  contacts,
  entryFactsUnreadable,
  linkableStatuses,
  entryPages,
  pageWindow,
  backHref,
}: {
  /** The people on THIS page (at most DECLINED_SHOW_MAX), newest decline first. */
  people: readonly DeclinedPerson[];
  /** Null when the decline records could not be read: the section says so, never "nobody declined". */
  total: number | null;
  timeZone: string;
  answersOn: boolean;
  followUps: FollowUpList | null;
  /** Each shown invitation's own follow-ups (any state), which decide the answers when the page list has no row for it. */
  scopedFollowUps?: ReadonlyMap<string, FollowUpList>;
  contacts: ReadonlyMap<string, ReplyContact> | null;
  entryFactsUnreadable: boolean;
  /** The entry states that have a section on this page, so a link is offered only where it can land. */
  linkableStatuses: ReadonlySet<string>;
  /** The queue page each entry sits on in its section. An entry absent here has no known page, so no link is offered for it. */
  entryPages: ReadonlyMap<string, number> | null;
  /** Which page of all the people who declined this is. */
  pageWindow: DeclinedPageWindow;
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
          {total > DECLINED_SHOW_MAX ? (
            <p className="text-sm text-neutral-600" data-testid="declined-showing">
              Showing {pageWindow.from + 1}–{pageWindow.to} of {total}, newest first. Page {pageWindow.page} of {pageWindow.pageCount}.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3" data-testid="declined-list">
            {shown.map((p) => {
              const a = answersFor(p.invitationId, answersOn, followUps, scopedFollowUps);
              const inQueue = p.entryStatus !== null && linkableStatuses.has(p.entryStatus);
              const entryPage = entryPages?.get(p.entryId);
              const canLink = inQueue && typeof entryPage === "number";
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
                      {a.kind === "not_collected" || a.kind === "none_on_record"
                        ? "Answer not collected"
                        : a.kind === "unreadable"
                          ? "We couldn’t load their answers just now."
                          : a.kind === "may_be_missing"
                            ? "Their answers may not be shown: the list is long."
                            : "Answer erased"}
                    </p>
                  )}
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {canLink ? (
                      <>
                        <Link
                          href={`/settings/waitlist?section=${p.entryStatus}${entryPage > 1 ? `&page=${entryPage}` : ""}#entry-${p.entryId}`}
                          className="underline"
                          data-testid="declined-entry-link"
                        >
                          Open their waitlist entry
                        </Link>
                      </>
                    ) : (
                      <span className="text-neutral-600" data-testid="declined-entry-state">
                        {p.entryStatus === null
                          ? "Their entry could not be read."
                          : !inQueue
                            ? "Their entry is no longer on the waitlist."
                            : "Their entry is on the waitlist, but its page could not be worked out just now. Find them in the waitlist above."}
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
          {pageWindow.pageCount > 1 ? (
            <nav aria-label="Pages of people who declined" className="flex flex-wrap items-center gap-3 text-sm" data-testid="declined-pages">
              {pageWindow.page > 1 ? (
                <Link href={declinedPageHref(backHref, pageWindow.page - 1)} rel="prev" className="underline" data-testid="declined-prev">
                  Previous page
                </Link>
              ) : null}
              {pageWindow.page < pageWindow.pageCount ? (
                <Link href={declinedPageHref(backHref, pageWindow.page + 1)} rel="next" className="underline" data-testid="declined-next">
                  Next page
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
