import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

// DAT-002: today's charting status on the dashboard is derived from two reads
// in app/(app)/dashboard/page.tsx (sessions, then session_blocks). Their errors
// used to be discarded, so a failed read presented a completed, already charted
// visit as "needs charting" (no linked session) or "started" (no charted area).
// A failed read now refuses the page through the route error boundary (the
// #981 pattern). The page is invoked with a fake client; child components are
// not rendered. Synthetic ids only.

const state = vi.hoisted(() => ({
  failTable: null as string | null,
  appt: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
}));

function fakeClient() {
  const rowsFor = (table: string): unknown[] => {
    if (table === "appointments") return state.appt ? [state.appt] : [];
    if (table === "sessions") return [{ id: "sess-1", appointment_id: "appt-1" }];
    if (table === "session_blocks") return [{ session_id: "sess-1" }];
    return [];
  };
  const builder = (table: string) => {
    const settle = () =>
      state.failTable === table
        ? { data: null, error: { code: "57014", message: "synthetic read failure" }, count: null }
        : { data: rowsFor(table), error: null, count: 0 };
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(settle).then(resolve, reject);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: null, error: state.failTable === table ? settle().error : null });
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

// Every props object in the returned tree (child components are not invoked).
function collectProps(node: unknown, out: Array<Record<string, unknown>> = [], seen = new Set<unknown>()) {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const n of node) collectProps(n, out, seen); return out; }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    out.push(props);
    for (const v of Object.values(props)) collectProps(v, out, seen);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) collectProps(v, out, seen);
  return out;
}

async function chartingFor() {
  const tree = await DashboardPage({ searchParams: Promise.resolve({}) });
  const props = collectProps(tree);
  const linked = props.map((p) => p.linkedSession).filter((v) => v !== undefined);
  return { linked };
}

beforeEach(() => {
  state.failTable = null;
  const now = new Date();
  state.appt = {
    id: "appt-1", studio_id: "studio-1", client_id: "client-1", practitioner_id: "prac-1",
    starts_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 30)).toISOString(),
    ends_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 30)).toISOString(),
    status: "completed", notes: null,
    client: { id: "client-1", name: "Client A", allergies: null },
    service: { id: "svc-1", name: "Service", modality: "electrolysis" },
    practitioner: { id: "prac-1", display_name: "Owner", color: null },
  };
});

describe("DAT-002 today's charting status after a failed read", () => {
  it("control: successful reads show the charted session", async () => {
    const r = await chartingFor();
    expect(r.linked).toContainEqual({ sessionId: "sess-1", hasChartedArea: true });
  });

  it.each(["sessions", "session_blocks"])(
    "a failed %s read refuses the page instead of presenting the visit as uncharted",
    async (table) => {
      state.failTable = table;
      await expect(chartingFor()).rejects.toThrow(/^Failed to load charting status$/);
    },
  );
});
