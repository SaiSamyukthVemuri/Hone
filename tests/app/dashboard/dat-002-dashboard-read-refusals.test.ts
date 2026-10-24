import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

// DAT-002 regression: "Dashboard database errors are displayed as zero
// activity". #981 made the practice snapshot refuse (tests/lib/dashboard/
// practice-metrics-read-failures.test.ts). These cases pin the OTHER dashboard
// reads that production already refuses, or reports as unknown, so they cannot
// regress into an empty or zero state. They invoke the real page with a fake
// client and inspect the promises it hands to the secondary stack (child
// components are not rendered). Synthetic ids only.

const state = vi.hoisted(() => ({
  fail: new Set<string>(),
  appt: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
}));

function fakeClient() {
  const builder = (key: string) => {
    const settle = () =>
      state.fail.has(key)
        ? { data: null, error: { code: "57014", message: "synthetic read failure" }, count: null }
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

async function render() {
  return DashboardPage({ searchParams: Promise.resolve({}) });
}

async function attentionSources() {
  const promise = findProp(await render(), "attentionSources") as Promise<readonly unknown[]> | undefined;
  expect(promise, "attentionSources prop not found").toBeDefined();
  return promise!;
}

beforeEach(() => {
  state.fail = new Set();
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

describe("DAT-002 dashboard reads that must refuse rather than show an empty day", () => {
  it("control: the page renders on successful reads", async () => {
    await expect(render()).resolves.toBeTruthy();
  });

  it("refuses the page when today's appointments cannot be read", async () => {
    state.fail.add("appointments");
    await expect(render()).rejects.toThrow(/Failed to load today's appointments/);
  });

  it("refuses the page when today's intake status cannot be read", async () => {
    state.fail.add("client_intake_forms");
    await expect(render()).rejects.toThrow(/Failed to load intake status/);
  });

  it("rejects the attention sources when the birthday read fails, instead of no birthdays", async () => {
    state.fail.add("clients");
    await expect(attentionSources()).rejects.toThrow(/Failed to load birthdays/);
  });
});

describe("DAT-002 payment status: unknown is not 'no account'", () => {
  it("a successful empty read means no connected account", async () => {
    const [, , payment] = await attentionSources();
    expect(payment).toEqual({ hasAccount: false, livemode: null, onboardingCompleted: false, payoutsEnabled: false });
  });

  it("a failed read is reported as unknown (null), never as 'no account'", async () => {
    state.fail.add("rpc:get_studio_payment_settings_display");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const [, , payment] = await attentionSources();
      expect(payment).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});
