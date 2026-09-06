import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// COMMS-01B2 — the BEHAVIOURAL half of migration 0192.
//
// tests/migrations/0192-*.test.ts proves what the migration SAYS. This file
// proves what PostgreSQL DOES, and only the database can show the difference:
// that a revoke line actually denies EXECUTE, that service_role still cannot
// read the table it is resolving through, and that a non-active row genuinely
// resolves to nothing rather than to a number nobody proved.
//
// THE BOUNDARY UNDER TEST. 0191 revokes ALL on studio_sms_senders from every
// application role and re-grants a column-level select to `authenticated` that
// omits the provider identifiers. 0192 must add exactly one capability across
// that boundary and no more: a definer lookup returning one studio's messaging
// service. If it ever became possible to read the table directly, or to call
// the lookup as anon or authenticated, the boundary would be gone and these
// tests are what say so.

let studioA: SeededStudio;
let studioB: SeededStudio;

const A_SID = "MG" + "a2".repeat(16);
const B_SID = "MG" + "b2".repeat(16);

/**
 * Seed one studio's sender row directly into a terminal state.
 *
 * REBUILT AGAINST THE FINAL 0191 SCHEMA. The earlier version of this helper was
 * not schema-valid and review said so: every status other than `off` requires a
 * complete provisioning claim, and two rows cannot share a number or a SID.
 * The final 0191 enforces all of it, so the fixture must satisfy, per row:
 *
 *   * the CLAIM EVIDENCE TRIPLE — key + instant + actor arrive together or not
 *     at all (studio_sms_senders_claim_evidence_check), and the actor must be a
 *     practitioner OF THAT STUDIO (composite FK to practitioners(id, studio_id));
 *   * claimed_phone_number present for any non-`off` status, and
 *     phone_number = claimed_phone_number — what was bought is what was claimed;
 *   * the shape checks: +E.164, PN + 32 hex, MG + 32 hex, hone-sms- + 32 hex;
 *   * for `active` specifically, the readiness check: both SIDs, the number,
 *     provisioned_at AND last_test_ok_at;
 *   * global uniqueness of phone_number_sid, messaging_service_sid and the
 *     claim key — so A and B must be given genuinely DISTINCT evidence, not the
 *     same literals twice.
 */
async function seedSender(
  s: SeededStudio,
  status: string,
  ev: { phone: string; pnSid: string; msgSid: string; claimKey: string },
  complete = true,
): Promise<void> {
  await adminQuery(
    `insert into public.studio_sms_senders
       (studio_id, provider, status, country,
        claimed_phone_number, phone_number, phone_number_sid, messaging_service_sid,
        provisioning_claim_key, provisioning_claim_at, provisioning_claim_by_practitioner_id,
        provisioning_lease_generation, provisioned_at, last_test_ok_at)
     values ($1, 'twilio', $2, 'CA',
             $3,
             case when $7 then $3 end,
             case when $7 then $4 end,
             $5,
             $6, now(), $8,
             1,
             case when $7 then now() end,
             case when $7 then now() end)`,
    [s.studioId, status, ev.phone, ev.pnSid, ev.msgSid, ev.claimKey, complete, s.practitionerId],
  );
}

const EV_A = {
  phone: "+15555550101",
  pnSid: "PN" + "a1".repeat(16),
  msgSid: "MG" + "a2".repeat(16),
  claimKey: "hone-sms-" + "a3".repeat(16),
};
const EV_B = {
  phone: "+15555550202",
  pnSid: "PN" + "b1".repeat(16),
  msgSid: "MG" + "b2".repeat(16),
  claimKey: "hone-sms-" + "b3".repeat(16),
};

beforeAll(async () => {
  studioA = await seedStudio("sms-out-a");
  studioB = await seedStudio("sms-out-b");
  await seedSender(studioA, "active", EV_A);
  await seedSender(studioB, "active", EV_B);
});

afterAll(async () => {
  await adminQuery(
    `delete from public.studio_sms_senders where studio_id = any($1::uuid[])`,
    [[studioA.studioId, studioB.studioId]],
  ).catch(() => {});
  await closePool();
});

describe("the lookup resolves each studio to its own sender", () => {
  it("Studio A resolves A's messaging service", async () => {
    const r = await asRole("service_role", (q) =>
      q(`select messaging_service_sid from public.resolve_active_studio_sms_sender($1)`, [
        studioA.studioId,
      ]),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].messaging_service_sid).toBe(A_SID);
  });

  it("Studio B resolves B's, and A's lookup never returns it", async () => {
    const b = await asRole("service_role", (q) =>
      q(`select messaging_service_sid from public.resolve_active_studio_sms_sender($1)`, [
        studioB.studioId,
      ]),
    );
    expect(b.rows[0].messaging_service_sid).toBe(B_SID);

    const a = await asRole("service_role", (q) =>
      q(`select messaging_service_sid from public.resolve_active_studio_sms_sender($1)`, [
        studioA.studioId,
      ]),
    );
    // The whole point of per-studio routing: A can never transmit B's SID.
    expect(a.rows.map((x: { messaging_service_sid: string }) => x.messaging_service_sid))
      .not.toContain(B_SID);
  });

  it("a studio with no sender row resolves to zero rows, not an error", async () => {
    const bare = await seedStudio("sms-out-bare");
    const r = await asRole("service_role", (q) =>
      q(`select messaging_service_sid from public.resolve_active_studio_sms_sender($1)`, [
        bare.studioId,
      ]),
    );
    // Absence is a fact, never a failure — the caller reports it as a
    // non-retryable configuration state, not as a transient read error.
    expect(r.rows).toHaveLength(0);
  });

  it("a NON-ACTIVE sender resolves to nothing", async () => {
    const pending = await seedStudio("sms-out-pending");
    await seedSender(
      pending,
      "provisioning",
      { phone: "+15555550303", pnSid: "PN" + "c1".repeat(16),
        msgSid: "MG" + "c2".repeat(16), claimKey: "hone-sms-" + "c3".repeat(16) },
      false,
    );
    const r = await asRole("service_role", (q) =>
      q(`select messaging_service_sid from public.resolve_active_studio_sms_sender($1)`, [
        pending.studioId,
      ]),
    );
    expect(r.rows).toHaveLength(0);
    await adminQuery(`delete from public.studio_sms_senders where studio_id = $1`, [
      pending.studioId,
    ]);
  });
});

describe("the routing-alert dedupe is enforced by PostgreSQL, under concurrency", () => {
  const EVENTS = [
    "sms_sender_not_active_for_studio",
    "sms_sender_ambiguous",
    "sms_sender_read_failed",
  ] as const;

  async function insertAlert(studioId: string, event: string) {
    return adminQuery(
      `insert into public.ops_alerts (severity, event, message, studio_id, safe_details)
       values ('warning', $2, 'routing failure', $1, '{}'::jsonb)`,
      [studioId, event],
    );
  }

  afterAll(async () => {
    await adminQuery(
      `delete from public.ops_alerts where studio_id = any($1::uuid[])`,
      [[studioA.studioId, studioB.studioId]],
    ).catch(() => {});
  });

  it("TWO SIMULTANEOUS inserts produce exactly ONE unresolved alert", async () => {
    // THE ACTUAL RACE. An application check-then-act cannot hold this: both
    // callers read zero open rows and both insert. Fired together with no
    // ordering between them, so the winner is decided by the index, not by us.
    const both = await Promise.allSettled([
      insertAlert(studioA.studioId, EVENTS[0]),
      insertAlert(studioA.studioId, EVENTS[0]),
    ]);
    const ok = both.filter((r) => r.status === "fulfilled").length;
    const conflicted = both.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string })?.code === "23505",
    ).length;

    expect(ok).toBe(1);
    expect(conflicted).toBe(1);

    const rows = await adminQuery(
      `select count(*)::int n from public.ops_alerts
        where studio_id = $1 and event = $2 and resolved_at is null`,
      [studioA.studioId, EVENTS[0]],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("a THIRD later attempt is still refused while the alert is open", async () => {
    await expect(insertAlert(studioA.studioId, EVENTS[0])).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("a DIFFERENT routing reason is independent", async () => {
    // Different faults need different operator actions, so one open alert must
    // never hide another.
    await expect(insertAlert(studioA.studioId, EVENTS[1])).resolves.toBeDefined();
    await expect(insertAlert(studioA.studioId, EVENTS[2])).resolves.toBeDefined();
  });

  it("a DIFFERENT studio is independent", async () => {
    await expect(insertAlert(studioB.studioId, EVENTS[0])).resolves.toBeDefined();
  });

  it("RESOLVING the alert re-arms it — nothing is suppressed forever", async () => {
    await adminQuery(
      `update public.ops_alerts set resolved_at = now()
        where studio_id = $1 and event = $2 and resolved_at is null`,
      [studioA.studioId, EVENTS[0]],
    );
    // The partial index only covers unresolved rows, so the recurrence lands.
    await expect(insertAlert(studioA.studioId, EVENTS[0])).resolves.toBeDefined();
    const rows = await adminQuery(
      `select count(*)::int n from public.ops_alerts
        where studio_id = $1 and event = $2 and resolved_at is null`,
      [studioA.studioId, EVENTS[0]],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("UNRELATED ops_alert events keep their existing many-open-rows semantics", async () => {
    // The index must not have quietly changed any other alert class.
    await expect(insertAlert(studioA.studioId, "cron_route_failed")).resolves.toBeDefined();
    await expect(insertAlert(studioA.studioId, "cron_route_failed")).resolves.toBeDefined();
    const rows = await adminQuery(
      `select count(*)::int n from public.ops_alerts
        where studio_id = $1 and event = 'cron_route_failed' and resolved_at is null`,
      [studioA.studioId],
    );
    expect(rows.rows[0].n).toBe(2);
  });
});

describe("ambiguity is unrepresentable, so the lookup can never pick a winner", () => {
  it("a SECOND live sender for one studio is refused by the database", async () => {
    // 0192's resolver returns a SET rather than a scalar precisely so a violated
    // invariant surfaces as ambiguity instead of a silently chosen first row.
    // This proves the invariant it leans on is real: one_live_per_studio is
    // UNIQUE (studio_id) WHERE status <> 'released', so the second row cannot
    // exist for the resolver to be ambiguous about.
    const dup = {
      phone: "+15555550404",
      pnSid: "PN" + "d1".repeat(16),
      msgSid: "MG" + "d2".repeat(16),
      claimKey: "hone-sms-" + "d3".repeat(16),
    };
    await expect(seedSender(studioA, "active", dup)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("the studio still resolves to exactly ONE sender afterwards", async () => {
    const r = await asRole("service_role", (q) =>
      q(`select messaging_service_sid from public.resolve_active_studio_sms_sender($1)`, [
        studioA.studioId,
      ]),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].messaging_service_sid).toBe(A_SID);
  });
});

describe("only the narrow function crosses 0191's boundary", () => {
  it("anon is DENIED execute", async () => {
    await expect(
      asRole("anon", (q) =>
        q(`select * from public.resolve_active_studio_sms_sender($1)`, [studioA.studioId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("authenticated is DENIED execute", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select * from public.resolve_active_studio_sms_sender($1)`, [studioA.studioId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("service_role STILL cannot read studio_sms_senders directly", async () => {
    // This is the assertion that proves 0192 did not widen 0191. If someone
    // "fixes" the dispatcher by granting SELECT instead, this turns red.
    await expect(
      asRole("service_role", (q) =>
        q(`select messaging_service_sid from public.studio_sms_senders limit 1`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("authenticated still cannot read the provider identifiers", async () => {
    // 0191 grants a column-level select that deliberately omits these.
    await expect(
      asRole("authenticated", (q) =>
        q(`select messaging_service_sid from public.studio_sms_senders limit 1`),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
