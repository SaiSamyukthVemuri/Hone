import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";
import {
  NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV,
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
} from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// WAITLIST-NAV-VIS-01 — Settings → Waitlist is discoverable whenever the
// studio has a live operator queue, not only when the rollout flags are on.
// ===========================================================================
//
// These render the REAL layout against a fake user client that answers the
// presence read from seeded rows by applying the filters the layout actually
// sent — so "removed/converted-only hides the tab" and "another studio's rows
// do not count" are properties of the issued query, not of a canned answer.

const STUDIO_ID = "studio-willow";
const OTHER_STUDIO_ID = "studio-other";
const SLUG = "willow-electrolysis";

type Row = { studio_id: string; status: string };
type Recorded = {
  table: string;
  columns: string;
  options: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
};

const scenario = {
  role: "owner" as "owner" | "member",
  rows: [] as Row[],
  error: null as null | { code: string },
};
const queries: Recorded[] = [];
let clientsBuilt = 0;

// NEW-CLIENT-MODE-01: the nav now reads the canonical mode. Driving it
// directly makes each case state the mode it is about, instead of stubbing two
// deploy variables and hoping the bridge turns them into the intended state.
// `source` is carried because the nav no longer asks WHAT the mode is, it asks
// whether a permitted join COMMITS DURABLY - and during the migration bridge
// those differ. A bridged WAITLIST commits durably only while the legacy
// durable list names the studio; a persisted one always does.
const admissionScenario: {
  value: { ok: boolean; mode?: string; source?: string };
} = {
  value: { ok: true, mode: "open", source: "persisted" },
};
// PARTIAL, not a replacement. The nav's decision now runs through
// lib/booking/new-client-waitlist-durability-bridge, which imports
// `newClientAdmissionIsCutOver` from this module - so a mock that supplied only
// the read would leave the bridge calling `undefined`. Stub the READ, keep
// every pure predicate real: they are the thing under test here.
vi.mock("@/lib/booking/new-client-admission", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/booking/new-client-admission")>();
  return {
    ...actual,
    getNewClientAdmissionMode: vi.fn(async () => admissionScenario.value),
  };
});
vi.mock("@/lib/supabase/queries", () => {
  // ONE identity under both names: the settings layout and page resolve it
  // through the redirecting guard, server actions through the throwing
  // backstop (SENTRY-IDENTITY-01).
  const identity = async () => ({
    practitioner: { id: "prac-1", role: scenario.role, user_id: "user-1" },
    studio: { id: STUDIO_ID, slug: SLUG, name: "Willow Electrolysis" },
  });
  return {
    getCurrentPractitionerWithStudio: identity,
    requirePractitionerWithStudio: identity,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    clientsBuilt += 1;
    return {
      from(table: string) {
        const rec: Recorded = { table, columns: "", options: {}, filters: [] };
        queries.push(rec);
        const settle = () => {
          if (scenario.error) return { data: null, count: null, error: scenario.error };
          const matching = scenario.rows.filter((r) =>
            rec.filters.every(([op, col, val]) => {
              const v = (r as Record<string, unknown>)[col];
              if (op === "eq") return v === val;
              if (op === "in") return (val as unknown[]).includes(v);
              throw new Error(`unmodelled filter ${op}`);
            }),
          );
          return {
            data: rec.options.head ? null : matching,
            count: rec.options.count ? matching.length : null,
            error: null,
          };
        };
        const builder = {
          select(columns: string, options: Record<string, unknown> = {}) {
            rec.columns = columns;
            rec.options = options;
            return builder;
          },
          eq(col: string, val: unknown) {
            rec.filters.push(["eq", col, val]);
            return builder;
          },
          in(col: string, val: unknown[]) {
            rec.filters.push(["in", col, val]);
            return builder;
          },
          then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve(settle()).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  },
}));

// Service-role must never be reached from the layout.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    throw new Error("service-role client used by Settings layout");
  },
}));

const envKeys = [NEW_CLIENT_WAITLIST_SLUGS_ENV, NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
let savedEnv: Array<readonly [string, string | undefined]> = [];
const setFlags = (on: boolean) => {
  for (const k of envKeys) {
    if (on) process.env[k] = SLUG;
    else delete process.env[k];
  }
};

function findItems(node: ReactNode): Array<{ href: string; label: string }> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findItems(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<{ items?: unknown; children?: ReactNode }>;
  if (Array.isArray(el.props?.items)) {
    return el.props.items as Array<{ href: string; label: string }>;
  }
  return findItems(el.props?.children);
}

async function waitlistTabShown(): Promise<boolean> {
  const { default: SettingsLayout } = await import("@/app/(app)/settings/layout");
  const tree = await SettingsLayout({ children: null });
  const items = findItems(tree);
  expect(items, "layout must hand SettingsNav its items").not.toBeNull();
  return items!.some((i) => i.href === "/settings/waitlist" && i.label === "Waitlist");
}

beforeEach(() => {
  admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
  savedEnv = envKeys.map((k) => [k, process.env[k]] as const);
  scenario.role = "owner";
  scenario.rows = [];
  scenario.error = null;
  queries.length = 0;
  clientsBuilt = 0;
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("Settings → Waitlist tab visibility", () => {
  it("1. owner + active rows + flags OFF → visible", async () => {
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    scenario.rows = Array.from({ length: 27 }, () => ({
      studio_id: STUDIO_ID,
      status: "waiting",
    }));
    expect(await waitlistTabShown()).toBe(true);
  });

  it.each(["waiting", "claimed", "invited", "expired", "released"])(
    "1b. a single %s entry is enough with flags OFF",
    async (status) => {
      admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
      scenario.rows = [{ studio_id: STUDIO_ID, status }];
      expect(await waitlistTabShown()).toBe(true);
    },
  );

  it("2. owner + PERSISTED WAITLIST → visible, without needing the presence read", async () => {
    admissionScenario.value = { ok: true, mode: "waitlist", source: "persisted" };
    expect(await waitlistTabShown()).toBe(true);
    expect(queries).toHaveLength(0);
    expect(clientsBuilt).toBe(0);
  });

  it("3. owner + no rows + mode OPEN → hidden", async () => {
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    expect(await waitlistTabShown()).toBe(false);
  });

  it("4. member + active rows (any mode) → hidden, and nothing is read", async () => {
    scenario.role = "member";
    scenario.rows = [{ studio_id: STUDIO_ID, status: "waiting" }];
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    expect(await waitlistTabShown()).toBe(false);
    admissionScenario.value = { ok: true, mode: "waitlist", source: "persisted" };
    expect(await waitlistTabShown()).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it("5. removed/converted-only history + flags OFF → hidden", async () => {
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    scenario.rows = [
      { studio_id: STUDIO_ID, status: "removed" },
      { studio_id: STUDIO_ID, status: "converted" },
    ];
    expect(await waitlistTabShown()).toBe(false);
  });

  it("6. the read is studio-scoped, HEAD-only, bounded to active states, on the user client", async () => {
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    // Another studio's active rows must not light up this studio's tab.
    scenario.rows = [{ studio_id: OTHER_STUDIO_ID, status: "waiting" }];
    expect(await waitlistTabShown()).toBe(false);

    expect(queries).toHaveLength(1);
    const [q] = queries;
    expect(q.table).toBe("new_client_waitlist_entries");
    expect(q.options).toEqual({ count: "exact", head: true });
    expect(q.filters).toContainEqual(["eq", "studio_id", STUDIO_ID]);
    expect(q.filters).toContainEqual([
      "in",
      "status",
      ["waiting", "claimed", "invited", "expired", "released"],
    ]);
    expect(clientsBuilt).toBe(1);
  });

  it("fails closed: a read error hides the tab and does not throw", async () => {
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    scenario.rows = [{ studio_id: STUDIO_ID, status: "waiting" }];
    scenario.error = { code: "42501" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await waitlistTabShown()).toBe(false);
    expect(err.mock.calls.flat().join(" ")).toContain("waitlist_nav_presence_failed");
  });
});

describe("the presence rule stays navigation-only", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const LAYOUT = readFileSync(path.join(ROOT, "app/(app)/settings/layout.tsx"), "utf8");
  const HELPER = readFileSync(
    path.join(ROOT, "lib/waitlist/operator-queue-presence.ts"),
    "utf8",
  );

  it("uses the RLS-scoped server client, never service-role", () => {
    for (const src of [LAYOUT, HELPER]) {
      expect(src).not.toMatch(/admin-server|createAdminClient|service[_-]?role_key/i);
    }
    expect(LAYOUT).toContain('from "@/lib/supabase/server"');
  });

  it("performs no write", () => {
    expect(HELPER).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
  });

  it("the tab's active states are the page's sections — one list, not two", () => {
    const PAGE = readFileSync(
      path.join(ROOT, "app/(app)/settings/waitlist/page.tsx"),
      "utf8",
    );
    expect(PAGE).toContain("const SECTION_STATUSES = OPERATOR_QUEUE_STATUSES;");
  });
});

describe("NEW-CLIENT-MODE-01: the nav follows the canonical mode", () => {
  // waitlistTabVisible = owner && (mode === WAITLIST || an active queue exists)
  //
  // The second half is unchanged and load-bearing: a studio with a real queue
  // must never lose its navigation to that queue, whatever the mode says. That
  // is also why UNKNOWN cannot hide an active queue - an unreadable mode is not
  // evidence that the queue is gone.
  const ACTIVE = [{ studio_id: STUDIO_ID, status: "waiting" }];

  it("WAITLIST + empty queue -> visible", async () => {
    admissionScenario.value = { ok: true, mode: "waitlist", source: "persisted" };
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(true);
  });

  it("OPEN + empty queue -> hidden", async () => {
    admissionScenario.value = { ok: true, mode: "open", source: "persisted" };
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(false);
  });

  it("CLOSED + empty queue -> hidden", async () => {
    admissionScenario.value = { ok: true, mode: "closed", source: "persisted" };
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(false);
  });

  it.each([["open"], ["closed"]])(
    "%s + an ACTIVE queue -> visible, because the queue is real",
    async (mode) => {
      admissionScenario.value = { ok: true, mode, source: "persisted" };
      scenario.rows = ACTIVE;
      expect(await waitlistTabShown()).toBe(true);
    },
  );

  it("UNKNOWN + an ACTIVE queue -> visible", async () => {
    // Never invent WAITLIST from an unreadable mode - but never strand a real
    // queue either.
    admissionScenario.value = { ok: false };
    scenario.rows = ACTIVE;
    expect(await waitlistTabShown()).toBe(true);
  });

  it("UNKNOWN + empty queue -> hidden", async () => {
    admissionScenario.value = { ok: false };
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(false);
  });

  it.each([["waitlist"], ["open"], ["closed"]])(
    "a non-owner never sees it, whatever the mode (%s)",
    async (mode) => {
      scenario.role = "member";
      admissionScenario.value = { ok: true, mode, source: "persisted" };
      scenario.rows = ACTIVE;
      expect(await waitlistTabShown()).toBe(false);
    },
  );
});

// ===========================================================================
// EXACT-HEAD P2-B at ed0ac2b3 — the nav follows the DURABLE COMMIT PATH.
//
// `waitlistLive = admission.mode === "waitlist"` was the wrong authority. During
// the migration bridge a studio can be in WAITLIST mode while its joins still
// commit through legacy email acceptance, so the tab opened an operator queue
// that nothing writes to: the owner saw an empty queue while their prospects sat
// in an inbox, and a deploy meant to change no behaviour silently added a tab.
//
// The rule is now:
//   owner AND (a permitted join commits DURABLY  OR  actionable rows exist)
//
// The second half is untouched, and it is what keeps every hidden case honest:
// a real queue always keeps its navigation, whatever the mode or the env says.
// ===========================================================================
describe("P2-B: the nav follows the durable commit path, not the mode alone", () => {
  const ACTIVE_ROWS = [{ studio_id: STUDIO_ID, status: "waiting" }];
  // Imported, not spelled out: a containment guard keeps the set of files that
  // NAME this flag closed, and a test does not need to widen it.
  const DURABLE_ENV = NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV;
  const ORIGINAL_DURABLE = process.env[DURABLE_ENV];

  function durableList(value: string | undefined) {
    if (value === undefined) delete process.env[DURABLE_ENV];
    else process.env[DURABLE_ENV] = value;
  }

  const bridged = { ok: true, mode: "waitlist", source: "legacy_bridge" };
  const persisted = { ok: true, mode: "waitlist", source: "persisted" };

  afterEach(() => durableList(ORIGINAL_DURABLE));

  it("persisted WAITLIST + durable env OFF + empty queue -> VISIBLE", async () => {
    // A cut-over studio commits durably whatever the legacy list says, so its
    // queue is real and its navigation must not depend on an env var that is
    // about to be deleted.
    durableList(undefined);
    admissionScenario.value = persisted;
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(true);
  });

  it("legacy WAITLIST + durable ON + empty queue -> VISIBLE", async () => {
    durableList(SLUG);
    admissionScenario.value = bridged;
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(true);
  });

  it("legacy WAITLIST + durable OFF + empty queue -> HIDDEN", async () => {
    // THE REPAIR. Joins still commit by email here, so there is no durable
    // queue to work and the tab would show the owner an empty one.
    durableList(undefined);
    admissionScenario.value = bridged;
    scenario.rows = [];
    expect(
      await waitlistTabShown(),
      "an email-committing studio has no durable queue to navigate to",
    ).toBe(false);
  });

  it("legacy WAITLIST + durable OFF + ACTIONABLE queue -> VISIBLE", async () => {
    // The fallback is load-bearing precisely here: rows written before the
    // durable slug was dropped are still real work, and the owner must be able
    // to reach them.
    durableList(undefined);
    admissionScenario.value = bridged;
    scenario.rows = ACTIVE_ROWS;
    expect(await waitlistTabShown()).toBe(true);
  });

  it("another studio in the durable list does not open THIS studio's tab", async () => {
    durableList("some-other-studio");
    admissionScenario.value = bridged;
    scenario.rows = [];
    expect(await waitlistTabShown()).toBe(false);
  });

  it.each([
    ["open", { ok: true, mode: "open", source: "persisted" }],
    ["closed", { ok: true, mode: "closed", source: "persisted" }],
    ["unknown", { ok: false }],
  ])(
    "%s + an ACTIONABLE queue -> VISIBLE even with the durable list off",
    async (_label, value) => {
      durableList(undefined);
      admissionScenario.value = value;
      scenario.rows = ACTIVE_ROWS;
      expect(await waitlistTabShown()).toBe(true);
    },
  );

  it("a NON-OWNER never sees the tab, in any bridge configuration", async () => {
    for (const durable of [undefined, SLUG]) {
      for (const value of [bridged, persisted]) {
        durableList(durable);
        scenario.role = "member";
        admissionScenario.value = value;
        scenario.rows = ACTIVE_ROWS;
        expect(
          await waitlistTabShown(),
          `member must never get the owner tab (durable=${String(durable)}, source=${value.source})`,
        ).toBe(false);
      }
    }
  });

  it("the durable commit path is the SHARED decision, not a second rule", async () => {
    // One authority, reused. If the nav grew its own copy of the bridge rule,
    // the two could drift and the tab could disagree with where joins land.
    const { newClientWaitlistCommitIsDurable } = await import(
      "@/lib/booking/new-client-waitlist-durability-bridge"
    );
    durableList(undefined);
    for (const value of [bridged, persisted]) {
      const durableCommit = newClientWaitlistCommitIsDurable(
        value as never,
        SLUG,
      );
      admissionScenario.value = value;
      scenario.rows = [];
      expect(
        await waitlistTabShown(),
        `the tab must agree with the commit path for source=${value.source}`,
      ).toBe(durableCommit);
    }
  });
});
