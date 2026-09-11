import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { localLongDate } from "@/lib/booking/tz";
// `claimWaitlistEntryAction` and `claimNextWaitlistEntriesAction` are
// deliberately NOT imported. Both still exist, are still tested and still reach
// their commands — this surface simply no longer offers claiming. See the
// CLAIMING IS INTERNAL note below.
import {
  expireWaitlistInvitationAction,
  releaseWaitlistEntryAction,
  removeWaitlistEntryAction,
  requeueWaitlistEntryAction,
} from "./actions";
import {
  STATUS_LABEL,
  STATUS_MEANING,
  actionAvailability,
  actionHelp,
  actionLabel,
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
// WHAT IT IS NOT. It surfaces the practitioner lifecycle that migrations
// 0188-0190 already shipped: setting someone aside, cancelling an invitation,
// recording an expiry, returning someone to the waitlist, and the original
// removal. It shows NO queue position to anyone, does NO ranking, forecasts no
// capacity, creates no appointment, edits no contact and takes no notes.
//
// A LABEL MAY ONLY PROMISE WHAT ITS COMMAND DELIVERS. `release` and `requeue`
// are two different transitions and must never read as one: release lands the
// entry in `released` (0189), and only requeue reaches `waiting` (0188). So
// "Return to waitlist" belongs to requeue alone, and release reads "Set aside"
// or "Cancel invitation" depending on what it is ending. `ACTION_RESULT_STATUS`
// in the model records each command's outcome, and a test refuses to let two
// controls with different outcomes share a label.
//
// CLAIMING IS INTERNAL, AND IS NOT SHOWN. `claimed` is a real database state and
// `claim_new_client_waitlist_entry(_ies)` are real, wired, tested commands —
// nothing about them changed. What changed is that this page stopped putting
// them in front of a practitioner. "Claim" describes how the queue moves an
// entry out of general contention; it is not a task a studio owner sets out to
// perform, and offering it made the surface read like an implementation detail
// rather than a list of people waiting to hear back.
//
// So: no Claim button, no "Claim the next N" form, and the state itself is shown
// as "Ready to invite" — which is what it MEANS to a practitioner. Entries
// already sitting in that state from the previous release keep working: they
// render, they are counted, and they can be set aside — which lands them in
// Released, where "Return to waitlist" then puts them back in line. Restoring
// any of this is a rendering change and nothing more, because no command, action
// or authority was touched to remove it.
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
//
// EVERY ROW STAYS REACHABLE, AND SO DOES ITS ONLY WAY OUT. Each section shows
// SECTION_PAGE_SIZE rows at a time and is navigable past that with
// `?section=<status>&page=<n>`. That is not a display nicety: an entry's escape
// action lives on its own row, so a row that cannot be displayed is an entry
// that cannot be released, expired or returned to the queue — and "Claim next
// N" can push the held section past one page on its own. The default view is
// unchanged, first page of all five sections; a group with more offers a link
// to the rest instead of a sentence saying it is incomplete.
// ===========================================================================

/**
 * How many rows one section shows at a time.
 *
 * A PAGE SIZE, NOT A CAP — and the difference is the whole point. Under a cap,
 * a section holding more than this stranded every row past it TOGETHER WITH ITS
 * ONLY ESCAPE ACTION: a claimed entry beyond the hundredth could never be
 * released, an invited one never expired, an expired one never returned to the
 * queue. "Claim next N" could itself create such rows, so the surface could
 * manufacture entries it was then unable to reach. Raising the number would
 * only move that cliff; every section is therefore NAVIGABLE past it, via
 * `?section=<status>&page=<n>` below.
 *
 * `count` remains a separate authoritative count over the whole filtered set,
 * so a studio is always told the real number. Reading `data.length` as the
 * queue size is exactly the lie this split exists to prevent.
 */
const SECTION_PAGE_SIZE = 100;

/** This route. Pagination links are plain hrefs to it: the read is decided
 *  entirely on the server, so a full navigation is the honest mechanism and
 *  costs the page no client JavaScript. */
const QUEUE_PATH = "/settings/waitlist";

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
 * also the set of states READ: one paged query per entry below, and the set a
 * `?section=` value is validated against.
 *
 * `converted` and `removed` are terminal history and are deliberately absent.
 * Reading them would spend a bound on rows nothing can be done to, and an
 * operator queue exists to show what still needs attention.
 */
const SECTION_STATUSES = [
  "waiting",
  "claimed",
  "invited",
  "expired",
  "released",
] as const satisfies ReadonlyArray<WaitlistEntryStatus>;

/**
 * THE HEADING IS THE STATE'S ONE PRACTITIONER-FACING NAME, read from the model
 * rather than written again here. A second copy is exactly how a state ends up
 * called "Held" in a heading and something else on the rows inside it.
 */
const SECTIONS: ReadonlyArray<{ status: WaitlistEntryStatus; heading: string }> =
  SECTION_STATUSES.map((status) => ({ status, heading: STATUS_LABEL[status] }));

/**
 * Which server action performs each lifecycle move THIS SURFACE OFFERS.
 *
 * `claim` is absent because claiming is no longer offered here, not because it
 * is unwired — `claimWaitlistEntryAction` is unchanged and still tested. Its
 * absence from this map is what makes the removal total: a `claim` verdict can
 * still come back available from the model and there is simply no form to
 * render for it.
 *
 * `invite` and `remove` are absent for their own reasons. Inviting is B2 work
 * and is not wired anywhere in this release; removal keeps its own two-step
 * disclosure below because it is terminal and a mis-tap must not perform it.
 */
const ACTION_FORMS: Partial<
  Record<AdmissionAction, (formData: FormData) => Promise<void>>
> = {
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

/** Next hands a repeated query param through as an array. Take the first
 *  rather than stringifying, which would turn `?page=2&page=3` into "2,3". */
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The requested page, 1-based.
 *
 * Anything unparseable, zero or negative becomes page one. A bad URL must land
 * on something real: rendering an empty section instead would read as "nobody
 * here", which is the one wrong answer this surface can give.
 */
function parsePageNumber(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function sectionHref(status: WaitlistEntryStatus, page = 1): string {
  return page <= 1
    ? `${QUEUE_PATH}?section=${status}`
    : `${QUEUE_PATH}?section=${status}&page=${page}`;
}

const NAV_LINK_CLASS =
  "inline-flex min-h-[44px] items-center rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900";

export default async function WaitlistSettingsPage({
  searchParams,
}: {
  // Next 15 App Router: searchParams is async, and a repeated param arrives as
  // an array. Both values are browser-controlled, so the type says so rather
  // than lying about it — and neither reaches a query except through the
  // validation immediately below.
  searchParams?: Promise<{ section?: string | string[]; page?: string | string[] }>;
}) {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return <DenialCard>Only studio owners can see the new-client waitlist.</DenialCard>;
  }

  // A SECTION IS HONOURED ONLY WHEN IT NAMES ONE OF THE FIVE READ STATES.
  // A typo, a terminal status, or an injected value falls back to the
  // all-sections view rather than rendering an empty page — and because the
  // value is matched against SECTIONS rather than passed through, nothing
  // browser-supplied ever reaches the `status` filter.
  const params = (await searchParams) ?? {};
  const requestedSection = firstParam(params.section);
  const focusedStatus =
    SECTIONS.find(({ status }) => status === requestedSection)?.status ?? null;
  // `page` is meaningless without a section, so it is only read alongside one.
  const pageNumber = focusedStatus ? parsePageNumber(firstParam(params.page)) : 1;

  // RLS-scoped user client, NOT the service-role client: the read is genuinely
  // gated by `is_studio_owner` at the database rather than by this page having
  // remembered to filter. The explicit studio filter is defence in depth and
  // the leading column of the queue index.
  //
  // ONE PAGED READ PER SECTION, not one global cap across all of them.
  //
  // A single bound over every active state lets one state starve the others:
  // fill the page with old expired/released rows and a freshly CLAIMED entry
  // falls off the end, taking its only escape action (Release) with it. The
  // operator would then have claimed someone they cannot subsequently reach.
  // Each section therefore carries its own window and its own exact count, so
  // no section can be crowded out by another's volume — and the existing
  // (studio_id, status, joined_at, id) index serves exactly this shape.
  //
  // ORDERING IS UNTOUCHED BY PAGING. `.range()` windows the SAME
  // (joined_at, id) total order the index declares, so page 2 is the rows the
  // database itself puts after page 1. Nothing here re-sorts or re-ranks.
  const supabase = await createClient();
  const rangeFrom = (pageNumber - 1) * SECTION_PAGE_SIZE;
  const sectionReads = await Promise.all(
    SECTIONS.map(async ({ status }) => {
      // IN A FOCUSED VIEW THE OTHER FOUR SECTIONS ARE STILL COUNTED — head-only,
      // so no rows come back but their exact counts do. Without that, the
      // headline "Waitlist entries: N" would quietly change meaning from "the
      // whole queue" to "this group", which is a different claim under the same
      // words. Five reads either way.
      const listed = focusedStatus === null || focusedStatus === status;
      const from = focusedStatus === status ? rangeFrom : 0;
      const query = supabase
        .from("new_client_waitlist_entries")
        .select("id,name,email,phone,joined_at,status", {
          count: "exact",
          head: !listed,
        })
        .eq("studio_id", studio.id)
        .eq("status", status)
        .order("joined_at", { ascending: true })
        .order("id", { ascending: true });
      const res = await (listed
        ? query.range(from, from + SECTION_PAGE_SIZE - 1)
        : query);
      return { status, res, from };
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
    { rows: WaitlistRow[]; total: number; from: number }
  >();
  for (const { status, res, from } of sectionReads) {
    const sectionRows = (res.data ?? []) as WaitlistRow[];
    // The authoritative total per section, from its own count — never
    // `rows.length`, which is one page of it. `from` travels with the rows
    // because "Showing 101–150" is a claim about the WINDOW, and only the read
    // knows which window it asked for.
    bySection.set(status, {
      rows: sectionRows,
      total: res.count ?? sectionRows.length,
      from,
    });
  }
  // Only the sections actually being listed contribute rows; a head-only read
  // has none by construction.
  const rows = SECTIONS.flatMap(({ status }) => bySection.get(status)?.rows ?? []);
  // The headline counts the WHOLE queue in both views, because every section is
  // counted in both views.
  const active = SECTIONS.reduce((n, { status }) => n + (bySection.get(status)?.total ?? 0), 0);
  // The FOCUSED view renders one section; the default renders all five, first
  // page each — the same read count, and the same rows a reader saw before.
  const visibleSections = focusedStatus
    ? SECTIONS.filter(({ status }) => status === focusedStatus)
    : SECTIONS;
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
        .is("released_at", null)
        // WAIT INTEGRATION-01 — THE PREDICATE MUST BE THE INDEX'S PREDICATE.
        //
        // The comment above names `..._one_live_per_entry` as the authority for
        // "which invitation is current", and that is right — but 0192 REDEFINED
        // that index. It is now FOUR columns:
        //
        //   where redeemed_at is null and expired_at is null
        //     and released_at is null and declined_at is null
        //
        // This read still asked 0188/0189's THREE. That is not a stylistic gap:
        // 0192 added `declined_at` precisely so a declined invitation stops
        // blocking its entry, so the database considers such a row CLOSED and
        // frees the entry for a later offer — while this page went on counting
        // it as live. The practitioner saw a phantom live invitation on a row
        // that was in fact available, with Cancel/Record-expired decided from a
        // dead cycle's clock.
        //
        // Neither component is wrong alone, which is why only an assembly finds
        // it: the page is correct against a pre-0192 schema, and 0192 is correct
        // on its own. Matching the index is the fix; no privilege changes and no
        // second opinion about liveness.
        //
        // MIGRATION-FIRST: this column exists because 0192 is in this candidate.
        // Deploying this read before hosted 0192 is applied would query a column
        // production does not have. See the PR body's deployment boundary.
        .is("declined_at", null),
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

      {/* NO BULK CLAIM CONTROL. "Claim the next N" was removed with the rest of
          the claiming vocabulary — see the CLAIMING IS INTERNAL note at the top
          of this file. `claim_new_client_waitlist_entries` and its server action
          are untouched and still tested; nothing on this page invokes them. */}

      {active === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          Nobody is waiting right now. New-client requests from your booking
          page will appear here.
        </div>
      ) : (
        <>
          {focusedStatus && (
            <p className="text-sm">
              <a href={QUEUE_PATH} className="underline">
                Back to all groups
              </a>
            </p>
          )}

          {visibleSections.map(({ status, heading }) => {
            const group = bySection.get(status);
            if (!group) return null;
            const focused = focusedStatus === status;
            // IN THE ALL-GROUPS VIEW an empty group is simply absent: an
            // operator queue shows what still needs attention. IN A FOCUSED
            // VIEW the group was asked for by name, so it must answer even when
            // the answer is "nobody" — an absent section would read as a broken
            // link rather than an empty group.
            if (!focused && group.total === 0) return null;
            const firstShown = group.from + 1;
            const lastShown = group.from + group.rows.length;
            // A PAGE PAST THE END returns no rows against a non-zero count.
            // Rendering that as an empty section would say "nobody here" about
            // a group that is not empty, so it says what actually happened and
            // offers the way back.
            const pastEnd = focused && group.rows.length === 0 && group.total > 0;
            const hasPrev = focused && pageNumber > 1;
            const hasNext = focused && lastShown < group.total;
            return (
              <section key={status} className="flex flex-col gap-3">
                <h3 className="text-sm font-medium" data-testid={`waitlist-section-${status}`}>
                  {/* THE GROUP'S OWN EXACT COUNT, not the number on screen.
                      `rows.length` here would restate the page size and tell a
                      studio with 150 held entries that it has 100. */}
                  {heading} <span className="tabular-nums">({group.total})</span>
                </h3>
                <p className="text-sm text-neutral-500">{STATUS_MEANING[status]}</p>

                {/* WHAT IS ON SCREEN, AND HOW TO REACH THE REST. The heading
                    carries the whole group; this line carries the window, and
                    in the all-groups view it carries the way through. */}
                {focused ? (
                  pastEnd ? (
                    <p className="text-sm text-neutral-500">
                      That page is past the end of this group, which holds{" "}
                      {group.total}.{" "}
                      <a
                        href={sectionHref(status)}
                        data-testid="waitlist-page-first"
                        className="underline"
                      >
                        Go to the first page
                      </a>
                    </p>
                  ) : group.total === 0 ? (
                    <p className="text-sm text-neutral-500">
                      Nobody is in this group right now.
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-500">
                      Showing {firstShown}–{lastShown} of {group.total}.
                    </p>
                  )
                ) : (
                  group.rows.length < group.total && (
                    <p className="text-sm text-neutral-500">
                      Showing the {group.rows.length} longest-waiting of{" "}
                      {group.total}.{" "}
                      <a
                        href={sectionHref(status)}
                        data-testid={`waitlist-section-all-${status}`}
                        className="underline"
                      >
                        Show all {group.total}
                      </a>
                    </p>
                  )
                )}

                {/* One card per person, stacking naturally on a phone: no
                    horizontal table to scroll at 390px, and every contact detail
                    is selectable text so it can be copied straight into an email
                    or a phone app. */}
                <ul className="flex flex-col gap-3">
                  {group.rows.map((row) => {
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
                        // WHICH PERSON THIS ROW IS, on the row itself.
                        //
                        // A control is only reachable if it is reachable ON THE
                        // ROW THAT NEEDS IT. Without an identifier here, "this
                        // page renders a Release" and "entry 150 can be
                        // released" are the same assertion — and on a page of
                        // a hundred claimed entries the first is satisfied by
                        // any of the other ninety-nine. This is what lets a
                        // test scope the second claim to one person.
                        //
                        // IT DISCLOSES NOTHING NEW. The id is already in this
                        // markup twice, as the hidden `entry_id` of each action
                        // form below, on a route that is owner-only three times
                        // over. It sits on the <li> rather than being read off
                        // those inputs because a row whose state offers no
                        // action has no form to read it from, and that row
                        // still has to be identifiable.
                        data-entry-id={row.id}
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
                          {/* CLAIM IS NOT IN THIS LIST. Claiming is an internal
                              transition, not a practitioner's job — the model
                              still rules on it and the command is untouched,
                              but nothing here asks for it. */}
                          {(["release", "expire", "requeue"] as AdmissionAction[]).map(
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
                              const help = actionHelp(action, row.status);
                              return (
                                <form key={action} action={formAction}>
                                  <input type="hidden" name="entry_id" value={row.id} />
                                  <button
                                    type="submit"
                                    data-testid={`waitlist-action-${action}`}
                                    className="min-h-[44px] w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900 sm:w-auto"
                                  >
                                    {/* THE ROW DECIDES THE VERB, AND IT MAY ONLY
                                        PROMISE WHAT THE COMMAND DELIVERS.
                                        Release reads "Set aside" on a ready-to-
                                        invite entry and "Cancel invitation" on
                                        an invited one — neither says "Return to
                                        waitlist", because release lands the
                                        entry in Released and only requeue
                                        reaches Waiting. */}
                                    {actionLabel(action, row.status)}
                                  </button>
                                  {/* The consequence, where the verb alone does
                                      not carry it. Beside the control, not in a
                                      tooltip: a tooltip is unreachable by touch. */}
                                  {help && (
                                    <span
                                      data-testid={`waitlist-action-help-${action}`}
                                      className="mt-1 block text-xs leading-snug text-neutral-500"
                                    >
                                      {help}
                                    </span>
                                  )}
                                </form>
                              );
                            },
                          )}

                          {/* The invitation window could not be read, so whether
                              it has run out is UNKNOWN. Say that, rather than
                              letting the absent control imply "still live". */}
                          {/* No action is offered here on purpose. An earlier
                              revision claimed Release worked regardless, which
                              was false: a redeemed invitation cannot be
                              released, and this is exactly the case where we do
                              not know whether it was. (The old sentence is not
                              quoted here — a reviewer matched it as live copy.) */}
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

                {/* PREV / NEXT — what turns a page size into a page. Without
                    it, row 101 of a group and the only action that can move it
                    are both unreachable. Rendered only where there is somewhere
                    to go, so a single-page group carries no dead controls. */}
                {(hasPrev || hasNext) && (
                  <nav aria-label={`${heading} pages`} className="flex flex-wrap gap-2">
                    {hasPrev && (
                      <a
                        href={sectionHref(status, pageNumber - 1)}
                        data-testid="waitlist-page-prev"
                        className={NAV_LINK_CLASS}
                      >
                        Previous
                      </a>
                    )}
                    {hasNext && (
                      <a
                        href={sectionHref(status, pageNumber + 1)}
                        data-testid="waitlist-page-next"
                        className={NAV_LINK_CLASS}
                      >
                        Next
                      </a>
                    )}
                  </nav>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
