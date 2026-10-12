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

/** The studio's live sender id, as the operator's page would have shown it. */
const liveSender = async (studioId: string): Promise<string | null> =>
  ((await adminQuery(
    "select id from public.studio_sms_senders where studio_id = $1 and status <> 'released'",
    [studioId],
  )).rows[0]?.id as string | undefined) ?? null;

const record = async (
  studioId: string,
  kind: string,
  status: string,
  missing: string | null = null,
  reference: string | null = null,
  expected?: string | null,
) =>
  (await adminQuery(
    "select * from public.record_studio_sms_sender_registration($1, $2, $3, $4, $5, $6)",
    [studioId, expected === undefined ? ((await liveSender(studioId)) ?? "00000000-0000-4000-8000-000000000000") : expected, kind, status, missing, reference],
  )).rows[0] as { result: string; registration_id: string | null };

const snapshot = async (studioId: string) =>
  (await adminQuery("select public.get_live_studio_sms_sender_registration_state($1) s", [studioId])).rows[0].s as {
    senders: Array<{ id: string; studio_id: string; status: string; phone_number: string; messaging_service_sid: string }>;
    registrations: Array<{ sender_id: string; kind: string; status: string }>;
  };

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

describe("the operator's snapshot (Codex P2 4244011188, 4244108801)", () => {
  it("shows the live sender BEFORE its first record, with its number and messaging service", async () => {
    const s = await seedStudio("reg-first");
    const num = phone();
    const id = await seedActiveSender(s, num);
    const snap = await snapshot(s.studioId);
    expect(snap.registrations).toEqual([]);
    expect(snap.senders).toEqual([
      { id, studio_id: s.studioId, status: "active", phone_number: num, messaging_service_sid: expect.stringMatching(/^MG/) },
    ]);
    expect((await snapshot(none.studioId))).toEqual({ senders: [], registrations: [] });
  });

  it("returns the LIVE number's evidence only, never a released predecessor's", async () => {
    const s = await seedStudio("reg-replaced");
    const old = await seedActiveSender(s, phone());
    await record(s.studioId, "us_10dlc", "approved");
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [old]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [old]);
    const replacement = await seedActiveSender(s, phone());
    await record(s.studioId, "us_10dlc", "pending");

    const snap = await snapshot(s.studioId);
    expect(snap.senders.map((x) => x.id)).toEqual([replacement]);
    expect(snap.registrations).toEqual([expect.objectContaining({ sender_id: replacement, kind: "us_10dlc", status: "pending" })]);
    // The predecessor's approval is still recorded, as that number's history.
    const all = await adminQuery("select status from public.studio_sms_sender_registrations where studio_id = $1 order by status", [s.studioId]);
    expect(all.rows.map((r) => r.status)).toEqual(["approved", "pending"]);
  });

  it("is service_role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) => q("select public.get_live_studio_sms_sender_registration_state($1)", [a.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const ok = await asRole("service_role", (q) => q("select public.get_live_studio_sms_sender_registration_state($1) s", [a.studioId]));
    expect(ok.rows[0].s.senders).toHaveLength(1);
  });
});

describe("compare-and-set on the sender support verified (Codex P2 4244108809)", () => {
  it("a write for a sender that was replaced after the page loaded is refused, and nothing lands on the replacement", async () => {
    const s = await seedStudio("reg-stale");
    const shown = await seedActiveSender(s, phone());
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [shown]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [shown]);
    await seedActiveSender(s, phone());
    expect(await record(s.studioId, "us_10dlc", "approved", null, null, shown)).toEqual({ result: "sender_changed", registration_id: null });
    expect((await snapshot(s.studioId)).registrations).toEqual([]);
  });

  it("another studio's sender id is never accepted", async () => {
    expect((await record(a.studioId, "us_10dlc", "approved", null, null, senderB)).result).toBe("sender_changed");
  });

  it("a missing expected sender is invalid input", async () => {
    expect((await record(a.studioId, "us_10dlc", "approved", null, null, null)).result).toBe("invalid_input");
  });

  it("a release that races the write waits for it: the sender row is locked until the record commits", async () => {
    const { Client } = await import("pg");
    const { resolveLocalDbUrl } = await import("./helpers/harness");
    const s = await seedStudio("reg-race");
    const id = await seedActiveSender(s, phone());
    const writer = new Client({ connectionString: resolveLocalDbUrl() });
    const releaser = new Client({ connectionString: resolveLocalDbUrl() });
    await Promise.all([writer.connect(), releaser.connect()]);
    try {
      await writer.query("begin");
      const w = await writer.query(
        "select result from public.record_studio_sms_sender_registration($1, $2, 'us_10dlc', 'approved', null, null)",
        [s.studioId, id],
      );
      expect(w.rows[0].result).toBe("recorded");
      await releaser.query("set lock_timeout = '500ms'");
      await expect(
        releaser.query("update public.studio_sms_senders set status = 'releasing' where id = $1", [id]),
      ).rejects.toMatchObject({ code: "55P03" });
      await writer.query("commit");
    } finally {
      await Promise.all([writer.end(), releaser.end()]);
    }
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
        asRole(role, (q) => q("select * from public.record_studio_sms_sender_registration($1, $2, 'us_10dlc', 'approved', null, null)", [a.studioId, senderA])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const ok = await asRole("service_role", (q) =>
      q("select result from public.record_studio_sms_sender_registration($1, $2, 'us_10dlc', 'approved', null, null)", [b.studioId, senderB]),
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
