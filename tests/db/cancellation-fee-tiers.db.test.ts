import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { buildPolicySnapshot } from "@/lib/booking/policy-acknowledgement";

let studio: SeededStudio;
let other: SeededStudio;
let member: { userId: string; practitionerId: string };
const POLICY = "Less than 48 hours: 50%. Same-day cancellations: 100%.";
const HASH = buildPolicySnapshot({
  cancellationPolicyText: POLICY,
  noShowPolicyText: "",
}).policySnapshotHash;
const save = (
  revision: number,
  user?: string,
  noticeValue = 5000,
  hash = HASH,
) =>
  asUser(user ?? studio.userId, (q) =>
    q(
      `select * from public.save_cancellation_fee_rules($1,$2,48,'percent',$3,'percent',10000,$4)`,
      [studio.studioId, revision, noticeValue, hash],
    ),
  );
const enabled = (revision: number, on: boolean) =>
  asUser(studio.userId, (q) =>
    q(`select * from public.set_cancellation_fee_rules_enabled($1,$2,$3)`, [
      studio.studioId,
      revision,
      on,
    ]),
  );
const current = async () =>
  (
    await adminQuery(
      `select * from public.studio_cancellation_fee_rules where studio_id=$1`,
      [studio.studioId],
    )
  ).rows[0];

beforeAll(async () => {
  studio = await seedStudio("cancellation-tiers");
  other = await seedStudio("cancellation-other");
  member = await seedMember(studio, "cancellation-member");
  await adminQuery(
    `update public.studios set timezone='America/Toronto', cancellation_policy_text=$2, no_show_policy_text='' where id=$1`,
    [studio.studioId, POLICY],
  );
});
afterAll(async () => {
  for (const s of [studio, other])
    if (s)
      await adminQuery(`delete from public.studios where id=$1`, [s.studioId]);
  await closePool();
});

describe("owner-configured cancellation fees on the full migrated chain", () => {
  it("has no enrollment by default; owner role alone never enables a fee", async () => {
    expect(await current()).toBeUndefined();
    await expect(save(0, member.userId)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(save(0, other.userId)).rejects.toMatchObject({
      code: "42501",
    });
    expect(await current()).toBeUndefined();
  });
  it("requires the exact current policy and valid amounts; saves OFF without modifying policy or no-show", async () => {
    await expect(
      save(0, undefined, 5000, "b".repeat(64)),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(save(0, undefined, 10001)).rejects.toMatchObject({
      code: "23514",
    });
    const r = await save(0);
    expect(r.rows[0]).toMatchObject({
      enabled: false,
      notice_hours: 48,
      notice_value: 5000,
      same_day_value: 10000,
      policy_snapshot_hash: HASH,
    });
    const s = (
      await adminQuery(
        `select cancellation_policy_text, no_show_fee_enabled from public.studios where id=$1`,
        [studio.studioId],
      )
    ).rows[0];
    expect(s).toEqual({
      cancellation_policy_text: POLICY,
      no_show_fee_enabled: false,
    });
  });
  it("direct writes are closed even to the owner and service role; other owners cannot read rules or history", async () => {
    await expect(
      asUser(studio.userId, (q) =>
        q(
          `update public.studio_cancellation_fee_rules set enabled=true where studio_id=$1`,
          [studio.studioId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    for (const table of [
      "studio_cancellation_fee_rules",
      "studio_cancellation_fee_rule_changes",
    ]) {
      const r = await asUser(other.userId, (q) =>
        q(`select * from public.${table} where studio_id=$1`, [
          studio.studioId,
        ]),
      );
      expect(r.rows).toHaveLength(0);
      const grants = (
        await adminQuery(
          `select has_table_privilege('service_role',$1,'INSERT,UPDATE,DELETE') allowed`,
          [`public.${table}`],
        )
      ).rows[0];
      expect(grants.allowed).toBe(false);
    }
  });
  it("two tabs saving the same revision produce exactly one write and one stale refusal", async () => {
    const revision = Number((await current()).revision);
    const results = await Promise.allSettled([save(revision), save(revision)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(Number((await current()).revision)).toBe(revision + 1);
    expect((await current()).enabled).toBe(false);
  });
  it("activation is a separate owner command, saving again turns it off and records both changes", async () => {
    let revision = Number((await current()).revision);
    await enabled(revision, true);
    expect((await current()).enabled).toBe(true);
    revision = Number((await current()).revision);
    await save(revision);
    expect((await current()).enabled).toBe(false);
    const changes = (
      await asUser(studio.userId, (q) =>
        q(
          `select changed_by from public.studio_cancellation_fee_rule_changes where studio_id=$1`,
          [studio.studioId],
        ),
      )
    ).rows;
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(changes.every((r) => r.changed_by === studio.userId)).toBe(true);
  });
  it("prepares the chosen rate with immutable evidence, rejects stale rules at claim, and leaves sent recovery available", async () => {
    await enabled(Number((await current()).revision), true);
    const appt = randomUUID(),
      ack = randomUUID(),
      attempt = randomUUID();
    await adminQuery(
      `insert into public.appointments (id, studio_id, client_id, status, starts_at, ends_at, cancelled_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
      values ($1,$2,$3,'cancelled','2031-03-20T15:00:00Z','2031-03-20T16:00:00Z','2031-03-19T14:00:00Z',60,0,'2031-03-20T16:00:00Z')`,
      [appt, studio.studioId, studio.clientId],
    );
    await adminQuery(
      `insert into public.appointment_policy_acknowledgements (id,studio_id,client_id,appointment_id,action,cancellation_policy_text_snapshot,policy_snapshot_hash)
      values ($1,$2,$3,$4,'cancel',$5,$6)`,
      [ack, studio.studioId, studio.clientId, appt, POLICY, HASH],
    );
    const insert = (cents: number, bp: number) =>
      adminQuery(
        `insert into public.payment_charge_attempts
      (id,studio_id,client_id,appointment_id,charge_reason,created_by_practitioner_id,amount_cents,status,calc_mode,basis_cents,percent_bp,policy_snapshot_hash,appointment_policy_acknowledgement_id)
      values ($1,$2,$3,$4,'late_cancellation_fee',$5,$6,'ready','percent',12000,$7,$8,$9) returning cancellation_fee_snapshot`,
        [
          attempt,
          studio.studioId,
          studio.clientId,
          appt,
          studio.practitionerId,
          cents,
          bp,
          HASH,
          ack,
        ],
      );
    await expect(insert(9000, 7500)).rejects.toMatchObject({ code: "23514" });
    expect(
      (await insert(6000, 5000)).rows[0].cancellation_fee_snapshot.tier,
    ).toBe("within_notice");
    await expect(
      adminQuery(
        `update public.payment_charge_attempts set cancellation_fee_snapshot=null where id=$1`,
        [attempt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await save(Number((await current()).revision));
    await expect(
      adminQuery(
        `update public.payment_charge_attempts set status='pending_stripe' where id=$1`,
        [attempt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await enabled(Number((await current()).revision), true);
    await expect(
      adminQuery(
        `update public.payment_charge_attempts set status='pending_stripe' where id=$1`,
        [attempt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("an older settings tab cannot report OFF or change the obsolete rate after tier adoption", async () => {
    for (const patch of [
      "late_cancel_fee_enabled = late_cancel_fee_enabled",
      "late_cancel_fee_enabled = not late_cancel_fee_enabled",
      "late_cancel_fee_mode = 'percent'",
      "late_cancel_fee_cents = 9999",
      "late_cancel_fee_percent_bp = 7500",
    ]) {
      await expect(
        asUser(studio.userId, (q) =>
          q(`update public.studios set ${patch} where id=$1`, [
            studio.studioId,
          ]),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect((await current()).enabled).toBe(true);
  });
  it("a policy change blocks activation without rewriting any acknowledgement", async () => {
    const before = (
      await adminQuery(
        `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id=$1`,
        [studio.studioId],
      )
    ).rows[0].n;
    await adminQuery(
      `update public.studios set cancellation_policy_text='Changed policy' where id=$1`,
      [studio.studioId],
    );
    await expect(
      enabled(Number((await current()).revision), true),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await adminQuery(
          `select count(*)::int n from public.appointment_policy_acknowledgements where studio_id=$1 and policy_snapshot_hash=$2`,
          [studio.studioId, HASH],
        )
      ).rows[0].n,
    ).toBe(before);
  });
});
