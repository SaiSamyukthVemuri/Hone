import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// SETTINGS-SMS against the REAL migrated DB: who can change the three studio SMS
// columns. The app action is owner-only, but the database is the boundary: the
// "studios: owners update" policy (0001) must hold for these columns too.
// Synthetic studios only; nothing is sent.

let a: SeededStudio;
let b: SeededStudio;
let memberUserId: string;

beforeAll(async () => {
  a = await seedStudio("sms-set-a");
  b = await seedStudio("sms-set-b");
  memberUserId = (await seedMember(a, "sms-set-prac")).userId;
});
afterAll(async () => {
  await closePool();
});

const read = async (id: string) =>
  (await adminQuery(`select send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders from public.studios where id = $1`, [id])).rows[0];

describe("studio SMS columns", () => {
  it("default OFF for a new studio (nothing is enabled by existing)", async () => {
    expect(await read(a.studioId)).toEqual({ send_confirmation_sms: false, send_24h_sms_reminders: false, send_2h_sms_reminders: false });
  });

  it("the owner can switch them on and off for their own studio, both states", async () => {
    await asUser(a.userId, (q) =>
      q(`update public.studios set send_confirmation_sms = true, send_24h_sms_reminders = true, send_2h_sms_reminders = true where id = $1`, [a.studioId]),
    );
    expect(await read(a.studioId)).toEqual({ send_confirmation_sms: true, send_24h_sms_reminders: true, send_2h_sms_reminders: true });
    await asUser(a.userId, (q) =>
      q(`update public.studios set send_confirmation_sms = false, send_24h_sms_reminders = false, send_2h_sms_reminders = false where id = $1`, [a.studioId]),
    );
    expect(await read(a.studioId)).toEqual({ send_confirmation_sms: false, send_24h_sms_reminders: false, send_2h_sms_reminders: false });
  });

  it("another studio's owner changes nothing in studio A (zero rows, values unchanged)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(`update public.studios set send_confirmation_sms = true, send_24h_sms_reminders = true where id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
    expect((await read(a.studioId)).send_confirmation_sms).toBe(false);
    expect((await read(b.studioId)).send_confirmation_sms).toBe(false);
  });

  it("a receptionist of studio A changes nothing", async () => {
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, `sms-set-recept-${userId.slice(0, 8)}@harness.local`]);
    await adminQuery(
      `insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1, $2, 'Synthetic Front Desk', true)`,
      [a.studioId, userId],
    );
    const res = await asUser(userId, (q) =>
      q(`update public.studios set send_confirmation_sms = true where id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
    expect((await read(a.studioId)).send_confirmation_sms).toBe(false);
  });

  it("a non-owner practitioner in studio A changes nothing", async () => {
    const res = await asUser(memberUserId, (q) =>
      q(`update public.studios set send_2h_sms_reminders = true where id = $1`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
    expect((await read(a.studioId)).send_2h_sms_reminders).toBe(false);
  });
});
