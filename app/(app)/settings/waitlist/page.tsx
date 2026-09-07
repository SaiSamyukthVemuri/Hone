import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { localLongDate } from "@/lib/booking/tz";
import {
  claimNextWaitlistEntriesAction,
  claimWaitlistEntryAction,
  expireWaitlistInvitationAction,
  releaseWaitlistEntryAction,
  removeWaitlistEntryAction,
  requeueWaitlistEntryAction,
} from "./actions";
import {
  ACTION_LABEL,
  STATUS_MEANING,
  actionAvailability,
  type AdmissionAction,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";

// ===========================================================================
// NEW-CLIENT WAITLIST — OPERATOR QUEUE (WAIT-02)
// ===========================================================================
//
// THE JOB THIS DOES. Before WAIT-02 the studio's waitlist was an inbox, so
// "who is waiting, how long, and can I take someone off?" meant scrolling
// email. This page answers exactly those three questions against the durable
// record and stops there.
//
// WHAT IT IS NOT — UPDATED BY WAIT-EXPOSE-01. It now surfaces the practitioner
// lifecycle that migrations 0188-0190 already shipped: claim (one, or the next
// N by the database's own queue order), release, record-expired and requeue,
// alongside the original removal. It still shows NO queue position to anyone,
// does NO ranking, forecasts no capacity, creates no appointment, edits no
// contact and takes no notes.
//
// It still cannot INVITE. `issue`, `redeem` and `record_conversion` are not
// referenced anywhere on this surface: issuing mints a token that must reach a
// real recipient, and redeem/conversion create a booking. Those wait on
// B1/B1.5c + B2.
//
// PEOPLE HERE ARE NOT CLIENTS. Nothing on this page links into a client
// record, because no client record exists: joining a waitlist creates none.
// That is why it does not live under /clients.
//
// AUTHORITY IS OWNER, THREE TIMES OVER. The route checks the role, the RLS
// policy on the table is `is_studio_owner`, and the removal command re-derives
// membership AND role in the database from the authenticated user id. A member
// who reaches this URL sees the denial card, and would see nothing even if the
// card were removed.
//
// ORDERING IS A TOTAL ORDER. (joined_at, id). Two people who submit in the
// same millisecond still have one stable, repeatable position, so the list
// does not shuffle between renders — and the index backing it is declared in
// exactly that column order.
// ===========================================================================

/**
 * One bounded page of the active queue. This is a display bound, NOT the size
 * of the queue: `count` below is a separate authoritative count over the whole
 * filtered set, so a studio with more waiting people than this is told the real
 * number and told that the list is truncated. Reading `data.length` as the
 * queue size is exactly the lie this split exists to prevent.
 */
const QUEUE_PAGE_SIZE = 100;

type WaitlistRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  joined_at: string;
  status: WaitlistEntryStatus;
};

/**
 * The states an operator can still act on. `converted` and `removed` are
 * terminal history and are deliberately NOT read here: including them would
 * spend the page's bound on rows nothing can be done to, and push live entries
 * off the end of a list whose whole job is showing what needs attention.
 */
const ACTIVE_STATUSES = ["waiting", "claimed", "invited", "expired", "released"] as const;

/** The order the sections appear in — most actionable first. */
const SECTIONS: ReadonlyArray<{ status: WaitlistEntryStatus; heading: string }> = [
  { status: "waiting", heading: "Waiting" },
  { status: "claimed", heading: "Held" },
  { status: "invited", heading: "Invited" },
  { status: "expired", heading: "Expired" },
  { status: "released", heading: "Returned to queue" },
];

/**
 * Which server action performs each lifecycle move.
 *
 * `invite` and `remove` are absent on purpose. Inviting is B2 work and is not
 * wired anywhere in this release; removal keeps its own two-step disclosure
 * below because it is terminal and a mis-tap must not perform it.
 */
const ACTION_FORMS: Partial<
  Record<AdmissionAction, (formData: FormData) => Promise<void>>
> = {
  claim: claimWaitlistEntryAction,
  release: releaseWaitlistEntryAction,
  requeue: requeueWaitlistEntryAction,
};

function DenialCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      {children}
    </div>
  );
}

/** Whole days between joining and now, floored. "0 days" is a valid answer. */
function daysWaiting(joinedAtIso: string, now: number): number {
  const joined = new Date(joinedAtIso).getTime();
  if (!Number.isFinite(joined)) return 0;
  return Math.max(0, Math.floor((now - joined) / 86_400_000));
}

function ageLabel(days: number): string {
  if (days === 0) return "Today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

export default async function WaitlistSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return <DenialCard>Only studio owners can see the new-client waitlist.</DenialCard>;
  }

  // RLS-scoped user client, NOT the service-role client: the read is genuinely
  // gated by `is_studio_owner` at the database rather than by this page having
  // remembered to filter. The explicit studio filter is defence in depth and
  // the leading column of the queue index.
  //
  // ONE query, bounded and ordered. No per-row follow-up read exists or could:
  // every column rendered below comes from this select.
  const supabase = await createClient();
  const { data, count, error } = await supabase
    .from("new_client_waitlist_entries")
    .select("id,name,email,phone,joined_at,status", { count: "exact" })
    .eq("studio_id", studio.id)
    .in("status", ACTIVE_STATUSES)
    .order("joined_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(QUEUE_PAGE_SIZE);

  if (error) {
    // Say so plainly instead of rendering an empty queue, which would read as
    // "nobody is waiting" — the one wrong answer this page can give.
    console.error(
      JSON.stringify({
        event: "waitlist_queue_load_failed",
        studioId: studio.id,
        code: error.code ?? "unknown",
        timestamp: new Date().toISOString(),
      }),
    );
    return (
      <DenialCard>
        The waitlist could not be loaded. Please refresh; if this continues,
        contact support rather than assuming the list is empty.
      </DenialCard>
    );
  }

  const rows = (data ?? []) as WaitlistRow[];
  // The authoritative total, from the count query — never `rows.length`, which
  // is capped at QUEUE_PAGE_SIZE.
  const active = count ?? rows.length;
  const truncated = rows.length < active;
  const now = Date.now();

  // WHETHER AN INVITATION HAS RUN OUT IS A DATABASE FACT, NOT A GUESS.
  //
  // "Record expired" may only be offered once `expires_at` has actually
  // elapsed: expiry RECORDS that the clock ran out, it does not cause it. The
  // operator's way to end a live invitation early is Release. So the elapsed
  // fact is read rather than assumed, and only for the entries that could use
  // it.
  const invitedIds = rows.filter((r) => r.status === "invited").map((r) => r.id);
  let cycleByEntry: Map<string, { elapsed: boolean; redeemed: boolean }> | null = new Map();
  if (invitedIds.length > 0) {
    // THE CURRENT CYCLE, NOT WHICHEVER ROW ARRIVES LAST.
    //
    // `new_client_waitlist_invitations` is APPEND-ONLY and undeletable, so an
    // entry that went invite -> expire -> requeue -> invite carries several
    // rows. Reading them unordered and letting each overwrite the previous
    // means an old elapsed row can mark a NEWER live invitation as elapsed and
    // surface "Record expired" prematurely — the exact premature expiry this
    // surface exists to prevent.
    //
    // A new invitation can only be issued once the previous one is terminal, so
    // the most recently ISSUED row is the current cycle by construction. The
    // order terminates in `id` because `issued_at` alone is not a total order.
    const invitations = await supabase
      .from("new_client_waitlist_invitations")
      .select("entry_id,expires_at,issued_at,redeemed_at,expired_at,released_at")
      .eq("studio_id", studio.id)
      .in("entry_id", invitedIds)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false });
    if (invitations.error) {
      // NULL means "we could not check", which is NOT the same as "not elapsed".
      // The control is withheld either way, but the sentence beside it has to
      // tell the truth about which of the two it is.
      console.error(
        JSON.stringify({
          event: "waitlist_invitation_window_read_failed",
          studioId: studio.id,
          code: invitations.error.code ?? "unknown",
          timestamp: new Date().toISOString(),
        }),
      );
      cycleByEntry = null;
    } else {
      for (const inv of (invitations.data ?? []) as Array<{
        entry_id: string;
        expires_at: string;
        redeemed_at: string | null;
        expired_at: string | null;
        released_at: string | null;
      }>) {
        // FIRST row per entry wins, and the read is ordered newest-first, so
        // this is the current cycle. Later rows for the same entry are history.
        if (cycleByEntry.has(inv.entry_id)) continue;
        const expiresAt = new Date(inv.expires_at).getTime();
        // `!= null` deliberately, not `!==`: an absent column must read as
        // "no terminal stamp", not as terminal. Strict inequality would make a
        // missing field mark a live invitation dead.
        const terminal =
          inv.redeemed_at != null || inv.expired_at != null || inv.released_at != null;
        cycleByEntry.set(inv.entry_id, {
          // Elapsed means: still live, and the clock has passed. A row already
          // carrying a terminal stamp is not something to record as expired.
          elapsed: !terminal && Number.isFinite(expiresAt) && expiresAt <= now,
          redeemed: inv.redeemed_at != null,
        });
      }
    }
  }

  // WHETHER ANYONE IS STILL WAITING IS A QUEUE FACT, NOT A PAGE FACT.
  //
  // The bounded read above is ONE mixed-status page. Once a studio has claimed
  // its oldest entries, those claimed rows still occupy that page while waiting
  // people sit beyond the limit — so deciding "is anyone waiting?" from the
  // slice would hide Claim next exactly when it is most needed. Counted
  // independently, with `head` so no rows cross the wire.
  const waitingCountRead = await supabase
    .from("new_client_waitlist_entries")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studio.id)
    .eq("status", "waiting");
  // A failed count must not hide the control: Claim next is a no-op when the
  // queue is empty, so offering it on an unknown count costs nothing, while
  // hiding it on an unknown count silently removes the studio's main action.
  const waitingCount = waitingCountRead.error ? null : (waitingCountRead.count ?? 0);
  const anyoneWaiting = waitingCount === null || waitingCount > 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-xl font-medium">Waitlist</h2>
        <p className="mt-1 text-sm text-neutral-500">
          New clients who asked to be contacted while new-client booking is by
          waitlist. They are not clients yet: nothing here has an appointment,
          an intake form or a record.
        </p>
      </section>

      <p className="text-sm font-medium" aria-live="polite">
        Waitlist entries: <span className="tabular-nums">{active}</span>
      </p>

      {/* CLAIM NEXT N — the database's queue order, not this page's.
          `claim_new_client_waitlist_entries` takes a COUNT and walks the
          existing canonical ordering. There is deliberately no "claim these
          selected people" bulk control: no command accepts an id list, and
          looping the single-entry command in TypeScript would invent
          partial-success semantics the database never agreed to. */}
      {anyoneWaiting && (
        <form
          action={claimNextWaitlistEntriesAction}
          className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-end"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Claim the next</span>
            <input
              type="number"
              name="count"
              defaultValue={5}
              min={1}
              max={25}
              inputMode="numeric"
              className="min-h-[44px] w-full rounded-md border border-neutral-300 px-3 text-base dark:border-neutral-700 sm:w-24"
            />
          </label>
          <button
            type="submit"
            className="min-h-[44px] rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Claim next
          </button>
          <span className="text-xs text-neutral-500">
            Takes them in the order they joined. Claiming holds someone for this
            studio; it does not contact them.
          </span>
        </form>
      )}

      {active === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          Nobody is waiting right now. New-client requests from your booking
          page will appear here.
        </div>
      ) : (
        <>
          {truncated && (
            <p className="text-sm text-neutral-500">
              Showing the {rows.length} longest-waiting of {active}. Some groups
              below may therefore be incomplete.
            </p>
          )}

          {SECTIONS.map(({ status, heading }) => {
            const group = rows.filter((r) => r.status === status);
            if (group.length === 0) return null;
            return (
              <section key={status} className="flex flex-col gap-3">
                <h3 className="text-sm font-medium" data-testid={`waitlist-section-${status}`}>
                  {heading} <span className="tabular-nums">({group.length})</span>
                </h3>
                <p className="text-sm text-neutral-500">{STATUS_MEANING[status]}</p>

                {/* One card per person, stacking naturally on a phone: no
                    horizontal table to scroll at 390px, and every contact detail
                    is selectable text so it can be copied straight into an email
                    or a phone app. */}
                <ul className="flex flex-col gap-3">
                  {group.map((row) => {
                    const days = daysWaiting(row.joined_at, now);
                    // PRESENTATION AVAILABILITY COMES FROM STORED STATE, never
                    // from firing a command and rendering its refusal. The RPC
                    // is still the authority — it re-derives everything — but a
                    // control the row's own state forbids is not offered.
                    const cycle = cycleByEntry === null ? null : cycleByEntry.get(row.id);
                    const elapsed = cycleByEntry === null ? undefined : cycle?.elapsed === true;
                    const redeemed =
                      cycleByEntry === null ? undefined : cycle?.redeemed === true;
                    return (
                      <li
                        key={row.id}
                        data-entry-status={row.status}
                        className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div className="flex min-w-0 flex-col gap-1">
                          <p className="font-medium break-words">{row.name}</p>
                          <p className="text-sm break-all text-neutral-600 dark:text-neutral-400">
                            {row.email}
                          </p>
                          {row.phone && (
                            <p className="text-sm text-neutral-600 dark:text-neutral-400">
                              {row.phone}
                            </p>
                          )}
                          <p className="text-sm text-neutral-500">
                            Joined {localLongDate(new Date(row.joined_at), studio.timezone)}
                            {" · "}
                            <span className="tabular-nums">{ageLabel(days)}</span> waiting
                          </p>
                        </div>

                        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                          {(["claim", "release", "expire", "requeue"] as AdmissionAction[]).map(
                            (action) => {
                              const verdict = actionAvailability(action, row.status, {
                                invitationElapsed: elapsed,
                                invitationRedeemed: redeemed,
                              });
                              if (!verdict.available) return null;
                              const formAction =
                                action === "expire"
                                  ? expireWaitlistInvitationAction
                                  : ACTION_FORMS[action];
                              if (!formAction) return null;
                              return (
                                <form key={action} action={formAction}>
                                  <input type="hidden" name="entry_id" value={row.id} />
                                  <button
                                    type="submit"
                                    data-testid={`waitlist-action-${action}`}
                                    className="min-h-[44px] w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900 sm:w-auto"
                                  >
                                    {ACTION_LABEL[action]}
                                  </button>
                                </form>
                              );
                            },
                          )}

                          {/* The invitation window could not be read, so whether
                              it has run out is UNKNOWN. Say that, rather than
                              letting the absent control imply "still live". */}
                          {row.status === "invited" && cycleByEntry === null && (
                            <span className="text-xs text-neutral-500">
                              Couldn&apos;t check whether this invitation has run
                              out. Release ends it either way.
                            </span>
                          )}

                          {/* REMOVE IS NOT OFFERED WHERE IT ALWAYS REFUSES.
                              `remove_new_client_waitlist_entry` answers
                              `release_required` for a held or invited entry and
                              changes nothing, so an owner who opened this and
                              pressed Confirm would get an avoidable error. The
                              same availability authority decides it. */}
                          {actionAvailability("remove", row.status).available && (
                          /* Two-step removal with no client JavaScript: the
                              confirm button does not exist in the DOM until the
                              disclosure is opened, so a mis-tap on a phone
                              cannot remove someone. Removal is terminal — the
                              row keeps its history, but it does not come back to
                              this queue. */
                          <details>
                            <summary className="min-h-[44px] cursor-pointer list-none rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 select-none hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900">
                              Remove
                            </summary>
                            <form
                              action={removeWaitlistEntryAction}
                              className="mt-2 flex flex-col gap-2"
                            >
                              <input type="hidden" name="entry_id" value={row.id} />
                              <p className="text-sm text-neutral-500">
                                Take {row.name} off the waitlist? This cannot be
                                undone from here.
                              </p>
                              <button
                                type="submit"
                                className="min-h-[44px] rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700/50 dark:text-red-300 dark:hover:bg-red-950/30"
                              >
                                Confirm removal
                              </button>
                            </form>
                          </details>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
