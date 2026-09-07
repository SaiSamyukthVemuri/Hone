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
  statusMeaning,
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
const SECTION_PAGE_SIZE = 100;

type WaitlistRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  joined_at: string;
  status: WaitlistEntryStatus;
};

/**
 * The sections, in the order they appear — most actionable first. This list is
 * also the set of states READ: one bounded query per entry below.
 *
 * `converted` and `removed` are terminal history and are deliberately absent.
 * Reading them would spend a bound on rows nothing can be done to, and an
 * operator queue exists to show what still needs attention.
 */
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
  // ONE BOUNDED READ PER SECTION, not one global cap across all of them.
  //
  // A single `.limit()` over every active state lets one state starve the
  // others: fill the page with old expired/released rows and a freshly CLAIMED
  // entry falls off the end, taking its only escape action (Release) with it.
  // The operator would then have claimed someone they cannot subsequently
  // reach. Each section therefore carries its own bound and its own exact
  // count, so no section can be crowded out by another's volume — and the
  // existing (studio_id, status, joined_at, id) index serves exactly this shape.
  const supabase = await createClient();
  const sectionReads = await Promise.all(
    SECTIONS.map(async ({ status }) => {
      const res = await supabase
        .from("new_client_waitlist_entries")
        .select("id,name,email,phone,joined_at,status", { count: "exact" })
        .eq("studio_id", studio.id)
        .eq("status", status)
        .order("joined_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(SECTION_PAGE_SIZE);
      return { status, res };
    }),
  );

  const failed = sectionReads.find(({ res }) => res.error);
  if (failed) {
    // Say so plainly instead of rendering an empty queue, which would read as
    // "nobody is waiting" — the one wrong answer this page can give. ANY
    // section failing collapses the whole surface: a partially rendered queue
    // is indistinguishable from a shorter one.
    console.error(
      JSON.stringify({
        event: "waitlist_queue_load_failed",
        studioId: studio.id,
        code: failed.res.error?.code ?? "unknown",
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

  const bySection = new Map<
    WaitlistEntryStatus,
    { rows: WaitlistRow[]; total: number }
  >();
  for (const { status, res } of sectionReads) {
    const sectionRows = (res.data ?? []) as WaitlistRow[];
    // The authoritative total per section, from its own count — never
    // `rows.length`, which is capped.
    bySection.set(status, { rows: sectionRows, total: res.count ?? sectionRows.length });
  }
  const rows = SECTIONS.flatMap(({ status }) => bySection.get(status)?.rows ?? []);
  const active = SECTIONS.reduce((n, { status }) => n + (bySection.get(status)?.total ?? 0), 0);
  const truncated = SECTIONS.some(
    ({ status }) => (bySection.get(status)?.rows.length ?? 0) < (bySection.get(status)?.total ?? 0),
  );
  // Whether anyone is waiting is now the waiting section's OWN exact count, so
  // it no longer depends on what happens to fit in a shared page.
  const anyoneWaiting = (bySection.get("waiting")?.total ?? 0) > 0;
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
    // THE LIVE INVITATION IS A SCHEMA INVARIANT, NOT A CHRONOLOGY GUESS.
    //
    // `new_client_waitlist_invitations` is append-only, so an entry that went
    // invite -> expire -> requeue -> invite carries several rows. An earlier
    // revision of this page chose the current one by `issued_at desc, id desc`
    // — which is EXACTLY the heuristic migration 0189 was written to remove.
    // Its own comment records why: two cycles completed inside ONE transaction
    // share an identical `issued_at`, so the tie-break fell to a random v4
    // UUID and "which invitation is current" was decided by coin flip; a
    // released historical row could win, and the genuine live cycle was left
    // unstamped.
    //
    // 0189 names the answer instead: `new_client_waitlist_invitations_one_live_
    // per_entry` is a UNIQUE index on (entry_id) WHERE redeemed_at, expired_at
    // and released_at are ALL null. At most one invitation per entry can be
    // live, so the live row IS the current cycle by construction, with no
    // ordering of any kind. This asks that question directly.
    //
    // REDEEMED IS ASKED SEPARATELY. A redeemed entry has no live row, and by
    // the same migration's lifecycle invariants it cannot acquire a later
    // cycle — so a redeemed stamp on an `invited` entry describes its current
    // cycle unambiguously.
    const [live, redeemed] = await Promise.all([
      supabase
        .from("new_client_waitlist_invitations")
        .select("entry_id,expires_at")
        .eq("studio_id", studio.id)
        .in("entry_id", invitedIds)
        .is("redeemed_at", null)
        .is("expired_at", null)
        .is("released_at", null),
      supabase
        .from("new_client_waitlist_invitations")
        .select("entry_id")
        .eq("studio_id", studio.id)
        .in("entry_id", invitedIds)
        .not("redeemed_at", "is", null),
    ]);

    if (live.error || redeemed.error) {
      // UNKNOWN — which is NOT "not elapsed" and NOT "not redeemed". Every
      // control that depends on the invitation is withheld, and the sentence
      // beside them says which of the two it is.
      console.error(
        JSON.stringify({
          event: "waitlist_invitation_window_read_failed",
          studioId: studio.id,
          code: (live.error ?? redeemed.error)?.code ?? "unknown",
          timestamp: new Date().toISOString(),
        }),
      );
      cycleByEntry = null;
    } else {
      const redeemedIds = new Set(
        ((redeemed.data ?? []) as Array<{ entry_id: string }>).map((r) => r.entry_id),
      );
      // Default every invited entry to "no live invitation": an entry with
      // neither a live nor a redeemed row offers nothing, which is the safe
      // direction.
      for (const id of invitedIds) {
        cycleByEntry.set(id, { elapsed: false, redeemed: redeemedIds.has(id) });
      }
      for (const inv of (live.data ?? []) as Array<{
        entry_id: string;
        expires_at: string;
      }>) {
        const expiresAt = new Date(inv.expires_at).getTime();
        cycleByEntry.set(inv.entry_id, {
          // A LIVE row whose clock has passed is the only thing that may be
          // recorded as expired.
          elapsed: Number.isFinite(expiresAt) && expiresAt <= now,
          redeemed: false,
        });
      }
    }
  }

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
                          {/* THE ROW SAYS WHAT THE PAGE ACTUALLY KNOWS. The
                              section sentence is status-only, and for `invited`
                              that is deliberately neutral — a redeemed entry
                              stays `invited` until conversion is recorded, so
                              "has not yet been used" would contradict this
                              row's own controls. Where the invitation facts are
                              loaded, the sentence is derived from them. */}
                          {row.status === "invited" && (
                            <p
                              data-testid="row-status-meaning"
                              className="text-sm text-neutral-500"
                            >
                              {statusMeaning("invited", {
                                invitationElapsed: elapsed,
                                invitationRedeemed: redeemed,
                                invitationFactsUnknown: cycleByEntry === null,
                              })}
                            </p>
                          )}
                        </div>

                        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                          {(["claim", "release", "expire", "requeue"] as AdmissionAction[]).map(
                            (action) => {
                              const verdict = actionAvailability(action, row.status, {
                                invitationElapsed: elapsed,
                                invitationRedeemed: redeemed,
                                invitationFactsUnknown: cycleByEntry === null,
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
                          {/* "Release ends it either way" USED TO SIT HERE and
                              was false: an invitation that has already been
                              redeemed cannot be released, and this is exactly
                              the case where we do not know whether it was. */}
                          {row.status === "invited" && cycleByEntry === null && (
                            <span className="text-xs text-neutral-500">
                              This invitation&apos;s current state could not be
                              checked, so no action is offered for it. Refresh to
                              try again.
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
