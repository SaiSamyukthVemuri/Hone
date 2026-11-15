import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0351: the two per-studio manual-fee switches. Defaults and owner-only writes against the real migrated chain.
// Synthetic data only. NOT RUN by the author on a shared stack: needs a local stack at the 0351 head.

let studio: SeededStudio;
let member: { userId: string; practitionerId: string };
let other: SeededStudio;

beforeAll(async () => {
  studio = await seedStudio("fee-set-a");
  member = await seedMember(studio, "fee-set-m");
  other = await seedStudio("fee-set-b");
});
afterAll(async () => {
  for (const s of [studio, other]) await adminQuery(`delete from public.studios where id = $1`, [s.studioId]);
  await closePool();
});

const read = async (id: string) =>
  (await adminQuery(`select late_cancel_fee_enabled, no_show_fee_enabled from public.studios where id = $1`, [id])).rows[0];

describe("0351 defaults", () => {
  it("both columns exist, are boolean NOT NULL, and default to false", async () => {
    const r = await adminQuery(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'studios' and column_name in ('late_cancel_fee_enabled','no_show_fee_enabled') order by column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: "late_cancel_fee_enabled", data_type: "boolean", is_nullable: "NO", column_default: "false" },
      { column_name: "no_show_fee_enabled", data_type: "boolean", is_nullable: "NO", column_default: "false" },
    ]);
  });
  it("a new studio starts with both OFF", async () => {
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: false });
  });
  it("NULL is refused", async () => {
    await expect(adminQuery(`update public.studios set late_cancel_fee_enabled = null where id = $1`, [studio.studioId])).rejects.toThrow();
  });
});

describe("0351 owner-only writes (role authenticated with the caller's own JWT)", () => {
  it("the owner can turn each type on and off independently", async () => {
    await asUser(studio.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: true, no_show_fee_enabled: false });
    await asUser(studio.userId, (q) => q(`update public.studios set no_show_fee_enabled = true, late_cancel_fee_enabled = false where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: true });
    await asUser(studio.userId, (q) => q(`update public.studios set no_show_fee_enabled = false where id = $1`, [studio.studioId]));
  });
  it("a non-owner member's UPDATE changes nothing", async () => {
    const r = await asUser(member.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true, no_show_fee_enabled = true where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: false });
  });
  it("another studio's owner cannot change this studio's switches", async () => {
    const r = await asUser(other.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    expect(await read(studio.studioId)).toEqual({ late_cancel_fee_enabled: false, no_show_fee_enabled: false });
  });
  it("an owner's switch change does not touch the fee amounts", async () => {
    await adminQuery(`update public.studios set late_cancel_fee_cents = 2500, no_show_fee_cents = 4000 where id = $1`, [studio.studioId]);
    await asUser(studio.userId, (q) => q(`update public.studios set late_cancel_fee_enabled = true where id = $1`, [studio.studioId]));
    const r = (await adminQuery(`select late_cancel_fee_cents, no_show_fee_cents from public.studios where id = $1`, [studio.studioId])).rows[0];
    expect(r).toEqual({ late_cancel_fee_cents: 2500, no_show_fee_cents: 4000 });
    await adminQuery(`update public.studios set late_cancel_fee_enabled = false where id = $1`, [studio.studioId]);
  });
});
