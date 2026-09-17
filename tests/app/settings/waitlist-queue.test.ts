import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPACITY_EXHAUSTED_COPY,
  CAPACITY_PANEL,
} from "@/lib/waitlist/invitation-capacity";
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
const revalidated: string[] = [];
const consoleErrors: string[] = [];

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
  revalidated.length = 0;
  consoleErrors.length = 0;
  Object.assign(scenario, {
    role: "owner",
    userId: USER_ID,
    rows: [],
    count: null,
    error: null,
    removeResult: "removed",
    removeError: null,
    liveInvitations: [],
    redeemedInvitations: [],
    invitationsError: null,
    services: [],
    servicesError: null,
    sectionTotals: null,
    preferences: [],
    preferencesError: null,
    openRound: null,
    roundsError: null,
    extraOpenRound: null,
    roundConsumed: 0,
    ignoreRange: false,
  });
}

vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => revalidated.push(p),
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: scenario.role, user_id: scenario.userId },
    studio: { id: STUDIO_ID, slug: SLUG, name: "Queue Studio", timezone: "America/Toronto" },
  }),
}));

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

        if (table === "new_client_waitlist_invitations") {
          if (scenario.invitationsError) {
            return { data: null, error: scenario.invitationsError };
          }
          // TWO invitation reads now, told apart by their predicates: the LIVE
          // one asks `is null` on all three terminal stamps; the REDEEMED one
          // asks `not redeemed_at is null`.
          const asksRedeemed = shape.filters.some((f) => f[0] === "not");
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
    };
  },
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      throw new Error(`the waitlist action must not touch tables directly: ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
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

/**
 * Render the page for a given query string.
 *
 * DEFAULTS TO NO PARAMS, so every existing call site keeps asserting on the
 * default all-sections view unchanged — the view a studio sees when it simply
 * opens /settings/waitlist.
 */
const render = async (
  searchParams: { section?: string | string[]; page?: string | string[] } = {},
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
    ...overrides,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reset();
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    consoleErrors.push(a.map(String).join(" "));
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-23T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  errSpy.mockRestore();
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
    const pageReads = queries.filter((x) => x.table === "new_client_waitlist_entries");
    expect(pageReads).toHaveLength(5);
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
    expect(entriesQuery().columns).toBe("id,name,email,phone,joined_at,status,source,joined_at_provenance");
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
    expect(html).toContain('href="/settings/waitlist?section=waiting"');
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

  it("offers EXACTLY ONE action per row, and no navigation at all", async () => {
    // Sharper than grepping for forbidden words: enumerate what a person can
    // actually press. WAIT-03's invitation and ADMIT's release would each have
    // to add a control here, and this list would change.
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();

    const controls = [
      ...[...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]),
      ...[...html.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map((m) => m[1]),
    ];
    // CLAIMING IS INTERNAL AND IS NOT OFFERED. A waiting row's only control is
    // removal, behind its confirmation step. What is NOT here is the point: no
    // Claim, no "Claim next", no Release, no Record expired, no Send invitation
    // — none of those is either permitted on a waiting entry or a job a
    // practitioner is being asked to do.
    // WAIT INTEGRATION-01 — THE LIST CHANGED, EXACTLY AS THIS GUARD PREDICTED.
    //
    // The note above says "WAIT-03's invitation and ADMIT's release would each
    // have to add a control here, and this list would change". The assembly
    // binds #683's composer to #685's `admit_`, so a waiting row now also
    // offers Invite to book, and the composer it opens carries its own send and
    // dismiss controls.
    //
    // CLAIMING IS STILL INTERNAL AND STILL NOT OFFERED — the part that was never
    // about invitation. The equality keeps a further control from arriving
    // unannounced, and the `claim` assertion below is untouched.
    // WAIT-CAPACITY-01 — AND IT CHANGED AGAIN, ON PURPOSE. The owner's
    // invitation-capacity panel adds exactly one control: "Start inviting"
    // when no capacity is open (or "Close invitations" when one is). It is an
    // OWNER control on the page, not a per-row action -- every row still offers
    // only Remove and Invite to book. Enumerated rather than excluded, so the
    // next unannounced control still fails here.
    // WAIT-04A — AND AGAIN, AND ONE OF THESE IS GENUINELY PER-ROW.
    //
    // Two owner controls and two tabs arrive with the add/import panel, which
    // is a page-level control like the capacity panel above it. "Record" is
    // different and is called out deliberately: it IS a per-row control, the
    // first added since Invite to book, and it writes the person's stated
    // availability. It reads "Update" once something has been recorded, so
    // both spellings are asserted below rather than only the one this fixture
    // happens to produce.
    //
    // Enumerated, not excluded, exactly as before: the next unannounced
    // control still fails here.
    expect(controls.sort()).toEqual([
      "Add to waitlist",
      "Cancel",
      "Confirm removal",
      "Invite to book",
      "Record",
      "Remove",
      "Send invitation",
      "Start inviting",
      "They asked today",
      "They were already waiting",
    ]);
    // Stated as its own claim so a future control named something else cannot
    // reintroduce claiming past the equality above.
    expect(html).not.toMatch(/\bclaim/i);

    // No links: a waiting person has no client record to navigate to, and
    // offering one would imply they are already a client.
    expect(html).not.toMatch(/<a\s/);
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
      "Set your invitation capacity before inviting someone to book.",
      CAPACITY_EXHAUSTED_COPY,
      "We couldn't check your invitation capacity just now. Reload the page before inviting.",
    ];
    let queueOnly = html.replace(
      /<section[^>]*data-testid="invitation-capacity"[\s\S]*?<\/section>/,
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
    for (const c of OWNER_CAPACITY_COPY) queueOnly = queueOnly.split(c).join("");
    expect(queueOnly, "the owner panel was not excised").not.toContain("invitation-capacity");
    // Non-vacuity: the strip must not have emptied the queue it is scanning.
    expect(queueOnly).toContain("Invite to book");
    for (const forbidden of [/position/i, /\brank/i, /capacity/i]) {
      expect(queueOnly, `forbidden vocabulary: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("reads the capacity with the page's OWN client, scoped and narrow", async () => {
    // THE READ'S SHAPE IS THE GUARD. A capacity read that quietly became broad
    // would still render correctly for this studio while exposing every other
    // studio's rounds to the query planner -- and RLS is the authority, not the
    // thing that makes a careless query safe to write.
    scenario.rows = [entry()];
    scenario.count = 1;
    await render();

    const cap = capacityQuery();
    // ONE CLIENT. The capacity read is recorded by the SAME fake that records
    // the queue read, which is only possible if the page used its existing
    // instance. A second client would not appear in `queries` at all.
    expect(queries.filter((q) => q.table === "studio_waitlist_admission_rounds")).toHaveLength(1);

    // ONLY THE COLUMNS IT RENDERS.
    expect(cap.columns).toBe("id,allowance,opened_at");
    expect(cap.columns).not.toContain("*");
    // Never the practitioner ids or the close stamps: the panel shows none of
    // them, and a column list is the cheapest place to keep that true.
    for (const col of ["opened_by_practitioner_id", "closed_by_practitioner_id", "closed_at"]) {
      expect(cap.columns).not.toContain(col);
    }

    // THIS STUDIO, EXPLICITLY. Defence in depth behind the owner RLS policy.
    expect(cap.filters).toContainEqual(["eq", "studio_id", STUDIO_ID]);
    // AND ONLY AN OPEN ROUND. Without this the page would see closed history
    // and could present a spent capacity as live.
    expect(cap.filters).toContainEqual(["is", "closed_at", null]);

    // BOUNDED. The database guarantees at most one open round; asking for two
    // is how the page detects that guarantee being violated rather than
    // silently using the first row.
    expect(cap.limit).toBe(2);
  });

  it("P2 4020704242 — the page builds exactly ONE owner-scoped client", async () => {
    // COUNTING QUERIES COULD NEVER PROVE THIS. The suite shares one query log
    // across every mock client, so "exactly one capacity query" was equally true
    // of a page that built a SECOND client and issued one query from it. The
    // ruling is one owner-scoped instance for the queue AND the capacity read,
    // so the instance is what gets counted.
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.openRound = { id: "round-a", allowance: 2, opened_at: "2026-09-10T00:00:00.000Z" };
    scenario.roundConsumed = 1;
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
    expect(queries.some((q) => q.table === "studio_waitlist_admission_rounds")).toBe(true);
    expect(capacityQuery().clientId).toBe(entriesQuery().clientId);
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

  it("an unreadable capacity withholds the send — it never reads as 'none'", async () => {
    // FAIL CLOSED. "Could not read" and "no capacity" would produce the same
    // sentence but a different fact, and treating an error as "none" would let
    // a real open capacity be hidden -- or worse, invert later.
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.roundsError = { code: "42501" };
    const html = await render();
    expect(html).toContain(esc("We couldn't check your invitation capacity just now."));
    expect(html).not.toContain(esc(CAPACITY_PANEL.emptyBody));
    expect(html).not.toContain("Start inviting");
  });

  it("a second open round is impossible, so it is treated as unknown", async () => {
    // The one-open-round index forbids this. If it is ever seen, an assumption
    // here is wrong -- picking a row would be guessing which capacity is real.
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.openRound = { id: "round-a", allowance: 3, opened_at: "2026-09-10T00:00:00.000Z" };
    scenario.extraOpenRound = { id: "round-b", allowance: 9, opened_at: "2026-09-11T00:00:00.000Z" };
    const html = await render();
    expect(html).toContain(esc("We couldn't check your invitation capacity just now."));
    expect(html).not.toContain("0 of 3 used");
    expect(html).not.toContain("0 of 9 used");
    expect(consoleErrors.join("\n")).toContain("waitlist_capacity_impossible_shape");
  });

  it("an unreadable consumed count is unknown capacity, not zero used", async () => {
    // Zero-used would present a full capacity as fully available.
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.openRound = { id: "round-a", allowance: 2, opened_at: "2026-09-10T00:00:00.000Z" };
    scenario.roundConsumed = null;
    const html = await render();
    expect(html).toContain(esc("We couldn't check your invitation capacity just now."));
    expect(html).not.toContain("0 of 2 used");
  });

  it("MATRIX 1 — no capacity: the panel explains, and no send is offered", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).toContain(esc(CAPACITY_PANEL.title));
    expect(html).toContain(esc(CAPACITY_PANEL.emptyBody));
    expect(html).toContain(esc(CAPACITY_PANEL.startLabel));
    // The send is unavailable BEFORE submission, and says why -- the whole point
    // is that the practitioner does not discover this only after pressing.
    expect(html).toContain(esc("Set your invitation capacity before inviting someone to book."));
    expect(html).toMatch(/data-testid="composer-send"[^>]*disabled/);
    // And the reason shown is the CAPACITY one, not the composer's ordinary
    // "choose a service" state that would disable it anyway.
    expect(html).toMatch(
      /data-testid="composer-send-reason"[^>]*>Set your invitation capacity before inviting someone to book\./,
    );
    // No close control when nothing is open.
    expect(html).not.toContain(esc(CAPACITY_PANEL.closeLabel));
  });

  it("MATRIX 2/3 — an open capacity shows usage and offers the send", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    // An ELIGIBLE service, because the composer refuses a send without one for
    // its own reasons. Without it this test would assert capacity while the
    // button stayed disabled for an unrelated cause.
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    scenario.openRound = { id: "round-a", allowance: 1, opened_at: "2026-09-10T00:00:00.000Z" };
    scenario.roundConsumed = 0;
    let html = await render();
    expect(html).toContain("0 of 1 used");
    expect(html).toContain("1 invitation remaining");
    expect(html).toContain(esc(CAPACITY_PANEL.closeLabel));
    // CAPACITY IS NO LONGER WHAT BLOCKS THE SEND. The button is still disabled
    // on a fresh composer -- no service is chosen yet, which is the composer's
    // own rule and not this feature's -- so asserting `not disabled` here would
    // be asserting something untrue. What must be gone is the capacity REASON.
    expect(html).not.toContain(esc("Set your invitation capacity before inviting someone to book."));
    expect(html).not.toContain(esc(CAPACITY_EXHAUSTED_COPY));

    // After one invitation is spent, the database's count moves and so does the
    // panel. The page reads that count; it never derives it.
    reset();
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.openRound = { id: "round-a", allowance: 1, opened_at: "2026-09-10T00:00:00.000Z" };
    scenario.roundConsumed = 1;
    scenario.services = [{ id: "svc-live", name: "Initial consultation", modality: "consultation", active: true }];
    html = await render();
    expect(html).toContain("1 of 1 used");
  });

  it("MATRIX 4 — a full capacity offers no send and never starts another", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    scenario.openRound = { id: "round-a", allowance: 1, opened_at: "2026-09-10T00:00:00.000Z" };
    scenario.roundConsumed = 1;
    const html = await render();
    expect(html).toContain("0 invitations remaining");
    expect(html).toContain(esc(CAPACITY_EXHAUSTED_COPY));
    expect(html).toMatch(/data-testid="composer-send"[^>]*disabled/);
    expect(html).toMatch(/data-testid="composer-send-reason"[^>]*>You&#x27;ve used all invitations/);
    // NOT AUTOMATICALLY REOPENED. The next capacity is the owner's decision.
    expect(html).toContain(esc(CAPACITY_PANEL.closeLabel));
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

  it("the owner capacity panel forecasts nothing to a prospect", async () => {
    // The panel may say "Invitation capacity" — that is the practitioner
    // wording. What it must NOT do is the thing the queue guard forbids:
    // promise a position, a rank, or when a slot will exist.
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    const panel =
      /<section[^>]*data-testid="invitation-capacity"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(panel, "the capacity panel did not render").not.toBe("");
    for (const forbidden of [/position/i, /\brank/i, /spots? left/i, /estimated/i, /your turn/i]) {
      expect(panel, `capacity panel forecast: ${forbidden}`).not.toMatch(forbidden);
    }
    // And it never speaks the database's word for itself.
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
    await removeWaitlistEntryAction(fd);

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
    expect(revalidated).toEqual(["/settings/waitlist"]);
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
    await removeWaitlistEntryAction(fd);
    expect(rpcCalls[0].args).toEqual({
      p_studio_id: STUDIO_ID,
      p_entry_id: "entry-1",
      p_actor_user_id: USER_ID,
    });
  });

  it.each([
    ["not_found", "That waitlist entry no longer exists."],
    ["already_removed", "That entry has already been removed."],
    // The two outcomes 0188 added so the operator could be told what to do.
    // Reachable here even though the queue page renders only `waiting` rows: a
    // second operator can claim, invite or convert the entry between the page
    // render and this submit.
    [
      "release_required",
      "That entry has been claimed or invited. Release it before removing it.",
    ],
    [
      "not_removable",
      "That person is already a client. Converted entries stay in waitlist history.",
    ],
    // Kept despite the route's own role check: the command re-derives membership
    // and role in the database, so a change committed in between lands here.
    ["not_owner", "Only studio owners can change the waitlist."],
    ["not_a_member", "Only studio owners can change the waitlist."],
  ])("maps the command refusal `%s` to copy an owner can act on", async (code, message) => {
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
      } else {
        expect(error!.message, `${code} falls through to the generic error`).not.toBe(GENERIC);
      }
      expect(revalidated, `${code} revalidated despite refusing`).toHaveLength(0);
    }
  });

  it("an unrecognised outcome or a database error is generic, never a raw code", async () => {
    for (const setup of [
      () => { scenario.removeResult = "some_future_code"; },
      () => { scenario.removeError = { code: "57014" }; },
    ]) {
      reset();
      setup();
      const fd = new FormData();
      fd.set("entry_id", "entry-1");
      await expect(removeWaitlistEntryAction(fd)).rejects.toThrow(
        "Could not remove that entry. Please try again.",
      );
    }
  });

  it("logs the outcome without any contact detail", async () => {
    scenario.removeResult = "not_found";
    const fd = new FormData();
    fd.set("entry_id", "entry-1");
    await expect(removeWaitlistEntryAction(fd)).rejects.toThrow();
    const line = consoleErrors.find((l) => l.includes("waitlist_remove_failed"));
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
    path.resolve(__dirname, "../../../app/(app)/settings/layout.tsx"),
    "utf8",
  );

  it("requires BOTH rollout flags, not just the durable one", () => {
    // Either half alone describes a studio that is not taking durable waitlist
    // requests. With the gate cleared, new clients book normally and nothing
    // new can arrive; with the durable flag cleared, the queue is still the
    // inbox. Advertising an intake surface in either state presents a stale
    // queue as a live one — and the durable flag is documented as SUBORDINATE
    // to the gate, so consulting it alone contradicts the contract.
    expect(LAYOUT).toMatch(
      /const waitlistTabVisible =\s*\n\s*isOwner &&\s*\n\s*isNewClientWaitlistEnabled\(studio\.slug\) &&\s*\n\s*isNewClientWaitlistDurableEnabled\(studio\.slug\);/,
    );
    expect(LAYOUT).toContain('{ href: "/settings/waitlist", label: "Waitlist" }');
  });

  it("derives BOTH flags from the SERVER-RESOLVED studio, never a browser value", () => {
    expect(LAYOUT).toContain("isNewClientWaitlistEnabled(studio.slug)");
    expect(LAYOUT).toContain("isNewClientWaitlistDurableEnabled(studio.slug)");
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

  it("sits inside the owner-only block", () => {
    const ownerIdx = LAYOUT.indexOf("...(isOwner");
    const waitlistIdx = LAYOUT.indexOf('"/settings/waitlist"');
    const closeOwnerIdx = LAYOUT.indexOf("]\n      : []");
    expect(waitlistIdx).toBeGreaterThan(ownerIdx);
    expect(waitlistIdx).toBeLessThan(closeOwnerIdx);
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
      const html = await render();
      expect(actionsFor(html)).toEqual(expected);
    });
  }

  it("EXPIRE IS NOT CANCELLATION — withheld while the invitation is live", async () => {
    scenario.rows = [entry({ id: "e-live", status: "invited" })];
    scenario.count = 1;
    scenario.liveInvitations = [
      { entry_id: "e-live", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    const html = await render();
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
    const html = await render();
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
    const html = await render();
    expect(actionsFor(html)).not.toContain("expire");
    // …and Release is withheld too: the command could only answer
    // `already_redeemed`.
    expect(actionsFor(html)).not.toContain("release");
    expect(html).toContain("has been used");
  });

  it("a FAILED invitation read withholds the control and SAYS it could not check", async () => {
    // The wrong answer here is silence that reads as "still live". Unknown is
    // not the same as not-elapsed, and the sentence has to say which it is.
    scenario.rows = [entry({ id: "e-unknown", status: "invited" })];
    scenario.count = 1;
    scenario.invitationsError = { code: "57014" };
    const html = await render();
    // FAILS CLOSED, both ways. Release used to render here on the assumption
    // that unknown meant "not redeemed" — but a redeemed invitation can only
    // answer `already_redeemed`, so the control could not succeed. Neither is
    // offered, and the copy no longer claims Release "ends it either way".
    expect(actionsFor(html)).not.toContain("expire");
    expect(actionsFor(html)).not.toContain("release");
    expect(html).toContain("could not be");
    expect(html).not.toContain("either way");
  });

  it("the invitation window is read ONLY when some row is invited", async () => {
    scenario.rows = [entry({ status: "waiting" })];
    scenario.count = 1;
    await render();
    // ONE read per section, and no invitation read at all because no row is
    // invited.
    expect(queries.filter((q) => q.table === "new_client_waitlist_invitations")).toHaveLength(0);
    expect(queries.filter((q) => q.table === "new_client_waitlist_entries")).toHaveLength(5);
  });

  it("and IS read when one is", async () => {
    // Non-vacuity for the assertion above.
    scenario.rows = [entry({ id: "e-inv", status: "invited" })];
    scenario.count = 1;
    await render();
    // TWO invitation reads: the live-cycle predicate and the redeemed one.
    // Identity comes from the 0189 unique index, never from ordering — so
    // neither read carries an `order`.
    const inv = queries.filter((q) => q.table === "new_client_waitlist_invitations");
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
    expect(html).toContain('href="/settings/waitlist?section=waiting"');
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
 * The row list has no nested `<li>`, so a row ends where the next one begins,
 * or where its `</ul>` does. Returns null when the row is not on the page at
 * all, which is the case the negative control drives.
 */
function rowMarkup(html: string, entryId: string): string | null {
  const attr = html.indexOf(`data-entry-id="${entryId}"`);
  if (attr === -1) return null;
  const start = html.lastIndexOf("<li", attr);
  const nextLi = html.indexOf("<li", attr);
  const listEnd = html.indexOf("</ul>", attr);
  const ends = [nextLi, listEnd].filter((i) => i !== -1);
  return html.slice(start, ends.length > 0 ? Math.min(...ends) : html.length);
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
    expect(html).toContain('href="/settings/waitlist?section=claimed"');
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
    expect(readFor("claimed").columns).toBe("id,name,email,phone,joined_at,status,source,joined_at_provenance");
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

    // Five reads either way; only the focused one asks for rows.
    const reads = queries.filter((q) => q.table === "new_client_waitlist_entries");
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

  it("offers the way back to all groups", async () => {
    scenario.rows = seedSection("claimed", 150);
    const html = await render({ section: "claimed" });
    expect(html).toContain('href="/settings/waitlist"');
    expect(html).toContain("Back to all groups");
  });

  it("renders prev/next only where there is somewhere to go", async () => {
    scenario.rows = seedSection("claimed", 150);
    const first = await render({ section: "claimed", page: "1" });
    expect(first).not.toContain('data-testid="waitlist-page-prev"');
    expect(first).toContain('href="/settings/waitlist?section=claimed&amp;page=2"');

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
  it("an unknown section falls back to ALL groups, and never reaches a filter", async () => {
    scenario.rows = [...seedSection("claimed", 2), ...seedSection("waiting", 2)];
    const html = await render({ section: "converted' or 1=1--" });

    // Both groups render: this is the default view, not an empty page.
    expect(html).toContain('data-entry-status="claimed"');
    expect(html).toContain('data-entry-status="waiting"');
    // The injected value reached no query. Status filters are the five the page
    // declares, because `section` is MATCHED against them rather than passed
    // through.
    const statuses = queries
      .filter((q) => q.table === "new_client_waitlist_entries")
      .map((q) => q.filters.find((f) => f[0] === "eq" && f[1] === "status")?.[2]);
    expect(statuses).toEqual(["waiting", "claimed", "invited", "expired", "released"]);
  });

  it("a terminal status is not a section, even though it is a real status", async () => {
    // `converted` and `removed` are deliberately unread. Naming one must not
    // produce a focused view of a group this surface does not show.
    scenario.rows = seedSection("waiting", 2);
    const html = await render({ section: "removed" });
    expect(html).not.toContain("Back to all groups");
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
    // Every state at once: if any heading, meaning line or control still says
    // it, this catches it regardless of which section it came from.
    scenario.rows = [
      entry({ id: "w1", status: "waiting" }),
      entry({ id: "c1", status: "claimed" }),
      entry({ id: "i1", status: "invited" }),
      entry({ id: "x1", status: "expired" }),
      entry({ id: "r1", status: "released" }),
    ];
    scenario.liveInvitations = liveInvitationFor("i1");
    const html = await render();

    // NON-VACUITY: all five sections really did render.
    for (const s of ["waiting", "claimed", "invited", "expired", "released"]) {
      expect(html, s).toContain(`data-testid="waitlist-section-${s}"`);
    }
    const text = visibleText(html);
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
    const html = await render();

    expect(rowActions(html, "i1")).toContain("release");
    const row = rowMarkup(html, "i1")!;
    expect(row).toContain("Cancel invitation");
    expect(row).not.toContain("Return to waitlist");
    expect(row).not.toMatch(/>Release</);
  });

  it("ALL THREE READ DIFFERENTLY ON THE SAME PAGE", async () => {
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
    const html = await render();

    expect(rowMarkup(html, "c1")).toContain("Set aside");
    expect(rowMarkup(html, "i1")).toContain("Cancel invitation");
    expect(rowMarkup(html, "r1")).toContain("Return to waitlist");

    // THE BUTTON LABEL "Return to waitlist" BELONGS TO REQUEUE ALONE — this is
    // the assertion that would have caught the defect. Matched case-sensitively
    // against the label itself: the help sentence beside Set aside says
    // "return THEM to the waitlist later", which is a different string and a
    // true one, so it is not what is being excluded here.
    expect(rowMarkup(html, "c1")).not.toContain("Return to waitlist");
    expect(rowMarkup(html, "i1")).not.toContain("Return to waitlist");
    expect(rowMarkup(html, "c1")).not.toContain("Cancel invitation");
    expect(rowMarkup(html, "r1")).not.toContain("Set aside");
  });

  it("requeue reads RETURN TO WAITLIST on expired and released rows", async () => {
    scenario.rows = [
      entry({ id: "x1", status: "expired" }),
      entry({ id: "r1", status: "released" }),
    ];
    const html = await render();

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
