import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVITE_ADMISSION_CLOSED_BANNER_COPY,
  INVITE_ADMISSION_UNREADABLE_COPY,
  INVITE_CLOSED_INVITED_ONLY_COPY,
} from "@/lib/waitlist/invite-to-book-contract";
import { CAPACITY_EXHAUSTED_COPY } from "@/lib/waitlist/invitation-capacity";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
  NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// WAIT-02 — THE OPERATOR QUEUE
// ===========================================================================
//
// Renders the REAL server component and asserts on its OUTPUT, and drives the
// REAL removal action against a recorded command layer. What matters:
//
//   1. OWNER ONLY. A member sees the denial card, not a list of contactable
//      people, and the removal action refuses them.
//   2. THE COUNT IS AUTHORITATIVE. "Waiting: N" comes from a count over the
//      whole filtered set, never from the length of a capped page — the one
//      wrong answer this surface can give.
//   3. ONE BOUNDED, ORDERED QUERY. Oldest first, id tie-break, studio-scoped,
//      status-scoped, limited. No per-row follow-up read.
//   4. A LOAD FAILURE IS NOT AN EMPTY QUEUE.
//   5. REMOVAL GOES THROUGH THE COMMAND, with server-derived tenant and actor.
//
// The database half — that RLS actually refuses a member and that the command
// actually re-derives the role — is proved in
// tests/db/new-client-waitlist-entries.db.test.ts. This file proves the surface
// asks the right questions and renders the right answers.

const STUDIO_ID = "44444444-4444-4444-8444-444444444444";
/** The decline-visibility count read (every declined invitation of the studio): a constant-cost read of its own, counted separately from the per-row reads. */
const DECLINE_COUNT_READ = "id,entry_id,declined_at";
// The invitation-to-booking summary's own reads: exact HEAD-ONLY counts under the period filter (constant cost, seven per page), counted separately below.
const isSummaryRead = (q: QueryShape) => q.table === "new_client_waitlist_invitations" && q.filters.some((f) => f[0] === "gte" && f[1] === "issued_at");
/**
 * The one entries projection. 0208 added the four SMS-standing columns; the
 * evidence reference and the recorder are deliberately absent, because the
 * queue states what is on record and never renders the owner's own note.
 */
const ENTRY_COLUMNS =
  "id,name,email,phone,joined_at,status,source,joined_at_provenance," +
  "sms_consent_at,sms_consent_source,sms_consent_given_on,sms_opted_out_at";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const SLUG = "queue-studio";

type QueryShape = {
  /** WHICH client issued it. The page must build exactly one. */
  clientId: number;
  table: string;
  columns: string;
  options: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
  orders: Array<[string, { ascending?: boolean } | undefined]>;
  limit: number | null;
  /** The window the page asked for, inclusive on both ends — PostgREST's own
   *  shape. Recorded separately from `limit` so a test can tell "the first
   *  hundred" apart from "the hundred after the first". */
  range: [number, number] | null;
};

type RpcCall = { fn: string; args: Record<string, unknown> };

const queries: QueryShape[] = [];

/**
 * EVERY createClient() CALL, not merely every query.
 *
 * WHAT THIS REPLACES. The suite shared ONE global query log across every mock
 * client, so "exactly one capacity query" was true of a page that built a
 * SECOND client and issued one query from it. Counting queries could never
 * prove the ruling -- one owner-scoped instance for the queue and the capacity
 * read -- so each client now gets an id and every query carries the id of the
 * client that issued it.
 */
const clientInstances: number[] = [];

/**
 * THE FIRST ENTRIES READ, BY NAME RATHER THAN BY POSITION.
 *
 * These assertions used to index `queries[0]`, which was only ever shorthand for
 * "the queue read" -- true while the page issued exactly one shape first. The
 * page now also reads its invitation capacity on the SAME client, so position
 * no longer identifies the query. Naming the table asserts the same thing about
 * the same read; nothing is relaxed, and a page that stopped issuing it at all
 * fails here rather than silently asserting about a different query.
 */
function entriesQuery(): QueryShape {
  const q = queries.find((x) => x.table === "new_client_waitlist_entries");
  if (!q) throw new Error("the page issued no new_client_waitlist_entries read");
  return q;
}

/**
 * The rendered form of a constant.
 *
 * React escapes text nodes, so a constant containing an apostrophe reaches the
 * markup as `&#x27;`. Asserting the raw string silently misses -- which is how
 * the send-unavailable copy slipped past an earlier strip. Escaping here keeps
 * the CONSTANT the single source of the sentence rather than duplicating it in
 * pre-escaped form.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** The capacity read, for the guards that pin its scope. */
function capacityQuery(): QueryShape {
  const q = queries.find((x) => x.table === "studio_waitlist_admission_rounds");
  if (!q) throw new Error("the page issued no studio_waitlist_admission_rounds read");
  return q;
}
const rpcCalls: RpcCall[] = [];
const userRpcCalls: RpcCall[] = [];
const summaryRpc: { error: null | { code: string } } = { error: null };
const SUMMARY_ROW = { invitations_total: 20, people_invited: 17, booked_linked_live: 5, booked_then_cancelled: 1, converted_unlinked: 1 };
const revalidated: string[] = [];
const consoleErrors: string[] = [];
const consoleWarns: string[] = [];

const scenario = {
  role: "owner" as string,
  userId: USER_ID as string | null,
  rows: [] as Array<Record<string, unknown>>,
  count: null as number | null,
  error: null as { code: string; message: string } | null,
  removeResult: "removed" as string | null,
  removeError: null as { code: string } | null,
  // The LIVE invitation read — the rows whose three terminal stamps are all
  // null. At most one per entry, by the 0189 unique index.
  liveInvitations: [] as Array<Record<string, unknown>>,
  // The studio-wide expiry read (no entry-id filter): null serves the same rows as the live read; a test seeds it to put an expiry OFF the page.
  studioExpiries: null as Array<Record<string, unknown>> | null,
  // The exact count PostgREST would report for that read (Content-Range). Absent means "the rows seeded". A test sets it above 1000 to model the API's row ceiling.
  studioExpiryCount: null as number | null,
  // A failure of the summary read alone (the page's own invitation reads still succeed).
  studioExpiriesError: null as { code: string } | null,
  // DECLINE VISIBILITY. The declined-invitation read (id,entry_id,declined_at), its exact count, a failure of that read alone, the names/states read
  // for the people listed, and the contact read (id,email,phone) the existing contact view uses.
  declinedInvitations: [] as Array<Record<string, unknown>>,
  declinedCount: null as number | null,
  declinedError: null as { code: string } | null,
  declineEntries: [] as Array<Record<string, unknown>>,
  aheadOf: {} as Record<string, number>,
  positionError: null as { code: string } | null,
  contactRows: [] as Array<Record<string, unknown>>,
  // The REDEEMED invitation read, asked separately.
  redeemedInvitations: [] as Array<Record<string, unknown>>,
  invitationsError: null as { code: string } | null,
  // The studio's services, as the composer's selector reads them. `active` is
  // carried because the canonical new-client predicate reads it.
  services: [] as Array<Record<string, unknown>>,
  servicesError: null as { code: string } | null,
  // Per-section totals, when a test needs a count LARGER than the rows it
  // seeded (truncation). Absent means "the count equals what was seeded".
  sectionTotals: null as Record<string, number> | null,
  // THE OPEN INVITATION CAPACITY, as the page's OWN client reads it. `null` is
  // the honest default: most of this suite predates capacity and a studio that
  // has never opened one is the ordinary state. A row here is what the owner
  // RLS policy would return.
  // The allowance estimate the page shows (the real action needs a second client and the slot engine).
  allowance: { ok: true, fit: 4, outstanding: 1, open: 3, outstandingScope: "window" } as Record<string, unknown>,
  openRound: null as Record<string, unknown> | null,
  roundsError: null as { code: string } | null,
  // Deliberately answerable as a SECOND row, so the impossible-shape branch can
  // be exercised: the one-open-round index forbids it, and the page must treat
  // it as unknown rather than picking one.
  extraOpenRound: null as Record<string, unknown> | null,
  // The database's own consumed count, which the page reads and never recomputes.
  roundConsumed: 0 as number | null,
  // WAIT-04A — STATED AVAILABILITY, as the owner's own client reads it under
  // the 0193 owner SELECT policy. Empty is the honest default: the command that
  // writes these shipped with no caller until this slice, so no studio has one.
  preferences: [] as Array<Record<string, unknown>>,
  preferencesError: null as { code: string } | null,
  // NEGATIVE CONTROL SWITCH. True makes the fake ignore the window's OFFSET and
  // answer every page with the top of the section — the read as it behaved
  // before pagination. Every assertion about reaching a later page must fail
  // against it, or it was proving nothing.
  ignoreRange: false,
};

function reset() {
  queries.length = 0;
  clientInstances.length = 0;
  rpcCalls.length = 0;
  userRpcCalls.length = 0;
  summaryRpc.error = null;
  revalidated.length = 0;
  consoleErrors.length = 0;
  consoleWarns.length = 0;
  flash.sets = [];
  flash.value = undefined;
  readback.value = { known: false };
  Object.assign(scenario, {
    role: "owner",
    userId: USER_ID,
    rows: [],
    count: null,
    error: null,
    removeResult: "removed",
    removeError: null,
    liveInvitations: [],
    studioExpiries: null,
    studioExpiryCount: null,
    studioExpiriesError: null,
    declinedInvitations: [],
    declinedCount: null,
    declinedError: null,
    declineEntries: [],
    aheadOf: {},
    positionError: null,
    contactRows: [],
    redeemedInvitations: [],
    invitationsError: null,
    services: [],
    servicesError: null,
    sectionTotals: null,
    preferences: [],
    preferencesError: null,
    allowance: { ok: true, fit: 4, outstanding: 1, open: 3, outstandingScope: "window" },
    openRound: null,
    roundsError: null,
    extraOpenRound: null,
    roundConsumed: 0,
    ignoreRange: false,
  });
  estimateCalls.length = 0;
}

// NEW-CLIENT-MODE-01: admission now comes from the canonical authority.
// Delegating to the REAL resolver with no stored value routes it through the
// transition bridge, so the env stubbing below keeps meaning what it meant.
// The three owner follow-up cards read through these loaders. A test may force a result to model
// "zero active entries but n>0 items"; null passes through to the real loader (every other test).
const followUp = vi.hoisted(() => ({
  attention: null as unknown,
  declined: null as unknown,
  replies: null as unknown,
  // The owner follow-up read. Null serves the real read, which the harness has no command for; a test seeds a list.
  followUps: null as unknown,
  // Per-invitation answers to the invitation-scoped form of the read, keyed by invitation id. A test seeds these; absent means the page list is served.
  scoped: {} as Record<string, unknown>,
  scopedCalls: [] as string[],
}));
vi.mock("@/lib/waitlist/followups-owner", async (orig) => {
  const a = await orig<typeof import("@/lib/waitlist/followups-owner")>();
  return { ...a, readFollowUps: vi.fn(async (...args: Parameters<typeof a.readFollowUps>) => {
    const inv = args[2];
    if (inv) {
      followUp.scopedCalls.push(inv);
      return (followUp.scoped[inv] as Awaited<ReturnType<typeof a.readFollowUps>> | undefined) ?? { kind: "ok" as const, rows: [] };
    }
    return (followUp.followUps as Awaited<ReturnType<typeof a.readFollowUps>> | null) ?? a.readFollowUps(...args);
  }) };
});
vi.mock("@/lib/waitlist/needs-attention", async (orig) => {
  const a = await orig<typeof import("@/lib/waitlist/needs-attention")>();
  return { ...a, loadNeedsAttention: vi.fn(async (...args: Parameters<typeof a.loadNeedsAttention>) =>
    (followUp.attention as Awaited<ReturnType<typeof a.loadNeedsAttention>> | null) ?? a.loadNeedsAttention(...args)) };
});
vi.mock("@/lib/waitlist/declined-attention", async (orig) => {
  const a = await orig<typeof import("@/lib/waitlist/declined-attention")>();
  return { ...a, loadDeclinedAttention: vi.fn(async (...args: Parameters<typeof a.loadDeclinedAttention>) =>
    (followUp.declined as Awaited<ReturnType<typeof a.loadDeclinedAttention>> | null) ?? a.loadDeclinedAttention(...args)) };
});
vi.mock("@/lib/waitlist/times-feedback-owner", async (orig) => {
  const a = await orig<typeof import("@/lib/waitlist/times-feedback-owner")>();
  return { ...a, countTimesFeedback: vi.fn(async (...args: Parameters<typeof a.countTimesFeedback>) =>
    (followUp.replies as Awaited<ReturnType<typeof a.countTimesFeedback>> | null) ?? a.countTimesFeedback(...args)) };
});

// Null keeps the legacy-bridge behaviour every pre-existing test relies on; a test sets a
// STORED mode to exercise the closed-admission invite block.
const admissionHolder = vi.hoisted(() => ({ stored: null as string | null, rule: "absent" as "applied" | "absent" | "error" }));
vi.mock("@/lib/booking/new-client-admission", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/booking/new-client-admission")>();
  return {
    ...actual,
    getNewClientAdmissionMode: vi.fn(async (studio: { slug: string | null }) =>
      actual.resolveAdmission({
        storedMode: admissionHolder.stored,
        storedSetAt: admissionHolder.stored ? "2026-09-01T00:00:00.000Z" : null,
        readFailed: false,
        studioSlug: studio.slug,
      }),
    ),
    studioIsInWaitlistMode: vi.fn(async (studio: { slug?: string | null }) => {
      const a = actual.resolveAdmission({
        storedMode: null,
          storedSetAt: null,
        readFailed: false,
        studioSlug: studio?.slug ?? null,
      });
      return a.ok && a.mode === "waitlist";
    }),
  };
});

const estimateCalls: unknown[] = [];
vi.mock("@/app/(app)/settings/waitlist/window-capacity-actions", () => ({
  estimateWindowCapacityAction: async (input: unknown) => {
    estimateCalls.push(input);
    return scenario.allowance;
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => revalidated.push(p),
}));

// The flash cookie: what the action sets, and what the page reads on its next render.
const flash: { sets: Array<{ name: string; value: string }>; value: string | undefined } = { sets: [], value: undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string) => {
      flash.sets.push({ name, value });
    },
    get: (name: string) =>
      name === "hone_waitlist_notice" && flash.value !== undefined ? { name, value: flash.value } : undefined,
  }),
}));
/** The action redirected to the plain page and left exactly this notice key in the flash cookie. */
async function expectNoticeRedirect(run: Promise<unknown>, key: string) {
  await expect(run).rejects.toThrow(/^NEXT_REDIRECT:\/waitlist$/);
  expect(flash.sets).toEqual([{ name: "hone_waitlist_notice", value: key }]);
}
// The real `redirect` throws a NEXT_REDIRECT control-flow error; this one does too, carrying the target.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

// What the owner's own session reads back when a remove answer is uncertain. `known: false` is a failed read.
const readback: { value: { known: true; status: string | null } | { known: false } } = {
  value: { known: false },
};
vi.mock("@/lib/waitlist/entry-status-readback", () => ({
  readEntryStatus: async () => readback.value,
}));

vi.mock("@/lib/supabase/queries", () => {
  // ONE identity under both names: the page and the settings layout resolve it
  // through the redirecting guard, server actions through the throwing
  // backstop (SENTRY-IDENTITY-01).
  const identity = async () => ({
    practitioner: { id: "prac-1", role: scenario.role, user_id: scenario.userId },
    studio: { id: STUDIO_ID, slug: SLUG, name: "Queue Studio", timezone: "America/Toronto" },
  });
  return {
    getCurrentPractitionerWithStudio: identity,
    requirePractitionerWithStudio: identity,
  };
});

// A minimal PostgREST-shaped builder that RECORDS the question rather than
// answering a pre-baked one, so the assertions are about the query the page
// actually issues.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    // A NEW IDENTITY PER CALL. The page is supposed to build exactly one.
    const clientId = clientInstances.length;
    clientInstances.push(clientId);
    return {
    from(table: string) {
      const shape: QueryShape = {
        clientId,
        table,
        columns: "",
        options: {},
        filters: [],
        orders: [],
        limit: null,
        range: null,
      };
      queries.push(shape);
      // THENABLE AT EVERY LINK, not only at `.limit`. The page issues TWO
      // shapes: the bounded entries read (terminal at `.limit`) and the
      // invitation-window read (terminal at `.in`). A builder that resolves
      // only on `.limit` cannot model the second, and every render would throw.
      const settle = () => {
        const filterVal = (op: string, col: string) =>
          shape.filters.find((f) => f[0] === op && f[1] === col)?.[2];

        // The composer's service selector. Answered from its own seed so a test
        // can distinguish an ELIGIBLE service from one the booking path would
        // refuse — the distinction this branch exists to make testable.
        if (table === "services") {
          return scenario.servicesError
            ? { data: null, error: scenario.servicesError }
            : { data: scenario.services, error: null };
        }

        // THE CAPACITY READ, ON THE PAGE'S OWN CLIENT. It is deliberately
        // answered here rather than by the admin fake: the page reads the round
        // with its existing owner-scoped instance under the owner RLS policy,
        // and a harness that answered it anywhere else would be modelling a
        // second client the page does not have.
        if (table === "studio_waitlist_admission_rounds") {
          if (scenario.roundsError) return { data: null, error: scenario.roundsError };
          const rows = [scenario.openRound, scenario.extraOpenRound].filter(Boolean);
          return { data: rows, error: null };
        }

        // WAIT-04A — ANSWERED HERE, ON THE PAGE'S OWN CLIENT, for exactly
        // the reason the capacity read is: 0193 grants `authenticated`
        // column-level SELECT and an owner RLS policy, so the owner's own
        // instance is the correct authority. A harness that served this from
        // the admin fake would be modelling a client the page does not build,
        // and would hide an admin-client regression rather than catch it.
        if (table === "new_client_waitlist_entry_preferences") {
          return scenario.preferencesError
            ? { data: null, error: scenario.preferencesError }
            : { data: scenario.preferences, error: null };
        }

        // The decline-visibility reads, answered from their own seeds. The fake honours the studio scope, and returns the exact count only when asked.
        if (table === "new_client_waitlist_invitations" && shape.columns === DECLINE_COUNT_READ) {
          if (scenario.declinedError) return { data: null, count: null, error: scenario.declinedError };
          const scoped =
            shape.filters.some((f) => f[0] === "eq" && f[1] === "studio_id" && f[2] === STUDIO_ID) &&
            shape.filters.some((f) => f[0] === "not" && f[1] === "declined_at");
          const src = scoped ? scenario.declinedInvitations : [];
          const rows = src.slice(0, Math.min(shape.limit ?? 1000, 1000));
          return { data: rows, count: shape.options.count === "exact" ? (scenario.declinedCount ?? src.length) : null, error: null };
        }
        // The position read: a head-only exact count of the entries AHEAD of one entry in its section, answered from a per-entry seed.
        if (table === "new_client_waitlist_entries" && shape.options.head === true && shape.filters.some((f) => f[0] === "or")) {
          const orFilter = String(shape.filters.find((f) => f[0] === "or")?.[2] ?? "");
          const entryId = orFilter.match(/id\.lt\.([^)]+)\)/)?.[1] ?? "";
          if (scenario.positionError) return { data: null, count: null, error: scenario.positionError };
          return { data: null, count: scenario.aheadOf[entryId] ?? 0, error: null };
        }
        if (table === "new_client_waitlist_entries" && (shape.columns === "id,name,status,joined_at" || shape.columns === "id,email,phone")) {
          const ids = (shape.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] ?? []) as string[];
          const src = shape.columns === "id,name,status,joined_at" ? scenario.declineEntries : scenario.contactRows;
          return { data: src.filter((r) => ids.includes(r.id as string)), error: null };
        }

        if (table === "new_client_waitlist_invitations") {
          if (scenario.invitationsError) {
            return { data: null, error: scenario.invitationsError };
          }
          // TWO invitation reads now, told apart by their predicates: the LIVE
          // one asks `is null` on all three terminal stamps; the REDEEMED one
          // asks `not redeemed_at is null`.
          const asksRedeemed = shape.filters.some((f) => f[0] === "not");
          // The studio-wide expiry summary read: the live predicate with NO entry-id list.
          if (!asksRedeemed && !shape.filters.some((f) => f[0] === "in")) {
            if (scenario.studioExpiriesError) return { data: null, count: null, error: scenario.studioExpiriesError };
            // THE FAKE HONOURS THE FILTERS AND THE API ROW CEILING. It answers only a read scoped to this studio with all four terminal stamps null,
            // so a read that dropped one of those terms gets nothing back; and it returns at most min(limit, max_rows = 1000) rows with the EXACT
            // count beside them only when the read asked for one, as the real Data API does.
            const isNull = (c: string) => shape.filters.some((f) => f[0] === "is" && f[1] === c && f[2] === null);
            const scoped =
              shape.filters.some((f) => f[0] === "eq" && f[1] === "studio_id" && f[2] === STUDIO_ID) &&
              ["redeemed_at", "expired_at", "released_at", "declined_at"].every(isNull);
            const src = scoped ? (scenario.studioExpiries ?? scenario.liveInvitations) : [];
            const rows = src.slice(0, Math.min(shape.limit ?? 1000, 1000)).map((r) => ({ expires_at: r.expires_at }));
            const count = shape.options.count === "exact" ? (scoped ? (scenario.studioExpiryCount ?? src.length) : 0) : null;
            return { data: rows, count, error: null };
          }
          return {
            data: asksRedeemed ? scenario.redeemedInvitations : scenario.liveInvitations,
            error: null,
          };
        }

        // ONE READ PER SECTION. The page asks per status, so the fake must
        // answer per status — returning every seeded row to every section would
        // render each person once per section.
        const status = filterVal("eq", "status");
        const matching =
          typeof status === "string"
            ? scenario.rows.filter((r) => r.status === status)
            : scenario.rows;
        // Totals, in precedence order: an explicit per-section total, then the
        // legacy single `count` (older cases seed only waiting rows), then the
        // number actually seeded.
        const total =
          scenario.sectionTotals && typeof status === "string"
            ? (scenario.sectionTotals[status] ?? matching.length)
            : scenario.count !== null && matching.length > 0
              ? scenario.count
              : matching.length;

        // HEAD-ONLY: the count, and no rows. A focused view reads the other
        // four sections this way so the headline keeps its whole-queue meaning.
        // A fake that returned rows anyway would hide a page that had stopped
        // windowing them.
        if (shape.options.head === true) {
          return {
            data: null,
            count: scenario.error ? null : total,
            error: scenario.error,
          };
        }

        // THE WINDOW THE PAGE ASKED FOR. PostgREST's `.range(from, to)` is
        // inclusive at both ends.
        const rows = shape.range
          ? scenario.ignoreRange
            // THE PRE-FIX READ, REPRODUCED FAITHFULLY: a bounded page from the
            // TOP of the section, whatever window was asked for — which is
            // exactly what `.limit(SECTION_PAGE_SIZE)` did. The negative
            // control drives this to prove the fixed assertions can fail.
            ? matching.slice(0, shape.range[1] - shape.range[0] + 1)
            : matching.slice(shape.range[0], shape.range[1] + 1)
          : matching;
        return {
          data: scenario.error ? null : rows,
          count: scenario.error ? null : total,
          error: scenario.error,
        };
      };

      const builder = {
        select(columns: string, options: Record<string, unknown> = {}) {
          shape.columns = columns;
          shape.options = options;
          return builder;
        },
        eq(column: string, value: unknown) {
          shape.filters.push(["eq", column, value]);
          return builder;
        },
        in(column: string, values: unknown) {
          shape.filters.push(["in", column, values]);
          return builder;
        },
        is(column: string, value: unknown) {
          shape.filters.push(["is", column, value]);
          return builder;
        },
        gte(column: string, value: unknown) {
          shape.filters.push(["gte", column, value]);
          return builder;
        },
        gt(column: string, value: unknown) {
          shape.filters.push(["gt", column, value]);
          return builder;
        },
        lte(column: string, value: unknown) {
          shape.filters.push(["lte", column, value]);
          return builder;
        },
        or(expression: string) {
          shape.filters.push(["or", "", expression]);
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          shape.filters.push(["not", column, `${op}:${String(value)}`]);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          shape.orders.push([column, options]);
          return builder;
        },
        limit(n: number) {
          shape.limit = n;
          return builder;
        },
        range(from: number, to: number) {
          shape.range = [from, to];
          return builder;
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(settle()).then(resolve);
        },
      };
      return builder;
    },
    // The owner's own session may call the summary command (the only rpc it makes); recorded apart from the admin client's.
    async rpc(fn: string, args: Record<string, unknown>) {
      userRpcCalls.push({ fn, args });
      return summaryRpc.error ? { data: null, error: summaryRpc.error } : { data: [SUMMARY_ROW], error: null };
    },
    };
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      throw new Error(`the waitlist action must not touch tables directly: ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      // The 0323 marker; not a waitlist call, so it is not recorded with them.
      if (fn === "waitlist_closed_invited_booking_enabled") {
        if (admissionHolder.rule === "applied") return { data: true, error: null };
        return { data: null, error: { code: admissionHolder.rule === "absent" ? "PGRST202" : "XX000", message: "x" } };
      }
      rpcCalls.push({ fn, args });
      // THE CONSUMED COUNT IS ITS OWN ANSWER. Returning the removal result for
      // every rpc made the count NaN, which the page correctly read as unknown
      // capacity -- so the panel never rendered and every panel assertion would
      // have been vacuously true. This function is service_role-only by 0192,
      // which is why it is the one capacity call that legitimately reaches the
      // admin client at all.
      if (fn === "read_waitlist_admission_round_consumed") {
        return scenario.roundConsumed === null
          ? { data: null, error: { code: "42501" } }
          : { data: scenario.roundConsumed, error: null };
      }
      if (scenario.removeError) return { data: null, error: scenario.removeError };
      return { data: scenario.removeResult, error: null };
    },
  }),
}));

const { default: WaitlistSettingsPage } = await import(
  "@/app/(app)/settings/waitlist/page"
);
const { removeWaitlistEntryAction } = await import(
  "@/app/(app)/settings/waitlist/actions"
);

/** Render the owner's Waitlist with the same parameters as a directory link. */
const render = async (
  searchParams: { tab?: string | string[]; section?: string | string[]; page?: string | string[]; view?: string | string[]; dpage?: string | string[] } = {},
) =>
  renderToStaticMarkup(
    await WaitlistSettingsPage({ searchParams: Promise.resolve(searchParams) }),
  );

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "entry-1",
    name: "Jo Smith",
    email: "jo@example.com",
    phone: "555 0100",
    joined_at: "2026-08-20T09:00:00.000Z",
    // The page groups by lifecycle state, so a row without one belongs to no
    // section and renders nowhere. Waiting is the default because it is the
    // state the original waiting-only surface described.
    status: "waiting",
    // WAIT-04A — THE FIXTURE MUST MODEL A ROW PRODUCTION CAN PRODUCE.
    //
    // 0193 added both columns and bound them to each other with a CHECK: only
    // `source = 'public_booking'` may carry `joined_at_provenance = 'form'`,
    // and the column defaults to 'form'. Every row that existed when 0193 was
    // applied therefore reads exactly like this one.
    //
    // Defaulting them here rather than leaving them undefined is deliberate.
    // Undefined resolves to the `unknown` claim, so the whole suite would have
    // rendered "Join date unknown" for a public-form joiner — a state the
    // database forbids — and every assertion about an ordinary row would have
    // been made against a row that cannot exist.
    source: "public_booking",
    joined_at_provenance: "form",
    // 0202's consent columns are nullable with no default, so a row that
    // nobody has recorded consent or STOP for reads exactly like this.
    sms_consent_at: null,
    sms_consent_source: null,
    sms_consent_given_on: null,
    sms_opted_out_at: null,
    ...overrides,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    consoleErrors.push(a.map(String).join(" "));
  });
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    consoleWarns.push(a.map(String).join(" "));
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-23T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("authority", () => {
  it("a NON-OWNER sees a denial card and no contact details", async () => {
    scenario.role = "practitioner";
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain("Only studio owners can see the new-client waitlist.");
    expect(html).not.toContain("jo@example.com");
    expect(html).not.toContain("Jo Smith");
    // And no query was even issued.
    expect(queries).toHaveLength(0);
  });

  it("the owner sees the queue", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain("Jo Smith");
    expect(html).toContain("jo@example.com");
    expect(html).toContain("555 0100");
  });
});

describe("the query the page asks", () => {
  beforeEach(() => {
    scenario.rows = [entry()];
    scenario.count = 1;
  });

  it("is ONE bounded, studio-scoped, status-scoped, ordered read", async () => {
    await render();
    // ONE BOUNDED READ PER SECTION — five of them — rather than one cap shared
    // across every state. A shared cap lets a busy section crowd another off
    // the page entirely, taking that section's only actions with it.
    // The owner's needs-attention card (0313) makes its own COMPLETE read of the
    // invited entries (id,name); it is a sixth, separate read, not a section. The
    // declined-times card reads released entries (id,name,released_at) the same way.
    const pageReads = queries.filter((x) => x.table === "new_client_waitlist_entries" && x.columns !== "id,name" && x.columns !== "id,name,released_at");
    expect(pageReads).toHaveLength(5);
    expect(queries.filter((x) => x.table === "new_client_waitlist_entries" && x.columns === "id,name")).toHaveLength(1);
    const q = pageReads.find((x) =>
      x.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "waiting"),
    )!;
    expect(q).toBeTruthy();
    expect(q.table).toBe("new_client_waitlist_entries");
    expect(q.filters).toEqual([
      ["eq", "studio_id", STUDIO_ID],
      // The page now reads every ACTIVE lifecycle state, not waiting alone.
      // `converted` and `removed` are terminal history and stay out, so the
      // bound is spent on rows an operator can still act on.
      ["eq", "status", "waiting"],
    ]);
    // A WINDOW, NOT A CAP. The default view asks for the first page of each
    // section; `.range` is what makes a later page reachable at all, so the
    // shape is pinned rather than merely "bounded".
    expect(q.range).toEqual([0, 99]);
    expect(q.limit).toBeNull();
  });

  it("orders oldest-first with a deterministic id tie-break", async () => {
    await render();
    expect(entriesQuery().orders).toEqual([
      ["joined_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("asks for an EXACT count, not an inferred one", async () => {
    await render();
    // `head: false` — this read wants the rows as well as the count. The
    // head-only form exists too, and is proved where it is used.
    expect(entriesQuery().options).toEqual({ count: "exact", head: false });
  });

  it("selects only the columns it renders — no `*`", async () => {
    await render();
    expect(entriesQuery().columns).toBe(ENTRY_COLUMNS);
    expect(entriesQuery().columns).not.toContain("*");
  });

  it("is issued through the RLS-scoped user client, never the service-role client", async () => {
    await render();
    // The admin mock throws on `from`, so a service-role read would have failed
    // the render outright; this pins the intent in the source too.
    const src = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/settings/waitlist/page.tsx"),
      "utf8",
    );
    expect(src).not.toContain("createAdminClient");
    expect(src).toContain('from "@/lib/supabase/server"');
  });
});

describe("the count is authoritative", () => {
  it("reports the TOTAL waiting, not the size of the capped page", async () => {
    // THE FAILURE THIS PREVENTS: a studio with 140 people waiting being told
    // "Waiting: 100" because the page read stopped there.
    scenario.rows = Array.from({ length: 100 }, (_, i) =>
      entry({ id: `entry-${i}`, name: `Person ${i}`, email: `p${i}@example.com` }),
    );
    scenario.count = 140;
    const html = await render();
    expect(html).toMatch(/Waitlist entries:\s*<[^>]*>140</);
    expect(html).toContain("Showing the first 100 of 140, in queue order.");
    // AND A WAY THROUGH, not just an admission. The old sentence was truthful
    // and offered nothing; the other 40 people were unreachable, and so were
    // their actions.
    expect(html).toContain('data-testid="waitlist-section-all-waiting"');
    expect(html).toContain('href="/waitlist?section=waiting"');
  });

  it("says nothing about truncation when the page holds everyone", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).toMatch(/Waitlist entries:\s*<[^>]*>1</);
    // STILL A NEGATIVE, AND NOW A STRONGER ONE: the page must say nothing
    // about truncation, and must never resurrect the duration claim either.
    expect(html).not.toContain("in queue order");
    expect(html).not.toContain("longest-waiting");
  });

  it("renders an empty state when nobody is waiting", async () => {
    scenario.rows = [];
    scenario.count = 0;
    const html = await render();
    expect(html).toContain("Nobody is waiting right now.");
    expect(html).toMatch(/Waitlist entries:\s*<[^>]*>0</);
  });
});

describe("a failed load is never shown as an empty queue", () => {
  it("says the list could not be loaded, and logs without PII", async () => {
    scenario.error = { code: "42501", message: "permission denied for table" };
    const html = await render();
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("Nobody is waiting");
    expect(html).not.toMatch(/Waitlist entries:\s*<[^>]*>0</);
    const line = consoleErrors.find((l) => l.includes("waitlist_queue_load_failed"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ studioId: STUDIO_ID, code: "42501" });
  });
});

describe("rendered rows", () => {
  it("every row identifies WHICH entry it is", async () => {
    // The hook the reachability proofs are scoped by. Pinned here as a live
    // contract of its own: removed, every scoped assertion would fail with a
    // confusing "no row" rather than naming what actually broke.
    //
    // It discloses nothing new — the id is already the hidden `entry_id` of
    // each action form on this owner-only route — and it sits on the <li>
    // because a row whose state offers no action has no form to read it from.
    scenario.rows = [
      entry({ id: "row-a", name: "Ada" }),
      entry({ id: "row-b", name: "Bo", status: "claimed" }),
    ];
    const html = await render();
    expect(html).toContain('data-entry-id="row-a"');
    expect(html).toContain('data-entry-id="row-b"');
  });

  it("shows how long each person has been waiting", async () => {
    scenario.rows = [
      entry({ id: "a", name: "Three Days", joined_at: "2026-08-20T09:00:00.000Z" }),
      entry({ id: "b", name: "Today", joined_at: "2026-08-23T08:00:00.000Z" }),
    ];
    scenario.count = 2;
    const html = await render();
    expect(html).toContain("3 days");
    expect(html).toContain("Today");
  });

  it("preserves the server's order in the DOM", async () => {
    scenario.rows = [
      entry({ id: "a", name: "Oldest", email: "oldest@example.com" }),
      entry({ id: "b", name: "Newest", email: "newest@example.com" }),
    ];
    scenario.count = 2;
    const html = await render();
    expect(html.indexOf("Oldest")).toBeLessThan(html.indexOf("Newest"));
  });

  it("omits the phone line entirely when there is none", async () => {
    scenario.rows = [entry({ phone: null })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain("jo@example.com");
    expect(html).not.toContain("555 0100");
  });

  it("offers Remove behind a confirmation step, and offers nothing else", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain("Remove");
    expect(html).toContain("Confirm removal");
    expect(html).toContain('<input type="hidden" name="entry_id" value="entry-1"/>');
  });

  it("offers only the permitted waiting-row controls and no link to a client record", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    const row = rowMarkup(html, "entry-1");
    expect(row).not.toBeNull();

    // The summary opens the row in place. Include every nested control, even
    // those hidden until the row opens, so an extra lifecycle action fails here.
    const labels = [...row!.matchAll(/<(button|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(
      ([, , content]) => content.replace(/<[^>]+>/g, "").trim(),
    );
    const detailSummary = labels.filter((label) => label.includes("View details for Jo Smith"));
    expect(detailSummary).toHaveLength(1);
    expect(labels.filter((label) => label !== detailSummary[0]).sort()).toEqual([
      "Cancel",
      "Confirm removal",
      "Invite to book Jo Smith",
      "Record",
      "Record SMS consent for Jo Smith",
      "Record consent",
      "Remove",
      "Send invitation",
    ]);
    expect(row).not.toMatch(/\bclaim/i);
    expect(row).not.toMatch(/<a\s/);
  });

  // =========================================================================
  // P1 3998286099 — the selector offers exactly what a new client can book
  // =========================================================================
  //
  // The composer's own filter is `isConsultationService`, which asks only "is
  // this a consultation" and never "is it active". That is STRICTLY WEAKER than
  // the rule the booking path enforces, so an archived consultation reached the
  // selector, was scoped into an invitation, and was then refused by the
  // recipient's own booking page. The page now filters with the canonical
  // `isBookableByNewClient` before the composer ever sees a row.
  describe("the Invite-to-book service selector", () => {
    const service = (over: Record<string, unknown> = {}) => ({
      id: "svc-1",
      name: "Consultation",
      modality: "consultation",
      active: true,
      ...over,
    });
    const withWaitingRow = () => {
      scenario.rows = [entry({ status: "waiting" })];
      scenario.count = 1;
    };

    it("offers an ACTIVE new-client-bookable consultation", async () => {
      withWaitingRow();
      scenario.services = [service({ id: "svc-live", name: "Initial consultation" })];
      const html = await render();
      expect(html).toContain("Initial consultation");
      expect(html).toContain('value="svc-live"');
    });

    it("does NOT offer an INACTIVE consultation", async () => {
      withWaitingRow();
      scenario.services = [
        service({ id: "svc-archived", name: "Archived consultation", active: false }),
      ];
      const html = await render();
      expect(html).not.toContain("svc-archived");
      expect(html).not.toContain("Archived consultation");
    });

    it("does NOT offer an ACTIVE non-consultation service", async () => {
      withWaitingRow();
      scenario.services = [
        service({ id: "svc-treatment", name: "Laser treatment", modality: "treatment" }),
      ];
      const html = await render();
      expect(html).not.toContain("svc-treatment");
      expect(html).not.toContain("Laser treatment");
    });

    it("does NOT offer an INACTIVE non-consultation service", async () => {
      withWaitingRow();
      scenario.services = [
        service({
          id: "svc-dead",
          name: "Retired facial",
          modality: "treatment",
          active: false,
        }),
      ];
      const html = await render();
      expect(html).not.toContain("svc-dead");
      expect(html).not.toContain("Retired facial");
    });

    it("treats a NULL active as ineligible, failing closed", async () => {
      // The schema type says non-null, but this row crosses the wire. The
      // canonical predicate's `active !== true` refuses it, and so must this.
      withWaitingRow();
      scenario.services = [service({ id: "svc-null", name: "Unknown state", active: null })];
      const html = await render();
      expect(html).not.toContain("svc-null");
    });

    it("scopes the read to THIS studio", async () => {
      // Tenancy is enforced by the query, not by filtering afterwards: a
      // service belonging to another studio is never returned to be filtered.
      withWaitingRow();
      scenario.services = [service()];
      await render();
      const read = queries.find((c) => c.table === "services");
      expect(read, "the page must read services for the composer").toBeDefined();
      expect(read!.filters).toContainEqual(["eq", "studio_id", STUDIO_ID]);
      // And it loads the field the canonical predicate needs.
      expect(read!.columns).toContain("active");
    });

    it("an UNREADABLE service list leaves nothing sendable", async () => {
      // Fail closed: #683's contract requires an explicit concrete service, so
      // an empty list means the send refuses. It must never widen to "any".
      withWaitingRow();
      scenario.servicesError = { code: "PGRST500" };
      const html = await render();
      expect(html).toContain("Invite to book");
      // No service option beyond the placeholder the composer renders itself.
      expect(html).not.toContain('value="svc-');
    });
  });

  // The expanded Invite-to-book composer used to sit INSIDE the row's controls column. Opening it
  // widened that column to the form's natural width, so the name and email were squeezed into a
  // sliver and the controls were drawn over the form. The composer is now its own full-width band.
  describe("row layout: the composer is a full-width band, not part of the controls column", () => {
    /** The end index of the <div> that opens at `start`, by counting nested <div> tags. */
    const divEnd = (html: string, start: number): number => {
      let depth = 0;
      for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
        depth += m[0] === "</div>" ? -1 : 1;
        if (depth === 0) return start + m.index! + m[0].length;
      }
      throw new Error("unbalanced <div>");
    };
    const openTagStart = (html: string, marker: string): number => {
      const at = html.indexOf(marker);
      expect(at, `${marker} is not rendered`).toBeGreaterThan(-1);
      return html.lastIndexOf("<div", at);
    };

    const service = (over: Record<string, unknown> = {}) => ({
      id: "svc-1",
      name: "Consultation",
      modality: "consultation",
      active: true,
      ...over,
    });
    const LONG_NAME = "Alexandria-Bartholomew Montgomery-Featherstonehaugh the Third";
    const LONG_EMAIL = "alexandria.bartholomew.montgomery.featherstonehaugh.the.third@a-very-long-subdomain.example.invalid";

    it("shows the joined date and availability at a glance and keeps contact details inside the disclosure", async () => {
      scenario.rows = [entry(), entry({ id: "imported", source: "legacy_import", joined_at_provenance: "unknown" })];
      scenario.count = 2;
      const html = await render();
      const summaryFor = (id: string) =>
        rowMarkup(html, id)?.match(/<details[^>]*data-testid="waitlist-entry-details"[^>]*><summary[^>]*>([\s\S]*?)<\/summary>/)?.[1];
      expect(summaryFor("entry-1")).toContain("Aug 20, 2026");
      expect(summaryFor("entry-1")).toContain("Not stated");
      expect(summaryFor("entry-1")).not.toContain("jo@example.com");
      expect(summaryFor("imported")).toContain("Join date unknown");
      expect(summaryFor("imported")).not.toContain("Aug 20");
    });

    it.each([
      { open: 3, direct: true },
      { open: 0, direct: false },
    ])("keeps the composer reachable when the studio has $open invitations available", async ({ open, direct }) => {
      scenario.services = [service()];
      scenario.rows = [entry()];
      scenario.count = 1;
      scenario.allowance = { ok: true, fit: open, outstanding: 0, open, outstandingScope: "window" };
      const row = rowMarkup(await render(), "entry-1");
      expect(row).toContain('data-testid="row-invite"');
      expect(row?.includes('aria-hidden="true">Invite</span>')).toBe(direct);
      expect(row?.includes("hidden peer-open/entry:block")).toBe(!direct);
    });

    it("the composer is outside the controls column, and the controls column cannot grow with it", async () => {
      scenario.rows = [entry({ name: LONG_NAME, email: LONG_EMAIL })];
      scenario.count = 1;
      scenario.services = [service()];
      const html = await render();
      const start = openTagStart(html, 'data-testid="row-controls"');
      const end = divEnd(html, start);
      const controls = html.slice(start, end);
      expect(controls).not.toContain('data-testid="row-invite"');
      expect(controls).not.toContain("composer");
      // The controls still carry Remove, and the composer follows them in the same row.
      expect(controls).toContain("Remove");
      const invite = html.indexOf('data-testid="row-invite"');
      expect(invite).toBeGreaterThan(end);
      // A FIXED width at the breakpoint where the columns sit side by side: it can no longer
      // take its width from whatever is inside it.
      const tag = html.slice(start, html.indexOf(">", start) + 1);
      expect(tag).toContain("sm:w-56");
      expect(tag).not.toContain("sm:w-auto");
      expect(tag).toContain("min-w-0");
    });

    it("the row is a plain column; only its first band is a side-by-side row", async () => {
      scenario.rows = [entry()];
      scenario.count = 1;
      scenario.services = [service()];
      const html = await render();
      const li = html.slice(html.indexOf("<li"), html.indexOf(">", html.indexOf("<li")) + 1);
      expect(li).toContain("flex-col");
      expect(li).not.toContain("sm:flex-row");
      const band = html.slice(html.indexOf("<li"), html.indexOf('data-testid="row-controls"'));
      expect(band).toContain("sm:flex-row");
    });

    it("a long name and a long email wrap inside their own column instead of widening the row", async () => {
      scenario.rows = [entry({ name: LONG_NAME, email: LONG_EMAIL })];
      scenario.count = 1;
      const html = await render();
      const name = html.indexOf(LONG_NAME);
      const nameTag = html.slice(html.lastIndexOf("<span", name), name);
      expect(nameTag).toContain("break-words");
      const email = html.indexOf(LONG_EMAIL);
      const emailTag = html.slice(html.lastIndexOf("<p", email), email);
      expect(emailTag).toContain("break-all");
      // A long token can shrink inside its grid track and break even without spaces.
      expect(nameTag).toContain("min-w-0");
      expect(nameTag).toContain("overflow-wrap:anywhere");
    });

    it("a row with no composer (not an invitable state) has the same two-band shape", async () => {
      scenario.rows = [entry({ status: "released" })];
      scenario.count = 1;
      const html = await render({ section: "released" });
      expect(html).toContain('data-testid="row-controls"');
      expect(html).not.toContain('data-testid="row-invite"');
    });
  });

  it("promises no queue position or capacity", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    // WAIT INTEGRATION-01 — `/invite/i` AND `/next \d+/i` ARE NO LONGER
    // FORBIDDEN, and only those two changed.
    //
    // This surface could not invite when the guard was written; the page header
    // said so outright ("It still cannot INVITE ... Those wait on B1/B1.5c +
    // B2"). Those now exist and the assembly binds them, so the page really
    // does offer "Invite to book", and the composer's own booking-window
    // presets read "Next 7 days".
    //
    // WHAT THE GUARD WAS ACTUALLY PROTECTING IS UNTOUCHED: no queue POSITION,
    // no RANK, no CAPACITY forecast. Those were never about invitation — they
    // are promises this product cannot keep about where someone sits in a line
    // or when a slot will exist, and they remain forbidden.
    // WAIT-CAPACITY-01 — THE SCAN IS SCOPED TO THE QUEUE, AND THE RULE IS
    // UNCHANGED. What this forbids is a promise to the WAITING PERSON about
    // where they sit or when a slot appears. The owner's invitation-capacity
    // control is a different thing entirely: it is the owner deciding how many
    // people THEY are ready to invite, it is not rendered to a prospect, and
    // "Invitation capacity" is the product's chosen practitioner wording.
    //
    // So the owner panel is excised before the scan rather than the word being
    // dropped from the list — which would have let a real capacity FORECAST
    // back into the queue rows unnoticed. The panel gets its own assertion
    // below, so removing it from here costs no coverage.
    // Excised: the owner panel, and the OWNER-FACING send-unavailable copy the
    // composer renders when no capacity is open. Both are named constants, so
    // this strips exactly those sentences and nothing else — the bare word stays
    // forbidden everywhere else in the queue.
    const OWNER_CAPACITY_COPY = [
      "We couldn't prepare invitations just now. Please try again.",
      CAPACITY_EXHAUSTED_COPY,
      "We couldn't check your invitation capacity just now. Reload the page before inviting.",
    ];
    let queueOnly = html.replace(
      /<section[^>]*data-testid="invitation-allowance"[\s\S]*?<\/section>/,
      "",
    );
    // WAIT-04A — THE ADD/IMPORT PANEL IS EXCISED FOR THE SAME REASON, AND ONLY
    // FOR THAT REASON. It is an OWNER control: the owner adding a person the
    // studio already knows about, and saying whether they have a join date for
    // them. It is never rendered to a prospect, and it forecasts nothing — it
    // describes where the row the owner is about to create will land, which is
    // a fact about the owner's own action, not a promise to the person.
    //
    // It gets its own assertion below, so excising it costs no coverage, and
    // the per-row availability control is deliberately NOT excised: it renders
    // inside a queue row, so the forbidden vocabulary still bites on it.
    queueOnly = queueOnly.replace(
      /<section[^>]*data-testid="add-to-waitlist"[\s\S]*?<\/section>/,
      "",
    );
    expect(queueOnly, "the add/import panel was not excised").not.toContain(
      "add-to-waitlist",
    );
    queueOnly = queueOnly.replace(/<span[^>]*data-testid="row-allowance"[\s\S]*?<\/span>/g, "");
    for (const c of OWNER_CAPACITY_COPY) queueOnly = queueOnly.split(c).join("");
    expect(queueOnly, "the owner panel was not excised").not.toContain("invitation-allowance");
    // Non-vacuity: the strip must not have emptied the queue it is scanning.
    expect(queueOnly).toContain("Invite to book");
    for (const forbidden of [/position/i, /\brank/i, /capacity/i]) {
      expect(queueOnly, `forbidden vocabulary: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("P2 4020704242 — the page builds exactly ONE owner-scoped client", async () => {
    // COUNTING QUERIES COULD NEVER PROVE THIS. The suite shares one query log
    // across every mock client, so "exactly one capacity query" was equally true
    // of a page that built a SECOND client and issued one query from it. The
    // ruling is one owner-scoped instance for the queue AND the capacity read,
    // so the instance is what gets counted.
    scenario.rows = [entry()];
    scenario.count = 1;
    await render();

    expect(clientInstances, "the page must build exactly one createClient()").toHaveLength(1);

    // AND BOTH READS CAME FROM IT. One instance plus a query from somewhere else
    // would still be two authorities; every recorded query must carry the same
    // client id.
    const ids = new Set(queries.map((q) => q.clientId));
    expect(ids.size, "every query must come from the one client").toBe(1);
    expect(ids.has(0)).toBe(true);

    // NON-VACUITY. If the page issued no capacity read at all, the set above
    // would trivially be one. Both reads must actually be present.
    expect(queries.some((q) => q.table === "new_client_waitlist_entries")).toBe(true);
    // The admission round is plumbing: the page never reads it (0324, auto-round).
    expect(queries.some((q) => q.table === "studio_waitlist_admission_rounds")).toBe(false);
  });

  it("NEGATIVE CONTROL — a second client makes that assertion fail", async () => {
    // Proved by construction rather than by trusting the counter: calling the
    // mocked factory again is exactly what a page building a second client
    // would do, and the assertion above must not survive it.
    const { createClient } = await import("@/lib/supabase/server");
    scenario.rows = [entry()];
    scenario.count = 1;
    await render();
    expect(clientInstances).toHaveLength(1);

    await createClient();
    expect(
      clientInstances,
      "a second createClient() must be visible to the guard",
    ).toHaveLength(2);
    // The shape the guard asserts is now false, which is the point.
    expect(clientInstances.length === 1).toBe(false);
  });

  it("shows the allowance above the waitlist, with nothing to type", async () => {
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.allowance = { ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "window" };
    const html = await render();
    const panel = /<section[^>]*data-testid="invitation-allowance"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(panel, "the allowance panel did not render").not.toBe("");
    expect(panel).toContain(esc("5 consultation appointments available. You can invite 3 more people."));
    expect(panel).toContain(esc("Availability can change; invitations don’t reserve appointments."));
    // Chloe never types a capacity, and never sees a round.
    expect(panel).not.toMatch(/<input/);
    expect(html).not.toContain("Start inviting");
    expect(html).not.toContain('data-testid="capacity-allowance"');
    // The page title introduces the workspace; capacity precedes the queue.
    expect(html.indexOf(">Waitlist</h1>")).toBeLessThan(html.indexOf('data-testid="invitation-allowance"'));
    expect(html.indexOf('data-testid="invitation-allowance"')).toBeLessThan(html.indexOf('data-testid="waitlist-section-waiting"'));
  });

  it("repeats the allowance beside each Invite to book", async () => {
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.allowance = { ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "window" };
    const html = await render();
    expect(html).toMatch(/data-testid="row-allowance"[^>]*>You can invite 3 more people</);
  });

  it("an unreadable estimate says so and never shows a number", async () => {
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.allowance = { ok: false };
    const html = await render();
    expect(html).toContain('data-testid="allowance-unavailable"');
    expect(html).not.toContain('data-testid="allowance-headline"');
    expect(html).not.toContain('data-testid="row-allowance"');
  });

  it("estimates the default window: the next two weeks, every day", async () => {
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    scenario.rows = [entry()];
    scenario.count = 1;
    await render();
    expect(estimateCalls).toEqual([{ serviceId: expect.any(String), windowDays: 14, allowedWeekdays: null }]);
  });

  it("opens no round and offers no capacity control (the round is plumbing)", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    await render();
    expect(rpcCalls.filter((c) => c.fn === "open_new_client_waitlist_admission_round")).toHaveLength(0);
  });

  it("MATRIX 12 — no internal capacity vocabulary ever reaches the page", async () => {
    // THE RAW-CODE NEGATIVE CONTROL, at the surface. A practitioner saw
    // "No invitation was created (no_admission_round)" in production.
    for (const round of [
      null,
      { id: "round-a", allowance: 1, opened_at: "2026-09-10T00:00:00.000Z" },
    ]) {
      for (const used of [0, 1]) {
        reset();
        scenario.rows = [entry()];
        scenario.count = 1;
        scenario.openRound = round;
        scenario.roundConsumed = used;
        const html = await render();
        for (const leak of [
          "no_admission_round",
          "admission_round_full",
          "round_already_open",
          "no_round_open",
          "admission round",
          "studio_waitlist_admission_rounds",
        ]) {
          expect(html.toLowerCase(), `internal vocabulary leaked: ${leak}`).not.toContain(
            leak.toLowerCase(),
          );
        }
      }
    }
  });

  it("the owner allowance forecasts nothing to a prospect", async () => {
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.allowance = { ok: true, fit: 5, outstanding: 2, open: 3, outstandingScope: "window" };
    const html = await render();
    const panel = /<section[^>]*data-testid="invitation-allowance"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(panel, "the allowance panel did not render").not.toBe("");
    for (const forbidden of [/position/i, /\brank/i, /spots? left/i, /estimated/i, /your turn/i]) {
      expect(panel, `allowance panel forecast: ${forbidden}`).not.toMatch(forbidden);
    }
    expect(panel).not.toMatch(/admission round/i);
  });

  it("promises nothing about when or whether anyone is contacted", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).not.toMatch(/guarantee|reserved|your turn|estimated wait/i);
  });
});

describe("removal", () => {
  it("goes through the command with a SERVER-DERIVED tenant and actor", async () => {
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expectNoticeRedirect(removeWaitlistEntryAction(fd), "remove.removed");

    expect(rpcCalls).toEqual([
      {
        fn: "remove_new_client_waitlist_entry",
        args: {
          p_studio_id: STUDIO_ID,
          p_entry_id: "entry-1",
          p_actor_user_id: USER_ID,
        },
      },
    ]);
    expect(revalidated).toEqual(["/waitlist"]);
  });

  it("refuses a NON-OWNER before the command is called", async () => {
    scenario.role = "practitioner";
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expect(removeWaitlistEntryAction(fd)).rejects.toThrow(
      "Only studio owners can change the waitlist.",
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a missing entry id before the command is called", async () => {
    await expect(removeWaitlistEntryAction(new FormData())).rejects.toThrow(
      "Missing waitlist entry.",
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("the browser cannot supply a studio, actor or role", async () => {
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    fd.set("studio_id", "attacker-studio");
    fd.set("p_studio_id", "attacker-studio");
    fd.set("actor_user_id", "attacker-user");
    fd.set("role", "owner");
    await expectNoticeRedirect(removeWaitlistEntryAction(fd), "remove.removed");
    expect(rpcCalls[0].args).toEqual({
      p_studio_id: STUDIO_ID,
      p_entry_id: "entry-1",
      p_actor_user_id: USER_ID,
    });
  });

  it.each([
    ["not_found", "That waitlist entry no longer exists."],
    ["already_removed", "That entry has already been removed."],
    // The two outcomes 0188 added so the operator could be told what to do. Reachable because a second
    // tab, a recipient's decline or a booking can move the entry between the page render and this submit.
    [
      "release_required",
      "That entry has been claimed or invited. Release it before removing it.",
    ],
    [
      "not_removable",
      "That person is already a client. Converted entries stay in waitlist history.",
    ],
  ])("a stale-state refusal `%s` redirects with its notice and the page shows that exact copy", async (code, message) => {
    scenario.removeResult = code;
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expectNoticeRedirect(removeWaitlistEntryAction(fd), `remove.${code}`);
    expect(revalidated).toEqual(["/waitlist"]);
    // A clean refusal is a warning, not a fault, and nothing was read back.
    expect(consoleErrors).toHaveLength(0);
    expect(consoleWarns.some((l) => l.includes("waitlist_remove_failed"))).toBe(true);
    // The page reads the cookie the action just set, and shows exactly that copy.
    flash.value = flash.sets[0]!.value;
    const html = await render();
    expect(html).toContain(message);
  });

  // Kept despite the route's own role check: the command re-derives membership and role in the
  // database, so a change committed in between lands here. Authority is never softened to a notice.
  it.each([
    ["not_owner", "Only studio owners can change the waitlist."],
    ["not_a_member", "Only studio owners can change the waitlist."],
  ])("the authority refusal `%s` is still thrown", async (code, message) => {
    scenario.removeResult = code;
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expect(removeWaitlistEntryAction(fd)).rejects.toThrow(message);
    expect(revalidated).toHaveLength(0);
  });

  /**
   * Every result the deployed command can produce, read from migration 0188:
   * the removal command's own `return '...'` codes, plus the ones it propagates
   * from `new_client_waitlist_resolve_owner` when that answers anything but
   * `ok`. Derived rather than transcribed, because the transcription is exactly
   * what went stale — the map carried 0185's `not_waiting` for two migrations
   * while 0188's `release_required` and `not_removable` fell through to the
   * generic error.
   */
  const deployedRemovalCodes = (): string[] => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/0188_new_client_waitlist_invitations.sql"),
      "utf8",
    );
    const bodyOf = (fn: string) => {
      const at = sql.indexOf(`create or replace function public.${fn}`);
      expect(at, `${fn} is not defined in 0188`).toBeGreaterThan(-1);
      return sql.slice(at, sql.indexOf("$$;", at));
    };
    const remove = bodyOf("remove_new_client_waitlist_entry");
    const owner = bodyOf("new_client_waitlist_resolve_owner");
    return [
      ...new Set([
        ...[...remove.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]),
        // `if v_code <> 'ok' then return v_code` — resolve_owner's refusals
        // arrive through the removal command verbatim.
        ...[...owner.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).filter((c) => c !== "ok"),
      ]),
    ].sort();
  };

  it("the deployed command's result vocabulary is exactly what this action expects", () => {
    expect(deployedRemovalCodes()).toEqual([
      "already_removed",
      "invalid_input",
      "not_a_member",
      "not_found",
      "not_owner",
      "not_removable",
      "release_required",
      "removed",
    ]);
  });

  it("every refusal is either mapped to copy, or deliberately generic", async () => {
    // The partition, stated: `invalid_input` means a null studio, actor or entry
    // id, and this action guards all three before the RPC — so it is upstream
    // breakage rather than something an owner can act on, and generic is the
    // honest answer. Everything else must say something specific.
    const GENERIC = "Could not remove that entry. Please try again.";
    const DELIBERATELY_GENERIC = new Set(["invalid_input"]);
    // Clean "the row is not where the page assumed" answers become a notice, not a throw.
    const NOTICED = new Set(["already_removed", "not_found", "not_removable", "release_required"]);

    for (const code of deployedRemovalCodes()) {
      if (code === "removed") continue;
      reset();
      scenario.removeResult = code;
      const fd = new FormData();
      fd.set("entry_id", "entry-1");
      const error = await removeWaitlistEntryAction(fd).then(
        () => null,
        (e: Error) => e,
      );
      expect(error, `${code} did not refuse`).not.toBeNull();
      if (DELIBERATELY_GENERIC.has(code)) {
        expect(error!.message, `${code} should be deliberately generic`).toBe(GENERIC);
      } else if (NOTICED.has(code)) {
        expect(error!.message, `${code} should redirect with a notice`).toBe("NEXT_REDIRECT:/waitlist");
        expect(flash.sets.at(-1)?.value, `${code} notice key`).toBe(`remove.${code}`);
      } else {
        expect(error!.message, `${code} falls through to the generic error`).not.toBe(GENERIC);
      }
      if (!NOTICED.has(code)) expect(revalidated, `${code} revalidated despite refusing`).toHaveLength(0);
    }
  });

  describe("an UNCERTAIN outcome reads the entry back before any retry is offered", () => {
    const UNCERTAIN: ReadonlyArray<[string, () => void]> = [
      ["an unrecognised code", () => { scenario.removeResult = "some_future_code"; }],
      ["a database error", () => { scenario.removeError = { code: "57014" }; }],
    ];
    for (const [label, arrange] of UNCERTAIN) {
      it(`${label}: the row is already removed -> success notice, no retry`, async () => {
        arrange();
        readback.value = { known: true, status: "removed" };
        const fd = new FormData();
        fd.set("entry_id", "entry-1");
        await expectNoticeRedirect(removeWaitlistEntryAction(fd), "remove.removed");
      });
      it(`${label}: the row is verifiably still there -> the generic error, a retry is honest`, async () => {
        arrange();
        readback.value = { known: true, status: "waiting" };
        const fd = new FormData();
        fd.set("entry_id", "entry-1");
        await expect(removeWaitlistEntryAction(fd)).rejects.toThrow(
          "Could not remove that entry. Please try again.",
        );
      });
      it(`${label}: a read that returns NO status is not a confirmation either -> unconfirmed, no retry`, async () => {
        arrange();
        readback.value = { known: true, status: null };
        const fd = new FormData();
        fd.set("entry_id", "entry-1");
        await expectNoticeRedirect(removeWaitlistEntryAction(fd), "remove.unconfirmed");
      });
      it(`${label}: the row cannot be read -> an unconfirmed notice that offers no retry`, async () => {
        arrange();
        readback.value = { known: false };
        const fd = new FormData();
        fd.set("entry_id", "entry-1");
        await expectNoticeRedirect(removeWaitlistEntryAction(fd), "remove.unconfirmed");
        flash.value = "remove.unconfirmed";
        const html = await render();
        expect(html).toContain("We could not confirm whether that entry was removed.");
        expect(html).not.toMatch(/try again\./i);
      });
      it(`${label}: is logged as a fault with no contact detail`, async () => {
        arrange();
        readback.value = { known: true, status: "waiting" };
        const fd = new FormData();
        fd.set("entry_id", "entry-1");
        await expect(removeWaitlistEntryAction(fd)).rejects.toThrow();
        expect(consoleErrors.some((l) => l.includes("waitlist_remove_failed"))).toBe(true);
      });
    }
  });

  it("a removal notice renders from the fixed table only, in its own style, and a hand-edited value shows nothing", async () => {
    flash.value = "remove.removed";
    const ok = await render();
    expect(ok).toContain("Removed from the waitlist.");
    expect(ok).not.toContain("Nothing was changed");
    // Success is styled apart from a refusal.
    expect(ok).toMatch(/data-tone="success"[^>]*emerald/);
    flash.value = "release.not_releasable";
    const refusal = await render();
    expect(refusal).toMatch(/data-tone="refusal"[^>]*amber/);
    expect(refusal).not.toContain("emerald-300");
    flash.value = "<b>owned</b>";
    const hostile = await render();
    expect(hostile).not.toContain("owned");
    expect(hostile).not.toContain('data-testid="lifecycle-notice"');
  });

  it("a crafted LINK cannot forge a banner: the URL parameter is not read at all", async () => {
    flash.value = undefined;
    for (const forged of ["remove.removed", "release.not_releasable", "<b>owned</b>"]) {
      const html = await render({ notice: forged } as never);
      expect(html, forged).not.toContain('data-testid="lifecycle-notice"');
      expect(html, forged).not.toContain("Removed from the waitlist.");
    }
  });

  it("logs the outcome without any contact detail", async () => {
    scenario.removeResult = "not_found";
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expect(removeWaitlistEntryAction(fd)).rejects.toThrow();
    const line = consoleWarns.find((l) => l.includes("waitlist_remove_failed"));
    expect(JSON.parse(line!)).toMatchObject({ studioId: STUDIO_ID, outcome: "not_found" });
    expect(line).not.toContain("jo@example.com");
  });

  it("refuses when the signed-in practitioner has no user id", async () => {
    scenario.userId = null;
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expect(removeWaitlistEntryAction(fd)).rejects.toThrow(
      "Could not identify the signed-in practitioner.",
    );
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("the Settings tab is server-gated", () => {
  const LAYOUT = readFileSync(
    path.resolve(__dirname, "../../../lib/settings/nav-registry.ts"),
    "utf8",
  );

  it("requires the DURABLE COMMIT PATH for the live path, OR an active queue", () => {
    // NEW-CLIENT-MODE-01: the two rollout flags are replaced by the one mode.
    // WAITLIST-NAV-VIS-01's second path is UNCHANGED and load-bearing: a studio
    // already holding active entries keeps its navigation to them, whatever the
    // mode says - which is also why UNKNOWN cannot strand a real queue.
    //
    // P2-B: the FIRST path is the durable commit decision, not the mode. A
    // bridged WAITLIST studio whose joins still commit by email has no durable
    // queue, so the tab would open an empty operator surface. Reusing the
    // bridge's own decision is what stops the nav and the commit point drifting
    // apart. Behavioural proof lives in waitlist-nav-visibility.test.ts.
    expect(LAYOUT).toMatch(
      /const waitlistLive = newClientWaitlistCommitIsDurable\(admission, ctx\.studio\.slug\);/,
    );
    expect(LAYOUT).toMatch(
      /return \(\s*\n\s*waitlistLive \|\|\s*\n\s*\(await hasActiveWaitlistEntries\(await createClient\(\), ctx\.studio\.id\)\)\s*\n\s*\);/,
    );
    expect(LAYOUT).toMatch(/label: "Waitlist",\s*\n\s*href: WAITLIST_PATH,/);
  });

  it("derives the mode from the SERVER-RESOLVED studio, never a browser value", () => {
    // NEW-CLIENT-MODE-01: the two env predicates are gone from this consumer.
    // The property that mattered is unchanged and now stronger - the authority
    // is keyed by the server-resolved studio, and nothing browser-supplied
    // reaches it.
    expect(LAYOUT).toContain("getNewClientAdmissionMode(ctx.studio)");
    expect(LAYOUT).not.toContain("isNewClientWaitlistEnabled");
    expect(LAYOUT).not.toContain("isNewClientWaitlistDurableEnabled");
    expect(LAYOUT).not.toMatch(/searchParams|useSearchParams|props\.slug/);
  });

  it("hiding the TAB never hides the DATA — the page has no flag gate", () => {
    // A rollback of either flag must not make committed entries unreachable.
    // The page's only gate is ownership.
    const PAGE = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/settings/waitlist/page.tsx"),
      "utf8",
    );
    expect(PAGE).not.toMatch(/isNewClientWaitlist(Durable)?Enabled/);
  });

  it("is an owner-only entry", () => {
    expect(LAYOUT).toMatch(/href: WAITLIST_PATH,\s*\n\s*roles: OWNER,\s*\n\s*visibleWhen: waitlistVisible/);
    expect(LAYOUT).toMatch(/if \(ctx\.role !== "owner"\) return false;/);
  });

  it("the flags are genuinely consulted at runtime, and BOTH are required", async () => {
    // Not a source-only claim: the two predicates the layout calls really do
    // answer as the visibility rule needs, including the case the review
    // found — durable set, gate cleared.
    const { isNewClientWaitlistEnabled, isNewClientWaitlistDurableEnabled } =
      await import("@/lib/booking/new-client-waitlist");
    const originals = [NEW_CLIENT_WAITLIST_SLUGS_ENV, NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV].map(
      (k) => [k, process.env[k]] as const,
    );
    const set = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    const visible = () =>
      isNewClientWaitlistEnabled(SLUG) && isNewClientWaitlistDurableEnabled(SLUG);
    try {
      set(NEW_CLIENT_WAITLIST_SLUGS_ENV, undefined);
      set(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, undefined);
      expect(visible(), "neither flag").toBe(false);

      set(NEW_CLIENT_WAITLIST_SLUGS_ENV, SLUG);
      expect(visible(), "gate only — the queue is still the inbox").toBe(false);

      set(NEW_CLIENT_WAITLIST_SLUGS_ENV, undefined);
      set(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, SLUG);
      expect(visible(), "durable only — new clients book normally again").toBe(false);

      set(NEW_CLIENT_WAITLIST_SLUGS_ENV, ` ${SLUG.toUpperCase()} `);
      expect(visible(), "both, with trim + case folding").toBe(true);

      set(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, `${SLUG}-archive`);
      expect(visible(), "exact match only — no prefix or suffix").toBe(false);
    } finally {
      for (const [k, v] of originals) set(k, v);
    }
  });
});

// ===========================================================================
// WAIT-EXPOSE-01 — which controls each lifecycle state may offer
// ===========================================================================
//
// PRESENTATION AVAILABILITY COMES FROM STORED STATE. The RPC remains the
// mutation authority and re-derives everything, but a control the row's own
// state forbids is never offered and then refused — waiting for an RPC refusal
// as UX teaches an operator that the button is unreliable rather than that the
// action is wrong.

/** The action controls rendered for one row, by their test ids. */
function actionsFor(html: string): string[] {
  return [...html.matchAll(/data-testid="waitlist-action-([a-z]+)"/g)]
    .map((m) => m[1]!)
    .sort();
}

describe("action visibility follows the row's lifecycle state", () => {
  // The test ids stay the COMMAND's name — `waitlist-action-release` — because
  // renaming them would churn every selector for a copy change. What the button
  // SAYS is asserted separately, below.
  const CASES: ReadonlyArray<[string, string[]]> = [
    // A waiting row offers no lifecycle control at all now: claiming is
    // internal, and nothing else is permitted on a waiting entry. Removal is
    // its own disclosure and carries no action test id.
    ["waiting", []],
    ["claimed", ["release"]],
    // A LIVE invitation offers release (end it early) and NOT Record expired.
    ["invited", ["release"]],
    ["expired", ["requeue"]],
    ["released", ["requeue"]],
  ];

  for (const [status, expected] of CASES) {
    it(`${status} offers exactly ${expected.join(", ") || "nothing"}`, async () => {
      scenario.rows = [entry({ id: `e-${status}`, status })];
      scenario.count = 1;
      // A live invitation: expires in the future, so nothing has run out.
      scenario.liveInvitations =
        status === "invited"
          ? [
              {
                entry_id: `e-${status}`,
                expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              },
            ]
          : [];
      const html = await render({ section: status });
      expect(rowMarkup(html, `e-${status}`)).not.toBeNull();
      expect(actionsFor(html)).toEqual(expected);
    });
  }

  it("EXPIRE IS NOT CANCELLATION — withheld while the invitation is live", async () => {
    scenario.rows = [entry({ id: "e-live", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [
      { entry_id: "e-live", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    const html = await render({ section: "invited" });
    expect(actionsFor(html)).not.toContain("expire");
    expect(html).not.toContain("Record expired");
    // Release is the operator's way to end it early, and it IS offered.
    expect(actionsFor(html)).toContain("release");
  });

  it("Record expired appears ONLY once the clock has run out", async () => {
    scenario.rows = [entry({ id: "e-done", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [
      { entry_id: "e-done", expires_at: new Date(Date.now() - 3_600_000).toISOString() },
    ];
    const html = await render({ section: "invited" });
    expect(actionsFor(html)).toContain("expire");
    expect(html).toContain("Record expired");
  });

  it("a REDEEMED invitation is never offered as expirable", async () => {
    // Redeeming is terminal for the invitation; the command refuses with
    // `already_redeemed`, and the page must not offer the control at all.
    scenario.rows = [entry({ id: "e-used", status: "invited" })];
    scenario.count = 1;
    // A redeemed invitation is TERMINAL, so it has no live row at all — the
    // 0189 unique index is on the all-null predicate. It appears only in the
    // redeemed read.
    scenario.liveInvitations = [];
    scenario.redeemedInvitations = [{ entry_id: "e-used" }];
    const html = await render({ section: "invited" });
    expect(actionsFor(html)).not.toContain("expire");
    // …and Release is withheld too: the command could only answer
    // `already_redeemed`.
    expect(actionsFor(html)).not.toContain("release");
    expect(html).toContain("has been used");
  });

  it("WAIT-P1-EXIT — that row is no longer a dead end: it offers Close", async () => {
    // THE REGRESSION TEST FOR THE DEAD END, AT THE SURFACE.
    //
    // Before 0200 this row rendered with NO lifecycle control at all, under
    // "this entry stays here until the booking is recorded" — which was true
    // and permanent, because release, expire, requeue and remove all refuse a
    // redeemed entry. `close_unbooked_new_client_waitlist_invitation` is the
    // exit, and it is the ONLY control this row may show.
    scenario.rows = [entry({ id: "e-stuck", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [];
    scenario.redeemedInvitations = [{ entry_id: "e-stuck" }];
    const html = await render({ section: "invited" });
    expect(actionsFor(html)).toEqual(["close"]);
    expect(html).toContain("Close without booking");
    // The sentence beside it must not contradict the control next to it.
    expect(html).not.toContain("stays here until");
    expect(html).toContain("no booking has been recorded");
  });

  it("WAIT-P1-EXIT — a CLOSED entry cannot go back on the waitlist", async () => {
    // 0200 answers `already_redeemed` for a requeue of an entry holding a
    // redeemed invitation, because returning it to the active set would let one
    // entry acquire a SECOND redeemed invitation. A control that can only fail
    // is not offered, and the remedy is named instead.
    //
    // THE WIRING THIS PROVES is that the page reads invitation facts for
    // `released` rows at all — deciding this from status alone is impossible,
    // because a released entry that was merely set aside IS requeueable.
    scenario.rows = [entry({ id: "e-closed", status: "released" })];
    scenario.count = 1;
    scenario.liveInvitations = [];
    scenario.redeemedInvitations = [{ entry_id: "e-closed" }];
    const html = await render({ section: "released" });
    expect(actionsFor(html)).toEqual([]);
    // AND THE ROW SAYS SO, rather than leaving the missing control to imply it.
    // The default `released` sentence promises "Return them to it to put them
    // back in line" — a promise this row cannot keep, which is the label-promise
    // rule applied to prose.
    // SCOPED TO THE ROW, NOT THE PAGE. The section heading carries the generic
    // `released` description, exactly as the `invited` section carries a
    // generic one that per-row context refines — an earlier revision of this
    // assertion read the heading and reported the row.
    const row = html.slice(
      html.indexOf('data-entry-id="e-closed"'),
      html.indexOf("</li>", html.indexOf('data-entry-id="e-closed"')),
    );
    expect(row).toContain("used their invitation without booking");
    expect(row, "the ROW still promises a return the command refuses").not.toMatch(
      /back in line/i,
    );
    // AND THE LIFECYCLE STILL TERMINATES. Removal is its own disclosure and
    // carries no action test id, so it is asserted by its own copy.
    expect(html).toMatch(/Remove/);
  });

  it("WAIT-P1-EXIT — an ORDINARY released row is untouched by that rule", async () => {
    // NON-VACUITY. Set-aside-without-redemption is the far commoner way to
    // reach `released`, and it must still offer Return to waitlist.
    scenario.rows = [entry({ id: "e-setaside", status: "released" })];
    scenario.count = 1;
    scenario.liveInvitations = [];
    scenario.redeemedInvitations = [];
    const html = await render({ section: "released" });
    expect(actionsFor(html)).toEqual(["requeue"]);
    expect(html).not.toContain("used their invitation without booking");
    // The instruction is what it keeps, and the control backs it up.
    expect(html).toContain("Return them to it to put them back in line");
  });

  it("WAIT-P1-EXIT — the Released SECTION never instructs, because it is mixed", async () => {
    // THE REVIEW FINDING THIS PINS. The section description is rendered
    // unconditionally above the group, and that group can now hold BOTH a
    // set-aside entry (which can be returned) and a closed one (which cannot).
    // It used to say "Return them to it to put them back in line", so the
    // section instructed owners to do exactly what the row beneath it said was
    // impossible.
    scenario.rows = [
      entry({ id: "e-plain", status: "released", name: "Plain Person" }),
      entry({ id: "e-shut", status: "released", name: "Shut Person" }),
    ];
    scenario.count = 2;
    scenario.liveInvitations = [];
    scenario.redeemedInvitations = [{ entry_id: "e-shut" }];
    const html = await render({ section: "released" });

    // The section heading and its description carry no instruction at all.
    const head = html.slice(
      html.indexOf('data-testid="waitlist-section-released"'),
      html.indexOf("<ul"),
    );
    expect(head, "the section still instructs, above a group it cannot speak for").not.toMatch(
      /back in line|return them/i,
    );

    // Each ROW still says the right thing for itself.
    const rowOf = (id: string) =>
      html.slice(html.indexOf(`data-entry-id="${id}"`), html.indexOf("</li>", html.indexOf(`data-entry-id="${id}"`)));
    expect(rowOf("e-plain")).toMatch(/back in line/i);
    expect(rowOf("e-shut")).toMatch(/used their invitation without booking/i);
    expect(rowOf("e-shut")).not.toMatch(/back in line/i);
  });

  it("a FAILED invitation read withholds the control and SAYS it could not check", async () => {
    // The wrong answer here is silence that reads as "still live". Unknown is
    // not the same as not-elapsed, and the sentence has to say which it is.
    scenario.rows = [entry({ id: "e-unknown", status: "invited" })];
    scenario.count = 1;
    scenario.invitationsError = { code: "57014" };
    const html = await render({ section: "invited" });
    // FAILS CLOSED, both ways. Release used to render here on the assumption
    // that unknown meant "not redeemed" — but a redeemed invitation can only
    // answer `already_redeemed`, so the control could not succeed. Neither is
    // offered, and the copy no longer claims Release "ends it either way".
    expect(actionsFor(html)).not.toContain("expire");
    expect(actionsFor(html)).not.toContain("release");
    expect(html).toContain("could not be");
    expect(html).not.toContain("either way");
  });

  it("the invitation-to-booking summary costs a constant number of reads, whatever the rows: seven head-only counts and one command call", async () => {
    for (const rows of [[entry({ status: "waiting" })], [entry({ id: "e-a", status: "invited" }), entry({ id: "e-b", status: "released" })]]) {
      queries.length = 0;
      rpcCalls.length = 0;
      userRpcCalls.length = 0;
      scenario.rows = rows;
      scenario.count = rows.length;
      await render();
      const reads = queries.filter(isSummaryRead);
      expect(reads).toHaveLength(7);
      for (const q of reads) {
        expect(q.options).toEqual({ count: "exact", head: true });
        expect(q.columns).toBe("id");
        expect(q.filters.some((f) => f[0] === "eq" && f[1] === "studio_id")).toBe(true);
      }
      expect(userRpcCalls.map((c) => c.fn)).toEqual(["waitlist_invitation_booking_counts"]);
      expect(userRpcCalls[0]!.args).toMatchObject({ p_studio_id: STUDIO_ID });
      expect(Object.keys(userRpcCalls[0]!.args).sort()).toEqual(["p_from", "p_studio_id"]);
      // and nothing the summary does reaches the service-role client
      expect(rpcCalls.filter((c) => c.fn === "waitlist_invitation_booking_counts")).toHaveLength(0);
    }
  });

  it("the page shows the summary with the command's counts, and Not available for the booked figures when the command fails", async () => {
    scenario.rows = [entry({ status: "waiting" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain('data-testid="invitation-booking-summary"');
    expect(html).toMatch(/data-testid="invitation-people">17</);
    expect(html).toMatch(/data-row="booked"[\s\S]*?data-value="5"/);
    expect(html).toContain("Not tracked");
    summaryRpc.error = { code: "PGRST202" };
    consoleErrors.length = 0;
    const failed = await render();
    expect(failed).toContain('data-testid="invitation-booking-unavailable"');
    expect(failed).toMatch(/data-row="booked"[\s\S]*?data-value="unavailable"/);
    expect(failed).toMatch(/data-testid="invitation-people">Not available</);
  });

  it("the invitation window is read ONLY for rows whose controls depend on it", async () => {
    // WIDENED BY 0200, AND STILL BOUNDED. `released` rows joined `invited` ones
    // because requeue's availability now depends on whether this entry's
    // invitation was used — but `waiting`, `claimed`, `converted` and `removed`
    // still trigger nothing, which is what keeps this a per-page read rather
    // than a per-row one.
    scenario.rows = [entry({ status: "waiting" })];
    scenario.count = 1;
    await render();
    // The studio-wide expiry summary (expires_at only) is a constant-cost read of its own, not a per-row one; it is counted separately.
    expect(queries.filter((q) => q.table === "new_client_waitlist_invitations" && q.columns !== "expires_at" && q.columns !== DECLINE_COUNT_READ && !isSummaryRead(q))).toHaveLength(0);
    expect(queries.filter((q) => q.table === "new_client_waitlist_invitations" && q.columns === "expires_at")).toHaveLength(1);
    // Five section reads, plus the needs-attention card's own read (id,name).
    expect(queries.filter((q) => q.table === "new_client_waitlist_entries" && q.columns !== "id,name" && q.columns !== "id,name,released_at")).toHaveLength(5);
    expect(queries.filter((q) => q.table === "new_client_waitlist_entries" && q.columns === "id,name")).toHaveLength(1);
  });

  it("and IS read when a row is invited", async () => {
    // Non-vacuity for the assertion above.
    scenario.rows = [entry({ id: "e-inv", status: "invited" })];
    scenario.count = 1;
    await render({ section: "invited" });
    // THREE invitation reads: the live-cycle predicate and the redeemed one the
    // page makes, plus the needs-attention card's own redeemed-invitation read
    // (0313), which exists only because an invited entry does. Identity comes
    // from the 0189 unique index, never from ordering — so none of them
    // carries an `order`.
    const inv = queries.filter((q) => q.table === "new_client_waitlist_invitations" && q.columns !== "expires_at" && q.columns !== DECLINE_COUNT_READ && !isSummaryRead(q));
    expect(inv).toHaveLength(3);
    for (const q of inv) expect(q.orders).toEqual([]);
  });

  it("and when a row is released — the same two reads, not a third", async () => {
    // WAIT-P1-EXIT rides the EXISTING queries: one `.in()` list widened, no new
    // round trip, no new policy, and still no ordering of any kind.
    scenario.rows = [entry({ id: "e-rel", status: "released" })];
    scenario.count = 1;
    await render({ section: "released" });
    // The declined-times card's own read (entry_id,declined_at) is a separate, card-level read.
    const inv = queries.filter((q) => q.table === "new_client_waitlist_invitations" && q.columns !== "entry_id,declined_at" && q.columns !== "expires_at" && q.columns !== DECLINE_COUNT_READ && !isSummaryRead(q));
    expect(inv).toHaveLength(2);
    for (const q of inv) expect(q.orders).toEqual([]);
  });

  it("the live invitation is identified STRUCTURALLY, never by chronology", () => {
    // 0189 exists because `issued_at desc, id desc` picked historical rows and
    // broke ties on a random UUID. The live row is the one whose three terminal
    // stamps are all null — a unique index, not a guess.
    const SRC = readFileSync(
      path.join(process.cwd(), "app/(app)/settings/waitlist/page.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const invRead = SRC.slice(SRC.indexOf('from("new_client_waitlist_invitations")'));
    expect(invRead).toMatch(/\.is\("redeemed_at", null\)/);
    expect(invRead).toMatch(/\.is\("expired_at", null\)/);
    expect(invRead).toMatch(/\.is\("released_at", null\)/);
    expect(invRead).not.toMatch(/issued_at/);
  });

  it("CLAIM NEXT IS GONE — it is offered in no queue shape at all", async () => {
    // It used to render above the sections whenever anyone was waiting. Bulk
    // claiming is an internal transition, so the control is removed rather than
    // merely hidden: no queue composition brings it back.
    for (const rows of [
      [entry({ id: "c1", status: "claimed" })],
      [entry({ id: "w1", status: "waiting" })],
      [entry({ id: "c1", status: "claimed" }), entry({ id: "w1", status: "waiting" })],
      Array.from({ length: 30 }, (_, i) => entry({ id: `w${i}`, status: "waiting" })),
    ]) {
      reset();
      scenario.rows = rows;
      const html = await render();
      expect(html).not.toContain("Claim next");
      expect(html).not.toContain("Claim the next");
      // The count input the form carried is gone with it.
      expect(html).not.toContain('name="count"');
    }
  });

  it("NON-VACUITY — the queue still renders while Claim next does not", async () => {
    // Without this, the assertions above would pass against a page that failed
    // to render anything at all.
    scenario.rows = [entry({ id: "w1", status: "waiting", name: "Still Here" })];
    const html = await render();
    expect(html).toContain(">Still Here<");
    expect(html).toMatch(/Waitlist entries:\s*<[^>]*>1</);
  });

  it("a busy section cannot crowd another off the page", async () => {
    // THE DEFECT THIS PINS. Under one shared cap, enough old expired/released
    // rows would push a freshly claimed entry off the page — taking Release,
    // its only escape action, with it. Per-section bounds make that
    // unreachable: every section shows its own oldest rows.
    scenario.rows = [
      ...Array.from({ length: 3 }, (_, i) =>
        entry({ id: `x${i}`, status: "expired", joined_at: "2020-01-01T00:00:00.000Z" }),
      ),
      entry({ id: "held", status: "claimed", joined_at: "2026-08-30T00:00:00.000Z" }),
    ];
    const html = await render();
    // The claimed row is present WITH its OWN Release control, despite being
    // the newest row on the page.
    expect(html).toContain('data-entry-status="claimed"');
    expect(rowActions(html, "held")).toContain("release");
  });

  it("each section reports its OWN total, and offers its own way through", async () => {
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.sectionTotals = { waiting: 250 };
    const html = await render();
    expect(html).toMatch(/Waitlist entries:\s*<[^>]*>250</);
    // The HEADING carries the group's exact total, not the number on screen —
    // one row is rendered, and the heading still says 250.
    expect(html).toContain(">(250)<");
    expect(html).not.toContain(">(1)<");
    expect(html).toContain("Showing the first 1 of 250, in queue order.");
    expect(html).toContain('href="/waitlist?section=waiting"');
  });
});

// ===========================================================================
// EVERY ENTRY STAYS REACHABLE, AND SO DOES ITS ONLY WAY OUT
// ===========================================================================
//
// THE DEFECT THIS CLOSES. Each section used to read one bounded page and stop.
// A section holding more than that stranded every row past it — and an entry's
// escape action lives on its own row, so a claimed entry beyond the hundredth
// could never be released, an invited one never expired, an expired one never
// returned to the queue. "Claim next N" walks the database's queue order and
// can push the held section past a page by itself, so the surface could
// manufacture entries it was then unable to reach.
//
// Raising 100 to a larger number would only move the cliff. These tests pin the
// mechanism instead: the window has an OFFSET, the offset is reachable from the
// UI, and the row it reveals arrives with its control.
//
// THE POSITIVE ASSERTIONS ARE PAIRED WITH THE SAME ONES RUN AGAINST A FAKE THAT
// IGNORES THE OFFSET — the read as it behaved before the fix. Without that half,
// a test that never windows anything passes for the wrong reason.

/** N seeded rows in one section, oldest first, each individually identifiable. */
function seedSection(status: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    entry({
      id: `${status}-${i + 1}`,
      name: `Person ${i + 1}`,
      email: `p${i + 1}@example.com`,
      status,
      // Ascending join times, so "the order the fake returns them" is also the
      // order the database's (joined_at, id) index would.
      joined_at: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
    }),
  );
}

/**
 * The markup of ONE row, sliced at its own boundaries.
 *
 * WHY THIS EXISTS. `actionsFor(html)` scans the WHOLE page, so on a page of
 * claimed entries "a Release is rendered" is satisfied by any row — including
 * one that is not the row under test. That makes "entry 150 can be released"
 * and "this page has a Release somewhere" the same assertion, and only the
 * second one is true under the pre-fix read. Scoping to the row is what
 * separates them.
 *
 * Composer choices can contain nested lists. Match the outer row's closing
 * tag so the result includes its final buttons, even when its composer opens.
 */
function rowMarkup(html: string, entryId: string): string | null {
  const attr = html.indexOf(`data-entry-id="${entryId}"`);
  if (attr === -1) return null;
  const start = html.lastIndexOf("<li", attr);
  const rowAndRest = html.slice(start);
  let depth = 0;
  for (const tag of rowAndRest.matchAll(/<\/?li\b[^>]*>/g)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return rowAndRest.slice(0, tag.index + tag[0].length);
  }
  throw new Error("Unclosed waitlist row");
}

/** The lifecycle actions offered ON one entry's own row — never the page's. */
function rowActions(html: string, entryId: string): string[] {
  const markup = rowMarkup(html, entryId);
  return markup === null ? [] : actionsFor(markup);
}

/** The read the page issued for one section, by its status filter. */
function readFor(status: string) {
  return queries.find(
    (q) =>
      q.table === "new_client_waitlist_entries" &&
      q.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === status),
  )!;
}

describe("a section past one page is navigable, not truncated", () => {
  it("the default view shows the first page AND an actionable way to the rest", async () => {
    scenario.rows = seedSection("claimed", 150);
    const html = await render();

    // The first hundred are here…
    expect(html).toContain(">Person 1<");
    expect(html).toContain(">Person 100<");
    // …the hundred-and-fiftieth is not…
    expect(html).not.toContain(">Person 150<");
    // …and the page says so, with a link rather than an apology.
    expect(html).toContain("Showing the first 100 of 150, in queue order.");
    expect(html).toContain('data-testid="waitlist-section-all-claimed"');
    expect(html).toContain('href="/waitlist?section=claimed"');
  });

  it("REQ 1-4 — entry 150 is reached, and RELEASE IS ON ITS OWN ROW", async () => {
    // The entry an operator most needs to reach: claimed, past the first page,
    // and holding a person whose only exit is the control on that row.
    scenario.rows = seedSection("claimed", 150);
    const html = await render({ section: "claimed", page: "2" });

    const row = rowMarkup(html, "claimed-150");
    expect(row, "entry 150 is not on the page at all").not.toBeNull();
    expect(row).toContain(">Person 150<");
    expect(row).toContain('data-entry-status="claimed"');

    // THE ASSERTION THAT MATTERS: the control is on THIS row, not merely
    // somewhere on a page full of other claimed people.
    expect(rowActions(html, "claimed-150")).toContain("release");
    // …and it is genuinely THIS entry the form would act on.
    expect(row).toContain('name="entry_id" value="claimed-150"');

    // NON-VACUITY FOR THE SLICE: one row, not the page. If it spanned its
    // neighbours, "its own Release" would mean nothing.
    expect(row).not.toContain(">Person 149<");
    expect(row).not.toContain(">Person 101<");

    // The window asked for is the SECOND page, stated honestly.
    expect(html).toContain("Showing 101–150 of 150.");
    expect(readFor("claimed").range).toEqual([100, 199]);
  });

  it("NEGATIVE CONTROL — that exact assertion goes RED against the pre-fix read", async () => {
    // The pre-fix read: a bounded page from the top of the section, whatever
    // window was requested.
    scenario.rows = seedSection("claimed", 150);
    scenario.ignoreRange = true;
    const html = await render({ section: "claimed", page: "2" });

    // THE EXACT ASSERTION FROM THE TEST ABOVE, SHOWN FAILING — written as the
    // same expression rather than its negation, so there is no doubt the two
    // tests are making the same claim about the same thing.
    expect(() =>
      expect(rowActions(html, "claimed-150")).toContain("release"),
    ).toThrow();

    // …and why it fails: entry 150 is absent, so it has no row and therefore
    // no control of its own.
    expect(rowMarkup(html, "claimed-150")).toBeNull();
    expect(rowActions(html, "claimed-150")).toEqual([]);

    // AND HERE IS WHY THE SCOPING WAS NECESSARY. The page-wide form of the
    // same claim PASSES against this broken read: rows 1-100 are also
    // `claimed`, so they render Releases of their own. An unscoped assertion
    // was being satisfied by another person's control, which is exactly the
    // false green this pairing removes.
    expect(actionsFor(html)).toContain("release");
    expect(html).toContain(">Person 1<");
    expect(rowActions(html, "claimed-1")).toContain("release");
  });

  it("PROVES THE CONTROL IS ROW-BOUND — reaching the row is what carries the action", async () => {
    // Non-vacuity for the negative control above: Release is not rendered once
    // per page regardless of rows, so its presence really does track the row.
    scenario.rows = [];
    const html = await render({ section: "claimed", page: "1" });
    expect(actionsFor(html)).not.toContain("release");
  });

  it("THE ROW SLICE ITSELF IS HONEST — it neither spans rows nor invents one", async () => {
    // Everything above rests on `rowMarkup` returning ONE row. A slice that
    // quietly returned the page would make every scoped assertion equivalent
    // to the page-wide one it replaced, and the negative control would stop
    // discriminating without ever going red.
    scenario.rows = [
      entry({ id: "claimed-a", name: "Ada", status: "claimed" }),
      entry({ id: "claimed-b", name: "Bo", status: "claimed" }),
    ];
    const html = await render();

    const a = rowMarkup(html, "claimed-a")!;
    const b = rowMarkup(html, "claimed-b")!;
    expect(a).toContain(">Ada<");
    expect(a).not.toContain(">Bo<");
    expect(b).toContain(">Bo<");
    expect(b).not.toContain(">Ada<");
    // Each carries its OWN entry id into its own action form.
    expect(a).toContain('name="entry_id" value="claimed-a"');
    expect(a).not.toContain('value="claimed-b"');
    // Both really do offer the control, so the exclusions above are not
    // passing because the slices are empty.
    expect(rowActions(html, "claimed-a")).toContain("release");
    expect(rowActions(html, "claimed-b")).toContain("release");
    // An entry that is not on the page has no slice — not the whole page.
    expect(rowMarkup(html, "claimed-nobody")).toBeNull();
  });

  it("REQ 4 — Claim next cannot create a row the UI is unable to reach", async () => {
    // The held section is the one Claim next grows. Whatever size it reaches,
    // every page of it is addressable and every row arrives with its control.
    scenario.rows = seedSection("claimed", 250);
    const lastPage = await render({ section: "claimed", page: "3" });
    const row = rowMarkup(lastPage, "claimed-250");
    expect(row, "entry 250 is not on the page at all").not.toBeNull();
    expect(row).toContain(">Person 250<");
    expect(rowActions(lastPage, "claimed-250")).toContain("release");
    expect(lastPage).toContain("Showing 201–250 of 250.");
  });

  it("REQ 2-3 — an expired row past a page keeps its escape too", async () => {
    scenario.rows = seedSection("expired", 150);
    const html = await render({ section: "expired", page: "2" });
    const row = rowMarkup(html, "expired-150");
    expect(row, "expired entry 150 is not on the page at all").not.toBeNull();
    expect(row).toContain(">Person 150<");
    // Requeue is this state's only way back, and it must be on THIS row.
    expect(rowActions(html, "expired-150")).toContain("requeue");
  });

  it("REQ 8 — paging windows the DATABASE's order and re-sorts nothing", async () => {
    scenario.rows = seedSection("claimed", 150);
    await render({ section: "claimed", page: "2" });
    expect(readFor("claimed").orders).toEqual([
      ["joined_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("REQ 9 — a focused page changes no authority boundary", async () => {
    // Same RLS-scoped client, same studio filter, same status filter. The admin
    // mock throws on `from`, so a service-role read would have failed outright.
    scenario.rows = seedSection("claimed", 150);
    await render({ section: "claimed", page: "2" });
    expect(readFor("claimed").filters).toEqual([
      ["eq", "studio_id", STUDIO_ID],
      ["eq", "status", "claimed"],
    ]);
    expect(readFor("claimed").columns).toBe(ENTRY_COLUMNS);
  });
});

describe("the focused view keeps the headline honest", () => {
  it("counts the WHOLE queue, not the group being viewed", async () => {
    // THE FAILURE THIS PREVENTS: "Waitlist entries" quietly changing meaning
    // from the whole queue to this group, under the same words.
    scenario.rows = [...seedSection("claimed", 150), ...seedSection("waiting", 7)];
    const html = await render({ section: "claimed", page: "2" });
    expect(html).toMatch(/Waitlist entries:\s*<[^>]*>157</);
  });

  it("reads the other sections HEAD-ONLY — their counts, none of their rows", async () => {
    scenario.rows = [...seedSection("claimed", 150), ...seedSection("waiting", 7)];
    const html = await render({ section: "claimed", page: "1" });

    // Five section reads either way; only the focused one asks for rows. (The
    // needs-attention card's own id,name read is not a section.)
    const reads = queries.filter((q) => q.table === "new_client_waitlist_entries" && q.columns !== "id,name" && q.columns !== "id,name,released_at");
    expect(reads).toHaveLength(5);
    const listed = reads.filter((q) => q.options.head === false);
    expect(listed).toHaveLength(1);
    expect(
      listed[0]!.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "claimed"),
    ).toBe(true);
    for (const q of reads) expect(q.options.count).toBe("exact");

    // And no waiting person is rendered while the held group is in focus.
    expect(html).not.toContain('data-entry-status="waiting"');
  });

  it("returns from a focused section to the complete waiting list through its view link", async () => {
    scenario.rows = seedSection("claimed", 150);
    const html = await render({ section: "claimed", page: "2" });
    const nav = /<nav[^>]*aria-label="Waitlist views"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
    expect(nav).toBeTruthy();
    expect(nav).toMatch(/<a\b[^>]*href="\/waitlist"[^>]*>Waiting</);
  });

  it("renders prev/next only where there is somewhere to go", async () => {
    scenario.rows = seedSection("claimed", 150);
    const first = await render({ section: "claimed", page: "1" });
    expect(first).not.toContain('data-testid="waitlist-page-prev"');
    expect(first).toContain('href="/waitlist?section=claimed&amp;page=2"');

    reset();
    scenario.rows = seedSection("claimed", 150);
    const second = await render({ section: "claimed", page: "2" });
    expect(second).toContain('data-testid="waitlist-page-prev"');
    expect(second).not.toContain('data-testid="waitlist-page-next"');

    reset();
    scenario.rows = seedSection("claimed", 40);
    const only = await render({ section: "claimed", page: "1" });
    expect(only).not.toContain('data-testid="waitlist-page-prev"');
    expect(only).not.toContain('data-testid="waitlist-page-next"');
  });
});

describe("a browser-supplied section or page can never mislead", () => {
  it("an unknown section falls back to Waiting and never reaches a filter", async () => {
    scenario.rows = [...seedSection("claimed", 2), ...seedSection("waiting", 2)];
    const html = await render({ section: "converted' or 1=1--" });

    expect(html).toContain('data-view="waiting"');
    expect(html).toContain('data-entry-status="claimed"');
    expect(html).toContain('data-entry-status="waiting"');
    // The injected value reached no query. Status filters are the five the page
    // declares, because `section` is MATCHED against them rather than passed
    // through.
    const statuses = queries
      .filter((q) => q.table === "new_client_waitlist_entries" && q.columns !== "id,name" && q.columns !== "id,name,released_at")
      .map((q) => q.filters.find((f) => f[0] === "eq" && f[1] === "status")?.[2]);
    expect(statuses).toEqual(["waiting", "claimed", "invited", "expired", "released"]);
  });

  it("a terminal status is not a section, even though it is a real status", async () => {
    // `converted` and `removed` are deliberately unread. Naming one must not
    // produce a focused view of a group this surface does not show.
    scenario.rows = seedSection("waiting", 2);
    const html = await render({ section: "removed" });
    expect(html).toContain('data-view="waiting"');
    expect(html).not.toContain('data-entry-status="removed"');
    expect(html).toContain('data-entry-status="waiting"');
  });

  it("a junk, zero or negative page lands on page ONE, never on nothing", async () => {
    for (const bad of ["0", "-3", "abc", ""]) {
      reset();
      scenario.rows = seedSection("claimed", 150);
      const html = await render({ section: "claimed", page: bad });
      expect(html, bad).toContain(">Person 1<");
      expect(html, bad).toContain("Showing 1–100 of 150.");
    }
  });

  it("a repeated param takes the first value rather than joining them", async () => {
    scenario.rows = seedSection("claimed", 150);
    const html = await render({ section: ["claimed", "waiting"], page: ["2", "9"] });
    expect(html).toContain("Showing 101–150 of 150.");
  });

  it("PAST THE END says so, and offers the way back", async () => {
    // The read returns no rows against a non-zero count. Rendering that as an
    // empty section would say "nobody here" about a group that is not empty.
    scenario.rows = seedSection("claimed", 150);
    const html = await render({ section: "claimed", page: "7" });
    expect(html).toContain("That page is past the end of this group");
    expect(html).toContain('data-testid="waitlist-page-first"');
    expect(html).not.toContain("Nobody is in this group right now.");
    // The group's real size is still stated in the heading.
    expect(html).toContain(">(150)<");
  });

  it("an EMPTY focused group answers, rather than vanishing", async () => {
    // A section asked for by name must respond even when the answer is nobody;
    // an absent section would read as a broken link.
    scenario.rows = seedSection("waiting", 3);
    const html = await render({ section: "released" });
    expect(html).toContain("Nobody is in this group right now.");
    expect(html).not.toContain("That page is past the end");
  });
});

// ===========================================================================
// THE PRACTITIONER'S VOCABULARY, NOT THE IMPLEMENTATION'S
// ===========================================================================
//
// "Claim" describes how the queue moves an entry out of general contention. It
// is not a job a studio owner sets out to do, and putting it on screen made the
// waitlist read like an implementation detail rather than a list of people
// waiting to hear back. The state, the commands and the server actions are all
// unchanged — only what is RENDERED moved.

/** A live invitation for one entry: not redeemed, not yet elapsed. */
function liveInvitationFor(entryId: string) {
  return [{ entry_id: entryId, expires_at: new Date(Date.now() + 86_400_000).toISOString() }];
}

/**
 * What a practitioner can actually READ.
 *
 * Scripts and then tags are stripped, so `data-testid="waitlist-section-claimed"`
 * and `data-entry-status="claimed"` are excluded by construction. Those keep the
 * DATABASE's word deliberately: they are selectors and internal state, renaming
 * them would churn every test and every query, and no practitioner sees them.
 * The rule being enforced is about COPY, so the check is about copy.
 */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

describe("claiming is internal and never reaches the screen", () => {
  it("a WAITING row offers no Claim, and the word appears nowhere", async () => {
    scenario.rows = [entry({ id: "w1", status: "waiting", name: "Ada Waiting" })];
    const html = await render();

    // The row is genuinely rendered — the absence below is not an empty page.
    expect(html).toContain(">Ada Waiting<");
    expect(rowActions(html, "w1")).toEqual([]);
    expect(visibleText(html)).not.toMatch(/\bclaim/i);
  });

  it("NO section, in any state, renders the word", async () => {
    // Scan the copy on every status page where an owner can reach a row.
    scenario.rows = [
      entry({ id: "w1", status: "waiting" }),
      entry({ id: "c1", status: "claimed" }),
      entry({ id: "i1", status: "invited" }),
      entry({ id: "x1", status: "expired" }),
      entry({ id: "r1", status: "released" }),
    ];
    scenario.liveInvitations = liveInvitationFor("i1");
    let text = "";

    // NON-VACUITY: all five sections really did render.
    for (const s of ["waiting", "claimed", "invited", "expired", "released"]) {
      const html = await render({ section: s });
      text += visibleText(html);
      expect(html, s).toContain(`data-testid="waitlist-section-${s}"`);
    }
    expect(text).not.toMatch(/\bclaim/i);
    expect(text).not.toMatch(/\bheld\b/i);
    // NON-VACUITY for the stripper: it kept the copy it was meant to scan.
    expect(text).toContain("Ready to invite");
    expect(text).toContain("Waitlist entries");
  });
});

describe("what each state and control is CALLED", () => {
  it("a claimed row is shown as READY TO INVITE", async () => {
    scenario.rows = [entry({ id: "c1", status: "claimed", name: "Bo Ready" })];
    const html = await render();

    expect(html).toContain("Ready to invite");
    expect(html).toContain(">Bo Ready<");
    // The section is genuinely the claimed one — the heading is not coming from
    // somewhere else — and the state's old name reaches no copy.
    expect(html).toContain('data-testid="waitlist-section-claimed"');
    expect(visibleText(html)).not.toMatch(/\bheld\b/i);
  });

  it("a claimed row's release control reads SET ASIDE, not a false promise", async () => {
    // THE P1 THIS PINS. Release does NOT return anyone to the waitlist: it
    // lands the entry in `released`, where a SECOND control — requeue, which
    // genuinely is "Return to waitlist" — is what reaches `waiting`. Labelling
    // this one "Return to waitlist" let an owner drop someone out of the queue
    // believing they had put them back in it.
    scenario.rows = [entry({ id: "c1", status: "claimed" })];
    const html = await render();

    // The control is present and wired…
    expect(rowActions(html, "c1")).toContain("release");
    // …and it promises only what the command delivers.
    const row = rowMarkup(html, "c1")!;
    expect(row).toContain("Set aside");
    expect(row).not.toContain("Return to waitlist");
    expect(row).not.toMatch(/>Release</);
    expect(row).not.toContain("Cancel invitation");

    // The consequence the verb cannot carry sits beside the control.
    expect(row).toContain('data-testid="waitlist-action-help-release"');
    expect(row).toContain("You can return them to the waitlist later.");
  });

  it("an invited row's release control reads CANCEL INVITATION", async () => {
    // The same command, but it ends something that has ALREADY REACHED SOMEONE.
    // Labelling both "Release" made the more consequential one look like filing.
    scenario.rows = [entry({ id: "i1", status: "invited" })];
    scenario.liveInvitations = liveInvitationFor("i1");
    const html = await render({ section: "invited" });

    expect(rowActions(html, "i1")).toContain("release");
    const row = rowMarkup(html, "i1")!;
    expect(row).toContain("Cancel invitation");
    expect(row).not.toContain("Return to waitlist");
    expect(row).not.toMatch(/>Release</);
  });

  it("the three lifecycle actions keep distinct labels across views", async () => {
    // Non-vacuity for the trio: rendered together, so no assertion is passing
    // on an absent row. And the whole point of the P1 — the two controls that
    // perform DIFFERENT transitions must not read alike, while the one that
    // genuinely returns someone to the waitlist keeps that phrase to itself.
    scenario.rows = [
      entry({ id: "c1", status: "claimed" }),
      entry({ id: "i1", status: "invited" }),
      entry({ id: "r1", status: "released" }),
    ];
    scenario.liveInvitations = liveInvitationFor("i1");
    const claimed = rowMarkup(await render(), "c1");
    const invited = rowMarkup(await render({ section: "invited" }), "i1");
    const released = rowMarkup(await render({ section: "released" }), "r1");

    expect(claimed).toContain("Set aside");
    expect(invited).toContain("Cancel invitation");
    expect(released).toContain("Return to waitlist");

    // THE BUTTON LABEL "Return to waitlist" BELONGS TO REQUEUE ALONE — this is
    // the assertion that would have caught the defect. Matched case-sensitively
    // against the label itself: the help sentence beside Set aside says
    // "return THEM to the waitlist later", which is a different string and a
    // true one, so it is not what is being excluded here.
    expect(claimed).not.toContain("Return to waitlist");
    expect(invited).not.toContain("Return to waitlist");
    expect(claimed).not.toContain("Cancel invitation");
    expect(released).not.toContain("Set aside");
  });

  it("requeue reads RETURN TO WAITLIST on expired and released rows", async () => {
    scenario.rows = [
      entry({ id: "x1", status: "expired" }),
      entry({ id: "r1", status: "released" }),
    ];
    const html = await render({ tab: "history" });

    for (const id of ["x1", "r1"]) {
      expect(rowActions(html, id), id).toContain("requeue");
      expect(rowMarkup(html, id), id).toContain("Return to waitlist");
      expect(rowMarkup(html, id), id).not.toContain("Return to queue");
    }
  });
});

describe("the wiring underneath is untouched", () => {
  it("both claim server actions still exist and are still exported", async () => {
    // This change removed a control, not a capability. If the actions were
    // deleted, restoring the UI would stop being a rendering change.
    const actions = await import("@/app/(app)/settings/waitlist/actions");
    expect(typeof actions.claimWaitlistEntryAction).toBe("function");
    expect(typeof actions.claimNextWaitlistEntriesAction).toBe("function");
  });

  it("every lifecycle command is still reached by the action layer", async () => {
    // The RPC census, over BOTH shapes: four actions pass the command name
    // through the shared runner as `rpc: "..."`, two call `.rpc("...")`.
    const src = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/settings/waitlist/actions.ts"),
      "utf8",
    );
    for (const command of [
      "claim_new_client_waitlist_entry",
      "claim_new_client_waitlist_entries",
      "release_new_client_waitlist_entry",
      "expire_new_client_waitlist_invitation",
      "requeue_new_client_waitlist_entry",
      "remove_new_client_waitlist_entry",
    ]) {
      expect(src, command).toContain(command);
    }
    // And the deferred three are still INVOKED nowhere. Comments are stripped
    // first: this file names all three in a comment saying it deliberately does
    // not wire them, and a scan of raw text would read that promise as a
    // breach of itself.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const deferred of [
      "issue_new_client_waitlist_invitation",
      "redeem_new_client_waitlist_invitation",
      "record_new_client_waitlist_conversion",
    ]) {
      expect(code, deferred).not.toContain(deferred);
    }
    // NON-VACUITY: the stripped source is still real code, not an empty string.
    expect(code).toContain("createAdminClient");
  });

  it("the PAGE no longer invokes either claim action", async () => {
    // The removal is total: not merely an unrendered branch, but no import.
    const src = readFileSync(
      path.resolve(__dirname, "../../../app/(app)/settings/waitlist/page.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("claimWaitlistEntryAction");
    expect(src).not.toContain("claimNextWaitlistEntriesAction");
    // NON-VACUITY: the stripped source is still real code with the actions it
    // DOES use.
    expect(src).toContain("releaseWaitlistEntryAction");
    expect(src).toContain("requeueWaitlistEntryAction");
  });
});

// ===========================================================================
// WAIT-04A — PROVENANCE, AVAILABILITY, AND THE TWO WAYS IN
// ===========================================================================
//
// The commands these exercise shipped with migration 0193 and had ZERO callers
// until this slice. What is proved here is the surface: that the page asks the
// right questions with the right client, and — the part that actually matters —
// that it never states a waiting time it cannot stand behind.
describe("WAIT-04A — what the queue may claim about a row", () => {
  it("a public-form joiner renders a join date AND a wait", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();

    expect(html).toContain('data-testid="joined-known"');
    expect(html).toContain("Joined");
    expect(html).toMatch(/waiting/);
    // The ordinary row carries NO caveat: annotating every form joiner would
    // bury the two origins that genuinely need one.
    expect(html).not.toContain('data-testid="joined-note"');
    expect(html).not.toContain('data-testid="entry-origin"');
  });

  it("an operator-supplied date renders the wait AND says where the date came from", async () => {
    scenario.rows = [
      entry({
        source: "legacy_import",
        joined_at_provenance: "operator_supplied",
        joined_at: "2025-03-04T09:00:00.000Z",
      }),
    ];
    scenario.count = 1;
    const html = await render();

    // The studio is standing behind this date, so a wait may be computed from
    // it — and it is a LONG one, which is exactly the fact an import exists to
    // preserve. Asserting the note alone would pass even if the date were
    // silently replaced by the import instant.
    expect(html).toContain('data-testid="joined-known"');
    expect(html).toContain("from studio records");
    expect(html).toMatch(/2025/);
    expect(html).toContain('data-testid="entry-origin"');
    expect(html).toContain("From studio records");
  });

  it("an UNKNOWN join date renders no date and no wait — 0193's rule, enforced", async () => {
    // THE IMPORT INSTANT IS IN `joined_at`, because the row needs a position in
    // the (joined_at, id) total order. 0193: "joined_at_provenance stays
    // 'unknown', so no reader may render it as a wait". A page that rendered it
    // would tell the operator this person joined today and has waited zero
    // days, about someone who has been waiting since before Hone existed.
    scenario.rows = [
      entry({
        source: "legacy_import",
        joined_at_provenance: "unknown",
        joined_at: "2026-09-16T12:00:00.000Z",
      }),
    ];
    scenario.count = 1;
    const html = await render();

    expect(html).toContain('data-testid="joined-unknown"');
    expect(html).not.toContain('data-testid="joined-known"');
    // SCOPED TO THE ROW. "Waiting" is also a section heading and "already
    // waiting" is a tab label, so a page-wide word search would pass on a page
    // that still rendered the false wait. The claim is about THIS person's
    // card: no join date, and no elapsed time of any unit.
    const card = html.match(/<li[^>]*data-entry-id="entry-1"[\s\S]*?<\/li>/)?.[0];
    expect(card, "the row did not render").toBeTruthy();
    expect(card!).not.toContain("Joined ");
    // THE DATE ITSELF MUST BE ABSENT FROM THE CARD. A bare "N days" search
    // cannot be used here: the invite composer inside this same row offers
    // "Next 7 days" and "3 days" expiry presets, which are claims about the
    // OFFER the studio is making and have nothing to do with how long this
    // person has waited. The year of the import instant appears nowhere in
    // those presets, so its absence is the precise, non-colliding assertion.
    expect(card!).not.toContain("2026-09-16");
    expect(card!).not.toMatch(/\b2026\b/);
    expect(card!).toContain("Join date unknown");
    // The person is still listed, still identifiable, still actionable. The
    // rule withholds a CLAIM, never the row.
    expect(html).toContain("Jo Smith");
    expect(html).toContain("Invite to book");
  });

  it("DIFFERENTIAL CONTROL — the same row and date render differently by provenance alone", async () => {
    // If the page ignored `joined_at_provenance` and rendered `joined_at`
    // unconditionally — the behaviour before this slice — these two renders
    // would be identical. Every assertion above would still pass on the first
    // one, so this is the assertion that proves the provenance is READ rather
    // than merely selected.
    const joined_at = "2026-09-16T12:00:00.000Z";

    scenario.rows = [entry({ source: "legacy_import", joined_at_provenance: "unknown", joined_at })];
    scenario.count = 1;
    const unknownHtml = await render();

    reset();
    scenario.rows = [entry({ joined_at })];
    scenario.count = 1;
    const formHtml = await render();

    expect(unknownHtml).not.toEqual(formHtml);
    expect(formHtml).toContain('data-testid="joined-known"');
    expect(unknownHtml).toContain('data-testid="joined-unknown"');
  });

  it("an unrecognised provenance fails to UNKNOWN, never to a confident date", async () => {
    // A value this build does not know about is precisely the case where
    // guessing produces a confident false statement.
    scenario.rows = [entry({ source: "legacy_import", joined_at_provenance: "from_the_future" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain('data-testid="joined-unknown"');
  });

  it("a practitioner-added row says who put them there", async () => {
    scenario.rows = [entry({ source: "practitioner", joined_at_provenance: "operator_supplied" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain("Added by the studio");
  });
});

describe("WAIT-04A — stated availability", () => {
  it("reads preferences with the page's OWN client, scoped to the studio AND the listed rows", async () => {
    // THE READ'S SHAPE IS THE GUARD, exactly as it is for the capacity read. A
    // read that quietly lost its `in` would ship every preference the studio
    // has ever recorded to render at most one page of them.
    scenario.rows = [entry()];
    scenario.count = 1;
    await render();

    const read = queries.find((q) => q.table === "new_client_waitlist_entry_preferences");
    expect(read, "the page issued no preferences read").toBeTruthy();
    // The SAME client instance the queue used. A second client would be a
    // second authority for one page — the #709 ruling, restated as a test.
    const queueRead = queries.find((q) => q.table === "new_client_waitlist_entries");
    expect(read!.clientId).toBe(queueRead!.clientId);
    expect(read!.columns).toBe("entry_id,preference,confirmed_at");
    expect(read!.filters).toContainEqual(["eq", "studio_id", STUDIO_ID]);
    expect(read!.filters.some((f) => f[0] === "in" && f[1] === "entry_id")).toBe(true);
  });

  it("asks for nothing at all when no row is listed", async () => {
    scenario.rows = [];
    scenario.count = 0;
    await render();
    expect(queries.some((q) => q.table === "new_client_waitlist_entry_preferences")).toBe(false);
  });

  it("an unrecorded preference offers the control with NOTHING pre-selected", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();

    expect(html).toContain('data-testid="availability-unrecorded"');
    expect(html).toContain("Availability not recorded");
    // NO DEFAULT. A pre-selected "both" would let a distracted press write an
    // answer the person never gave.
    expect(html).toMatch(/<option value="" selected="">Choose/);
    expect(html).toContain(">Record<");
  });

  it("a recorded preference renders the value and when it was last confirmed", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.preferences = [
      {
        entry_id: "entry-1",
        preference: "weekends",
        confirmed_at: "2026-09-01T09:00:00.000Z",
      },
    ];
    const html = await render();

    expect(html).toContain('data-testid="availability-current"');
    expect(html).toMatch(/Available weekends/i);
    expect(html).toContain('data-testid="availability-confirmed"');
    // The control now UPDATES rather than records, and opens on the stored value.
    expect(html).toContain(">Update<");
    expect(html).toMatch(/<option value="weekends" selected="">/);
  });

  it("a preference value outside the three the CHECK permits is not rendered", async () => {
    // This build and the database disagreeing is not a reason to put an unknown
    // string in front of a practitioner.
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.preferences = [
      { entry_id: "entry-1", preference: "alternate tuesdays", confirmed_at: null },
    ];
    const html = await render();
    expect(html).not.toContain("alternate tuesdays");
    expect(html).toContain('data-testid="availability-unrecorded"');
  });

  it("a FAILED preferences read says nothing, rather than 'not recorded'", async () => {
    // "Not recorded" is a claim about the PERSON. A failed read is a fact about
    // the READ, and reporting one as the other would tell an operator this
    // person never answered when in truth we could not look.
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.preferencesError = { code: "42501" };
    const html = await render();

    expect(html).not.toContain('data-testid="availability-unrecorded"');
    expect(html).not.toContain('data-testid="availability-current"');
    // The queue itself is unaffected: one unreadable side-fact must not
    // collapse the list of people.
    expect(html).toContain("Jo Smith");
    expect(consoleErrors.join("\n")).toContain("waitlist_preferences_load_failed");
  });
});

describe("WAIT-04A — the two ways a person reaches the queue", () => {
  it("offers both, and tells the owner what each does to queue position", async () => {
    scenario.rows = [];
    scenario.count = 0;
    const html = await render();

    expect(html).toContain('data-testid="add-to-waitlist"');
    expect(html).toContain("They asked today");
    expect(html).toContain("They were already waiting");
    expect(html).toContain("back of the queue");
  });

  it("the import form makes 'I have no date' a first-class answer, not a blank field", async () => {
    scenario.rows = [];
    scenario.count = 0;
    const html = await render();
    // Only the active tab's form renders, so the import fields are reached by
    // rendering that tab — asserted through the panel's own initial-tab prop in
    // the component test. Here the tab control itself must exist.
    expect(html).toContain('data-testid="add-tab-import"');
  });

  it("the owner panel forecasts NOTHING to a prospect", async () => {
    // The promised counterpart to excising this panel from the vocabulary scan.
    // It may say where the row the owner is creating will land; it may not
    // forecast a wait, a rank, or when a slot will appear.
    scenario.rows = [];
    scenario.count = 0;
    const html = await render();
    const panel = html.match(
      /<section[^>]*data-testid="add-to-waitlist"[\s\S]*?<\/section>/,
    )?.[0];
    expect(panel, "the panel did not render").toBeTruthy();
    for (const forbidden of [
      /\brank\b/i,
      /\byour turn\b/i,
      /\bspots? left\b/i,
      /\bestimated\b/i,
      /\bnext (week|month)\b/i,
      /\bwe(?:'|&#x27;)?ll contact you\b/i,
    ]) {
      expect(panel!, `forbidden forecast: ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

// ===========================================================================
// P2 4028093990 — THE TRUNCATION SENTENCE IS A CLAIM ABOUT THE WHOLE SET
// ===========================================================================
//
// "Showing the N longest-waiting of M" asserts a DURATION ordering over every
// row it covers. An imported row whose join date is unknown takes part in the
// (joined_at, id) queue order — 0193 stamps the import instant precisely so it
// has a position — while having no waiting time anyone can state. One such row
// in the displayed set makes that sentence false for the set containing it.
//
// The repair is a universally true sentence rather than another provenance
// branch: ORDER is real for every row, DURATION is not. Per-row claims stay
// provenance-gated, because those CAN be.
describe("WAIT-04A — truncation copy is provenance-neutral", () => {
  /** A truncated group: fewer rows than the group's own count. */
  function truncated(rows: Array<Record<string, unknown>>, total: number) {
    scenario.rows = rows;
    scenario.count = total;
  }

  it("an UNKNOWN imported row cannot coexist with a 'longest-waiting' claim", async () => {
    truncated(
      [
        entry({ id: "entry-0", name: "Ada" }),
        entry({
          id: "entry-1",
          name: "Grace",
          source: "legacy_import",
          joined_at_provenance: "unknown",
          joined_at: "2026-09-16T12:00:00.000Z",
        }),
      ],
      140,
    );
    const html = await render();

    // The set is truncated, so the sentence IS rendered — this is not vacuous.
    expect(html).toContain("Showing the first 2 of 140, in queue order.");
    // And it makes no duration claim over a set that contains an unknown row.
    expect(html).not.toContain("longest-waiting");
    expect(html).not.toMatch(/longest|waited longest|been waiting longest/i);
  });

  it("the neutral sentence still appears when every row IS a known joiner", async () => {
    // The repair must not be a branch that only fires for imports: the sentence
    // is one sentence, true in both cases. A page that said "longest-waiting"
    // whenever no unknown row happened to be on THIS page would be false as
    // soon as one paged into view.
    truncated(
      Array.from({ length: 3 }, (_, i) => entry({ id: `entry-${i}`, name: `P${i}` })),
      99,
    );
    const html = await render();
    expect(html).toContain("Showing the first 3 of 99, in queue order.");
    expect(html).not.toContain("longest-waiting");
  });

  it("PER-ROW truth is unchanged: the known row keeps its date and wait, the unknown row has neither", async () => {
    // The set-level claim was dropped; the row-level ones were not. Losing them
    // would be a different defect — withholding facts the page can stand behind.
    truncated(
      [
        entry({ id: "entry-0", name: "Ada", joined_at: "2025-01-05T09:00:00.000Z" }),
        entry({
          id: "entry-1",
          name: "Grace",
          source: "legacy_import",
          joined_at_provenance: "unknown",
          joined_at: "2026-09-16T12:00:00.000Z",
        }),
      ],
      140,
    );
    const html = await render();

    const known = html.match(/<li[^>]*data-entry-id="entry-0"[\s\S]*?<\/li>/)?.[0];
    const unknown = html.match(/<li[^>]*data-entry-id="entry-1"[\s\S]*?<\/li>/)?.[0];
    expect(known, "the known row did not render").toBeTruthy();
    expect(unknown, "the unknown row did not render").toBeTruthy();

    expect(known!).toContain('data-testid="joined-known"');
    expect(known!).toContain("Joined ");
    expect(known!).toMatch(/2025/);

    expect(unknown!).toContain('data-testid="joined-unknown"');
    expect(unknown!).not.toContain("Joined ");
    expect(unknown!).not.toMatch(/\b2026\b/);
  });

  it("an unknown row does not acquire an ordinal from the surrounding copy", async () => {
    // "First N" is a claim about the displayed WINDOW, not about any person.
    // Nothing in the group may hand this row a rank or a position.
    truncated(
      [
        entry({
          id: "entry-1",
          name: "Grace",
          source: "legacy_import",
          joined_at_provenance: "unknown",
        }),
      ],
      250,
    );
    const html = await render();
    const row = html.match(/<li[^>]*data-entry-id="entry-1"[\s\S]*?<\/li>/)?.[0];
    expect(row).toBeTruthy();
    for (const forbidden of [/\bposition\b/i, /\brank\b/i, /\b#\d+\b/, /\b\d+(st|nd|rd|th)\b/i]) {
      expect(row!, `ordinal leaked: ${forbidden}`).not.toMatch(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 0208 — EACH ROW STATES ITS SMS STANDING, AS RECORDED
// ---------------------------------------------------------------------------
//
// The row says what is on record and nothing more: STOP first, then whose
// consent it is and when, then "none". The owner's recording form appears only
// where the command would accept it. The command's own refusals are proved in
// tests/db/waitlist-sms-consent-practitioner-and-signup.db.test.ts; the action
// in tests/app/waitlist-sms-consent-action.test.ts.
describe("0208 — each row states its SMS standing, as recorded", () => {
  const standing = (row: string) =>
    row.match(/data-testid="sms-consent-status"[^>]*>([^<]*)</)?.[1] ?? null;
  const rowOf = async (over: Record<string, unknown>) => {
    scenario.rows = [entry({ id: "e-sms", ...over })];
    scenario.count = 1;
    const row = rowMarkup(await render(), "e-sms");
    expect(row, "the row must render").not.toBeNull();
    return row!;
  };

  it("a row with a mobile and no consent offers the recording form, nothing preselected", async () => {
    const row = await rowOf({});
    expect(standing(row)).toBe("Texts: no consent on record");
    expect(row).toContain('data-testid="sms-consent-form"');
    expect(row).toMatch(/<input type="hidden" name="entry_id" value="e-sms"\/>/);
    // NO DEFAULTS: the attestation is unticked and neither date answer is
    // chosen, so a hurried press records nothing nobody stated.
    const form = row.match(/<form\b[^>]*data-testid="sms-consent-form"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('name="sms_consent_attest"');
    expect(form).toContain('name="sms_consent_date_known"');
    expect(form).not.toMatch(/\bchecked\b/);
    // The day field appears only once "I know the day" is chosen.
    expect(form).not.toContain('name="sms_consent_given_on"');
  });

  it("STOP wins: an opted-out row says so and offers no form, even with consent on record", async () => {
    const row = await rowOf({
      sms_consent_at: "2026-08-20T09:00:00.000Z",
      sms_consent_source: "public_form",
      sms_opted_out_at: "2026-08-21T09:00:00.000Z",
    });
    expect(standing(row)).toBe("Texts: opted out (replied STOP)");
    expect(row).not.toContain('data-testid="sms-consent-form"');
    expect(row).not.toMatch(/agreed/);
  });

  it("the person's own Yes reads as theirs, on the studio's calendar day", async () => {
    // 02:30 UTC on the 21st is still the 20th in Toronto: the day is the
    // studio's, not the server's.
    const row = await rowOf({
      sms_consent_at: "2026-08-21T02:30:00.000Z",
      sms_consent_source: "public_form",
    });
    expect(standing(row)).toBe("Texts: agreed on the waitlist form on Aug 20, 2026");
    expect(row).not.toContain('data-testid="sms-consent-form"');
  });

  it("a studio-recorded consent says so, with the day they agreed, unshifted", async () => {
    // A bare date read as an instant would render as Feb 28 in Toronto.
    const row = await rowOf({
      sms_consent_at: "2026-08-22T15:00:00.000Z",
      sms_consent_source: "practitioner",
      sms_consent_given_on: "2026-03-01",
    });
    expect(standing(row)).toBe(
      "Texts: consent recorded by the studio on Aug 22, 2026 · they agreed on Mar 1, 2026",
    );
    expect(row).not.toContain('data-testid="sms-consent-form"');
  });

  it("an unknown agreement day is stated as unknown, never as the recording day", async () => {
    const row = await rowOf({
      sms_consent_at: "2026-08-22T15:00:00.000Z",
      sms_consent_source: "practitioner",
      sms_consent_given_on: null,
    });
    expect(standing(row)).toBe(
      "Texts: consent recorded by the studio on Aug 22, 2026 · they agreed on a day not known",
    );
  });

  it("a row with no mobile says so, and offers no form", async () => {
    const row = await rowOf({ phone: null });
    expect(standing(row)).toBe("Texts: no consent on record · no mobile number on file");
    expect(row).not.toContain('data-testid="sms-consent-form"');
  });

  it("the read never asks for the owner's evidence note, the recorder or the scope", async () => {
    await rowOf({});
    for (const column of [
      "sms_consent_evidence_ref",
      "sms_consent_recorded_by_practitioner_id",
      "sms_consent_scope",
      "sms_consent_text_version",
    ]) {
      expect(entriesQuery().columns).not.toContain(column);
    }
  });
});

describe("closed admission blocks the owner's invite until 0323 is applied (0204 invited_book refuses it)", () => {
  afterEach(() => {
    admissionHolder.stored = null;
    admissionHolder.rule = "absent";
  });

  it("shows NO block under Closed once 0323 is applied (the marker answers true)", async () => {
    admissionHolder.stored = "closed";
    admissionHolder.rule = "applied";
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    const html = await render();
    expect(html).not.toContain("invites-blocked-admission");
    // Neutral information, not a warning: it names all three facts.
    expect(html).toContain('data-testid="invites-closed-invited-only"');
    expect(html).toContain(INVITE_CLOSED_INVITED_ONLY_COPY);
    expect(html).toMatch(/data-testid="invites-closed-invited-only"[^>]*class="[^"]*neutral/);
    expect(html).not.toMatch(/data-testid="invites-closed-invited-only"[^>]*class="[^"]*amber/);
    expect(INVITE_CLOSED_INVITED_ONLY_COPY).toContain("Closed");
    expect(INVITE_CLOSED_INVITED_ONLY_COPY).toMatch(/New clients can’t book or join your waitlist online/);
    expect(INVITE_CLOSED_INVITED_ONLY_COPY).toMatch(/invite here can still book/);
    // Send is not withheld for admission: neither blocked copy reaches the composer.
    expect(html).not.toContain(INVITE_ADMISSION_CLOSED_BANNER_COPY);
    expect(html).not.toContain(INVITE_ADMISSION_UNREADABLE_COPY);
  });

  it("the information note is absent whenever Closed is blocked, unreadable, or not Closed", async () => {
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    for (const [stored, rule] of [["closed", "absent"], ["closed", "error"], ["not-a-mode", "applied"], ["waitlist", "applied"], ["open", "applied"]] as const) {
      admissionHolder.stored = stored;
      admissionHolder.rule = rule;
      expect(await render(), `${stored}/${rule}`).not.toContain("invites-closed-invited-only");
    }
  });

  it("a marker failure other than 'absent' pauses invitations without claiming Closed", async () => {
    admissionHolder.stored = "closed";
    admissionHolder.rule = "error";
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain('data-testid="invites-blocked-admission"');
    expect(html).toContain("We couldn’t check new-client admission, so invitations are paused.");
    expect(html).not.toContain("set to Closed");
  });

  it("says so, names Settings → Booking, and links to it", async () => {
    admissionHolder.stored = "closed";
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain('data-testid="invites-blocked-admission"');
    expect(html).toContain("New-client admission is set to Closed");
    expect(html).toContain("Settings → Booking");
    expect(html).toContain('href="/settings/booking#new-client-admission"');
    expect(html).not.toContain("No invitation was created");
  });

  it("an UNREADABLE mode pauses invitations without claiming it is Closed", async () => {
    admissionHolder.stored = "not-a-mode";
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain('data-testid="invites-blocked-admission"');
    expect(html).toContain("We couldn’t check new-client admission, so invitations are paused. Check Settings → Booking.");
    expect(html).not.toContain("set to Closed");
  });

  it.each(["waitlist", "open"])("shows no block under %s", async (mode) => {
    admissionHolder.stored = mode;
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    expect(await render()).not.toContain("invites-blocked-admission");
  });
});

describe("owner follow-up cards render with ZERO active entries (Codex P2)", () => {
  afterEach(() => {
    followUp.attention = followUp.declined = followUp.replies = null;
    followUp.scoped = {};
    followUp.scopedCalls = [];
    vi.unstubAllEnvs();
  });
  const empty = () => {
    scenario.rows = [];
    scenario.count = 0;
  };

  it("Replies to review (n) is accessible from Responses with an empty waitlist", async () => {
    vi.stubEnv("WAITLIST_TIMES_FEEDBACK", "1");
    followUp.replies = { kind: "ok", n: 2 };
    empty();
    const html = await render({ tab: "responses" });
    expect(html).toContain('data-view="responses"');
    expect(html).toContain("Replies to review (2)");
  });

  it("Needs your attention (n) is accessible from Responses with an empty waitlist", async () => {
    followUp.attention = { kind: "ok", total: 3, shown: [{ id: "a", name: "A" }] };
    empty();
    const html = await render({ tab: "responses" });
    expect(html).toContain('data-view="responses"');
    expect(html).toContain("Needs your attention (3)");
  });

  it("Declined the offered times (n) is accessible from Responses with an empty waitlist", async () => {
    followUp.declined = { kind: "ok", total: 1, shown: [{ id: "d", name: "D" }], ids: new Set(["d"]) };
    empty();
    const html = await render({ tab: "responses" });
    expect(html).toContain('data-view="responses"');
    expect(html).toContain("Declined the offered times (1)");
  });

  it("keeps a direct link to follow-ups when the waiting list is empty", async () => {
    followUp.attention = { kind: "ok", total: 1, shown: [{ id: "a", name: "A" }] };
    empty();
    const html = await render();
    expect(html).toContain("Nobody is waiting right now");
    expect(html).toMatch(/href="\/waitlist\?tab=responses"/);
    const followUps = await render({ tab: "responses" });
    expect(followUps).toMatch(/data-workspace-section="responses"[\s\S]*?id="follow-up"/);
    expect(followUps).toContain("Needs your attention (1)");
  });
});

// ===========================================================================
// EXPIRY VISIBILITY — display only. The text comes ONLY from the live row's `expires_at`.
// Time is fixed at 2026-08-23T09:00:00Z; the studio is America/Toronto (EDT).
// ===========================================================================
describe("each active invitation shows its exact expiry and the time left", () => {
  const at = (iso: string) => new Date(iso).toISOString();

  it("shows the deadline in the studio's zone, the time left, and a summary of the next expiry", async () => {
    scenario.rows = [
      entry({ id: "e-a", status: "invited" }),
      entry({ id: "e-b", status: "invited" }),
      entry({ id: "e-c", status: "invited" }),
    ];
    scenario.count = 3;
    scenario.liveInvitations = [
      { entry_id: "e-a", expires_at: at("2026-08-23T13:30:00Z") }, // 4 h 30 min
      { entry_id: "e-b", expires_at: at("2026-08-24T08:59:00Z") }, // inside 24 h
      { entry_id: "e-c", expires_at: at("2026-08-26T09:00:00Z") }, // 3 days
    ];
    const html = await render({ section: "invited" });
    expect(html).toContain("9:30 AM EDT");
    expect(html).toContain("in 4 h 30 min");
    expect(html).toContain("in 3 days");
    const summary = html.match(/data-testid="invitation-expiry-summary"[^>]*>(.*?)<\/p>/s)?.[1] ?? "";
    expect(summary).toContain("9:30 AM EDT");
    expect(summary).toContain("in 4 h 30 min");
    expect(summary).toContain("2 expire within 24 hours");
    expect(summary).toContain("As of");
    expect((html.match(/data-testid="row-invitation-expiry"/g) ?? []).length).toBe(3);
  });

  it("THE SUMMARY IS STUDIO-WIDE: an earlier expiry OFF this page is the next one, and is counted", async () => {
    // This page holds one invited row expiring in 5 days. Another invitation, on a page not shown, expires in 2 hours.
    scenario.rows = [entry({ id: "e-on-page", status: "invited" })];
    scenario.count = 150;
    scenario.liveInvitations = [{ entry_id: "e-on-page", expires_at: at("2026-08-28T09:00:00Z") }];
    scenario.studioExpiries = [
      { expires_at: at("2026-08-28T09:00:00Z") },
      { expires_at: at("2026-08-23T11:00:00Z") }, // off the page, 2 h
      { expires_at: at("2026-08-23T20:00:00Z") }, // off the page, 11 h
    ];
    const html = await render({ section: "invited" });
    const summary = html.match(/data-testid="invitation-expiry-summary"[^>]*>(.*?)<\/p>/s)?.[1] ?? "";
    expect(summary).toContain("in 2 h.");
    expect(summary).toContain("2 expire within 24 hours");
    // …and the read is one small one: expires_at only, scoped to the studio, no entry id and no name.
    const reads = queries.filter((q) => q.table === "new_client_waitlist_invitations" && q.columns === "expires_at");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.options).toEqual({ count: "exact" });
    expect(reads[0]!.limit).toBe(1000);
    expect(reads[0]!.filters.some((f) => f[0] === "in")).toBe(false);
    expect(reads[0]!.filters.find((f) => f[0] === "eq" && f[1] === "studio_id")?.[2]).toBe(STUDIO_ID);
    for (const col of ["redeemed_at", "expired_at", "released_at", "declined_at"]) {
      expect(reads[0]!.filters.some((f) => f[0] === "is" && f[1] === col), col).toBe(true);
    }
  });

  it("THE API ROW CEILING: 1000 rows back but an exact count of 1500 shows NO summary, never a partial one", async () => {
    // The real Data API returns at most max_rows = 1000 rows whatever limit was asked for, so a length-only check can never see the cut.
    scenario.rows = [entry({ id: "e-on-page", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [{ entry_id: "e-on-page", expires_at: at("2026-08-28T09:00:00Z") }];
    scenario.studioExpiries = Array.from({ length: 1000 }, () => ({ expires_at: at("2026-08-28T09:00:00Z") }));
    scenario.studioExpiryCount = 1500;
    const html = await render({ section: "invited" });
    expect(html).not.toContain("invitation-expiry-summary");
    expect(html).toContain("row-invitation-expiry"); // the per-row line is unaffected
  });

  it("exactly 1000 live invitations with an exact count of 1000 IS complete and shows the summary", async () => {
    scenario.rows = [entry({ id: "e-on-page", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [{ entry_id: "e-on-page", expires_at: at("2026-08-28T09:00:00Z") }];
    scenario.studioExpiries = Array.from({ length: 1000 }, () => ({ expires_at: at("2026-08-28T09:00:00Z") }));
    const html = await render({ section: "invited" });
    expect(html).toContain("invitation-expiry-summary");
  });

  it("an unreadable exact count shows no summary", async () => {
    scenario.rows = [entry({ id: "e-on-page", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [{ entry_id: "e-on-page", expires_at: at("2026-08-28T09:00:00Z") }];
    scenario.studioExpiryCount = Number.NaN;
    const html = await render({ section: "invited" });
    expect(html).not.toContain("invitation-expiry-summary");
  });

  it("a FAILED summary read shows no summary, logs once, and leaves the per-row lines", async () => {
    scenario.rows = [entry({ id: "e-on-page", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [{ entry_id: "e-on-page", expires_at: at("2026-08-28T09:00:00Z") }];
    scenario.studioExpiries = [{ expires_at: at("2026-08-23T11:00:00Z") }];
    scenario.studioExpiriesError = { code: "57014" };
    const html = await render({ section: "invited" });
    expect(html).not.toContain("invitation-expiry-summary");
    expect(html).toContain("row-invitation-expiry");
    expect(consoleErrors.filter((l) => l.includes("waitlist_invitation_expiry_summary_read_failed"))).toHaveLength(1);
  });

  it("a deadline that has passed says so, and is not counted as about to expire", async () => {
    scenario.rows = [entry({ id: "e-old", status: "invited" }), entry({ id: "e-new", status: "invited" })];
    scenario.count = 2;
    scenario.liveInvitations = [
      { entry_id: "e-old", expires_at: at("2026-08-23T08:00:00Z") },
      { entry_id: "e-new", expires_at: at("2026-08-23T10:00:00Z") },
    ];
    const html = await render({ section: "invited" });
    expect(html).toContain('data-state="deadline_passed"');
    expect(html).toContain("It has passed.");
    expect(visibleText(html)).not.toMatch(/in -|-\d+ min/);
    expect(html).toContain("1 expires within 24 hours");
  });

  it("with no open invitation there is no summary line", async () => {
    scenario.rows = [entry({ id: "e-old", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [{ entry_id: "e-old", expires_at: at("2026-08-23T08:00:00Z") }];
    const html = await render({ section: "invited" });
    expect(html).not.toContain("invitation-expiry-summary");
  });

  it("an UNREADABLE invitation read shows no expiry text at all (never a guess)", async () => {
    scenario.rows = [entry({ id: "e-x", status: "invited" })];
    scenario.count = 1;
    scenario.invitationsError = { code: "57014" };
    const html = await render({ section: "invited" });
    expect(html).not.toContain("row-invitation-expiry");
    expect(html).not.toContain("invitation-expiry-summary");
    expect(html).toContain("could not be checked");
  });

  it("a redeemed entry (no live row) shows no expiry", async () => {
    scenario.rows = [entry({ id: "e-used", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [];
    scenario.redeemedInvitations = [{ entry_id: "e-used" }];
    const html = await render({ section: "invited" });
    expect(html).not.toContain("row-invitation-expiry");
  });

  it("RULE, not spelling: the expiry text is built only from the live read's expires_at", () => {
    const src = readFileSync(
      path.join(process.cwd(), "app/(app)/settings/waitlist/page.tsx"),
      "utf8",
    );
    // The only writer of the per-row expiry map is the live-row loop, and it copies the row's own column.
    const writes = [...src.matchAll(/expiryByEntry\.set\(([^)]*)\)/g)].map((m) => m[1]!.replace(/\s+/g, ""));
    expect(writes).toEqual(["inv.entry_id,inv.expires_at"]);
    // The per-row line reads that map.
    expect(src).toMatch(/rowExpiry\(\s*raw,/);
    // The summary is NOT built from the page's rows: it reads its own studio-wide set.
    expect(src).toMatch(/expirySummary\(\s*studioExpiries,/);
    expect(src).not.toMatch(/expirySummary\(\s*\[\.\.\.expiryByEntry/);
    // The expiry is never derived from an issue time, a fixed TTL or a client clock.
    const helper = readFileSync(
      path.join(process.cwd(), "lib/waitlist/invitation-expiry-display.ts"),
      "utf8",
    );
    expect(helper).not.toMatch(/issued_at|issuedAt|TTL|setHours|setDate/);
  });
});

// ===========================================================================
// DECLINE VISIBILITY — display only. A decline is the invitation's own `declined_at`; nothing is sent, written or logged beyond a code.
// Time is fixed at 2026-08-23T09:00:00Z; the studio is America/Toronto (EDT).
// ===========================================================================
describe("people who declined: the summary count and the declined view", () => {
  beforeEach(() => {
    followUp.scoped = {};
    followUp.scopedCalls = [];
    followUp.followUps = null;
  });
  const dec = (id: string, entryId: string, at: string) => ({ id, entry_id: entryId, declined_at: new Date(at).toISOString() });
  const seed = () => {
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    scenario.declinedInvitations = [
      dec("i3", "e-b", "2026-08-22T10:00:00Z"),
      dec("i2", "e-a", "2026-08-21T10:00:00Z"),
      dec("i1", "e-a", "2026-08-10T10:00:00Z"), // the same person's earlier decline: counted once
    ];
    scenario.declineEntries = [
      { id: "e-a", name: "Alex Rivers", status: "waiting", joined_at: "2026-07-01T12:00:00+00:00" },
      { id: "e-b", name: "Bo Tanaka", status: "removed", joined_at: "2026-07-02T12:00:00+00:00" },
    ];
    scenario.contactRows = [
      { id: "e-a", email: "alex@example.invalid", phone: "+14165550100" },
      { id: "e-b", email: "bo@example.invalid", phone: null },
    ];
  };

  it("the summary counts PEOPLE (not invitations), links to the view, and carries no name or contact", async () => {
    seed();
    const html = await render();
    const line = html.match(/data-testid="declined-summary"[^>]*>(.*?)<\/p>/s)?.[1] ?? "";
    expect(line).toContain("2 people have declined.");
    expect(line).toContain('href="/waitlist?view=declined"');
    for (const secret of ["Alex", "Bo Tanaka", "alex@example.invalid", "+14165550100", "bo@example.invalid"]) expect(html, secret).not.toContain(secret);
    expect(html).not.toContain('data-testid="declined-people"');
  });

  it("nobody declined: the count says 0 and offers no link", async () => {
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain("0 people have declined.");
    expect(html).not.toContain("declined-view-link");
  });

  it("an UNREADABLE decline read says it could not count, never 0", async () => {
    seed();
    scenario.declinedError = { code: "57014" };
    const html = await render();
    expect(html).toContain("we couldn");
    expect(html).not.toContain("0 people have declined");
    expect(html).not.toContain("declined-view-link");
  });

  it("a response cut at the API's 1000-row ceiling (exact count 1500) shows no count, never a partial one", async () => {
    scenario.rows = [entry({ id: "w1", status: "waiting" })];
    scenario.count = 1;
    scenario.declinedInvitations = Array.from({ length: 1000 }, (_, i) => dec(`i${i}`, `e${i}`, "2026-08-20T10:00:00Z"));
    scenario.declinedCount = 1500;
    const html = await render();
    expect(html).toContain("we couldn");
    expect(html).not.toMatch(/\d+ people have declined/);
  });

  it("the declined view lists each person once: name, when they declined in the studio's zone, and an entry link only where it can land", async () => {
    seed();
    const html = await render({ view: "declined" });
    expect(html).toContain('data-testid="declined-people"');
    expect((html.match(/data-testid="declined-row"/g) ?? []).length).toBe(2);
    expect(html).toContain("Alex Rivers");
    expect(html).toContain("Declined Aug 21, 2026, 6:00 AM EDT");
    // The waiting entry links to its own section; the removed one has no section to land in.
    expect(html).toContain('href="/waitlist?section=waiting#entry-e-a"'); // nobody ahead of them: page 1
    expect(html).not.toContain("#entry-e-b");
    expect(html).toContain("Their entry is no longer on the waitlist.");
    // Newest decline first.
    expect(html.indexOf("Bo Tanaka")).toBeLessThan(html.indexOf("Alex Rivers"));
  });

  it("the three outcomes stay separate: the note names all three, and 'declined' is never said of a passed deadline or a release", async () => {
    seed();
    scenario.rows = [entry({ id: "w1", status: "invited" })];
    scenario.liveInvitations = [{ entry_id: "w1", expires_at: new Date("2026-08-23T08:00:00Z").toISOString() }]; // deadline passed, nothing stamped
    const html = await render({ view: "declined" });
    expect(html).toContain("“Expired”");
    expect(html).toContain("“Released — reason not recorded”");
    expect((html.match(/data-testid="declined-row"/g) ?? []).length).toBe(2); // the expired invitation's entry is NOT a row
    expect(html).not.toContain("Jo Smith");
  });

  it("contact details are only inside each person's closed 'Contact details' disclosure, and never in the address", async () => {
    seed();
    const html = await render({ view: "declined" });
    const blocks = [...html.matchAll(/<details[^>]*data-testid="declined-contact"[^>]*>([\s\S]*?)<\/details>/g)].map((m) => m[1]!);
    expect(blocks.length).toBe(2);
    expect(blocks.join("")).toContain("alex@example.invalid");
    const outside = html.replace(/<details[^>]*data-testid="declined-contact"[^>]*>[\s\S]*?<\/details>/g, "");
    for (const secret of ["alex@example.invalid", "bo@example.invalid", "+14165550100", "(416) 555-0100"]) expect(outside, secret).not.toContain(secret);
    expect(html).not.toMatch(/<details[^>]*data-testid="declined-contact"[^>]*\sopen/);
    // Every link outside the disclosure is free of names and contact details (the Email and Call links live inside it, by design).
    for (const m of outside.matchAll(/href="([^"]*)"/g)) expect(m[1]!, m[1]).not.toMatch(/Alex|Bo%20|alex@|bo@|%40|5550100/);
  });

  describe("with the answers gate ON: the page list is not the whole truth", () => {
    const fuRow = (invitationId: string, entryId: string, over: Record<string, unknown> = {}) => ({
      followupId: `f-${invitationId}`, kind: "decline", invitationId, entryId, clientName: "X", openedAt: "2026-08-21T10:00:00.000Z", status: "open",
      whyNotWork: "Mornings are hard", betterTimes: "Weekday evenings", answersErasedAt: null, submittedAt: "2026-08-21T10:00:00.000Z", closedAt: null, eraseBy: null, ...over,
    });
    const withGate = async (list: unknown) => {
      process.env.WAITLIST_DECLINE_ANSWERS = "1";
      followUp.followUps = list;
      try {
        return await render({ view: "declined" });
      } finally {
        delete process.env.WAITLIST_DECLINE_ANSWERS;
        followUp.followUps = null;
      }
    };
    const rowOf = (html: string, id: string) => html.match(new RegExp(`<li[^>]*data-entry-id="${id}"[^>]*data-testid="declined-row"[\\s\\S]*?</li>`))?.[0] ?? "";

    it("a CLOSED follow-up whose answers were erased (which the page list leaves out) reads as removed, never 'No answers on record'", async () => {
      seed();
      followUp.scoped = { i3: { kind: "ok", rows: [fuRow("i3", "e-b", { status: "handled", whyNotWork: null, betterTimes: null, answersErasedAt: "2026-09-01T00:00:00.000Z", closedAt: "2026-08-25T00:00:00.000Z" })] } };
      const html = await withGate({ kind: "ok", rows: [fuRow("i2", "e-a")] }); // the page list has Alex only
      const bo = rowOf(html, "e-b");
      expect(bo).toContain("Answer erased");
      expect(bo).not.toContain("Answer not collected");
      expect(followUp.scopedCalls).toEqual(["i3"]); // only the person the page list does not cover is asked about
      expect(rowOf(html, "e-a")).toContain("Mornings are hard");
    });
    it("a person the scoped read finds NO decline follow-up for reads 'Answer not collected'", async () => {
      seed();
      const html = await withGate({ kind: "ok", rows: [fuRow("i2", "e-a")] });
      expect(rowOf(html, "e-b")).toContain("Answer not collected");
      expect(rowOf(html, "e-b")).not.toContain("Answer erased");
    });
    it("a failed scoped read says the answers could not be loaded, never 'none'", async () => {
      seed();
      followUp.scoped = { i3: { kind: "unknown" } };
      const html = await withGate({ kind: "ok", rows: [fuRow("i2", "e-a")] });
      const bo = rowOf(html, "e-b");
      expect(bo).toContain("We couldn’t load their answers just now.");
      expect(bo).not.toContain("Answer not collected");
    });
    it("an unreadable page list does not stop the scoped reads from answering", async () => {
      seed();
      followUp.scoped = { i3: { kind: "ok", rows: [fuRow("i3", "e-b", { whyNotWork: "Too far" })] } };
      const html = await withGate({ kind: "unknown" });
      expect(rowOf(html, "e-b")).toContain("Too far");
      expect(followUp.scopedCalls.sort()).toEqual(["i2", "i3"]);
    });
    it("with the gate OFF no scoped read is made at all", async () => {
      seed();
      await render({ view: "declined" });
      expect(followUp.scopedCalls).toEqual([]);
    });
  });

  describe("ALL recorded declines are reachable by paging, and every per-person read is bounded to ONE page", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `e${String(i).padStart(3, "0")}`);
    const seed120 = () => {
      scenario.rows = [entry({ id: "w1", status: "waiting" })];
      scenario.count = 1;
      // Newest first by decline time: e000 is the most recent.
      scenario.declinedInvitations = ids.map((id, i) => ({ id: `i-${id}`, entry_id: id, declined_at: new Date(Date.UTC(2026, 7, 22, 10, 0, 0) - i * 60_000).toISOString() }));
      scenario.declineEntries = ids.map((id) => ({ id, name: `P ${id}`, status: "waiting", joined_at: "2026-07-01T12:00:00+00:00" }));
    };
    const renderGated = async (searchParams: Parameters<typeof render>[0]) => {
      process.env.WAITLIST_DECLINE_ANSWERS = "1";
      followUp.followUps = { kind: "ok", rows: [] };
      try {
        return await render(searchParams);
      } finally {
        delete process.env.WAITLIST_DECLINE_ANSWERS;
        followUp.followUps = null;
      }
    };
    const rowsIn = (html: string) => [...html.matchAll(/data-entry-id="(e\d+)" data-testid="declined-row"/g)].map((m) => m[1]!);
    const factIds = () => ((queries.find((q) => q.columns === "id,name,status,joined_at")!.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] ?? []) as string[]);

    it("page 1 of 120 people: the 50 newest, with a Next link; reads are 50 scoped, 50 positions, 50 facts, 50 contacts", async () => {
      seed120();
      const html = await renderGated({ view: "declined" });
      expect(rowsIn(html)).toEqual(ids.slice(0, 50));
      expect(html).toContain("Showing 1–50 of 120, newest first. Page 1 of 3.");
      expect(html).toContain('href="/waitlist?view=declined&amp;dpage=2"');
      expect(html).not.toContain("declined-prev");
      expect(followUp.scopedCalls.length).toBe(50);
      expect(queries.filter((q) => q.table === "new_client_waitlist_entries" && q.filters.some((f) => f[0] === "or")).length).toBe(50);
      expect(factIds()).toEqual(ids.slice(0, 50));
      const contactIds = (queries.find((q) => q.columns === "id,email,phone")?.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] ?? []) as string[];
      expect(contactIds).toEqual(ids.slice(0, 50)); // contact details are read for this page's people only
    });
    it("page 2 shows people 51-100 and page 3 the last 20: every recorded decline is reachable, with each one's date", async () => {
      seed120();
      const p2 = await renderGated({ view: "declined", dpage: "2" });
      expect(rowsIn(p2)).toEqual(ids.slice(50, 100));
      expect(p2).toContain("Showing 51–100 of 120");
      expect(p2).toContain('href="/waitlist?view=declined"'); // Previous
      expect(p2).toContain('href="/waitlist?view=declined&amp;dpage=3"');
      expect(followUp.scopedCalls.length).toBe(50);
      expect(new Set(followUp.scopedCalls)).toEqual(new Set(ids.slice(50, 100).map((id) => `i-${id}`))); // THIS page's people only
      expect(factIds()).toEqual(ids.slice(50, 100));
      expect(p2).toContain("Declined Aug 22, 2026"); // each row carries its date
      followUp.scopedCalls = [];
      const p3 = await renderGated({ view: "declined", dpage: "3" });
      expect(rowsIn(p3)).toEqual(ids.slice(100));
      expect(p3).toContain("Showing 101–120 of 120");
      expect(p3).not.toContain("declined-next");
      expect(followUp.scopedCalls.length).toBe(20);
    });
    it("a page past the end shows the last page, and an unreadable page number shows page 1", async () => {
      seed120();
      expect(rowsIn(await renderGated({ view: "declined", dpage: "99" }))).toEqual(ids.slice(100));
      expect(rowsIn(await renderGated({ view: "declined", dpage: "0" }))).toEqual(ids.slice(0, 50));
      expect(rowsIn(await renderGated({ view: "declined", dpage: "abc" }))).toEqual(ids.slice(0, 50));
    });
    it("no name or contact detail is in any paging address", async () => {
      seed120();
      const html = await renderGated({ view: "declined", dpage: "2" });
      const nav = html.match(/data-testid="declined-pages"[\s\S]*?<\/nav>/)?.[0] ?? "";
      expect(nav).not.toBe("");
      for (const m of nav.matchAll(/href="([^"]*)"/g)) expect(m[1]!).toMatch(/^\/waitlist\?view=declined(&amp;dpage=\d+)?$/);
    });
    it("50 or fewer people: no paging controls", async () => {
      seed();
      const html = await render({ view: "declined" });
      expect(html).not.toContain("declined-pages");
    });
  });

  describe("the entry link opens the page that CONTAINS the entry", () => {
    const seedLinks = (ahead: Record<string, number>) => {
      seed();
      scenario.declineEntries = [
        { id: "e-a", name: "Alex Rivers", status: "waiting", joined_at: "2026-07-01T12:00:00+00:00" },
        { id: "e-b", name: "Bo Tanaka", status: "invited", joined_at: "2026-07-02T12:00:00+00:00" },
      ];
      scenario.aheadOf = ahead;
    };
    it("page = floor(entries ahead / 100) + 1, on the entry's own section, with the page only past the first", async () => {
      seedLinks({ "e-a": 250, "e-b": 99 });
      const html = await render({ view: "declined" });
      expect(html).toContain('href="/waitlist?section=waiting&amp;page=3#entry-e-a"');
      expect(html).toContain('href="/waitlist?section=invited#entry-e-b"'); // 99 ahead is still page 1
      expect(html).not.toContain("first page of its section");
    });
    it("exactly 100 ahead is page 2", async () => {
      seedLinks({ "e-a": 100, "e-b": 0 });
      expect(await render({ view: "declined" })).toContain("section=waiting&amp;page=2#entry-e-a");
    });
    it("the position read is the queue's own order: this studio, this status, strictly before by (joined_at, id), head-only and exact", async () => {
      seedLinks({});
      await render({ view: "declined" });
      const q = queries.filter((x) => x.table === "new_client_waitlist_entries" && x.options.head === true && x.filters.some((f) => f[0] === "or"));
      expect(q.length).toBe(2);
      const a = q.find((x) => x.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "waiting"))!;
      expect(a.options).toEqual({ count: "exact", head: true });
      expect(a.filters.find((f) => f[0] === "eq" && f[1] === "studio_id")?.[2]).toBe(STUDIO_ID);
      expect(a.filters.find((f) => f[0] === "or")?.[2]).toBe("joined_at.lt.2026-07-01T12:00:00+00:00,and(joined_at.eq.2026-07-01T12:00:00+00:00,id.lt.e-a)");
    });
    it("a position that cannot be read gives plain text, never a link that might open the wrong page", async () => {
      seedLinks({});
      scenario.positionError = { code: "57014" };
      const html = await render({ view: "declined" });
      expect(html).not.toContain("declined-entry-link");
      expect(html).not.toContain("#entry-e-a");
      expect(html).toContain("its page could not be worked out just now");
    });
    it("a person whose entry has no section (removed) is not position-read at all", async () => {
      seed();
      await render({ view: "declined" });
      const heads = queries.filter((x) => x.filters.some((f) => f[0] === "or"));
      expect(heads.every((x) => x.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] !== "removed"))).toBe(true);
      expect(heads.length).toBe(1);
    });
  });

  it("the unreadable-names state says so and still shows the declines", async () => {
    seed();
    scenario.declineEntries = [];
    const html = await render({ view: "declined" });
    expect(html).toContain("A person on the waitlist");
    expect(html).toContain("Their entry could not be read.");
  });

  it("with the answers gate off the rows say answers are not collected (not 'none on record')", async () => {
    seed();
    const html = await render({ view: "declined" });
    expect(html).toContain("Answer not collected");
  });

  it("an unreadable decline read in the view says so, and never 'nobody declined'", async () => {
    seed();
    scenario.declinedError = { code: "57014" };
    const html = await render({ view: "declined" });
    expect(html).toContain('data-testid="declined-unknown"');
    expect(html).not.toContain("Nobody has declined");
  });

  it("a non-owner never reaches the view", async () => {
    seed();
    scenario.role = "practitioner";
    const html = await render({ view: "declined" });
    expect(html).not.toContain("declined-people");
    expect(html).not.toContain("Alex Rivers");
  });

  it("reads: owner session only, the studio's scope, and the view is not pulled by any other value", async () => {
    seed();
    await render({ view: "something-else" });
    expect(queries.some((q) => q.columns === "id,name,status,joined_at")).toBe(false);
    expect(followUp.scopedCalls).toEqual([]);
    expect(queries.some((q) => q.columns === "id,email,phone")).toBe(false);
    const read = queries.find((q) => q.table === "new_client_waitlist_invitations" && q.columns === DECLINE_COUNT_READ)!;
    expect(read.options).toEqual({ count: "exact" });
    expect(read.filters.find((f) => f[0] === "eq" && f[1] === "studio_id")?.[2]).toBe(STUDIO_ID);
    expect(read.filters.some((f) => f[0] === "not" && f[1] === "declined_at")).toBe(true);
  });

  it("RULE: a decline comes only from declined_at; the feature sends nothing and writes nothing", () => {
    const read = readFileSync(path.join(process.cwd(), "lib/waitlist/decline-visibility-read.ts"), "utf8");
    const pure = readFileSync(path.join(process.cwd(), "lib/waitlist/decline-visibility.ts"), "utf8");
    const comp = readFileSync(path.join(process.cwd(), "components/waitlist/declined-section.tsx"), "utf8");
    expect(read).toMatch(/\.not\("declined_at", "is", null\)/);
    const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const t of [code(read), code(pure), code(comp)]) {
      expect(t).not.toMatch(/expired_at|released_at|expires_at/);
      expect(t).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
      expect(t).not.toMatch(/sendEmail|sendSms|resend|twilio|createAdminClient|console\./i);
    }
  });
});
