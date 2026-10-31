import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-58: the app of #1199 must work on a database WITHOUT 0258 (no
// clients.preferred_name, no client_legal_identities), so deploying it does not
// have to wait for the migration. Every caller that names preferred_name is run
// against a fake database that answers as Postgres/PostgREST would on 0246:
//   - any select/filter naming preferred_name  -> 42703 "column ... does not exist"
//   - any insert/update carrying preferred_name -> PGRST204
//   - any read of client_legal_identities       -> 42P01
// Each test also asserts the read RETRIED without the column (so the first
// attempt really did hit the missing column: not vacuous). Synthetic data.

vi.mock("server-only", () => ({}));

type Call = { table: string; select: string[]; filters: string[]; payload?: Record<string, unknown>; outcome?: "ok" | "missing_preferred" | "missing_legal" };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: {} as Record<string, unknown[]>,
  rpc: {} as Record<string, unknown>,
}));

function builder(table: string, rpcName?: string) {
  const call: Call = { table, select: [], filters: [] };
  h.calls.push(call);
  const settle = (mode: "many" | "one") => {
    const p = call.payload;
    const named = [...call.select, ...call.filters].some((s) => s.includes("preferred_name"));
    if ((p && p.preferred_name !== undefined) || named) {
      call.outcome = "missing_preferred";
      return p
        ? { data: null, error: { code: "PGRST204", message: "Could not find the 'preferred_name' column of 'clients' in the schema cache" } }
        : { data: null, error: { code: "42703", message: "column clients.preferred_name does not exist" } };
    }
    if (table === "client_legal_identities") {
      call.outcome = "missing_legal";
      return { data: null, error: { code: "42P01", message: 'relation "public.client_legal_identities" does not exist' } };
    }
    call.outcome = "ok";
    if (rpcName) return { data: h.rpc[rpcName] ?? null, error: null };
    // keyset pagination (.gt("id", last)) past the first page returns nothing
    const rows = call.filters.some((f) => f.startsWith("gt ")) ? [] : (h.rows[table] ?? []);
    return mode === "one" ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length };
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => settle("many")).then(res, rej);
      }
      if (prop === "maybeSingle" || prop === "single") return async () => settle("one");
      return (...args: unknown[]) => {
        if (prop === "select" && typeof args[0] === "string") call.select.push(args[0]);
        else if (prop === "insert" || prop === "update" || prop === "upsert") call.payload = args[0] as Record<string, unknown>;
        else call.filters.push(`${String(prop)} ${args.filter((a) => typeof a === "string").join(" ")}`);
        return proxy;
      };
    },
  });
  return proxy;
}
const fakeClient = () => ({
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  from: (table: string) => builder(table),
  rpc: (name: string) => builder("rpc", name),
});

const practitioner = { id: "prac-1", role: "owner", active: true, display_name: "Owner", email: "owner@example.test" };
const studio = { id: "studio-1", name: "Studio", slug: "studio", timezone: "UTC", owner_email: "owner@example.test", practitioner_capacity_enabled: false, google_calendar_connection_enabled: false };

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/supabase/admin-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase/admin-server")>()),
  createAdminClient: () => fakeClient(),
}));
vi.mock("@/lib/supabase/queries", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase/queries")>()),
  requirePractitionerWithStudio: async () => ({ practitioner, studio }),
  getCurrentPractitionerWithStudio: async () => ({ practitioner, studio }),
}));

import { resetPreferredNameProbeForTests } from "@/lib/clients/preferred-name-read";

const missingPreferredHits = (table: string) => h.calls.filter((c) => c.table === table && c.outcome === "missing_preferred");
const okCalls = (table: string) => h.calls.filter((c) => c.table === table && c.outcome === "ok");
const noColumn = (c: Call) => ![...c.select, ...c.filters].some((s) => s.includes("preferred_name")) && !(c.payload && "preferred_name" in c.payload && c.payload.preferred_name !== undefined);

// first imports of the heavy pages can exceed 5s on a loaded host
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  h.calls = [];
  h.rows = {};
  h.rpc = {};
  resetPreferredNameProbeForTests();
});

describe("the fake database is not vacuous", () => {
  it("answers 42703 for a select naming preferred_name and ok for the same read without it", async () => {
    const c = fakeClient() as unknown as { from: (t: string) => { select: (s: string) => { limit: (n: number) => Promise<unknown> } } };
    const bad = await c.from("clients").select("id, name, preferred_name").limit(1);
    const good = await c.from("clients").select("id, name").limit(1);
    expect((bad as { error: { code: string } }).error.code).toBe("42703");
    expect((good as { error: unknown }).error).toBeNull();
  });
});

describe("book_appointment client lookup (calendar/actions.ts)", () => {
  it("loads the client without preferred_name instead of refusing the booking", async () => {
    h.rows.services = [{ id: "svc-1", name: "Service", default_duration_minutes: 60, active: true, modality: "electrolysis" }];
    h.rows.clients = [{ id: "client-1", name: "Ada Test", email: "ada@example.test", phone: null, sms_consent_at: null, sms_opted_out_at: null }];
    const { bookAppointmentForClientAction } = await import("@/app/(app)/calendar/actions");
    const fd = new FormData();
    fd.set("client_id", "client-1");
    fd.set("service_id", "svc-1");
    fd.set("starts_at", new Date(Date.now() + 86_400_000).toISOString());
    const res = await bookAppointmentForClientAction(fd).catch(() => null);
    expect((res as { error?: string } | null)?.error).not.toBe("Could not load the client. Please try again.");
    expect(missingPreferredHits("clients").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("clients").some(noColumn)).toBe(true);
  });
});

describe("cancel notification client read (calendar/actions.ts)", () => {
  it("still reads the client's name and email after the cancellation", async () => {
    h.rpc.practitioner_cancel_appointment = "cancelled";
    h.rows.appointments = [{ client_id: "client-1", starts_at: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60, service_id: null }];
    h.rows.clients = [{ name: "Ada Test", email: "ada@example.test" }];
    const { cancelAppointmentAction } = await import("@/app/(app)/calendar/actions");
    const fd = new FormData();
    fd.set("appointment_id", "appt-1");
    await cancelAppointmentAction(fd).catch(() => null);
    expect(missingPreferredHits("clients").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("clients").some(noColumn)).toBe(true);
  });
});

describe("manual postcare send lookup (calendar/actions.ts)", () => {
  it("does not fail the lookup on the missing column", async () => {
    h.rows.appointments = [];
    const { sendPostcareEmailAction } = await import("@/app/(app)/calendar/actions");
    const fd = new FormData();
    fd.set("appointment_id", "appt-1");
    const res = await sendPostcareEmailAction(fd);
    expect((res as { error?: string }).error).not.toBe("Could not send postcare. Please try again.");
    expect(missingPreferredHits("appointments").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("appointments").some(noColumn)).toBe(true);
  });
});

describe("automatic postcare send read (postcare-auto-send.ts)", () => {
  it("loads the appointment without preferred_name (not 'load_error')", async () => {
    const { autoSendPostcareOnComplete } = await import("@/app/(app)/calendar/postcare-auto-send");
    h.rows.appointments = [{
      id: "appt-1", status: "completed", starts_at: new Date().toISOString(), postcare_email_sent_at: null, postcare_email_send_attempts: 0,
      client: { name: "Ada Test", email: "ada@example.test" },
      service: { name: "Service", modality: "electrolysis" },
      studio: { id: "studio-1", name: "Studio", owner_email: "o@example.test", timezone: "UTC", postcare_delivery_mode: "manual", postcare_aftercare_text: "x" },
      practitioner: { display_name: "Owner" },
    }];
    const outcome = await autoSendPostcareOnComplete("appt-1", "studio-1", "prac-1", { admin: fakeClient() as never, sendPostcare: (async () => ({ ok: true })) as never });
    expect(outcome).not.toBe("load_error");
    expect(missingPreferredHits("appointments").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("appointments").some(noColumn)).toBe(true);
  });
});

describe("appointment detail page (calendar/[id])", () => {
  it("is a not-found for a missing appointment, not a database error", async () => {
    h.rows.appointments = [];
    const { default: Page } = await import("@/app/(app)/calendar/[id]/page");
    await expect(Page({ params: Promise.resolve({ id: "appt-1" }), searchParams: Promise.resolve({}) } as never)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(missingPreferredHits("appointments").length).toBeGreaterThanOrEqual(1);
  });
});

describe("upcoming page (calendar/upcoming)", () => {
  it("renders from a read without preferred_name", async () => {
    h.rows.appointments = [];
    const { default: Page } = await import("@/app/(app)/calendar/upcoming/page");
    await expect(Page()).resolves.toBeTruthy();
    expect(missingPreferredHits("appointments").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("appointments").some(noColumn)).toBe(true);
  });
});

describe("dashboard today's appointments", () => {
  it("loads without preferred_name instead of throwing", async () => {
    h.rows.appointments = [];
    const { default: Page } = await import("@/app/(app)/dashboard/page");
    await expect(Page({ searchParams: Promise.resolve({}) } as never)).resolves.toBeTruthy();
    expect(missingPreferredHits("appointments").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("appointments").some(noColumn)).toBe(true);
  });
});

describe("calendar range read (lib/booking/queries.ts)", () => {
  it("returns the appointments with the client's stored name when preferred_name is absent", async () => {
    h.rows.appointments = [{ id: "a1", starts_at: "2026-11-01T15:00:00Z", practitioner: { id: "p", color: "#000", display_name: "P" }, client: { id: "c", name: "Ada Test" }, service: { id: "s", name: "S", modality: null, calendar_color: null } }];
    const { getAppointmentsForRange } = await import("@/lib/booking/queries");
    const rows = await getAppointmentsForRange("studio-1", "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z");
    expect(rows).toHaveLength(1);
    expect(missingPreferredHits("appointments").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("appointments").some(noColumn)).toBe(true);
  });
});

describe("client directory (lib/supabase/queries.ts)", () => {
  it("lists clients without preferred_name", async () => {
    h.rows.clients = [{ id: "c1", name: "Ada Test", pronouns: null, email: null, phone: null, address: null, archived_at: null }];
    const { getClientsForStudio } = await import("@/lib/supabase/queries");
    const rows = await getClientsForStudio("studio-1");
    expect(rows.map((r) => r.name)).toEqual(["Ada Test"]);
    expect(missingPreferredHits("clients").length).toBeGreaterThanOrEqual(1);
    expect(okCalls("clients").some(noColumn)).toBe(true);
  });
});

describe("global search", () => {
  it("finds a client by stored name with no preferred_name column and no legal table", async () => {
    h.rows.clients = [{ id: "c1", name: "Ada Test", email: null, phone: null }];
    const { globalSearchAction } = await import("@/app/(app)/global-search-actions");
    const res = await globalSearchAction("ada test");
    expect(res).toMatchObject({ ok: true });
    const results = (res as { results: Array<{ title?: string; label?: string }> }).results;
    expect(JSON.stringify(results)).toContain("Ada Test");
    // The search runs its candidate reads in parallel, so each one that names the
    // column sees it missing once; the whole search then reruns without it, and no
    // read of the rerun names it (next assertion).
    expect(h.calls.filter((c) => c.table === "clients" && c.outcome === "missing_preferred").length).toBeGreaterThanOrEqual(1);
    expect(h.calls.filter((c) => c.outcome === "ok" && !noColumn(c))).toHaveLength(0);
    // the missing legal table is "nothing found", not a failed search
    expect(h.calls.some((c) => c.table === "client_legal_identities" && c.outcome === "missing_legal")).toBe(true);
  });
});

describe("staff client create and edit", () => {
  const post = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const run = async (fn: () => Promise<unknown>) => {
    try { return { result: await fn(), redirected: null as string | null }; }
    catch (e) { const m = /^NEXT_REDIRECT:(.*)$/.exec((e as Error).message); if (!m) throw e; return { result: undefined, redirected: m[1] }; }
  };

  it("create with an EMPTY preferred name saves (the column is left out)", async () => {
    h.rows.clients = [{ id: "new-client" }];
    const { createClientAction } = await import("@/app/(app)/clients/new/actions");
    const { redirected } = await run(() => createClientAction(post({ name: "Ada Test", preferred_name: "" })));
    expect(redirected).toMatch(/^\/clients\//);
    const inserts = h.calls.filter((c) => c.payload && "name" in c.payload && c.table === "clients");
    expect(inserts.some((c) => c.outcome === "ok" && noColumn(c))).toBe(true);
  });

  it("create with a TYPED preferred name is refused clearly, never silently dropped", async () => {
    h.rows.clients = [{ id: "new-client" }];
    const { createClientAction } = await import("@/app/(app)/clients/new/actions");
    const { result, redirected } = await run(() => createClientAction(post({ name: "Ada Test", preferred_name: "Addie" })));
    expect(redirected).toBeNull();
    expect(result).toEqual({ ok: false, error: "Preferred names are not available yet. Remove the preferred name and save again." });
    expect(h.calls.filter((c) => c.payload && c.outcome === "ok")).toHaveLength(0);
  });

  it("edit with an EMPTY preferred name saves; a typed one is refused; a form without the field never names the column", async () => {
    h.rows.clients = [{ id: "client-x", name: "Ada Test", phone: null, date_of_birth: null }];
    const { updateClientAction } = await import("@/app/(app)/clients/[id]/actions");
    const bound = (fd: FormData) => { fd.set("client_id", "client-x"); return updateClientAction(fd); };
    const empty = await run(() => bound(post({ name: "Ada Test", preferred_name: "" })));
    expect(empty.result).not.toMatchObject({ ok: false });
    const typed = await run(() => bound(post({ name: "Ada Test", preferred_name: "Addie" })));
    expect(typed.result).toEqual({ ok: false, error: "Preferred names are not available yet. Remove the preferred name and save again." });
    h.calls = [];
    await run(() => bound(post({ name: "Ada Test" })));
    expect(h.calls.filter((c) => c.payload).every((c) => c.outcome === "ok")).toBe(true);
  });
});
