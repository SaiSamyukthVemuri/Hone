import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

// DAT-002 follow-up (Privacy PEER-1087 N2): four older dashboard refusals
// embedded the raw PostgREST error text in their thrown message. error.tsx
// never renders it, but server-side error capture receives it, and that text
// can echo the failing statement. Each now throws a fixed message, as #1087's
// refusals do. Each read is failed in turn by table and call order, through
// the real page with a fake client. Synthetic ids only.

const SYNTHETIC = "synthetic read failure: relation clients column date_of_birth";

const state = vi.hoisted(() => ({
  fail: null as string | null,
  calls: new Map<string, number>(),
  appt: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
}));

function fakeClient() {
  const builder = (key: string) => {
    const n = (state.calls.get(key) ?? 0) + 1;
    state.calls.set(key, n);
    const settle = () =>
      state.fail === `${key}#${n}`
        ? { data: null, error: { code: "57014", message: SYNTHETIC }, count: null }
        : { data: key === "appointments" && state.appt ? [state.appt] : [], error: null, count: 0 };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(settle).then(resolve, reject);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: null, error: settle().error });
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => builder(table),
    rpc: (fn: string) => builder(`rpc:${fn}`),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/supabase/admin-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase/admin-server")>()),
  createAdminClient: () => fakeClient(),
}));
vi.mock("@/lib/supabase/queries", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase/queries")>()),
  requirePractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Studio", slug: "studio", timezone: "UTC", practitioner_capacity_enabled: false },
  }),
}));

const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");

function findProp(node: unknown, name: string, seen = new Set<unknown>()): unknown {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findProp(n, name, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (name in props) return props[name];
    return findProp(props.children, name, seen);
  }
  return undefined;
}

// Renders the page and settles the attention sources, returning the first
// refusal from either, or null when both succeed.
async function refusal(): Promise<Error | null> {
  try {
    const page = await DashboardPage({ searchParams: Promise.resolve({}) });
    const sources = findProp(page, "attentionSources") as Promise<unknown> | undefined;
    expect(sources, "attentionSources prop not found").toBeDefined();
    await sources;
    return null;
  } catch (e) {
    return e as Error;
  }
}

beforeEach(() => {
  state.fail = null;
  state.calls = new Map();
  const now = new Date();
  const at = (h: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 30)).toISOString();
  state.appt = {
    id: "appt-1", studio_id: "studio-1", client_id: "client-1", practitioner_id: "prac-1",
    starts_at: at(0), ends_at: at(1), status: "confirmed", notes: null,
    client: { id: "client-1", name: "Client A", allergies: null },
    service: { id: "svc-1", name: "Service", modality: "electrolysis" },
    practitioner: { id: "prac-1", display_name: "Owner", color: null },
  };
});

const CASES = [
  // WS-DB: appointments#1 is the upcoming-visit read for the preparation tier
  // (started before the roster); the roster is #2. See the degrade test below.
  { read: "appointments#2", message: "Failed to load today's appointments" },
  { read: "client_intake_forms#2", message: "Failed to load intake status" },
  { read: "clients#1", message: "Failed to load birthdays" },
];

describe("DAT-002 follow-up: dashboard refusals carry a fixed message", () => {
  it("control: every read succeeds and nothing refuses", async () => {
    expect(await refusal()).toBeNull();
    const reads = [...state.calls].flatMap(([k, n]) => Array.from({ length: n }, (_, i) => `${k}#${i + 1}`));
    for (const { read } of CASES) expect(reads).toContain(read);
  });

  for (const { read, message } of CASES) {
    it(`a failed ${read} refuses with exactly "${message}", without the database text`, async () => {
      state.fail = read;
      const error = await refusal();
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe(message);
      expect(error!.message).not.toContain("synthetic");
    });
  }

  it("a failed intake-awaiting-review read (client_intake_forms#1) degrades THAT count and does not refuse the page or the bundle", async () => {
    // Insurance B2: it used to reject the whole attentionSources bundle.
    state.fail = "client_intake_forms#1";
    expect(await refusal()).toBeNull();
  });

  it("a failed upcoming-visit read (appointments#1) degrades the ORDER and does not refuse", async () => {
    state.fail = "appointments#1";
    expect(await refusal()).toBeNull();
  });
});
