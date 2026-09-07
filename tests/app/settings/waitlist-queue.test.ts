import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // Per-section totals, when a test needs a count LARGER than the rows it
  // seeded (truncation). Absent means "the count equals what was seeded".
  sectionTotals: null as Record<string, number> | null,
  // NEGATIVE CONTROL SWITCH. True makes the fake ignore the window's OFFSET and
  // answer every page with the top of the section — the read as it behaved
  // before pagination. Every assertion about reaching a later page must fail
  // against it, or it was proving nothing.
  ignoreRange: false,
};

function reset() {
  queries.length = 0;
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
    sectionTotals: null,
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
  createClient: async () => ({
    from(table: string) {
      const shape: QueryShape = {
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
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      throw new Error(`the waitlist action must not touch tables directly: ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
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
    expect(queries[0].orders).toEqual([
      ["joined_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("asks for an EXACT count, not an inferred one", async () => {
    await render();
    // `head: false` — this read wants the rows as well as the count. The
    // head-only form exists too, and is proved where it is used.
    expect(queries[0].options).toEqual({ count: "exact", head: false });
  });

  it("selects only the columns it renders — no `*`", async () => {
    await render();
    expect(queries[0].columns).toBe("id,name,email,phone,joined_at,status");
    expect(queries[0].columns).not.toContain("*");
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
    expect(html).toContain("Showing the 100 longest-waiting of 140.");
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
    expect(html).not.toContain("longest-waiting of");
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
    expect(controls.sort()).toEqual(["Confirm removal", "Remove"]);
    // Stated as its own claim so a future control named something else cannot
    // reintroduce claiming past the equality above.
    expect(html).not.toMatch(/\bclaim/i);

    // No links: a waiting person has no client record to navigate to, and
    // offering one would imply they are already a client.
    expect(html).not.toMatch(/<a\s/);
  });

  it("promises no queue position, invitation or capacity", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    for (const forbidden of [/invite/i, /position/i, /\brank/i, /next \d+/i, /capacity/i]) {
      expect(html, `forbidden vocabulary: ${forbidden}`).not.toMatch(forbidden);
    }
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
    expect(html).toContain("Showing the 1 longest-waiting of 250.");
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
    expect(html).toContain("Showing the 100 longest-waiting of 150.");
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
    expect(readFor("claimed").columns).toBe("id,name,email,phone,joined_at,status");
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
