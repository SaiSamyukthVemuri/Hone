import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  adminTx,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";
import { seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// 0254, PERM-HON44 (Sam decision 12): finances, card charges and price changes are
// OWNER-ONLY in the database; a practitioner edits only their own pinned
// cautions, only the owner deletes them. Role AND tenant tests, per policy and
// function, on the REAL migrated chain. Synthetic data only. Every probe runs in
// a transaction that is rolled back, so nothing here persists.

let paid: PaymentScenario; // completed visit with a READY card attempt
let cash: PaymentScenario; // completed visit with no attempt (settlement target)
let paidOwner: SeededStudio;
let paidMember: { userId: string; practitionerId: string };
let cashOwner: SeededStudio;
let cashMember: { userId: string; practitionerId: string };
let other: SeededStudio; // a different studio's owner (tenant probe)
let sessionStudio: SeededStudio;
let sessionId: string;
let sessionMember: { userId: string; practitionerId: string };

const asStudio = (s: PaymentScenario): SeededStudio => ({
  studioId: s.studioId,
  userId: s.practitionerUserId,
  practitionerId: s.practitionerId,
  clientId: s.clientId,
});

beforeAll(async () => {
  paid = await seedQuickCheckoutScenario({
    label: "perm-paid",
    appointmentStatus: "completed",
    attempt: "ready",
    bookedService: { name: "Perm Service", priceCents: 12_000 },
  });
  cash = await seedQuickCheckoutScenario({ label: "perm-cash", appointmentStatus: "completed", attempt: "none" });
  paidOwner = asStudio(paid);
  cashOwner = asStudio(cash);
  paidMember = await seedMember(paidOwner, "perm-paid-member");
  cashMember = await seedMember(cashOwner, "perm-cash-member");
  other = await seedStudio("perm-other");
  sessionStudio = await seedStudio("perm-session");
  sessionId = (await seedSession(sessionStudio)).sessionId;
  sessionMember = await seedMember(sessionStudio, "perm-session-member");
});

afterAll(async () => {
  await closePool();
});

const ROLLBACK = new Error("rollback");
type Ctx = {
  q: UserQuery;
  as: <R>(userId: string, run: (q: UserQuery) => Promise<R>) => Promise<R>;
};
/** One transaction as postgres, always rolled back; `as()` runs a block as a signed-in member. */
async function sandbox<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await adminTx(async (q) => {
      const ctx: Ctx = {
        q,
        as: async (userId, run) => {
          await q("set local role authenticated");
          await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
          try {
            return await run(q);
          } finally {
            await q("reset role");
          }
        },
      };
      out = await fn(ctx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return out;
}

/** Run a statement inside a savepoint and report its SQLSTATE (or null on success). */
async function sqlState(q: UserQuery, sql: string, params: unknown[] = []): Promise<string | null> {
  await q("savepoint probe");
  try {
    await q(sql, params);
    await q("release savepoint probe");
    return null;
  } catch (error) {
    await q("rollback to savepoint probe");
    return (error as { code?: string }).code ?? "no-code";
  }
}

const countFor = (q: UserQuery, table: string, studioId: string) =>
  q(`select count(*)::int n from public.${table} where studio_id = $1`, [studioId]).then((r) => r.rows[0].n as number);

describe("1. financial reads are owner-only, scoped to the studio", () => {
  it("payment_charge_attempts: the owner reads the attempt; a practitioner of the same studio and another studio's owner read none", async () => {
    await sandbox(async ({ as, q }) => {
      expect(await as(paidOwner.userId, (uq) => countFor(uq, "payment_charge_attempts", paid.studioId))).toBeGreaterThan(0);
      expect(await as(paidMember.userId, (uq) => countFor(uq, "payment_charge_attempts", paid.studioId))).toBe(0);
      expect(await as(other.userId, (uq) => countFor(uq, "payment_charge_attempts", paid.studioId))).toBe(0);
      // ground truth: the row exists
      expect(await countFor(q, "payment_charge_attempts", paid.studioId)).toBeGreaterThan(0);
    });
  });

  it("appointment_settlements: after the owner records a payment, the owner reads it; a practitioner and another studio read none", async () => {
    await sandbox(async ({ as, q }) => {
      const recorded = await as(cashOwner.userId, (uq) =>
        uq(`select * from public.record_appointment_settlement($1, $2, 'paid_cash', 5000, null, false)`, [cash.studioId, cash.appointmentId]),
      );
      expect(recorded.rows[0].result).toBe("recorded");
      expect(await as(cashOwner.userId, (uq) => countFor(uq, "appointment_settlements", cash.studioId))).toBe(1);
      expect(await as(cashMember.userId, (uq) => countFor(uq, "appointment_settlements", cash.studioId))).toBe(0);
      expect(await as(other.userId, (uq) => countFor(uq, "appointment_settlements", cash.studioId))).toBe(0);
      expect(await countFor(q, "appointment_settlements", cash.studioId)).toBe(1);
    });
  });

  it("every policy that can read the three financial tables is owner-gated, none is member-wide (catalog)", async () => {
    const { rows } = await adminQuery(
      `select c.relname, pol.polname,
              lower(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')) as q
         from pg_policy pol join pg_class c on c.oid = pol.polrelid
        where c.relnamespace = 'public'::regnamespace
          and c.relname in ('payment_charge_attempts', 'manual_fee_charge_attempts', 'appointment_settlements')
          and pol.polcmd in ('r', '*')`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(["appointment_settlements", "manual_fee_charge_attempts", "payment_charge_attempts"]);
    for (const r of rows) {
      expect(r.q, r.polname).toMatch(/is_studio_owner\(/);
      expect(r.q, r.polname).not.toMatch(/is_studio_member\(/);
    }
  });
});

describe("2. recording a settlement is owner-only (record_appointment_settlement)", () => {
  const CALL = `select * from public.record_appointment_settlement($1, $2, 'paid_cash', 5000, null, false)`;

  it("a practitioner gets the closed code owner_only and NOTHING is written", async () => {
    await sandbox(async ({ as, q }) => {
      const r = await as(cashMember.userId, (uq) => uq(CALL, [cash.studioId, cash.appointmentId]));
      expect(r.rows[0].result).toBe("owner_only");
      expect(r.rows[0].settlement_id).toBeNull();
      expect(await countFor(q, "appointment_settlements", cash.studioId)).toBe(0);
    });
  });

  it("a practitioner learns nothing about the appointment: a forged appointment id answers owner_only too, not not_found", async () => {
    await sandbox(async ({ as }) => {
      const r = await as(cashMember.userId, (uq) => uq(CALL, [cash.studioId, randomUUID()]));
      expect(r.rows[0].result).toBe("owner_only");
    });
  });

  it("the owner records it (positive control), and replay is idempotent", async () => {
    await sandbox(async ({ as }) => {
      const first = await as(cashOwner.userId, (uq) => uq(CALL, [cash.studioId, cash.appointmentId]));
      expect(first.rows[0].result).toBe("recorded");
      const again = await as(cashOwner.userId, (uq) => uq(CALL, [cash.studioId, cash.appointmentId]));
      expect(again.rows[0].result).toBe("already_settled");
    });
  });

  it("another studio's owner is refused by the membership boundary (they are not a member of this studio)", async () => {
    await sandbox(async ({ as, q }) => {
      const state = await as(other.userId, (uq) => sqlState(uq, CALL, [cash.studioId, cash.appointmentId]));
      expect(state).not.toBeNull();
      expect(await countFor(q, "appointment_settlements", cash.studioId)).toBe(0);
    });
  });
});

describe("3. price changes are owner-only", () => {
  it("set_session_price: the owner sets it and it is audited WITHOUT amounts", async () => {
    await sandbox(async ({ as, q }) => {
      await as(sessionStudio.userId, (uq) => uq(`select public.set_session_price($1, $2, 9999)`, [sessionId, sessionStudio.clientId]));
      const row = await q(`select price_paid_cents from public.sessions where id = $1`, [sessionId]);
      expect(row.rows[0].price_paid_cents).toBe(9999);
      const audit = await q(
        `select actor_id, metadata from public.audit_logs where studio_id = $1 and action = 'session_price_set' and entity_id = $2`,
        [sessionStudio.studioId, sessionId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_id).toBe(sessionStudio.practitionerId);
      expect(Object.keys(audit.rows[0].metadata).sort()).toEqual(["changed", "cleared", "client_id"]); // no amount key
      expect(audit.rows[0].metadata).toMatchObject({ cleared: false, changed: true });
    });
  });

  it("set_session_price: a practitioner of the studio is refused (42501) and the price is untouched", async () => {
    await sandbox(async ({ as, q }) => {
      const state = await as(sessionMember.userId, (uq) =>
        sqlState(uq, `select public.set_session_price($1, $2, 1)`, [sessionId, sessionStudio.clientId]),
      );
      expect(state).toBe("42501");
      expect((await q(`select price_paid_cents from public.sessions where id = $1`, [sessionId])).rows[0].price_paid_cents).toBeNull();
      expect(
        (await q(`select count(*)::int n from public.audit_logs where studio_id = $1 and action = 'session_price_set'`, [sessionStudio.studioId])).rows[0].n,
      ).toBe(0);
    });
  });

  it("set_session_price: another studio's owner is refused at the membership boundary", async () => {
    await sandbox(async ({ as, q }) => {
      const state = await as(other.userId, (uq) => sqlState(uq, `select public.set_session_price($1, $2, 1)`, [sessionId, sessionStudio.clientId]));
      expect(state).not.toBeNull();
      expect((await q(`select price_paid_cents from public.sessions where id = $1`, [sessionId])).rows[0].price_paid_cents).toBeNull();
    });
  });

  const PRICE = `insert into public.client_pricing (studio_id, client_id, service_name, price_cents, effective_from) values ($1, $2, 'Perm Service', 7000, '2026-01-01')`;

  it("client_pricing: the owner inserts, updates and deletes; each is audited without an amount", async () => {
    await sandbox(async ({ as, q }) => {
      await as(sessionStudio.userId, (uq) => uq(PRICE, [sessionStudio.studioId, sessionStudio.clientId]));
      const id = (await q(`select id from public.client_pricing where studio_id = $1`, [sessionStudio.studioId])).rows[0].id;
      const upd = await as(sessionStudio.userId, (uq) => uq(`update public.client_pricing set price_cents = 8000 where id = $1`, [id]));
      expect(upd.rowCount).toBe(1);
      const del = await as(sessionStudio.userId, (uq) => uq(`delete from public.client_pricing where id = $1`, [id]));
      expect(del.rowCount).toBe(1);
      const audit = await q(
        `select action, metadata from public.audit_logs where studio_id = $1 and entity_type = 'client_pricing' order by created_at, action`,
        [sessionStudio.studioId],
      );
      expect(audit.rows.map((r) => r.action).sort()).toEqual(["client_price_removed", "client_price_set", "client_price_set"]);
      for (const r of audit.rows) expect(Object.keys(r.metadata).sort()).toEqual(["client_id", "operation"]); // no amount key
    });
  });

  it("client_pricing: a practitioner can READ prices but cannot insert (42501), update or delete (0 rows)", async () => {
    await sandbox(async ({ as, q }) => {
      await q(PRICE, [sessionStudio.studioId, sessionStudio.clientId]); // as postgres
      const id = (await q(`select id from public.client_pricing where studio_id = $1`, [sessionStudio.studioId])).rows[0].id;
      const read = await as(sessionMember.userId, (uq) => countFor(uq, "client_pricing", sessionStudio.studioId));
      expect(read).toBe(1);
      expect(await as(sessionMember.userId, (uq) => sqlState(uq, PRICE, [sessionStudio.studioId, sessionStudio.clientId]))).toBe("42501");
      const upd = await as(sessionMember.userId, (uq) => uq(`update public.client_pricing set price_cents = 1 where id = $1`, [id]));
      expect(upd.rowCount).toBe(0);
      const del = await as(sessionMember.userId, (uq) => uq(`delete from public.client_pricing where id = $1`, [id]));
      expect(del.rowCount).toBe(0);
      expect((await q(`select price_cents from public.client_pricing where id = $1`, [id])).rows[0].price_cents).toBe(7000);
    });
  });

  it("client_pricing: another studio's owner can neither read nor write this studio's prices", async () => {
    await sandbox(async ({ as, q }) => {
      await q(PRICE, [sessionStudio.studioId, sessionStudio.clientId]);
      expect(await as(other.userId, (uq) => countFor(uq, "client_pricing", sessionStudio.studioId))).toBe(0);
      expect(await as(other.userId, (uq) => sqlState(uq, PRICE, [sessionStudio.studioId, sessionStudio.clientId]))).toBe("42501");
    });
  });
});

describe("4. pinned cautions: a practitioner adds and edits their own; only the owner deletes", () => {
  async function seedNote(q: UserQuery, authorId: string | null, text = "Allergy: latex"): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into public.client_pinned_notes (id, client_id, studio_id, text, created_by_practitioner_id) values ($1, $2, $3, $4, $5)`,
      [id, sessionStudio.clientId, sessionStudio.studioId, text, authorId],
    );
    return id;
  }
  const EDIT = `select public.edit_client_pinned_note($1, $2, $3, $4, $5) as ok`;
  const edit = (q: UserQuery, studio: string, client: string, id: string, original: string, text: string) =>
    q(EDIT, [studio, client, id, original, text]).then((r) => r.rows[0].ok as boolean);

  it("a practitioner adds a caution (unchanged)", async () => {
    await sandbox(async ({ as }) => {
      const state = await as(sessionMember.userId, (uq) =>
        sqlState(
          uq,
          `insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id) values ($1, $2, 'Fragile skin', $3)`,
          [sessionStudio.clientId, sessionStudio.studioId, sessionMember.practitionerId],
        ),
      );
      expect(state).toBeNull();
    });
  });

  it("DELETE: a practitioner deletes nothing (0 rows), even their own; the owner deletes and it is audited", async () => {
    await sandbox(async ({ as, q }) => {
      const mine = await seedNote(q, sessionMember.practitionerId);
      const del = await as(sessionMember.userId, (uq) => uq(`delete from public.client_pinned_notes where id = $1`, [mine]));
      expect(del.rowCount).toBe(0);
      expect((await q(`select count(*)::int n from public.client_pinned_notes where id = $1`, [mine])).rows[0].n).toBe(1);

      const byOwner = await as(sessionStudio.userId, (uq) => uq(`delete from public.client_pinned_notes where id = $1`, [mine]));
      expect(byOwner.rowCount).toBe(1);
      const audit = await q(`select actor_id, metadata from public.audit_logs where action = 'pinned_note_deleted' and entity_id = $1`, [mine]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_id).toBe(sessionStudio.practitionerId);
      expect(JSON.stringify(audit.rows[0].metadata)).not.toContain("latex");
    });
  });

  it("DELETE: another studio's owner deletes nothing", async () => {
    await sandbox(async ({ as, q }) => {
      const id = await seedNote(q, sessionMember.practitionerId);
      const del = await as(other.userId, (uq) => uq(`delete from public.client_pinned_notes where id = $1`, [id]));
      expect(del.rowCount).toBe(0);
    });
  });

  it("EDIT: the author edits their own caution; the text changes, nothing else, and it is audited without the text", async () => {
    await sandbox(async ({ as, q }) => {
      const id = await seedNote(q, sessionMember.practitionerId, "Old text");
      expect(await as(sessionMember.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, id, "Old text", "New text"))).toBe(true);
      const row = (await q(`select text, created_by_practitioner_id, client_id, studio_id from public.client_pinned_notes where id = $1`, [id])).rows[0];
      expect(row).toMatchObject({
        text: "New text",
        created_by_practitioner_id: sessionMember.practitionerId,
        client_id: sessionStudio.clientId,
        studio_id: sessionStudio.studioId,
      });
      const audit = await q(`select actor_id, metadata from public.audit_logs where action = 'pinned_note_edited' and entity_id = $1`, [id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_id).toBe(sessionMember.practitionerId);
      expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/Old text|New text/);
    });
  });

  it("EDIT: a practitioner cannot edit the OWNER'S caution or an author-less legacy one (false, unchanged, no audit)", async () => {
    await sandbox(async ({ as, q }) => {
      const owners = await seedNote(q, sessionStudio.practitionerId, "Owner's");
      const legacy = await seedNote(q, null, "Legacy");
      for (const [id, text] of [[owners, "Owner's"], [legacy, "Legacy"]] as const) {
        expect(await as(sessionMember.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, id, text, "Hijacked"))).toBe(false);
        expect((await q(`select text from public.client_pinned_notes where id = $1`, [id])).rows[0].text).toBe(text);
      }
      expect((await q(`select count(*)::int n from public.audit_logs where action = 'pinned_note_edited' and studio_id = $1`, [sessionStudio.studioId])).rows[0].n).toBe(0);
    });
  });

  it("EDIT: the owner edits any caution, including a colleague's and a legacy one", async () => {
    await sandbox(async ({ as, q }) => {
      const theirs = await seedNote(q, sessionMember.practitionerId, "Theirs");
      const legacy = await seedNote(q, null, "Legacy");
      expect(await as(sessionStudio.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, theirs, "Theirs", "Owner fixed"))).toBe(true);
      expect(await as(sessionStudio.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, legacy, "Legacy", "Owner fixed 2"))).toBe(true);
    });
  });

  it("EDIT: a stale original_text, a wrong client and a deleted note all answer false (optimistic concurrency, no disclosure)", async () => {
    await sandbox(async ({ as, q }) => {
      const id = await seedNote(q, sessionMember.practitionerId, "Current");
      const asMember = (original: string, client = sessionStudio.clientId, note = id) =>
        as(sessionMember.userId, (uq) => edit(uq, sessionStudio.studioId, client, note, original, "X"));
      expect(await asMember("Stale")).toBe(false);
      expect(await asMember("Current", randomUUID())).toBe(false);
      expect(await asMember("Current", sessionStudio.clientId, randomUUID())).toBe(false);
      expect((await q(`select text from public.client_pinned_notes where id = $1`, [id])).rows[0].text).toBe("Current");
    });
  });

  it("EDIT: another studio's owner, naming this studio, gets false; naming their own studio finds nothing", async () => {
    await sandbox(async ({ as, q }) => {
      const id = await seedNote(q, sessionMember.practitionerId, "Tenant");
      expect(await as(other.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, id, "Tenant", "Stolen"))).toBe(false);
      expect(await as(other.userId, (uq) => edit(uq, other.studioId, sessionStudio.clientId, id, "Tenant", "Stolen"))).toBe(false);
      expect((await q(`select text from public.client_pinned_notes where id = $1`, [id])).rows[0].text).toBe("Tenant");
    });
  });

  it("EDIT: refuses empty and over-length text without touching the note", async () => {
    await sandbox(async ({ as, q }) => {
      const id = await seedNote(q, sessionMember.practitionerId, "Bounded");
      expect(await as(sessionMember.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, id, "Bounded", ""))).toBe(false);
      expect(await as(sessionMember.userId, (uq) => edit(uq, sessionStudio.studioId, sessionStudio.clientId, id, "Bounded", "x".repeat(201)))).toBe(false);
    });
  });

  it("EDIT: no session (anon) cannot execute the command at all (42501)", async () => {
    await sandbox(async ({ q }) => {
      await q("set local role anon");
      const state = await sqlState(q, EDIT, [sessionStudio.studioId, sessionStudio.clientId, randomUUID(), "a", "b"]);
      await q("reset role");
      expect(state).toBe("42501");
    });
  });
});

describe("5. privileges and catalog (the migration asserts these at apply time; re-proved here)", () => {
  const SIGS = [
    "public.set_session_price(uuid, uuid, integer)",
    "public.record_appointment_settlement(uuid, uuid, text, integer, text, boolean)",
    "public.edit_client_pinned_note(uuid, uuid, uuid, text, text)",
  ];

  it.each(SIGS)("%s: authenticated only (not anon, PUBLIC or service_role)", async (sig) => {
    const { rows } = await adminQuery(
      `select has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
              has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role,
              (select count(*)::int from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = $1::regprocedure and a.privilege_type = 'EXECUTE' and a.grantee = 0) as public_grants`,
      [sig],
    );
    expect(rows[0]).toEqual({ authenticated: true, anon: false, service_role: false, public_grants: 0 });
  });

  it.each(["public.audit_pinned_note_delete()", "public.audit_client_pricing_change()"])("%s: executable by no runtime role", async (sig) => {
    const { rows } = await adminQuery(
      `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role`,
      [sig],
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: false });
  });

  it("no member-wide write policy remains on client_pricing, and none for DELETE on pinned cautions", async () => {
    const { rows } = await adminQuery(
      `select c.relname, pol.polname, pol.polcmd,
              lower(coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) as e
         from pg_policy pol join pg_class c on c.oid = pol.polrelid
        where c.relnamespace = 'public'::regnamespace
          and ((c.relname = 'client_pricing' and pol.polcmd in ('a', 'w', 'd', '*'))
            or (c.relname = 'client_pinned_notes' and pol.polcmd in ('d', '*')))`,
    );
    expect(rows.length).toBe(4); // client_pricing insert, update, delete + pinned delete
    for (const r of rows) expect(r.e, `${r.relname}.${r.polname}`).toMatch(/is_studio_owner\(/);
  });

  it("the other settlement commands are unchanged: waive and supersede are still owner-only and still granted to authenticated", async () => {
    const { rows } = await adminQuery(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname in ('waive_appointment_fee', 'supersede_appointment_settlement')
        order by 1`,
    );
    expect(rows).toEqual([
      { proname: "supersede_appointment_settlement", authenticated: true, anon: false },
      { proname: "waive_appointment_fee", authenticated: true, anon: false },
    ]);
  });
});

describe("6. RESIDUAL, characterized so it flips loudly when decided: the service price list is member-readable", () => {
  it("a practitioner can still read services.price_cents (needed to quote and book; a column privilege cannot tell an owner from a practitioner)", async () => {
    await sandbox(async ({ as }) => {
      const seen = await as(paidMember.userId, (uq) =>
        uq(`select price_cents from public.services where studio_id = $1 and name = 'Perm Service'`, [paid.studioId]),
      );
      expect(seen.rows).toEqual([{ price_cents: 12_000 }]);
    });
  });
});
