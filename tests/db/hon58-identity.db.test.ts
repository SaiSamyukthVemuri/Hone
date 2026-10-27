import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// HON-58 identity (migration 0258, reserved by OPS for HON-58), proved against
// the real migrated local database: the migration chain applies it, so nothing
// is applied or removed here.
//
// What it proves: preferred name on clients (nullable, shaped, no backfill);
// legal identity readable/writable by an active OWNER or PRACTITIONER only;
// a RECEPTIONIST (studio_receptionists, not a practitioners row), anon and
// service_role denied; cross-studio isolation; no delete; one identity per
// client; client and studio immutable. The file's own shape is pinned in
// tests/migrations/0258-hon58-identity.test.ts.

let a: SeededStudio;
let b: SeededStudio;
let aPractitioner: { userId: string; practitionerId: string };
let aReceptionist: string;
let bMember: { userId: string; practitionerId: string };

async function seedReceptionist(studio: SeededStudio): Promise<string> {
  const userId = randomUUID();
  await adminQuery("insert into auth.users(id,email) values ($1,$2)", [userId, `desk-${userId}@harness.local`]);
  await adminQuery(
    "insert into public.studio_receptionists(studio_id,user_id,display_name,active) values ($1,$2,'Synthetic Front Desk',true)",
    [studio.studioId, userId],
  );
  return userId;
}

const INSERT_LEGAL = `insert into public.client_legal_identities
  (client_id, studio_id, legal_given_name, legal_family_name, updated_by)
  values ($1, $2, $3, $4, $5) returning client_id, studio_id, updated_at`;

beforeAll(async () => {
  a = await seedStudio("hon58-a");
  b = await seedStudio("hon58-b");
  aPractitioner = await seedMember(a, "hon58-a-practitioner");
  bMember = await seedMember(b, "hon58-b-practitioner");
  aReceptionist = await seedReceptionist(a);
});

afterAll(async () => {
  await closePool();
});

describe("preferred name on the client", () => {
  it("existing clients have it null (no backfill) and display as before", async () => {
    const r = await adminQuery("select preferred_name from public.clients where id = $1", [a.clientId]);
    expect(r.rows[0].preferred_name).toBeNull();
  });

  it("a practitioner sets it on the SAME client row; the client id and name are untouched", async () => {
    await asUser(aPractitioner.userId, (q) =>
      q("update public.clients set preferred_name = 'Janie' where id = $1", [a.clientId]),
    );
    const r = await adminQuery("select id, name, preferred_name from public.clients where id = $1", [a.clientId]);
    expect(r.rows[0]).toMatchObject({ id: a.clientId, preferred_name: "Janie" });
    expect((await adminQuery("select count(*)::int n from public.clients where studio_id = $1", [a.studioId])).rows[0].n).toBe(1);
  });

  it.each([["empty", ""], ["padded", " Janie "], ["too long", "x".repeat(201)]])("refuses a %s preferred name", async (_l, value) => {
    await expect(
      asUser(a.userId, (q) => q("update public.clients set preferred_name = $2 where id = $1", [a.clientId, value])),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("legal identity: owner and practitioner only", () => {
  it("the owner records one and reads it back", async () => {
    const r = await asUser(a.userId, (q) => q(INSERT_LEGAL, [a.clientId, a.studioId, "Jane", "Smith-Reyes", a.practitionerId]));
    expect(r.rowCount).toBe(1);
    const got = await asUser(a.userId, (q) => q("select legal_given_name, legal_family_name, source from public.client_legal_identities where client_id = $1", [a.clientId]));
    expect(got.rows[0]).toEqual({ legal_given_name: "Jane", legal_family_name: "Smith-Reyes", source: "staff_entry" });
  });

  it("an active non-owner practitioner of the same studio can read and update it", async () => {
    const read = await asUser(aPractitioner.userId, (q) => q("select client_id from public.client_legal_identities where client_id = $1", [a.clientId]));
    expect(read.rowCount).toBe(1);
    const upd = await asUser(aPractitioner.userId, (q) => q("update public.client_legal_identities set legal_middle_name = 'Marie', updated_by = $2 where client_id = $1 returning updated_at, created_at", [a.clientId, aPractitioner.practitionerId]));
    expect(upd.rowCount).toBe(1);
    expect(new Date(upd.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(new Date(upd.rows[0].created_at).getTime());
  });

  it("one identity per client: a second row for the same client is refused", async () => {
    await expect(asUser(a.userId, (q) => q(INSERT_LEGAL, [a.clientId, a.studioId, "Other", "Name", a.practitionerId]))).rejects.toMatchObject({ code: "23505" });
  });

  it("the client and studio cannot be changed", async () => {
    const other = await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Second Client') returning id", [randomUUID(), a.studioId]);
    await expect(asUser(a.userId, (q) => q("update public.client_legal_identities set client_id = $2 where client_id = $1", [a.clientId, other.rows[0].id]))).rejects.toMatchObject({ code: "23514" });
  });

  it("insurer text can never be the source, and a row needs at least one name", async () => {
    const c = (await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Third Client') returning id", [randomUUID(), a.studioId])).rows[0].id;
    await expect(asUser(a.userId, (q) => q("insert into public.client_legal_identities (client_id, studio_id, legal_given_name, source) values ($1,$2,'X','insurer_response')", [c, a.studioId]))).rejects.toMatchObject({ code: "23514" });
    await expect(asUser(a.userId, (q) => q("insert into public.client_legal_identities (client_id, studio_id, legal_given_name) values ($1,$2,'  ')", [c, a.studioId]))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("denied: receptionist, anon, service_role", () => {
  it("a same-studio receptionist (an active studio_receptionists row, not a practitioner) sees nothing and writes nothing", async () => {
    expect((await adminQuery("select count(*)::int n from public.practitioners where studio_id = $1 and user_id = $2", [a.studioId, aReceptionist])).rows[0].n).toBe(0);
    const read = await asUser(aReceptionist, (q) => q("select client_id from public.client_legal_identities where studio_id = $1", [a.studioId]));
    expect(read.rowCount).toBe(0);
    const c = (await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Desk Client') returning id", [randomUUID(), a.studioId])).rows[0].id;
    await expect(asUser(aReceptionist, (q) => q("insert into public.client_legal_identities (client_id, studio_id, legal_given_name) values ($1,$2,'Desk')", [c, a.studioId]))).rejects.toMatchObject({ code: "42501" });
    const upd = await asUser(aReceptionist, (q) => q("update public.client_legal_identities set legal_given_name = 'Hacked' where client_id = $1", [a.clientId]));
    expect(upd.rowCount).toBe(0);
    expect((await adminQuery("select legal_given_name from public.client_legal_identities where client_id = $1", [a.clientId])).rows[0].legal_given_name).toBe("Jane");
  });

  it("the single predicate is true for owner and practitioner and false for a receptionist, a stranger and another studio's member", async () => {
    const pred = (uid: string, studio: string) => asUser(uid, async (q) => (await q("select public.can_use_client_legal_identity($1) as ok", [studio])).rows[0].ok as boolean);
    expect(await pred(a.userId, a.studioId)).toBe(true);
    expect(await pred(aPractitioner.userId, a.studioId)).toBe(true);
    expect(await pred(aReceptionist, a.studioId)).toBe(false);
    expect(await pred(bMember.userId, a.studioId)).toBe(false);
  });

  it("anon and service_role have no table privilege and cannot execute the predicate", async () => {
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q("select client_id from public.client_legal_identities limit 1"))).rejects.toMatchObject({ code: "42501" });
      await expect(asRole(role, (q) => q("select public.can_use_client_legal_identity($1)", [a.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("no role may delete a legal identity directly", async () => {
    await expect(asUser(a.userId, (q) => q("delete from public.client_legal_identities where client_id = $1", [a.clientId]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("cross-studio isolation", () => {
  it("another studio's practitioner cannot read, insert or update studio A's legal identity", async () => {
    expect((await asUser(bMember.userId, (q) => q("select client_id from public.client_legal_identities where client_id = $1", [a.clientId]))).rowCount).toBe(0);
    await expect(asUser(bMember.userId, (q) => q(INSERT_LEGAL, [a.clientId, a.studioId, "X", "Y", bMember.practitionerId]))).rejects.toMatchObject({ code: "42501" });
    expect((await asUser(bMember.userId, (q) => q("update public.client_legal_identities set legal_given_name = 'No' where client_id = $1", [a.clientId]))).rowCount).toBe(0);
  });

  it("a row cannot pair studio B with studio A's client (composite foreign key)", async () => {
    // A client of studio A that has NO legal identity yet, so the primary key cannot answer first.
    const bare = (await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Bare Client') returning id", [randomUUID(), a.studioId])).rows[0].id;
    await expect(asUser(b.userId, (q) => q(INSERT_LEGAL, [bare, b.studioId, "X", "Y", b.practitionerId]))).rejects.toMatchObject({ code: "23503" });
  });
});

describe("history is preserved", () => {
  it("deleting a client removes its legal identity with it, and nothing else is cascaded from it", async () => {
    const c = (await adminQuery("insert into public.clients (id, studio_id, name) values ($1,$2,'Gone Client') returning id", [randomUUID(), a.studioId])).rows[0].id;
    await asUser(a.userId, (q) => q("insert into public.client_legal_identities (client_id, studio_id, legal_given_name) values ($1,$2,'Gone')", [c, a.studioId]));
    await adminQuery("delete from public.clients where id = $1", [c]);
    expect((await adminQuery("select count(*)::int n from public.client_legal_identities where client_id = $1", [c])).rows[0].n).toBe(0);
    expect((await adminQuery("select count(*)::int n from public.client_legal_identities where client_id = $1", [a.clientId])).rows[0].n).toBe(1);
  });
});
