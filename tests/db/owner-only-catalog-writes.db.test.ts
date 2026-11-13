import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, closePool, seedMember, seedStudio, type SeededStudio, type UserQuery } from "./helpers/harness";

// 0339 (HON-44 gaps H1, H2): INSERT and UPDATE on public.services and public.consent_form_templates are owner-only
// in the database, for a caller that reaches PostgREST directly with their own session (role authenticated + their
// JWT claims, the repository's stand-in for a user's own client). Role AND tenant probes on the real migrated chain.
// Synthetic data only; every probe runs in a transaction that is rolled back.

type Spec = {
  table: "services" | "consent_form_templates";
  policies: string[]; // every policy on the table after 0339, ordered by name
  seed: string; // ($1 id, $2 studio_id)
  insert: string; // ($1 studio_id)
  update: string; // ($1 id)
  cols: string;
  unchanged: Record<string, unknown>;
  changed: Record<string, unknown>;
};
const SPECS: Spec[] = [
  {
    table: "services",
    policies: ["services_member_select (SELECT)", "services_owner_insert (INSERT)", "services_owner_update (UPDATE)"],
    seed: `insert into public.services (id, studio_id, name, default_duration_minutes, price_cents, active) values ($1, $2, 'Seeded service', 60, 9000, true)`,
    insert: `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active) values ($1, 'Probe service', 30, 5000, true)`,
    update: `update public.services set price_cents = 1, default_duration_minutes = 5, active = false, pre_care_instructions = 'probe' where id = $1`,
    cols: "price_cents, default_duration_minutes, active, pre_care_instructions",
    unchanged: { price_cents: 9000, default_duration_minutes: 60, active: true, pre_care_instructions: null },
    changed: { price_cents: 1, default_duration_minutes: 5, active: false, pre_care_instructions: "probe" },
  },
  {
    table: "consent_form_templates",
    policies: [
      "consent_form_templates_studio_member_select (SELECT)",
      "consent_form_templates_studio_owner_insert (INSERT)",
      "consent_form_templates_studio_owner_update (UPDATE)",
    ],
    seed: `insert into public.consent_form_templates (id, studio_id, title, body, status, is_live) values ($1, $2, 'Seeded consent', 'Seeded wording', 'active', false)`,
    insert: `insert into public.consent_form_templates (studio_id, title, body, status, is_live) values ($1, 'Probe consent', 'Probe wording', 'draft', false)`,
    // wording AND set-live in one statement: both are what the settings page lets an owner do
    update: `update public.consent_form_templates set title = 'Changed', body = 'Changed wording', is_live = true where id = $1`,
    cols: "title, body, is_live",
    unchanged: { title: "Seeded consent", body: "Seeded wording", is_live: false },
    changed: { title: "Changed", body: "Changed wording", is_live: true },
  },
];

let studio: SeededStudio; // owner of studio A
let member: { userId: string; practitionerId: string }; // active non-owner practitioner of A
let other: SeededStudio; // owner of studio B
let otherMember: { userId: string; practitionerId: string }; // non-owner practitioner of B
let receptionist: string; // front-desk user of A (studio_receptionists, never practitioners)
let serviceId: string;
const rowId = new Map<string, string>();

beforeAll(async () => {
  studio = await seedStudio("cat-own-a");
  member = await seedMember(studio, "cat-own-m");
  other = await seedStudio("cat-own-b");
  otherMember = await seedMember(other, "cat-own-bm");
  receptionist = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [receptionist, `cat-own-desk-${receptionist.slice(0, 8)}@harness.local`]);
  await adminQuery(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Synthetic Front Desk', true)`, [studio.studioId, receptionist]);
  for (const s of SPECS) {
    const id = randomUUID();
    await adminQuery(s.seed, [id, studio.studioId]);
    rowId.set(s.table, id);
  }
  serviceId = rowId.get("services")!;
});
afterAll(async () => {
  await closePool();
});

const ROLLBACK = new Error("rollback");
type Claims = { sub?: string; role: "authenticated" | "anon" };
type As = <R>(claims: Claims, run: (q: UserQuery) => Promise<R>) => Promise<R>;
async function sandbox<T>(fn: (as: As, q: UserQuery) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await adminTx(async (q) => {
      const as: As = async (claims, run) => {
        await q(`set local role ${claims.role}`);
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        try {
          return await run(q);
        } finally {
          await q("reset role");
        }
      };
      out = await fn(as, q);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return out;
}
const user = (sub: string): Claims => ({ sub, role: "authenticated" });

/** Runs one statement in a savepoint: the rows it affected, or the SQLSTATE it raised. */
async function attempt(q: UserQuery, sql: string, params: unknown[]): Promise<number | string> {
  await q("savepoint probe");
  try {
    const r = await q(sql, params);
    await q("release savepoint probe");
    return r.rowCount ?? 0;
  } catch (error) {
    await q("rollback to savepoint probe");
    return (error as { code?: string }).code ?? "no-code";
  }
}
const RLS = "42501";
const NOTHING_WRITTEN = [0, RLS]; // 0 rows (no visible row) or refused outright; both store nothing

describe("0339: the catalog state the migration leaves", () => {
  it.each(SPECS)("$table has the member read and exactly two write policies, both owner-only", async (s) => {
    const r = await adminQuery(
      `select policyname, cmd, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr from pg_policies where schemaname = 'public' and tablename = $1 order by policyname`,
      [s.table],
    );
    expect(r.rows.map((p) => `${p.policyname} (${p.cmd})`)).toEqual(s.policies);
    for (const p of r.rows.filter((x) => x.cmd !== "SELECT")) {
      expect(p.expr).toMatch(/is_studio_owner/);
      expect(p.expr).not.toMatch(/is_studio_member/);
    }
  });
});

describe.each(SPECS)("0339: who can write $table through the Data API", (s) => {
  const id = () => rowId.get(s.table)!;
  const stored = (q: UserQuery) => q(`select ${s.cols} from public.${s.table} where id = $1`, [id()]).then((r) => r.rows[0]);
  const countA = (q: UserQuery) => q(`select count(*)::int n from public.${s.table} where studio_id = $1`, [studio.studioId]).then((r) => r.rows[0].n as number);
  const del = `delete from public.${s.table} where id = $1`;

  it("positive control: the owner inserts a row and updates one", async () => {
    await sandbox(async (as, q) => {
      expect(await as(user(studio.userId), (uq) => attempt(uq, s.insert, [studio.studioId]))).toBe(1);
      expect(await as(user(studio.userId), (uq) => attempt(uq, s.update, [id()]))).toBe(1);
      expect(await stored(q)).toEqual(s.changed);
      expect(await countA(q)).toBe(2);
    });
  });

  it("an active non-owner practitioner of the same studio still READS the rows but cannot insert (42501) or update (0 rows)", async () => {
    await sandbox(async (as, q) => {
      expect(await as(user(member.userId), countA)).toBe(1); // the existing permitted read is unchanged
      expect(await as(user(member.userId), stored)).toEqual(s.unchanged);
      expect(await as(user(member.userId), (uq) => attempt(uq, s.insert, [studio.studioId]))).toBe(RLS);
      expect(await as(user(member.userId), (uq) => attempt(uq, s.update, [id()]))).toBe(0);
      expect(await stored(q)).toEqual(s.unchanged);
      expect(await countA(q)).toBe(1);
    });
  });

  it("another studio's owner and practitioner can neither read nor write it, nor move a row of their own into it", async () => {
    await sandbox(async (as, q) => {
      for (const u of [other.userId, otherMember.userId]) {
        expect(await as(user(u), countA)).toBe(0);
        expect(await as(user(u), (uq) => attempt(uq, s.insert, [studio.studioId]))).toBe(RLS);
        expect(await as(user(u), (uq) => attempt(uq, s.update, [id()]))).toBe(0);
      }
      // Re-tenant probe: B's owner owns a row in B and tries to point it at A. USING passes (they own the existing
      // row); WITH CHECK must refuse the resulting row.
      const own = randomUUID();
      await q(s.seed, [own, other.studioId]);
      expect(await as(user(other.userId), (uq) => attempt(uq, `update public.${s.table} set studio_id = $2 where id = $1`, [own, studio.studioId]))).toBeTypeOf("string"); // refused (an error), never 0 or 1 rows
      expect(await stored(q)).toEqual(s.unchanged);
      expect(await countA(q)).toBe(1);
    });
  });

  it("the studio's receptionist, a signed-in user with no studio, and an anonymous caller write nothing", async () => {
    await sandbox(async (as, q) => {
      const stranger = randomUUID();
      await q(`insert into auth.users (id, email) values ($1, $2)`, [stranger, `cat-own-stranger-${stranger.slice(0, 8)}@harness.local`]);
      for (const claims of [user(receptionist), user(stranger), { role: "anon" } as Claims]) {
        expect(await as(claims, (uq) => attempt(uq, s.insert, [studio.studioId])), JSON.stringify(claims)).toBe(RLS);
        expect(NOTHING_WRITTEN, JSON.stringify(claims)).toContain(await as(claims, (uq) => attempt(uq, s.update, [id()])));
      }
      expect(await stored(q)).toEqual(s.unchanged);
      expect(await countA(q)).toBe(1);
    });
  });

  it("an owner who is deactivated loses the write (is_studio_owner needs active = true)", async () => {
    await sandbox(async (as, q) => {
      await q(`update public.practitioners set active = false where id = $1`, [studio.practitionerId]);
      expect(await as(user(studio.userId), (uq) => attempt(uq, s.insert, [studio.studioId]))).toBe(RLS);
      expect(await as(user(studio.userId), (uq) => attempt(uq, s.update, [id()]))).toBe(0);
      expect(await stored(q)).toEqual(s.unchanged);
    });
  });

  it("DELETE remains denied for everyone, the owner included (no DELETE policy; 0339 adds none)", async () => {
    await sandbox(async (as, q) => {
      for (const claims of [user(studio.userId), user(member.userId), user(other.userId), user(receptionist), { role: "anon" } as Claims]) {
        expect(NOTHING_WRITTEN, JSON.stringify(claims)).toContain(await as(claims, (uq) => attempt(uq, del, [id()])));
      }
      expect(await countA(q)).toBe(1);
    });
  });
});

describe("0339: the owner-only commands that sit beside the services policies are unchanged", () => {
  it("reorder_studio_service and show_studio_service still refuse a non-owner practitioner", async () => {
    await sandbox(async (as) => {
      const reorder = await as(user(member.userId), (uq) => attempt(uq, `select public.reorder_studio_service($1, $2, 'down', null)`, [studio.studioId, serviceId]));
      const show = await as(user(member.userId), (uq) => attempt(uq, `select public.show_studio_service($1, $2)`, [studio.studioId, serviceId]));
      expect(typeof reorder).toBe("string");
      expect(typeof show).toBe("string");
    });
  });
});
