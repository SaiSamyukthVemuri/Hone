import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// SMS-SENDER-REG-01 (#824), migration 0217, against the real database.
//
//   * the ONLY writer is the service_role command, and it resolves the
//     studio's LIVE sender itself: evidence can never land on another studio's
//     sender, a released one, or a studio with none;
//   * the studio OWNER reads their own rows, without the provider reference;
//     a practitioner, another studio's owner and anon read nothing;
//   * nobody, service_role included, writes the table directly;
//   * one row per sender per kind, updated in place.
// ===========================================================================

let a: SeededStudio;
let b: SeededStudio;
let none: SeededStudio;
let member: { userId: string; practitionerId: string };

const hex = (n: number) => randomBytes(n).toString("hex");

async function seedActiveSender(s: SeededStudio, phone: string): Promise<string> {
  const { rows } = await adminQuery(
    `insert into public.studio_sms_senders
       (studio_id, provider, status, country,
        claimed_phone_number, phone_number, phone_number_sid, messaging_service_sid,
        provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id,
        provisioning_lease_generation, provisioned_at, last_test_ok_at)
     values ($1, 'twilio', 'active', 'US', $2, $2, $3, $4, $5, now(), $6, 1, now(), now())
     returning id`,
    [s.studioId, phone, `PN${hex(16)}`, `MG${hex(16)}`, `hone-sms-${hex(16)}`, s.practitionerId],
  );
  return rows[0].id as string;
}

const record = async (
  studioId: string,
  kind: string,
  status: string,
  missing: string | null = null,
  reference: string | null = null,
) =>
  (await adminQuery(
    "select * from public.record_studio_sms_sender_registration($1, $2, $3, $4, $5)",
    [studioId, kind, status, missing, reference],
  )).rows[0] as { result: string; registration_id: string | null };

const phone = () => `+1212${String(Math.floor(2_000_000 + Math.random() * 7_999_999))}`;

let senderA: string;
let senderB: string;

beforeAll(async () => {
  a = await seedStudio("reg-a");
  b = await seedStudio("reg-b");
  none = await seedStudio("reg-none");
  member = await seedMember(a, "reg-member");
  senderA = await seedActiveSender(a, phone());
  senderB = await seedActiveSender(b, phone());
});

afterAll(async () => {
  await closePool();
});

describe("the command", () => {
  it("records against the studio's own live sender, and updates the same row in place", async () => {
    const first = await record(a.studioId, "us_10dlc", "pending", null, "BN1234abcd");
    expect(first.result).toBe("recorded");
    const again = await record(a.studioId, "us_10dlc", "requires_information", "  a campaign description  ");
    expect(again).toEqual({ result: "recorded", registration_id: first.registration_id });
    const { rows } = await adminQuery(
      "select studio_id, sender_id, status, missing_information, provider_reference from public.studio_sms_sender_registrations where id = $1",
      [first.registration_id],
    );
    expect(rows[0]).toEqual({
      studio_id: a.studioId,
      sender_id: senderA,
      status: "requires_information",
      missing_information: "a campaign description",
      // A later record without a reference keeps the one support already gave.
      provider_reference: "BN1234abcd",
    });
  });

  it("never reaches another studio's sender: evidence lands on the named studio's own sender only", async () => {
    await record(b.studioId, "us_10dlc", "approved");
    const { rows } = await adminQuery(
      "select studio_id, sender_id from public.studio_sms_sender_registrations where studio_id = $1",
      [b.studioId],
    );
    expect(rows).toEqual([{ studio_id: b.studioId, sender_id: senderB }]);
  });

  it("refuses a studio with no live sender, and a released sender is not live", async () => {
    expect(await record(none.studioId, "us_10dlc", "approved")).toEqual({ result: "no_live_sender", registration_id: null });
    const s = await seedStudio("reg-released");
    const id = await seedActiveSender(s, phone());
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [id]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [id]);
    expect((await record(s.studioId, "us_10dlc", "approved")).result).toBe("no_live_sender");
  });

  it("refuses invalid input and writes nothing", async () => {
    for (const args of [
      ["sms_short_code", "approved", null, null],
      ["us_10dlc", "delivered", null, null],
      ["us_10dlc", "requires_information", null, null],
      ["us_10dlc", "requires_information", "   ", null],
      ["us_10dlc", "approved", "something", null],
      ["us_10dlc", "requires_information", "x".repeat(301), null],
      ["us_10dlc", "approved", null, "has spaces"],
    ] as const) {
      expect((await record(a.studioId, args[0], args[1], args[2], args[3])).result, JSON.stringify(args)).toBe("invalid_input");
    }
    expect((await record(a.studioId, "us_10dlc", "approved")).result).toBe("recorded");
    const n = await adminQuery("select count(*)::int n from public.studio_sms_sender_registrations where sender_id = $1", [senderA]);
    expect(n.rows[0].n).toBe(1);
  });

  it("toll-free verification is its own row beside 10DLC", async () => {
    await record(a.studioId, "toll_free_verification", "pending");
    const { rows } = await adminQuery(
      "select kind from public.studio_sms_sender_registrations where sender_id = $1 order by kind",
      [senderA],
    );
    expect(rows.map((r) => r.kind)).toEqual(["toll_free_verification", "us_10dlc"]);
  });
});

describe("the operator's read (Codex P2 4244011188)", () => {
  it("shows the LIVE number's evidence only, never a released predecessor's", async () => {
    const s = await seedStudio("reg-replaced");
    const old = await seedActiveSender(s, phone());
    await record(s.studioId, "us_10dlc", "approved");
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [old]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [old]);
    const replacement = phone();
    await seedActiveSender(s, replacement);
    await record(s.studioId, "us_10dlc", "pending");

    const live = (await adminQuery("select * from public.list_live_studio_sms_sender_registrations($1)", [s.studioId])).rows;
    expect(live).toEqual([expect.objectContaining({ kind: "us_10dlc", status: "pending", phone_number: replacement })]);
    // The predecessor's approval is still recorded, as that number's history.
    const all = await adminQuery("select status from public.studio_sms_sender_registrations where studio_id = $1 order by status", [s.studioId]);
    expect(all.rows.map((r) => r.status)).toEqual(["approved", "pending"]);
  });

  it("is service_role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) => q("select * from public.list_live_studio_sms_sender_registrations($1)", [a.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const ok = await asRole("service_role", (q) => q("select * from public.list_live_studio_sms_sender_registrations($1)", [a.studioId]));
    expect(ok.rows.length).toBeGreaterThan(0);
  });
});

describe("privileges", () => {
  it("the owner reads their own rows, without the provider reference", async () => {
    const own = await asUser(a.userId, (q) =>
      q("select kind, status from public.studio_sms_sender_registrations order by kind"),
    );
    expect(own.rows.map((r) => r.kind)).toEqual(["toll_free_verification", "us_10dlc"]);
    await expect(
      asUser(a.userId, (q) => q("select provider_reference from public.studio_sms_sender_registrations")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("another studio's owner, a practitioner and anon read nothing of studio A", async () => {
    const other = await asUser(b.userId, (q) =>
      q("select count(*)::int n from public.studio_sms_sender_registrations where studio_id = $1", [a.studioId]),
    );
    expect(other.rows[0].n).toBe(0);
    const practitioner = await asUser(member.userId, (q) =>
      q("select count(*)::int n from public.studio_sms_sender_registrations"),
    );
    expect(practitioner.rows[0].n).toBe(0);
    await expect(asRole("anon", (q) => q("select * from public.studio_sms_sender_registrations"))).rejects.toMatchObject({ code: "42501" });
  });

  it("nobody writes the table directly, and only service_role runs the command", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const sql of [
        `insert into public.studio_sms_sender_registrations (studio_id, sender_id, kind, status) values ('${a.studioId}', '${senderA}', 'us_10dlc', 'approved')`,
        "update public.studio_sms_sender_registrations set status = 'approved'",
        "delete from public.studio_sms_sender_registrations",
      ]) {
        await expect(asRole(role, (q) => q(sql)), `${role}: ${sql.slice(0, 30)}`).rejects.toMatchObject({ code: "42501" });
      }
    }
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) => q("select * from public.record_studio_sms_sender_registration($1, 'us_10dlc', 'approved', null, null)", [a.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const ok = await asRole("service_role", (q) =>
      q("select result from public.record_studio_sms_sender_registration($1, 'us_10dlc', 'approved', null, null)", [b.studioId]),
    );
    expect(ok.rows[0].result).toBe("recorded");
  });

  it("deleting the sender takes its evidence with it", async () => {
    const s = await seedStudio("reg-cascade");
    const id = await seedActiveSender(s, phone());
    await record(s.studioId, "us_10dlc", "approved");
    await adminQuery("delete from public.studio_sms_senders where id = $1", [id]);
    const n = await adminQuery("select count(*)::int n from public.studio_sms_sender_registrations where studio_id = $1", [s.studioId]);
    expect(n.rows[0].n).toBe(0);
  });
});
