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

const A_SID = "MG000000000000000000000000000a01";
const B_SID = "MG000000000000000000000000000b01";

/** Put a studio's sender row directly into a given terminal state. */
async function seedSender(
  studioId: string,
  status: string,
  sid: string,
  complete = true,
): Promise<void> {
  // The readiness CHECK makes `active` unreachable without the full set, so a
  // complete row is required for the active cases and deliberately withheld
  // for the non-active ones.
  await adminQuery(
    `insert into public.studio_sms_senders
       (studio_id, provider, status, country, phone_number, phone_number_sid,
        messaging_service_sid, provisioned_at, last_test_ok_at)
     values ($1, 'twilio', $2, 'CA',
             case when $4 then '+15555550100' end,
             case when $4 then 'PN' || repeat('a', 32) end,
             $3,
             case when $4 then now() end,
             case when $4 then now() end)`,
    [studioId, status, sid, complete],
  );
}

beforeAll(async () => {
  studioA = await seedStudio("sms-out-a");
  studioB = await seedStudio("sms-out-b");
  await seedSender(studioA.studioId, "active", A_SID);
  await seedSender(studioB.studioId, "active", B_SID);
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
    await seedSender(pending.studioId, "provisioning", "MG0000000000000000000000000p01", false);
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
