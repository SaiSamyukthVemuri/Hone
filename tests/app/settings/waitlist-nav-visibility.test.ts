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

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: scenario.role, user_id: "user-1" },
    studio: { id: STUDIO_ID, slug: SLUG, name: "Willow Electrolysis" },
  }),
}));

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
    setFlags(false);
    scenario.rows = Array.from({ length: 27 }, () => ({
      studio_id: STUDIO_ID,
      status: "waiting",
    }));
    expect(await waitlistTabShown()).toBe(true);
  });

  it.each(["waiting", "claimed", "invited", "expired", "released"])(
    "1b. a single %s entry is enough with flags OFF",
    async (status) => {
      setFlags(false);
      scenario.rows = [{ studio_id: STUDIO_ID, status }];
      expect(await waitlistTabShown()).toBe(true);
    },
  );

  it("2. owner + flags ON → visible, without needing the presence read", async () => {
    setFlags(true);
    expect(await waitlistTabShown()).toBe(true);
    expect(queries).toHaveLength(0);
    expect(clientsBuilt).toBe(0);
  });

  it("3. owner + no rows + flags OFF → hidden", async () => {
    setFlags(false);
    expect(await waitlistTabShown()).toBe(false);
  });

  it("4. member + active rows (flags OFF or ON) → hidden, and nothing is read", async () => {
    scenario.role = "member";
    scenario.rows = [{ studio_id: STUDIO_ID, status: "waiting" }];
    setFlags(false);
    expect(await waitlistTabShown()).toBe(false);
    setFlags(true);
    expect(await waitlistTabShown()).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it("5. removed/converted-only history + flags OFF → hidden", async () => {
    setFlags(false);
    scenario.rows = [
      { studio_id: STUDIO_ID, status: "removed" },
      { studio_id: STUDIO_ID, status: "converted" },
    ];
    expect(await waitlistTabShown()).toBe(false);
  });

  it("6. the read is studio-scoped, HEAD-only, bounded to active states, on the user client", async () => {
    setFlags(false);
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
    setFlags(false);
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
