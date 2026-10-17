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
//   * one row per sender per NUMBER per kind, updated in place; the kind is
//     derived from the number and the evidence is bound to it (Codex P2
//     4244484021, 4244484022).
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

/** The studio's live sender id and number, as the operator's page would have shown them. */
const liveSender = async (studioId: string): Promise<{ id: string; phone: string | null } | null> => {
  const row = (await adminQuery(
    "select id, phone_number from public.studio_sms_senders where studio_id = $1 and status <> 'released'",
    [studioId],
  )).rows[0];
  return row ? { id: row.id as string, phone: (row.phone_number as string | null) ?? null } : null;
};

const NO_SENDER = "00000000-0000-4000-8000-000000000000";
const NO_PHONE = "+12125550000";

const record = async (
  studioId: string,
  status: string,
  missing: string | null = null,
  reference: string | null = null,
  expected?: { sender?: string | null; phone?: string | null; updatedAt?: string | null },
) => {
  const live = await liveSender(studioId);
  const sender = expected && "sender" in expected ? expected.sender : (live?.id ?? NO_SENDER);
  const shown = expected && "phone" in expected ? expected.phone : (live?.phone ?? NO_PHONE);
  // By default a FRESH form: it shows the record as it is now (or none).
  const version = expected && "updatedAt" in expected ? expected.updatedAt : await shownVersion(studioId, sender, shown);
  return (await adminQuery(
    "select * from public.record_studio_sms_sender_registration($1, $2, $3, $4, $5, $6, $7)",
    [studioId, sender, shown, status, missing, reference, version],
  )).rows[0] as { result: string; registration_id: string | null; kind: string | null; previous_status: string | null };
};

/**
 * The version a form loaded NOW would carry: the record's updated_at exactly as
 * the page's snapshot gives it (the same jsonb string the form posts back).
 */
async function shownVersion(studioId: string, sender: string | null | undefined, phoneShown: string | null | undefined): Promise<string | null> {
  const s = (await adminQuery("select public.get_live_studio_sms_sender_registration_state($1) s", [studioId])).rows[0].s as {
    registrations?: Array<{ sender_id: string; phone_number: string; updated_at: string }>;
  } | null;
  return s?.registrations?.find((r) => r.sender_id === sender && r.phone_number === phoneShown)?.updated_at ?? null;
}

/** Try to move the SAME sender row to another number (0191 refuses: write-once). */
const renumber = (senderId: string, to: string) =>
  adminQuery(
    "update public.studio_sms_senders set claimed_phone_number = $2, phone_number = $2 where id = $1",
    [senderId, to],
  );

const snapshot = async (studioId: string) =>
  (await adminQuery("select public.get_live_studio_sms_sender_registration_state($1) s", [studioId])).rows[0].s as {
    senders: Array<{ id: string; studio_id: string; status: string; phone_number: string; messaging_service_sid: string }>;
    registrations: Array<{ sender_id: string; phone_number: string; kind: string; status: string }>;
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
    const first = await record(a.studioId, "pending", null, "BN1234abcd");
    expect(first.result).toBe("recorded");
    const again = await record(a.studioId, "requires_information", "  a campaign description  ");
    expect(again).toEqual({ result: "recorded", registration_id: first.registration_id, kind: "us_10dlc", previous_status: "pending" });
    const { rows } = await adminQuery(
      "select studio_id, sender_id, status, missing_information, provider_reference from public.studio_sms_sender_registrations where id = $1",
      [first.registration_id],
    );
    expect(rows[0]).toEqual({
      studio_id: a.studioId,
      sender_id: senderA,
      status: "requires_information",
      missing_information: "a campaign description",
      // A later record WITHOUT a reference clears it: what is submitted is what is stored.
      provider_reference: null,
    });
  });

  it("never reaches another studio's sender: evidence lands on the named studio's own sender only", async () => {
    await record(b.studioId, "approved");
    const { rows } = await adminQuery(
      "select studio_id, sender_id from public.studio_sms_sender_registrations where studio_id = $1",
      [b.studioId],
    );
    expect(rows).toEqual([{ studio_id: b.studioId, sender_id: senderB }]);
  });

  it("refuses a studio with no live sender, and a released sender is not live", async () => {
    expect(await record(none.studioId, "approved")).toEqual({ result: "no_live_sender", registration_id: null, kind: null, previous_status: null });
    const s = await seedStudio("reg-released");
    const id = await seedActiveSender(s, phone());
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [id]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [id]);
    expect((await record(s.studioId, "approved")).result).toBe("no_live_sender");
  });

  it("refuses invalid input and writes nothing", async () => {
    for (const args of [
      ["delivered", null, null],
      ["requires_information", null, null],
      ["requires_information", "   ", null],
      ["approved", "something", null],
      ["requires_information", "x".repeat(301), null],
      ["approved", null, "has spaces"],
    ] as const) {
      expect((await record(a.studioId, args[0], args[1], args[2])).result, JSON.stringify(args)).toBe("invalid_input");
    }
    for (const shown of [null, "", "2125550123", "+442071234567", "not a number"]) {
      expect((await record(a.studioId, "approved", null, null, { phone: shown })).result, String(shown)).toBe("invalid_input");
    }
    expect((await record(a.studioId, "approved")).result).toBe("recorded");
    const n = await adminQuery("select count(*)::int n from public.studio_sms_sender_registrations where sender_id = $1", [senderA]);
    expect(n.rows[0].n).toBe(1);
  });

});

describe("the kind is the number's (Codex P2 4244484022)", () => {
  it("a toll-free number is recorded as toll-free verification, a long code as 10DLC; the caller never chooses", async () => {
    const tf = await seedStudio("reg-tollfree");
    await seedActiveSender(tf, `+1888${String(Math.floor(2_000_000 + Math.random() * 7_999_999))}`);
    expect(await record(tf.studioId, "approved")).toMatchObject({ result: "recorded", kind: "toll_free_verification" });
    const ca = await seedStudio("reg-canadian");
    await seedActiveSender(ca, `+1416${String(Math.floor(2_000_000 + Math.random() * 7_999_999))}`);
    expect(await record(ca.studioId, "approved")).toMatchObject({ result: "recorded", kind: "us_10dlc" });
  });

  it("no other pairing can be stored, even by a superuser", async () => {
    const { rows } = await adminQuery("select phone_number from public.studio_sms_senders where id = $1", [senderA]);
    await expect(
      adminQuery(
        "insert into public.studio_sms_sender_registrations (studio_id, sender_id, phone_number, kind, status) values ($1, $2, $3, 'toll_free_verification', 'approved')",
        [a.studioId, senderA, rows[0].phone_number],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      adminQuery(
        "insert into public.studio_sms_sender_registrations (studio_id, sender_id, phone_number, kind, status) values ($1, $2, '+18885550123', 'us_10dlc', 'approved')",
        [a.studioId, senderA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("evidence is bound to the number support verified (Codex P2 4244484021)", () => {
  it("a sender with no number yet is refused, whatever the operator submits", async () => {
    const s = await seedStudio("reg-nonumber");
    const { rows } = await adminQuery(
      "insert into public.studio_sms_senders (studio_id, provider, status, country, claimed_phone_number, provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id, provisioning_lease_generation) values ($1, 'twilio', 'selecting', 'US', $2, $3, now(), $4, 1) returning id",
      [s.studioId, phone(), `hone-sms-${hex(16)}`, s.practitionerId],
    );
    const id = rows[0].id as string;
    expect(await record(s.studioId, "approved", null, null, { sender: id, phone: phone() })).toEqual({
      result: "sender_has_no_number",
      registration_id: null,
      kind: null,
      previous_status: null,
    });
    const n = await adminQuery("select count(*)::int n from public.studio_sms_sender_registrations where sender_id = $1", [id]);
    expect(n.rows[0].n).toBe(0);
  });

  it("a number the operator did not see is refused on the SAME sender id, and nothing is written", async () => {
    const s = await seedStudio("reg-wrongnumber");
    const shown = phone();
    const id = await seedActiveSender(s, shown);
    let other = phone();
    while (other === shown) other = phone();
    expect(await record(s.studioId, "approved", null, null, { sender: id, phone: other })).toEqual({
      result: "sender_changed",
      registration_id: null,
      kind: null,
      previous_status: null,
    });
    expect((await snapshot(s.studioId)).registrations).toEqual([]);
    expect(await record(s.studioId, "approved", null, null, { sender: id, phone: shown })).toMatchObject({ result: "recorded" });
  });

  it("a sender row never changes number (0191 write-once), so per-number evidence cannot follow it to another", async () => {
    await expect(renumber(senderA, phone())).rejects.toThrow(/write-once/);
  });

  it("the snapshot never returns a row for a number other than the one the sender holds", async () => {
    // Simulate legacy or hand-made history: a row for a number this sender does not hold.
    const s = await seedStudio("reg-history");
    const held = phone();
    const id = await seedActiveSender(s, held);
    let stale = phone();
    while (stale === held) stale = phone();
    await adminQuery(
      "insert into public.studio_sms_sender_registrations (studio_id, sender_id, phone_number, kind, status) values ($1, $2, $3, 'us_10dlc', 'approved')",
      [s.studioId, id, stale],
    );
    expect((await snapshot(s.studioId)).registrations).toEqual([]);
    await record(s.studioId, "pending");
    expect((await snapshot(s.studioId)).registrations).toEqual([
      expect.objectContaining({ sender_id: id, phone_number: held, status: "pending" }),
    ]);
  });

  it("the owner reads the number on each row, so readiness can ignore another number's evidence", async () => {
    const own = await asUser(a.userId, (q) => q("select phone_number from public.studio_sms_sender_registrations"));
    const { rows } = await adminQuery("select phone_number from public.studio_sms_senders where id = $1", [senderA]);
    expect(own.rows.map((r) => r.phone_number)).toEqual([rows[0].phone_number]);
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
      // 0229 adds provisioned_at to each sender, additively.
      { id, studio_id: s.studioId, status: "active", phone_number: num, messaging_service_sid: expect.stringMatching(/^MG/), provisioned_at: expect.any(String) },
    ]);
    // 0229 adds campaign_bindings, additively.
    expect((await snapshot(none.studioId))).toEqual({ senders: [], registrations: [], campaign_bindings: [] });
  });

  it("returns the LIVE number's evidence only, never a released predecessor's", async () => {
    const s = await seedStudio("reg-replaced");
    const old = await seedActiveSender(s, phone());
    await record(s.studioId, "approved");
    await adminQuery("update public.studio_sms_senders set status = 'releasing' where id = $1", [old]);
    await adminQuery("update public.studio_sms_senders set status = 'released', released_at = now() where id = $1", [old]);
    const replacement = await seedActiveSender(s, phone());
    await record(s.studioId, "pending");

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
    expect(await record(s.studioId, "approved", null, null, { sender: shown })).toEqual({ result: "sender_changed", registration_id: null, kind: null, previous_status: null });
    expect((await snapshot(s.studioId)).registrations).toEqual([]);
  });

  it("another studio's sender id is never accepted", async () => {
    expect((await record(a.studioId, "approved", null, null, { sender: senderB })).result).toBe("sender_changed");
  });

  it("a missing expected sender is invalid input", async () => {
    expect((await record(a.studioId, "approved", null, null, { sender: null })).result).toBe("invalid_input");
  });

  it("a release that races the write waits for it: the sender row is locked until the record commits", async () => {
    const { Client } = await import("pg");
    const { resolveLocalDbUrl } = await import("./helpers/harness");
    const s = await seedStudio("reg-race");
    const num = phone();
    const id = await seedActiveSender(s, num);
    const writer = new Client({ connectionString: resolveLocalDbUrl() });
    const releaser = new Client({ connectionString: resolveLocalDbUrl() });
    await Promise.all([writer.connect(), releaser.connect()]);
    try {
      await writer.query("begin");
      const w = await writer.query(
        "select result from public.record_studio_sms_sender_registration($1, $2, $3, 'approved', null, null, null)",
        [s.studioId, id, num],
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
    expect(own.rows.map((r) => r.kind)).toEqual(["us_10dlc"]);
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
        `insert into public.studio_sms_sender_registrations (studio_id, sender_id, phone_number, kind, status) values ('${a.studioId}', '${senderA}', '+12125550123', 'us_10dlc', 'approved')`,
        "update public.studio_sms_sender_registrations set status = 'approved'",
        "delete from public.studio_sms_sender_registrations",
      ]) {
        await expect(asRole(role, (q) => q(sql)), `${role}: ${sql.slice(0, 30)}`).rejects.toMatchObject({ code: "42501" });
      }
    }
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (q) => q("select * from public.record_studio_sms_sender_registration($1, $2, $3, 'approved', null, null, null)", [a.studioId, senderA, NO_PHONE])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    const phoneB = (await liveSender(b.studioId))?.phone;
    // A fresh form: the version of whatever record b already holds (or none).
    const shownB = await shownVersion(b.studioId, senderB, phoneB);
    const ok = await asRole("service_role", (q) =>
      q("select result from public.record_studio_sms_sender_registration($1, $2, $3, 'approved', null, null, $4)", [b.studioId, senderB, phoneB, shownB]),
    );
    expect(ok.rows[0].result).toBe("recorded");
  });

  it("deleting the sender takes its evidence with it", async () => {
    const s = await seedStudio("reg-cascade");
    const id = await seedActiveSender(s, phone());
    await record(s.studioId, "approved");
    await adminQuery("delete from public.studio_sms_senders where id = $1", [id]);
    const n = await adminQuery("select count(*)::int n from public.studio_sms_sender_registrations where studio_id = $1", [s.studioId]);
    expect(n.rows[0].n).toBe(0);
  });
});

// Codex P2 4253653241 and 4253770080: the reference is stored exactly as
// submitted (clearable), and the command reports the status it replaced.
describe("reference clearing and the replaced status", () => {
  it("an emptied reference CLEARS the stored one; the command returns the previous status", async () => {
    const s = await seedStudio("reg-clear");
    await seedActiveSender(s, phone());
    const first = await record(s.studioId, "approved", null, "BN1234abcd");
    expect(first).toMatchObject({ result: "recorded" });
    expect((first as Record<string, unknown>).previous_status).toBeNull();
    const second = await record(s.studioId, "suspended", null, null);
    expect((second as Record<string, unknown>).previous_status).toBe("approved");
    const { rows } = await adminQuery("select status, provider_reference from public.studio_sms_sender_registrations where id = $1", [first.registration_id]);
    expect(rows[0]).toEqual({ status: "suspended", provider_reference: null });
  });
});

// Codex P2 on #844 (6a6aa5ec): concurrent registration writes are SERIALIZED,
// so each write's previous_status (which the audit records) is the real one.
// Codex P2 4266275222: and a write may replace only the record its form showed.
describe("concurrent registration writes take turns, and a stale form never wins", () => {
  const RECORD = "select * from public.record_studio_sms_sender_registration($1, $2, $3, $4, $5, $6, $7)";

  it("two forms loaded from the same record: the second waits its turn, then is REFUSED as stale; the first's decision stands", async () => {
    const { Client } = await import("pg");
    const { resolveLocalDbUrl } = await import("./helpers/harness");
    const s = await seedStudio("reg-serial");
    const num = phone();
    const id = await seedActiveSender(s, num);
    await record(s.studioId, "pending");
    // Both operators load the page now: the same record, the same version.
    const loaded = await shownVersion(s.studioId, id, num);
    expect(loaded).not.toBeNull();
    const one = new Client({ connectionString: resolveLocalDbUrl() });
    const two = new Client({ connectionString: resolveLocalDbUrl() });
    await Promise.all([one.connect(), two.connect()]);
    try {
      await one.query("begin");
      const first = await one.query(RECORD, [s.studioId, id, num, "approved", null, null, loaded]);
      expect(first.rows[0]).toMatchObject({ result: "recorded", previous_status: "pending" });
      // The second writer starts WHILE the first is uncommitted and waits at the
      // sender lock, BEFORE it reads the record it would replace.
      const secondP = two.query(RECORD, [s.studioId, id, num, "suspended", null, null, loaded]);
      await new Promise((r) => setTimeout(r, 300));
      await one.query("commit");
      const second = await secondP;
      // It sees the first's committed record (approved), not the stale pending.
      expect(second.rows[0]).toMatchObject({ result: "stale_record", registration_id: null, previous_status: "approved" });
    } finally {
      await Promise.all([one.end(), two.end()]);
    }
    expect((await snapshot(s.studioId)).registrations[0]).toMatchObject({ status: "approved" });
    // Reloaded, the second operator decides against the CURRENT record.
    expect(await record(s.studioId, "suspended")).toMatchObject({ result: "recorded", previous_status: "approved" });
  });

  it("THE LOST UPDATE Codex describes: approved -> suspended by one operator; another's stale reference edit cannot restore approved", async () => {
    const s = await seedStudio("reg-lost-update");
    const num = phone();
    const id = await seedActiveSender(s, num);
    await record(s.studioId, "approved", null, "BN-OLD");
    const staleForm = await shownVersion(s.studioId, id, num);
    // Operator A suspends it.
    expect(await record(s.studioId, "suspended", null, "BN-OLD")).toMatchObject({ result: "recorded", previous_status: "approved" });
    // Operator B, still showing "approved", edits only the reference.
    expect(await record(s.studioId, "approved", null, "BN-NEW", { updatedAt: staleForm })).toMatchObject({ result: "stale_record", previous_status: "suspended" });
    expect((await snapshot(s.studioId)).registrations[0]).toMatchObject({ status: "suspended", provider_reference: "BN-OLD" });
  });

  it("a form that showed NO record cannot overwrite one recorded since, and a form that showed one cannot write when none exists", async () => {
    const s = await seedStudio("reg-stale-none");
    const num = phone();
    const id = await seedActiveSender(s, num);
    // Loaded while there was no record.
    const empty = await shownVersion(s.studioId, id, num);
    expect(empty).toBeNull();
    expect(await record(s.studioId, "approved")).toMatchObject({ result: "recorded", previous_status: null });
    expect(await record(s.studioId, "rejected", null, null, { updatedAt: null })).toMatchObject({ result: "stale_record", previous_status: "approved" });
    // A version for a record that does not exist (another number's form).
    const other = await seedStudio("reg-stale-phantom");
    const otherNum = phone();
    await seedActiveSender(other, otherNum);
    expect(await record(other.studioId, "approved", null, null, { updatedAt: "2026-01-01T00:00:00+00:00" })).toMatchObject({ result: "stale_record", previous_status: null });
    expect((await snapshot(other.studioId)).registrations).toEqual([]);
  });
});

// Codex P2 4274747633: a live sender with an other-NANP number (a Caribbean
// member such as +1876) is not a number Hone serves; no registration evidence
// can be recorded for it, by the command or by any direct write.
describe("unsupported NANP senders", () => {
  it("the command refuses an other-NANP sender (+1876), and writes nothing", async () => {
    const s = await seedStudio("reg-other-nanp");
    const jm = `+1876555${String(Math.floor(1000 + Math.random() * 9000))}`;
    await seedActiveSender(s, jm);
    expect(await record(s.studioId, "approved")).toMatchObject({ result: "unsupported_number", registration_id: null });
    expect((await snapshot(s.studioId)).registrations).toEqual([]);
  });

  it("the table refuses other-NANP and N11 numbers even from a direct write", async () => {
    const s = await seedStudio("reg-other-nanp-direct");
    const id = await seedActiveSender(s, phone());
    for (const bad of ["+18765550123", "+12465550123", "+18095550123", "+14115550123"]) {
      await expect(
        adminQuery(
          "insert into public.studio_sms_sender_registrations (studio_id, sender_id, phone_number, kind, status) values ($1, $2, $3, 'us_10dlc', 'approved')",
          [s.studioId, id, bad],
        ),
        bad,
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});
