import Link from "next/link";
import type { FollowUpRow } from "@/lib/waitlist/followups-owner";
import type { LinkableList } from "@/lib/waitlist/followup-linkable";
import { bellStatusLine, DECLINE_CARD_SAVED, emailStatusLine, emptyOutboxCounts, type OutboxCounts } from "@/lib/waitlist/decline-status-lines";
import { NO_TIMES_WORK_LABELS } from "@/lib/waitlist/decline-responses";
import {
  eraseAnswersAction,
  keepWithdrawalAction,
  linkAppointmentAction,
  markHandledAction,
} from "@/app/(app)/settings/waitlist/follow-up-actions";
import type { FollowUpNotice } from "@/lib/waitlist/follow-up-notice";

// HON-7 (b). The owner's follow-up section: the target of the `#follow-up` anchor the email, the bell and the sign-in return all land on.
// OWNER-ONLY BY CONSTRUCTION: it renders the recipient's answers, so it must only ever be rendered after the page's owner check (a test pins the
// call site's order). Data comes in as props; this performs no reads. Nothing here says "delivered", "queued" or "pending" about the email, and
// nothing auto-resolves: the owner's own action closes a response.

export const LINKABLE_MORE_COPY = "Showing the 10 most recently booked appointments";

export const FOLLOWUP_CAPPED_COPY = "Showing the first 500 responses. More are waiting; contact support to see the rest.";

const NOTICE_COPY: Record<FollowUpNotice, string> = {
  done: "Done.",
  already: "Already done.",
  refused: "That could not be done. Check the response and try again.",
  failed: "That did not go through. Nothing was changed, so please try again.",
};

function eraseDate(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(d);
  } catch {
    return null;
  }
}

const BUTTON =
  "inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

/** Two-step erase with no client JavaScript, the same pattern as Remove: the confirm button is not in the DOM until the disclosure is opened. */
function EraseControl({ id }: { id: string }) {
  return (
    <details data-testid="erase-control">
      <summary className={`${BUTTON} cursor-pointer list-none select-none`}>Erase answers</summary>
      <form action={eraseAnswersAction} className="mt-2 flex flex-col gap-2">
        <Hidden id={id} />
        <p className="break-words text-neutral-600 dark:text-neutral-400">
          Erase their answers now? This cannot be undone. The response itself stays, so you can still follow up.
        </p>
        <button type="submit" className={BUTTON}>
          Yes, erase the answers
        </button>
      </form>
    </details>
  );
}

function Hidden({ id }: { id: string }) {
  return <input type="hidden" name="followupId" value={id} />;
}

export function DeclineFollowUpSection({
  rows,
  timeZone,
  emailEnabled,
  outbox,
  linkable,
  notice,
  justSaved = false,
  capped = false,
}: {
  rows: FollowUpRow[];
  timeZone: string;
  emailEnabled: boolean;
  /** Outbox counts by invitation id; null when they could not be read. */
  outbox: Map<string, OutboxCounts> | null;
  /** This person's own appointments the owner may link, by follow-up id. */
  linkable: Map<string, LinkableList>;
  notice: FollowUpNotice | null;
  /** True when the owner arrived straight from a response being saved. */
  justSaved?: boolean;
  /** True when the list reached the database's 500-row cap: more responses may be waiting than are shown. */
  capped?: boolean;
}) {
  const open = rows.filter((r) => r.status === "open");
  return (
    <section
      id="follow-up"
      aria-labelledby="follow-up-heading"
      data-testid="decline-follow-up"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950"
    >
      <h2 id="follow-up-heading" className="font-medium">
        {`Waitlist responses (${open.length}${capped ? "+" : ""})`}
      </h2>
      {capped ? (
        <p className="mt-1" role="status" data-testid="follow-up-capped">
          {FOLLOWUP_CAPPED_COPY}
        </p>
      ) : null}
      {justSaved ? (
        <p className="mt-1" role="status">
          {DECLINE_CARD_SAVED}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-1" role="status" data-testid="follow-up-notice">
          {NOTICE_COPY[notice]}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="mt-1">No responses need follow-up.</p> : null}
      <ul className="mt-2 flex flex-col gap-4">
        {rows.map((r) => {
          const erased = r.answersErasedAt !== null;
          const hasAnswers = r.whyNotWork !== null || r.betterTimes !== null;
          const when = eraseDate(r.eraseBy, timeZone);
          const counts = outbox ? ((r.invitationId ? outbox.get(r.invitationId) : undefined) ?? emptyOutboxCounts()) : null;
          const emailLine = r.kind === "decline" ? emailStatusLine(emailEnabled, counts) : null;
          return (
            <li key={r.followupId} className="border-t border-amber-200 pt-3 first:border-t-0 first:pt-0" data-status={r.status} data-kind={r.kind}>
              <p className="font-medium">{r.clientName || "A person on the waitlist"}</p>
              {r.kind === "withdrawal" ? <p>{NO_TIMES_WORK_LABELS.noLongerNeed}.</p> : null}
              {erased ? (
                <p className="text-neutral-600 dark:text-neutral-400">
                  {eraseDate(r.answersErasedAt, timeZone) ? `Answers erased on ${eraseDate(r.answersErasedAt, timeZone)}.` : "Their answers have been erased."}
                </p>
              ) : r.whyNotWork !== null || r.betterTimes !== null ? (
                <dl className="mt-1">
                  <dt className="text-neutral-600 dark:text-neutral-400">{NO_TIMES_WORK_LABELS.why}</dt>
                  <dd className="whitespace-pre-wrap">{r.whyNotWork}</dd>
                  <dt className="mt-1 text-neutral-600 dark:text-neutral-400">{NO_TIMES_WORK_LABELS.better}</dt>
                  <dd className="whitespace-pre-wrap">{r.betterTimes}</dd>
                </dl>
              ) : null}
              {!erased && hasAnswers ? (
                <p className="mt-1 text-neutral-600 dark:text-neutral-400" data-testid="erase-by">
                  {when ? `Answers will be erased on ${when}.` : "Erase date unavailable. You can erase these answers now, or contact support."}
                </p>
              ) : null}
              {r.kind === "decline" ? (
                <>
                  <p className="mt-1 text-neutral-600 dark:text-neutral-400">{bellStatusLine()}</p>
                  <p className="text-neutral-600 dark:text-neutral-400">{emailLine}</p>
                </>
              ) : (
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">{bellStatusLine()}</p>
              )}
              {r.status === "open" ? (
                <div className="mt-2 flex flex-col gap-2">
                  {linkable.get(r.followupId)?.more ? (
                    <p className="text-neutral-600 dark:text-neutral-400" data-testid="linkable-more">
                      {LINKABLE_MORE_COPY}
                    </p>
                  ) : null}
                  {(linkable.get(r.followupId)?.items ?? []).map((a) => (
                    <form key={a.id} action={linkAppointmentAction}>
                      <Hidden id={r.followupId} />
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <button type="submit" className={BUTTON}>
                        Link booking: {a.label}
                      </button>
                    </form>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <Link href="/calendar" className={BUTTON}>
                      Book now
                    </Link>
                    {r.kind === "decline" ? (
                      <form action={markHandledAction}>
                        <Hidden id={r.followupId} />
                        <button type="submit" className={BUTTON}>
                          Mark handled
                        </button>
                      </form>
                    ) : (
                      <form action={keepWithdrawalAction}>
                        <Hidden id={r.followupId} />
                        <button type="submit" className={BUTTON}>
                          Keep on the waitlist
                        </button>
                      </form>
                    )}
                  </div>
                  <p className="text-neutral-600 dark:text-neutral-400">
                    Book now opens the calendar. After you book, the appointment appears here to link, which also covers someone who booked elsewhere.
                  </p>
                </div>
              ) : (
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">{STATUS_COPY[r.status]}</p>
              )}
              {!erased && hasAnswers ? (
                <div className="mt-2">
                  <EraseControl id={r.followupId} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const STATUS_COPY: Record<Exclude<FollowUpRow["status"], "open">, string> = {
  handled: "Handled.",
  kept: "Kept on the waitlist.",
  booked: "Booked and linked.",
  removed: "Removed from the waitlist.",
};
