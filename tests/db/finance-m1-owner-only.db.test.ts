import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
  type UserQuery,
} from "./helpers/harness";
import { seedQuickCheckoutScenario } from "./helpers/payment-seed";

// 0302, finance DB closure M1. Real RLS on the REAL migrated chain, as a real signed-in
// user (authenticated role + JWT subject), for each of: the studio owner, a non-owner
// practitioner of the SAME studio, a receptionist (a studio_receptionists row, NO
// practitioners row), another studio's owner, and anon. Synthetic data only.
//
//   (i)  client_payment_methods: SELECT is owner-only. Before 0302 every member read the
//        brand, last4, expiry and Stripe ids of every client.
//   (ii) services: INSERT and UPDATE are owner-only. Before 0302 every member could change
//        the price list through the Data API. SELECT stays member-wide until M3 (this file
//        pins that too, so M3's change is a visible flip).

let owner: SeededStudio;
let member: { userId: string; practitionerId: string };
let receptionistUserId: string;
let other: SeededStudio;
let cardId: string;
let serviceId: string;

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

beforeAll(async () => {
  const scenario = await seedQuickCheckoutScenario({
    label: "m1-owner",
    appointmentStatus: "completed",
    attempt: "none",
  });
  owner = {
    studioId: scenario.studioId,
    userId: scenario.practitionerUserId,
    practitionerId: scenario.practitionerId,
    clientId: scenario.clientId,
  };
  member = await seedMember(owner, "m1-member");
  other = await seedStudio("m1-other");

  receptionistUserId = randomUUID();
  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
    receptionistUserId,
    `m1-reception-${receptionistUserId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.studio_receptionists (studio_id, user_id, display_name) values ($1, $2, 'M1 Reception')`,
    [owner.studioId, receptionistUserId],
  );

  cardId = (
    await adminQuery(`select id from public.client_payment_methods where studio_id = $1`, [owner.studioId])
  ).rows[0].id;
  serviceId = (
    await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
       values ($1, 'M1 Service', 60, 5000, true, 'electrolysis') returning id`,
      [owner.studioId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await closePool();
});

const CARD_COLS = "brand, last4, exp_month, exp_year, stripe_customer_id, stripe_payment_method_id, stripe_setup_intent_id, stripe_account_id";

describe("0302 (i) client_payment_methods: owner-only select", () => {
  it("the owner reads the card summary and the Stripe ids", async () => {
    const r = await asUser(owner.userId, (q) =>
      q(`select ${CARD_COLS} from public.client_payment_methods where studio_id = $1`, [owner.studioId]),
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].brand).toBe("visa");
    expect(r.rows[0].last4).toBe("4242");
    expect(r.rows[0].stripe_customer_id).toBeTruthy();
  });

  it("a non-owner practitioner of the same studio reads ZERO rows (named columns, select *, count, by id)", async () => {
    await asUser(member.userId, async (q) => {
      expect((await q(`select ${CARD_COLS} from public.client_payment_methods where studio_id = $1`, [owner.studioId])).rowCount).toBe(0);
      expect((await q(`select * from public.client_payment_methods`)).rowCount).toBe(0);
      expect((await q(`select count(*)::int n from public.client_payment_methods`)).rows[0].n).toBe(0);
      expect((await q(`select id from public.client_payment_methods where id = $1`, [cardId])).rowCount).toBe(0);
    });
  });

  it("a receptionist (no practitioners row) reads zero rows", async () => {
    const r = await asUser(receptionistUserId, (q) => q(`select * from public.client_payment_methods`));
    expect(r.rowCount).toBe(0);
  });

  it("another studio's owner reads zero rows of this studio", async () => {
    const r = await asUser(other.userId, (q) =>
      q(`select * from public.client_payment_methods where studio_id = $1`, [owner.studioId]),
    );
    expect(r.rowCount).toBe(0);
  });

  it("anon reads zero rows", async () => {
    const r = await asRole("anon", (q) => q(`select * from public.client_payment_methods`));
    expect(r.rowCount).toBe(0);
  });

  it("no browser role can write the table (unchanged: no write policy exists); the row is untouched", async () => {
    for (const who of [member.userId, owner.userId]) {
      await asUser(who, async (q) => {
        expect(
          await sqlState(
            q,
            `insert into public.client_payment_methods (studio_id, client_id) values ($1, $2)`,
            [owner.studioId, owner.clientId],
          ),
        ).not.toBeNull();
        expect((await q(`update public.client_payment_methods set last4 = '0000' where id = $1`, [cardId])).rowCount).toBe(0);
        expect((await q(`delete from public.client_payment_methods where id = $1`, [cardId])).rowCount).toBe(0);
      });
    }
    const after = await adminQuery(`select last4 from public.client_payment_methods where id = $1`, [cardId]);
    expect(after.rows).toEqual([{ last4: "4242" }]);
  });

  it("the catalog: exactly one select policy on the table, owner-only, and no member policy remains", async () => {
    const { rows } = await adminQuery(
      `select policyname, cmd, roles::text as roles, qual
         from pg_policies where schemaname = 'public' and tablename = 'client_payment_methods' order by policyname`,
    );
    expect(rows.map((r) => [r.policyname, r.cmd, r.roles])).toEqual([
      ["client_payment_methods_owner_select", "SELECT", "{authenticated}"],
    ]);
    expect(rows[0].qual).toContain("is_studio_owner");
    expect(rows[0].qual).not.toContain("is_studio_member");
  });
});

describe("0302 (ii) services: owner-only insert and update", () => {
  it("the owner can insert and update a service", async () => {
    await asUser(owner.userId, async (q) => {
      const ins = await q(
        `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
         values ($1, 'M1 Owner Service', 30, 1000, true, 'electrolysis') returning id`,
        [owner.studioId],
      );
      expect(ins.rowCount).toBe(1);
      const upd = await q(`update public.services set price_cents = 5500 where id = $1`, [serviceId]);
      expect(upd.rowCount).toBe(1);
    });
    expect((await adminQuery(`select price_cents from public.services where id = $1`, [serviceId])).rows[0].price_cents).toBe(5500);
    await adminQuery(`update public.services set price_cents = 5000 where id = $1`, [serviceId]);
  });

  it("a non-owner practitioner cannot insert (42501) and an update changes 0 rows; the row is unchanged", async () => {
    await asUser(member.userId, async (q) => {
      expect(
        await sqlState(
          q,
          `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
           values ($1, 'M1 Member Service', 30, 1, true, 'electrolysis')`,
          [owner.studioId],
        ),
      ).toBe("42501");
      expect((await q(`update public.services set price_cents = 1, name = 'hacked' where id = $1`, [serviceId])).rowCount).toBe(0);
    });
    const row = (await adminQuery(`select name, price_cents from public.services where id = $1`, [serviceId])).rows[0];
    expect(row).toEqual({ name: "M1 Service", price_cents: 5000 });
    expect((await adminQuery(`select count(*)::int n from public.services where studio_id = $1 and name = 'M1 Member Service'`, [owner.studioId])).rows[0].n).toBe(0);
  });

  it("a receptionist cannot insert (42501) or update (0 rows)", async () => {
    await asUser(receptionistUserId, async (q) => {
      expect(
        await sqlState(
          q,
          `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
           values ($1, 'M1 Reception Service', 30, 1, true, 'electrolysis')`,
          [owner.studioId],
        ),
      ).toBe("42501");
      expect((await q(`update public.services set price_cents = 1 where id = $1`, [serviceId])).rowCount).toBe(0);
    });
  });

  it("another studio's owner cannot insert into, or update, this studio's services", async () => {
    await asUser(other.userId, async (q) => {
      expect(
        await sqlState(
          q,
          `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
           values ($1, 'M1 Cross Service', 30, 1, true, 'electrolysis')`,
          [owner.studioId],
        ),
      ).toBe("42501");
      expect((await q(`update public.services set price_cents = 1 where id = $1`, [serviceId])).rowCount).toBe(0);
    });
  });

  it("CHARACTERIZED, flips in M3: members still READ the service list and its prices", async () => {
    const r = await asUser(member.userId, (q) =>
      q(`select name, price_cents, default_duration_minutes, active from public.services where id = $1`, [serviceId]),
    );
    expect(r.rows).toEqual([{ name: "M1 Service", price_cents: 5000, default_duration_minutes: 60, active: true }]);
  });

  it("the catalog: select stays member-wide, insert and update are owner-only, no member write policy remains", async () => {
    const { rows } = await adminQuery(
      `select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'services' order by policyname`,
    );
    expect(rows.map((r) => [r.policyname, r.cmd])).toEqual([
      ["services_member_select", "SELECT"],
      ["services_owner_insert", "INSERT"],
      ["services_owner_update", "UPDATE"],
    ]);
  });
});

describe("0302 leaves the definer paths alone", () => {
  it("no new function, no changed grant: the policy migration restates no privilege", async () => {
    const t = await adminQuery(
      `select has_table_privilege('authenticated', 'public.client_payment_methods', 'SELECT') as sel,
              has_table_privilege('authenticated', 'public.services', 'INSERT') as ins,
              has_table_privilege('authenticated', 'public.services', 'UPDATE') as upd`,
    );
    // Table privileges are untouched (the policies are the gate), so these stay true.
    expect(t.rows[0]).toEqual({ sel: true, ins: true, upd: true });
  });
});
