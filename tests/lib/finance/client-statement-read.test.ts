import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

type Result = { data: unknown; error: unknown };
type Call = { table: string; method: string; args: unknown[] };
const ROOT = path.resolve(__dirname, "../../..");

/** A recording fake. A table maps to a queue of results: each await takes the next, the last repeats. */
function recording(results: Record<string, Result | Result[]>) {
  const calls: Call[] = [];
  const queues = new Map<string, Result[]>();
  for (const [t, r] of Object.entries(results)) queues.set(t, Array.isArray(r) ? [...r] : [r]);
  const client = {
    from: (table: string) => {
      const chain: unknown = new Proxy(() => undefined, {
        get: (_x, prop) => {
          if (prop === "then")
            return (res: (v: unknown) => void) => {
              const q = queues.get(table) ?? [{ data: [], error: null }];
              res(q.length > 1 ? q.shift() : q[0]);
            };
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args });
            return chain;
          };
        },
      });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
const ok = (data: unknown): Result => ({ data, error: null });
const CLIENT = "11111111-1111-4111-8111-111111111111";
const studio = { id: "22222222-2222-4222-8222-222222222222", timezone: "America/Toronto" };
const NOW = new Date("2026-11-19T18:00:00Z");
const appt = (i: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, client_id: CLIENT, starts_at: `2026-11-03T15:${String(i % 60).padStart(2, "0")}:00+00:00`,
  status: "completed", practitioner_id: null, service_id: null, duration_minutes: 30, ...over,
});
const healthy = (): Record<string, Result | Result[]> => ({
  clients: ok({ id: CLIENT, name: "Client One", preferred_name: null }),
  appointments: ok([appt(1)]),
  sessions: ok([]), payment_charge_attempts: ok([]), appointment_settlements: ok([]), manual_fee_charge_attempts: ok([]), services: ok([]), practitioners: ok([]),
});
const load = async (role: string, client: SupabaseClient, currency: string | null = "cad", id = CLIENT) => {
  const { loadClientStatementRead } = await import("@/lib/finance/client-statement-read");
  return loadClientStatementRead({ role }, studio, currency, id, NOW, client);
};

describe("access: owner only, before any query", () => {
  it("every non-owner role is refused and NO query is made", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      const { client, calls } = recording(healthy());
      expect(await load(role, client)).toEqual({ access: "refused" });
      expect(calls, role).toEqual([]);
    }
  });
  it("a malformed client id and a missing currency are refused before any query", async () => {
    const a = recording(healthy());
    expect(await load("owner", a.client, "cad", "not-a-uuid")).toEqual({ access: "granted", ok: false, reason: "invalid_client" });
    expect(a.calls).toEqual([]);
    const b = recording(healthy());
    expect(await load("owner", b.client, null)).toEqual({ access: "granted", ok: false, reason: "currency_unknown" });
    expect(b.calls).toEqual([]);
  });
  it("a client of another studio or an unknown id is the SAME not-found, and no visit or money is read", async () => {
    const { client, calls } = recording({ ...healthy(), clients: ok(null) });
    expect(await load("owner", client)).toEqual({ access: "granted", ok: false, reason: "client_not_found" });
    expect(calls.every((c) => c.table === "clients")).toBe(true);
    const scoped = calls.filter((c) => c.method === "eq").map((c) => c.args.join("="));
    expect(scoped).toEqual([`id=${CLIENT}`, `studio_id=${studio.id}`]);
  });
});

describe("appointment-first, keyset paged over the full history", () => {
  it("a visit with no money row is KEPT", async () => {
    const r = await load("owner", recording(healthy()).client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    if (r.access === "granted" && r.ok) {
      expect(r.visits).toHaveLength(1);
      expect(r.visits[0].lines).toEqual([]);
      expect(r.client).toEqual({ id: CLIENT, name: "Client One" });
    }
  });
  it("reads more than one page: a full page asks for the next by (starts_at, id), a short page stops", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => appt(i + 1, { starts_at: `2026-01-01T00:00:00+00:00` }));
    const page2 = [appt(501, { starts_at: "2026-02-01T00:00:00+00:00" })];
    const { client, calls } = recording({ ...healthy(), appointments: [ok(page1), ok(page2)] });
    const r = await load("owner", client);
    expect(r).toMatchObject({ ok: true });
    if (r.access === "granted" && r.ok) expect(r.visits).toHaveLength(501);
    const ors = calls.filter((c) => c.table === "appointments" && c.method === "or");
    expect(ors).toHaveLength(1);
    expect(String(ors[0].args[0])).toContain(`id.gt."${page1[499].id}"`);
    expect(String(ors[0].args[0])).toContain('starts_at.gt."2026-01-01T00:00:00+00:00"');
  });
  it("a page one row short of full is the LAST page: no second request", async () => {
    const { client, calls } = recording({ ...healthy(), appointments: ok(Array.from({ length: 499 }, (_, i) => appt(i + 1))) });
    await load("owner", client);
    expect(calls.filter((c) => c.table === "appointments" && c.method === "or")).toEqual([]);
    expect(calls.filter((c) => c.table === "appointments" && c.method === "limit")).toHaveLength(1);
  });
  it("every appointment read is scoped by studio AND client, ordered by (starts_at, id)", async () => {
    const { client, calls } = recording(healthy());
    await load("owner", client);
    const a = calls.filter((c) => c.table === "appointments");
    expect(a.filter((c) => c.method === "eq").map((c) => c.args.join("="))).toEqual([`studio_id=${studio.id}`, `client_id=${CLIENT}`]);
    expect(a.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual(["starts_at", "id"]);
  });
  it("history beyond MAX_PAGES fails closed; a repeated row or another client's row fails the read", async () => {
    const { MAX_PAGES } = await import("@/lib/finance/client-statement-read");
    const full = (k: number) => Array.from({ length: 500 }, (_, i) => appt(k * 1000 + i + 1));
    const never = recording({ ...healthy(), appointments: Array.from({ length: MAX_PAGES + 1 }, (_, k) => ok(full(k))) });
    expect(await load("owner", never.client)).toEqual({ access: "granted", ok: false, reason: "too_many_appointments" });
    expect(await load("owner", recording({ ...healthy(), appointments: ok([appt(1), appt(1)]) }).client)).toMatchObject({ ok: false, reason: "read_failed" });
    expect(await load("owner", recording({ ...healthy(), appointments: ok([appt(1, { client_id: "other" })]) }).client)).toMatchObject({ ok: false, reason: "read_failed" });
  });
});

describe("fail closed", () => {
  it("an error in any table fails the whole read; a money table at the 1000-row cap fails it; 999 does not", async () => {
    for (const table of ["clients", "appointments", "sessions", "payment_charge_attempts", "appointment_settlements", "manual_fee_charge_attempts"]) {
      const r = await load("owner", recording({ ...healthy(), [table]: { data: null, error: { message: "boom" } } }).client);
      expect(r, table).toMatchObject({ access: "granted", ok: false, reason: "read_failed" });
    }
    const rows = (k: number) => Array.from({ length: k }, (_, i) => ({ id: `s${i}`, appointment_id: appt(1).id }));
    expect(await load("owner", recording({ ...healthy(), sessions: ok(rows(999)) }).client)).toMatchObject({ ok: true });
    expect(await load("owner", recording({ ...healthy(), sessions: ok(rows(1000)) }).client)).toMatchObject({ ok: false, reason: "read_failed" });
  });
  it("settlements are read live-only (superseded_at IS NULL) and quoted_amount_cents is selected", async () => {
    const { client, calls } = recording(healthy());
    await load("owner", client);
    const s = calls.filter((c) => c.table === "appointment_settlements");
    expect(s.some((c) => c.method === "is" && c.args[0] === "superseded_at" && c.args[1] === null)).toBe(true);
    expect(s.some((c) => c.method === "select" && String(c.args[0]).includes("quoted_amount_cents"))).toBe(true);
  });
});

describe("source guard: read-only, no service role, no Stripe, no mail", () => {
  const src = readFileSync(path.join(ROOT, "lib/finance/client-statement-read.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("uses only the invoker client and issues no write", () => {
    expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(code).not.toMatch(/service[_-]?role|createAdminClient|createServiceClient|SUPABASE_SERVICE/i);
    expect(code).not.toMatch(/from\s+["'][^"']*(stripe|resend|nodemailer|sendgrid|twilio)/i);
    expect(code).not.toMatch(/new\s+Stripe|\bfetch\(/);
  });
  it("the owner gate is the first statement of the exported function", () => {
    const body = code.slice(code.indexOf("export async function loadClientStatementRead"));
    const afterSignature = body.slice(body.indexOf("{\n", body.indexOf("Promise<ClientStatementRead>")) + 2);
    expect(afterSignature.trimStart().startsWith('if (practitioner.role !== "owner") return { access: "refused" };')).toBe(true);
  });
  it("the assembler is pure: no server-only, supabase, stripe, mail, fetch, clock or env", () => {
    const a = readFileSync(path.join(ROOT, "lib/finance/statement-document-assemble.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of [/server-only/, /supabase/i, /stripe/i, /resend|nodemailer|sendgrid|twilio/i, /\bfetch\(/, /new Date\(\)/, /Date\.now/, /process\.env/]) expect(a).not.toMatch(bad);
  });
});
