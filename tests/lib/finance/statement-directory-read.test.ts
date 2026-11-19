import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

type Result = { data: unknown; error: unknown };
type Call = { table: string; method: string; args: unknown[] };
const ROOT = path.resolve(__dirname, "../../..");

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
const studio = { id: "22222222-2222-4222-8222-222222222222", timezone: "America/Toronto" };
const NOW = new Date("2026-11-19T18:00:00Z");
const appt = (i: number, clientId = "c1") => ({
  id: `a${i}`, client_id: clientId, starts_at: "2026-11-03T15:00:00+00:00", status: "completed", practitioner_id: null, service_id: null, duration_minutes: 30,
});
const healthy = (): Record<string, Result | Result[]> => ({
  appointments: ok([appt(1)]),
  sessions: ok([]), payment_charge_attempts: ok([]), appointment_settlements: ok([]), manual_fee_charge_attempts: ok([]), services: ok([]), practitioners: ok([]),
  clients: ok([{ id: "c1", name: "Ada Lovelace", preferred_name: null }]),
});
const loadDir = async (role: string, client: SupabaseClient, currency: string | null = "cad", month = "2026-11") => {
  const { loadStatementDirectory } = await import("@/lib/finance/statement-directory-read");
  return loadStatementDirectory({ role }, studio, currency, month, NOW, client);
};

describe("the Clients tab read: owner gate before any query", () => {
  it("every non-owner role is refused and NO query is made", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      const { client, calls } = recording(healthy());
      expect(await loadDir(role, client)).toEqual({ access: "refused" });
      expect(calls, role).toEqual([]);
    }
  });
  it("a missing currency or a malformed month is refused before any query", async () => {
    const a = recording(healthy());
    expect(await loadDir("owner", a.client, null)).toEqual({ access: "granted", ok: false, reason: "currency_unknown" });
    const b = recording(healthy());
    expect(await loadDir("owner", b.client, "cad", "2026-13")).toEqual({ access: "granted", ok: false, reason: "month_out_of_range" });
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });
});

describe("the Clients tab read: the studio's month, whole or nothing", () => {
  it("lists the client with a visit and no payment record, with name and counts", async () => {
    const r = await loadDir("owner", recording(healthy()).client);
    expect(r).toMatchObject({ access: "granted", ok: true, month: "2026-11", label: "November 2026" });
    if (r.access === "granted" && r.ok) {
      expect(r.directory.rows).toEqual([{ clientId: "c1", name: "Ada Lovelace", visitCount: 1, paidCents: 0, awaitingCount: 1, unconfirmedFeeCount: 0 }]);
      expect(r.directory.reconciliation.reconciled).toBe(true);
    }
  });
  it("reads the STUDIO's month as two local-midnight instants (a DST day is 25 hours long), scoped to the studio only", async () => {
    const { client, calls } = recording(healthy());
    await loadDir("owner", client);
    const a = calls.filter((c) => c.table === "appointments");
    expect(a.find((c) => c.method === "gte")?.args).toEqual(["starts_at", "2026-11-01T04:00:00.000Z"]);
    expect(a.find((c) => c.method === "lt")?.args).toEqual(["starts_at", "2026-12-01T05:00:00.000Z"]);
    expect(a.filter((c) => c.method === "eq").map((c) => c.args.join("="))).toEqual([`studio_id=${studio.id}`]);
    expect(a.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual(["starts_at", "id"]);
    const names = calls.filter((c) => c.table === "clients" && c.method === "eq").map((c) => c.args.join("="));
    expect(names).toEqual([`studio_id=${studio.id}`]);
  });
  it("more than one page of a busy month is read by keyset, then totals cover all of it", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => appt(i + 1, `c${i % 7}`));
    const page2 = [appt(501, "c1")];
    const { client, calls } = recording({ ...healthy(), appointments: [ok(page1), ok(page2)], clients: ok(Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, name: `Client ${i}`, preferred_name: null }))) });
    const r = await loadDir("owner", client);
    expect(r).toMatchObject({ ok: true });
    if (r.access === "granted" && r.ok) expect(r.directory.totals.visitCount).toBe(501);
    expect(calls.filter((c) => c.table === "appointments" && c.method === "or")).toHaveLength(1);
  });
  it("any error, a capped money table, a failed name read, or an over-long month fails the WHOLE read", async () => {
    for (const table of ["appointments", "sessions", "payment_charge_attempts", "appointment_settlements", "manual_fee_charge_attempts", "clients"]) {
      expect(await loadDir("owner", recording({ ...healthy(), [table]: { data: null, error: { message: "x" } } }).client), table).toMatchObject({ ok: false, reason: "read_failed" });
    }
    const capped = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, appointment_id: "a1" }));
    expect(await loadDir("owner", recording({ ...healthy(), sessions: ok(capped) }).client)).toMatchObject({ ok: false, reason: "read_failed" });
    const { MAX_PAGES } = await import("@/lib/finance/statement-money-read");
    const full = (k: number) => Array.from({ length: 500 }, (_, i) => ({ ...appt(k * 1000 + i + 1), id: `p${k}-${i}` }));
    const never = recording({ ...healthy(), appointments: Array.from({ length: MAX_PAGES + 1 }, (_, k) => ok(full(k))) });
    expect(await loadDir("owner", never.client)).toEqual({ access: "granted", ok: false, reason: "too_many_appointments" });
  });
  it("a visit with no client cannot be attributed: the read fails rather than guess", async () => {
    expect(await loadDir("owner", recording({ ...healthy(), appointments: ok([{ ...appt(1), client_id: null }]) }).client)).toMatchObject({ ok: false, reason: "read_failed" });
  });
});

describe("Find a client: the read", () => {
  const load = async (role: string, client: SupabaseClient) => {
    const { loadFinderClients } = await import("@/lib/finance/statement-directory-read");
    return loadFinderClients({ role }, studio, client);
  };
  const row = (id: string, name: string, archived = false) => ({ id, name, preferred_name: null, archived_at: archived ? "2026-01-01T00:00:00Z" : null });
  it("a non-owner is refused with no query", async () => {
    const { client, calls } = recording({ clients: ok([]) });
    expect(await load("practitioner", client)).toEqual({ access: "refused" });
    expect(calls).toEqual([]);
  });
  it("reads the active studio's clients (active and archived) in one traversal scoped by studio id; the four-field mapping only", async () => {
    const { client, calls } = recording({ clients: ok([row("c1", "Ada Lovelace"), row("c9", "Old Client", true)]) });
    const r = await load("owner", client);
    expect(r.access === "granted" && r.ok && r.clients.map((c) => [c.id, c.name, c.archived])).toEqual([["c1", "Ada Lovelace", false], ["c9", "Old Client", true]]);
    expect(calls.filter((c) => c.method === "eq").map((c) => c.args.join("="))).toEqual([`studio_id=${studio.id}`]);
    if (r.access === "granted" && r.ok) expect(Object.keys(r.clients[0]).sort()).toEqual(["archived", "id", "name", "preferredName"]);
  });
  it("the select is NARROW: id, name, preferred_name, archived_at, and never an email, phone, pronouns or any other column", async () => {
    const { client, calls } = recording({ clients: ok([row("c1", "Ada Lovelace")]) });
    await load("owner", client);
    const sel = calls.filter((c) => c.table === "clients" && c.method === "select").map((c) => String(c.args[0]));
    expect(sel).toEqual(["id, name, preferred_name, archived_at"]);
    for (const s of sel) expect(s).not.toMatch(/email|phone|pronoun|address|birth|\*/i);
  });
  it("FAILS CLOSED at the block cap: a studio larger than the cap is read_failed, never a shortened list", async () => {
    const blocks = Array.from({ length: 51 }, (_, k) => ok(Array.from({ length: 500 }, (_, i) => row(`b${String(k).padStart(3, "0")}-${String(i).padStart(4, "0")}`, `N ${k}-${i}`))));
    expect(await load("owner", recording({ clients: [...blocks, ok([])] }).client)).toEqual({ access: "granted", ok: false, reason: "read_failed" });
    const underCap = blocks.slice(0, 49);
    underCap.push(ok([row("zzz", "Tail")]));
    const r = await load("owner", recording({ clients: underCap }).client);
    expect(r.access === "granted" && r.ok && r.clients.length).toBe(24501); // 49 full blocks + a short last one is read whole
  });
  it("keyset-pages by id across blocks, and a repeated row or an error is read_failed, never a shorter list", async () => {
    const block = (k: number) => Array.from({ length: 500 }, (_, i) => row(`${String(k).padStart(2, "0")}-${String(i).padStart(4, "0")}`, `C ${k}-${i}`));
    const { client, calls } = recording({ clients: [ok(block(1)), ok([row("99-0000", "Last")])] });
    const r = await load("owner", client);
    expect(r.access === "granted" && r.ok && r.clients.length).toBe(501);
    expect(calls.filter((c) => c.method === "gt").map((c) => c.args[0])).toEqual(["id"]);
    expect(await load("owner", recording({ clients: ok([row("c1", "A"), row("c1", "A")]) }).client)).toEqual({ access: "granted", ok: false, reason: "read_failed" });
    expect(await load("owner", recording({ clients: { data: null, error: { message: "x" } } }).client)).toEqual({ access: "granted", ok: false, reason: "read_failed" });
  });
});

describe("source guard: read-only, no service role, no Stripe, no mail", () => {
  const strip = (f: string) => readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["lib/finance/statement-money-read.ts", "lib/finance/statement-directory-read.ts"]) {
    it(`${f}: invoker client only, no write verb`, () => {
      const code = strip(f);
      expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
      expect(code).not.toMatch(/service[_-]?role|createAdminClient|createServiceClient|SUPABASE_SERVICE/i);
      expect(code).not.toMatch(/from\s+["'][^"']*(stripe|resend|nodemailer|sendgrid|twilio)/i);
      expect(code).not.toMatch(/new\s+Stripe|\bfetch\(/);
    });
  }
  it("no client email or phone is selected anywhere in the statement reads", () => {
    for (const f of ["lib/finance/statement-directory-read.ts", "lib/finance/client-statement-read.ts", "lib/finance/statement-money-read.ts"]) {
      const selects = [...strip(f).matchAll(/\.select\(\s*([`"'])([^`"']*)\1/g)].map((m) => m[2]);
      for (const sel of selects) expect(sel, f).not.toMatch(/\b(email|phone|pronouns|address|date_of_birth)\b/);
    }
  });
  it("the owner gate is the first statement of both exported loaders", () => {
    const code = strip("lib/finance/statement-directory-read.ts");
    for (const fn of ["loadStatementDirectory", "loadFinderClients"]) {
      const body = code.slice(code.indexOf(`export async function ${fn}`));
      const open = body.indexOf("): Promise<");
      const afterSig = body.slice(body.indexOf("{\n", open) + 2);
      expect(afterSig.trimStart().startsWith('if (practitioner.role !== "owner") return { access: "refused" };'), fn).toBe(true);
    }
  });
});
