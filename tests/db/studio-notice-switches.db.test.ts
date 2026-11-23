import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// 0373: the two client-notice switches. Defaults and owner-only writes against the real migrated chain.
// Synthetic data only. NOT RUN by the author on a shared stack: needs a local stack at the 0373 head.

let studio: SeededStudio;
let member: { userId: string; practitionerId: string };
let other: SeededStudio;

beforeAll(async () => {
  studio = await seedStudio("notice-sw-a");
  member = await seedMember(studio, "notice-sw-m");
  other = await seedStudio("notice-sw-b");
});
afterAll(async () => {
  for (const s of [studio, other]) await adminQuery(`delete from public.studios where id = $1`, [s.studioId]);
  await closePool();
});

const read = async (id: string) =>
  (await adminQuery(
    `select send_moved_appointment_emails as moved, send_client_cancellation_emails as cancelled, send_confirmation_emails as confirmed from public.studios where id = $1`,
    [id],
  )).rows[0];

describe("0373 defaults", () => {
  it("both columns exist, are boolean NOT NULL, and default to true", async () => {
    const r = await adminQuery(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'studios' and column_name in ('send_moved_appointment_emails','send_client_cancellation_emails') order by column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: "send_client_cancellation_emails", data_type: "boolean", is_nullable: "NO", column_default: "true" },
      { column_name: "send_moved_appointment_emails", data_type: "boolean", is_nullable: "NO", column_default: "true" },
    ]);
  });
  it("a new studio has both notices ON", async () => {
    const row = await read(studio.studioId);
    expect(row.moved).toBe(true);
    expect(row.cancelled).toBe(true);
  });
  it("NULL is refused", async () => {
    await expect(adminQuery(`update public.studios set send_moved_appointment_emails = null where id = $1`, [studio.studioId])).rejects.toThrow();
    await expect(adminQuery(`update public.studios set send_client_cancellation_emails = null where id = $1`, [studio.studioId])).rejects.toThrow();
  });
});

describe("0373 owner-only writes (role authenticated with the caller's own JWT)", () => {
  it("the owner can turn each notice off and on independently, and confirmations are untouched", async () => {
    const before = await read(studio.studioId);
    await asUser(studio.userId, (q) => q(`update public.studios set send_moved_appointment_emails = false where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ moved: false, cancelled: true, confirmed: before.confirmed });
    await asUser(studio.userId, (q) => q(`update public.studios set send_client_cancellation_emails = false, send_moved_appointment_emails = true where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ moved: true, cancelled: false, confirmed: before.confirmed });
    await asUser(studio.userId, (q) => q(`update public.studios set send_client_cancellation_emails = true where id = $1`, [studio.studioId]));
  });
  it("turning confirmations off changes neither notice", async () => {
    await asUser(studio.userId, (q) => q(`update public.studios set send_confirmation_emails = false where id = $1`, [studio.studioId]));
    expect(await read(studio.studioId)).toEqual({ moved: true, cancelled: true, confirmed: false });
    await asUser(studio.userId, (q) => q(`update public.studios set send_confirmation_emails = true where id = $1`, [studio.studioId]));
  });
  it("a non-owner member's UPDATE changes nothing", async () => {
    const r = await asUser(member.userId, (q) => q(`update public.studios set send_moved_appointment_emails = false, send_client_cancellation_emails = false where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    const row = await read(studio.studioId);
    expect(row.moved).toBe(true);
    expect(row.cancelled).toBe(true);
  });
  it("another studio's owner cannot change this studio's switches", async () => {
    const r = await asUser(other.userId, (q) => q(`update public.studios set send_moved_appointment_emails = false where id = $1 returning id`, [studio.studioId]));
    expect(r.rows).toHaveLength(0);
    expect((await read(studio.studioId)).moved).toBe(true);
  });
});
