import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type UserQuery,
} from "./helpers/harness";
import {
  cleanupPaymentScenario,
  seedEligibleQuickCheckoutScenario,
  type PaymentScenario,
} from "./helpers/payment-seed";
import { COLLECTED_KINDS } from "@/lib/finance/statement";
import { loadStatementView } from "@/lib/finance/statement-read";
import { localDateString } from "@/lib/booking/tz";
import { yearMonthOf } from "@/lib/finance/statement-period";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// HON-64 Slice A: the DB/RLS proof the unit tests cannot give. The REAL read module (lib/finance/statement-read.ts) runs against the real
// migrated chain through a small client shim over a signed-in database connection, so every row it sees is filtered by RLS exactly as for
// a signed-in user. Synthetic data only. Every studio created here is removed afterwards.

type Result = { data: unknown[] | null; error: { message: string } | null };

/** A just-enough SupabaseClient over one signed-in connection: from/select/eq/in/is/gte/lt/order/limit, plus the `clients(...)` embed. */
function clientOver(q: UserQuery): SupabaseClient {
  const from = (table: string) => {
    let cols = "*";
    const where: string[] = [];
    const params: unknown[] = [];
    let order = "";
    let limit = "";
    const add = (col: string, op: string, value: unknown) => {
      params.push(value);
      where.push(op === "any" ? `t.${col} = any($${params.length})` : `t.${col} ${op} $${params.length}`);
    };
    const builder: Record<string, unknown> = {
      select(c: string) { cols = c; return builder; },
      eq(col: string, v: unknown) { add(col, "=", v); return builder; },
      in(col: string, v: unknown[]) { add(col, "any", v); return builder; },
      is(col: string, v: null) { if (v !== null) throw new Error("only IS NULL"); where.push(`t.${col} is null`); return builder; },
      gte(col: string, v: unknown) { add(col, ">=", v); return builder; },
      lt(col: string, v: unknown) { add(col, "<", v); return builder; },
      order(col: string) { order = ` order by t.${col}`; return builder; },
      limit(n: number) { limit = ` limit ${Number(n)}`; return builder; },
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        const parts = cols.match(/(?:[^,(]|\([^)]*\))+/g)!.map((s) => s.trim());
        const select = parts
          .map((p) => {
            const embed = p.match(/^clients\(([^)]*)\)$/);
            if (embed) {
              const inner = embed[1].split(",").map((s) => s.trim()).join(", ");
              return `(select to_jsonb(c) from (select ${inner} from public.clients c0 where c0.id = t.client_id) c) as clients`;
            }
            return `t.${p}`;
          })
          .join(", ");
        const sql = `select ${select} from public.${table} t${where.length ? ` where ${where.join(" and ")}` : ""}${order}${limit}`;
        return q(sql, params)
          .then((r) => ({ data: r.rows as unknown[], error: null }) as Result)
          .catch((e: Error) => ({ data: null, error: { message: e.message } }) as Result)
          .then(resolve, reject);
      },
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

const created: string[] = [];
let a: PaymentScenario; // studio A: owner, a live cash settlement that was then corrected
let aMember: { userId: string; practitionerId: string };
let b: PaymentScenario; // studio B: another studio's owner, with its own money
let month: ReturnType<typeof yearMonthOf>;
let tz: string;

beforeAll(async () => {
  a = await seedEligibleQuickCheckoutScenario({ label: "stmt-a" });
  b = await seedEligibleQuickCheckoutScenario({ label: "stmt-b" });
  created.push(a.studioId, b.studioId);
  aMember = await seedMember({ studioId: a.studioId, userId: a.practitionerUserId, practitionerId: a.practitionerId, clientId: a.clientId }, "stmt-member");

  for (const s of [a, b]) {
    const rec = await asUser(s.practitionerUserId, async (q) => {
      const r = await q(`select * from public.record_appointment_settlement($1,$2,$3,$4,$5,$6)`, [s.studioId, s.appointmentId, "paid_cash", 4500, null, true]);
      return r.rows[0] as { result: string; settlement_id: string };
    });
    expect(rec.result).toBe("recorded");
    if (s === a) {
      // Correct A's cash record to e-transfer 4000: the original becomes superseded, the replacement is the only live row.
      const fix = await asUser(s.practitionerUserId, async (q) => {
        const r = await q(`select * from public.supersede_appointment_settlement($1,$2,$3,$4,$5,$6,$7)`, [s.studioId, rec.settlement_id, "paid_e_transfer", 4000, "synthetic correction", null, true]);
        return r.rows[0] as { result: string };
      });
      expect(fix.result).toBe("corrected");
    }
  }
  const s = await adminQuery(`select a.starts_at, st.timezone from public.appointments a join public.studios st on st.id = a.studio_id where a.id = $1`, [a.appointmentId]);
  tz = (s.rows[0] as { timezone: string }).timezone;
  month = yearMonthOf(localDateString(new Date((s.rows[0] as { starts_at: string }).starts_at), tz));
});

afterAll(async () => {
  for (const id of created) await cleanupPaymentScenario(id).catch(() => undefined);
  await closePool();
});

const studioA = () => ({ id: a.studioId, timezone: tz });
const viewAs = (userId: string, studio: { id: string; timezone: string }, role: string) =>
  asUser(userId, (q) => loadStatementView({ role }, studio, month, "cad", clientOver(q)));

describe("owner reads the statement data under RLS", () => {
  it("the real read module returns the owner's own studio month, with the live settlement only", async () => {
    const view = await viewAs(a.practitionerUserId, studioA(), "owner");
    expect(view).toMatchObject({ access: "granted", ok: true });
    if (!("statement" in view)) throw new Error("expected a statement");
    const s = view.statement;
    expect(Object.keys(view.visitInfo)).toEqual([a.appointmentId]);
    expect(s.reconciliation.rowsClassified).toBe(1);
  });
});

describe("a superseded settlement is NOT counted in Collected", () => {
  it("the database holds two rows for the visit (original superseded, replacement live), and the statement counts only the replacement", async () => {
    const raw = await adminQuery(
      `select method, amount_cents, superseded_at is not null as superseded from public.appointment_settlements where studio_id = $1 order by recorded_at`,
      [a.studioId],
    );
    expect(raw.rows).toEqual([
      { method: "paid_cash", amount_cents: 4500, superseded: true },
      { method: "paid_e_transfer", amount_cents: 4000, superseded: false },
    ]);
    const view = await viewAs(a.practitionerUserId, studioA(), "owner");
    if (!("statement" in view)) throw new Error("expected a statement");
    const k = view.statement.all.kinds;
    expect(k.collected_cash).toEqual({ count: 0, cents: 0 });
    expect(k.collected_e_transfer).toEqual({ count: 1, cents: 4000 });
    expect(view.statement.all.collectedCents).toBe(4000);
    expect(COLLECTED_KINDS.reduce((n, kind) => n + k[kind].cents, 0)).toBe(4000);
  });
});

describe("a non-owner member is refused by RLS on the three money tables", () => {
  const tables = ["payment_charge_attempts", "manual_fee_charge_attempts", "appointment_settlements"] as const;

  it("the owner sees the settlement rows; the practitioner member of the same studio sees none, with no error", async () => {
    const owner = await asUser(a.practitionerUserId, (q) => q(`select count(*)::int n from public.appointment_settlements where studio_id = $1`, [a.studioId]));
    expect(owner.rows[0].n).toBe(2);
    for (const t of tables) {
      const member = await asUser(aMember.userId, (q) => q(`select count(*)::int n from public.${t} where studio_id = $1`, [a.studioId]));
      expect(member.rows[0].n, t).toBe(0);
    }
  });

  it("each table's read policy is the owner check, not a membership check", async () => {
    const pol = await adminQuery(
      `select tablename, cmd, qual from pg_policies where schemaname = 'public' and tablename = any($1) and cmd in ('SELECT','ALL')`,
      [[...tables]],
    );
    for (const t of tables) {
      const rows = pol.rows.filter((r: { tablename: string }) => r.tablename === t) as { qual: string }[];
      expect(rows.length, t).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.qual, t).toMatch(/is_studio_owner/);
        expect(r.qual, t).not.toMatch(/is_studio_member/);
      }
    }
  });

  it("a member's client run through the real read module shows visits but NO money (the gate, not RLS, is what refuses it in the app)", async () => {
    const view = await viewAs(aMember.userId, studioA(), "owner");
    if (!("statement" in view)) throw new Error("expected a statement");
    expect(view.statement.all.collectedCents).toBe(0);
    expect(view.statement.reconciliation.rowsClassified).toBe(0);
    // And the app's own gate refuses the role before any query exists.
    expect(await loadStatementView({ role: "practitioner" }, studioA(), month, "cad", clientOver(() => { throw new Error("no query may run"); }))).toEqual({ access: "refused" });
  });

  it("a receptionist role does not exist in this schema yet, so only the practitioner member is probed here", async () => {
    const roles = await adminQuery(
      `select pg_get_constraintdef(c.oid) def from pg_constraint c where c.conrelid = 'public.practitioners'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ilike '%role%'`,
    );
    expect(JSON.stringify(roles.rows)).not.toMatch(/receptionist/);
  });
});

describe("another studio's rows are never read", () => {
  it("studio A's owner pointed at studio B gets nothing, and A's view never contains B's visit", async () => {
    const wrong = await viewAs(a.practitionerUserId, { id: b.studioId, timezone: tz }, "owner");
    if (!("statement" in wrong)) throw new Error("expected a statement");
    expect(wrong.statement.all.collectedCents).toBe(0);
    expect(Object.keys(wrong.visitInfo)).toEqual([]);

    const own = await viewAs(a.practitionerUserId, studioA(), "owner");
    if (!("statement" in own)) throw new Error("expected a statement");
    expect(Object.keys(own.visitInfo)).not.toContain(b.appointmentId);
  });

  it("studio B's owner reads exactly B's own cash record, and none of A's", async () => {
    const view = await viewAs(b.practitionerUserId, { id: b.studioId, timezone: tz }, "owner");
    if (!("statement" in view)) throw new Error("expected a statement");
    expect(view.statement.all.kinds.collected_cash).toEqual({ count: 1, cents: 4500 });
    expect(view.statement.all.kinds.collected_e_transfer.count).toBe(0);
    expect(Object.keys(view.visitInfo)).toEqual([b.appointmentId]);
  });

  it("a studio created with no relation to either sees no rows from the three tables", async () => {
    const c = await seedStudio("stmt-c");
    created.push(c.studioId);
    for (const t of ["payment_charge_attempts", "manual_fee_charge_attempts", "appointment_settlements"]) {
      const r = await asUser(c.userId, (q) => q(`select count(*)::int n from public.${t}`));
      expect(r.rows[0].n, t).toBe(0);
    }
  });
});
