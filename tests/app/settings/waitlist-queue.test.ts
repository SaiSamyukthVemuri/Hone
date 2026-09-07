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
  // The invitation-window read, which decides whether "Record expired" may be
  // offered at all. Empty by default: no row is `invited` unless a test says so.
  invitations: [] as Array<Record<string, unknown>>,
  invitationsError: null as { code: string } | null,
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
      };
      queries.push(shape);
      // THENABLE AT EVERY LINK, not only at `.limit`. The page issues TWO
      // shapes: the bounded entries read (terminal at `.limit`) and the
      // invitation-window read (terminal at `.in`). A builder that resolves
      // only on `.limit` cannot model the second, and every render would throw.
      const settle = () => {
        if (table === "new_client_waitlist_invitations") {
          return {
            data: scenario.invitationsError ? null : scenario.invitations,
            error: scenario.invitationsError,
          };
        }
        return {
          data: scenario.error ? null : scenario.rows,
          count: scenario.error ? null : scenario.count,
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
        order(column: string, options?: { ascending?: boolean }) {
          shape.orders.push([column, options]);
          return builder;
        },
        limit(n: number) {
          shape.limit = n;
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

const render = async () => renderToStaticMarkup(await WaitlistSettingsPage());

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
    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.table).toBe("new_client_waitlist_entries");
    expect(q.filters).toEqual([
      ["eq", "studio_id", STUDIO_ID],
      // The page now reads every ACTIVE lifecycle state, not waiting alone.
      // `converted` and `removed` are terminal history and stay out, so the
      // bound is spent on rows an operator can still act on.
      ["in", "status", ["waiting", "claimed", "invited", "expired", "released"]],
    ]);
    expect(q.limit).toBeGreaterThan(0);
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
    expect(queries[0].options).toEqual({ count: "exact" });
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
    expect(html).toMatch(/Active entries:\s*<[^>]*>140</);
    expect(html).toContain("Showing the 100 longest-waiting of 140.");
  });

  it("says nothing about truncation when the page holds everyone", async () => {
    scenario.rows = [entry()];
    scenario.count = 1;
    const html = await render();
    expect(html).toMatch(/Active entries:\s*<[^>]*>1</);
    expect(html).not.toContain("longest-waiting of");
  });

  it("renders an empty state when nobody is waiting", async () => {
    scenario.rows = [];
    scenario.count = 0;
    const html = await render();
    expect(html).toContain("Nobody is waiting right now.");
    expect(html).toMatch(/Active entries:\s*<[^>]*>0</);
  });
});

describe("a failed load is never shown as an empty queue", () => {
  it("says the list could not be loaded, and logs without PII", async () => {
    scenario.error = { code: "42501", message: "permission denied for table" };
    const html = await render();
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("Nobody is waiting");
    expect(html).not.toMatch(/Active entries:\s*<[^>]*>0</);
    const line = consoleErrors.find((l) => l.includes("waitlist_queue_load_failed"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ studioId: STUDIO_ID, code: "42501" });
  });
});

describe("rendered rows", () => {
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
    // WAIT-EXPOSE-01 surfaced the lifecycle authority that already shipped, so
    // the list this test anticipated changing has changed. A WAITING row now
    // offers Claim; the page offers Claim next once, above the sections. What
    // is NOT here is the point: no Release, no Record expired, no Send
    // invitation — none of those is permitted on a waiting entry, and the page
    // withholds them from stored state rather than firing a command to find out.
    expect(controls.sort()).toEqual([
      "Claim",
      "Claim next",
      "Confirm removal",
      "Remove",
    ]);

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
  const CASES: ReadonlyArray<[string, string[]]> = [
    ["waiting", ["claim"]],
    ["claimed", ["release"]],
    // A LIVE invitation offers Release (end it early) and NOT Record expired.
    ["invited", ["release"]],
    ["expired", ["requeue"]],
    ["released", ["requeue"]],
  ];

  for (const [status, expected] of CASES) {
    it(`${status} offers exactly ${expected.join(", ") || "nothing"}`, async () => {
      scenario.rows = [entry({ id: `e-${status}`, status })];
      scenario.count = 1;
      // A live invitation: expires in the future, so nothing has run out.
      scenario.invitations =
        status === "invited"
          ? [
              {
                entry_id: `e-${status}`,
                expires_at: new Date(Date.now() + 86_400_000).toISOString(),
                redeemed_at: null,
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
    scenario.invitations = [
      {
        entry_id: "e-live",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        redeemed_at: null,
      },
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
    scenario.invitations = [
      {
        entry_id: "e-done",
        expires_at: new Date(Date.now() - 3_600_000).toISOString(),
        redeemed_at: null,
      },
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
    scenario.invitations = [
      {
        entry_id: "e-used",
        expires_at: new Date(Date.now() - 3_600_000).toISOString(),
        redeemed_at: new Date(Date.now() - 1_800_000).toISOString(),
      },
    ];
    const html = await render();
    expect(actionsFor(html)).not.toContain("expire");
  });

  it("a FAILED invitation read withholds the control and SAYS it could not check", async () => {
    // The wrong answer here is silence that reads as "still live". Unknown is
    // not the same as not-elapsed, and the sentence has to say which it is.
    scenario.rows = [entry({ id: "e-unknown", status: "invited" })];
    scenario.count = 1;
    scenario.invitationsError = { code: "57014" };
    const html = await render();
    expect(actionsFor(html)).not.toContain("expire");
    expect(html).toContain("Couldn&#x27;t check whether this invitation has run out");
    // Release still works, and the copy says so.
    expect(actionsFor(html)).toContain("release");
  });

  it("the invitation window is read ONLY when some row is invited", async () => {
    scenario.rows = [entry({ status: "waiting" })];
    scenario.count = 1;
    await render();
    expect(queries.map((q) => q.table)).toEqual(["new_client_waitlist_entries"]);
  });

  it("and IS read when one is", async () => {
    // Non-vacuity for the assertion above.
    scenario.rows = [entry({ id: "e-inv", status: "invited" })];
    scenario.count = 1;
    scenario.invitations = [];
    await render();
    expect(queries.map((q) => q.table)).toEqual([
      "new_client_waitlist_entries",
      "new_client_waitlist_invitations",
    ]);
  });

  it("Claim next is offered only when somebody is actually waiting", async () => {
    scenario.rows = [entry({ status: "claimed" })];
    scenario.count = 1;
    const claimedHtml = await render();
    expect(claimedHtml).not.toContain("Claim next");

    reset();
    scenario.rows = [entry({ status: "waiting" })];
    scenario.count = 1;
    expect(await render()).toContain("Claim next");
  });
});
