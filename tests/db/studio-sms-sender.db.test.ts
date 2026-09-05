import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asRole,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// COMMS-01B — the BEHAVIOURAL half of migration 0191.
//
// tests/migrations/0191-*.test.ts proves what the migration SAYS. This file
// proves what PostgreSQL DOES, and the difference matters: SQL text cannot
// demonstrate that a partial unique index actually excludes a second live row,
// that a BEFORE UPDATE trigger actually refuses a reminted claim key, or that a
// CHECK actually blocks `active`. Only the database can.
//
// It also proves the half that the unit suite structurally cannot. The
// in-memory store in tests/lib/sms/provisioning.test.ts is written to this
// contract; if the contract is not real, that suite is green and wrong.
//
// Every assertion is scoped by ids seeded here, never by global counts, so the
// file is safe to re-run against a database other worktrees are sharing.

let a: SeededStudio; // studio A
let b: SeededStudio; // studio B
let aMember: { userId: string; practitionerId: string }; // non-owner in A

type ClaimRow = {
  result: string;
  sender_id: string | null;
  claim_key: string | null;
  sender_status: string | null;
};

async function claim(
  studioId: string,
  actorUserId: string,
  country = "CA",
  areaCode: string | null = "416",
): Promise<ClaimRow> {
  const res = await adminQuery(
    `select result, sender_id, claim_key, sender_status
       from public.claim_studio_sms_provisioning($1, $2, $3, $4)`,
    [studioId, actorUserId, country, areaCode],
  );
  return res.rows[0] as ClaimRow;
}

async function finalize(
  studioId: string,
  claimKey: string,
  phoneNumber: string,
  phoneNumberSid: string,
  messagingServiceSid: string,
  testOk: boolean,
): Promise<string> {
  const res = await adminQuery(
    `select public.finalize_studio_sms_provisioning($1, $2, $3, $4, $5, $6) as r`,
    [studioId, claimKey, phoneNumber, phoneNumberSid, messagingServiceSid, testOk],
  );
  return (res.rows[0] as { r: string }).r;
}

async function failAttempt(
  studioId: string,
  claimKey: string,
  code: string,
): Promise<string> {
  const res = await adminQuery(
    `select public.fail_studio_sms_provisioning($1, $2, $3) as r`,
    [studioId, claimKey, code],
  );
  return (res.rows[0] as { r: string }).r;
}

async function row(studioId: string) {
  const res = await adminQuery(
    `select * from public.studio_sms_senders
      where studio_id = $1 and status <> 'released'`,
    [studioId],
  );
  return res.rows[0] as Record<string, unknown> | undefined;
}

/** Deterministic, shape-valid provider identifiers for a test. */
const pn = (seed: string) => `PN${seed.repeat(32).slice(0, 32)}`;
const mg = (seed: string) => `MG${seed.repeat(32).slice(0, 32)}`;

beforeAll(async () => {
  a = await seedStudio("comms01b-a");
  b = await seedStudio("comms01b-b");
  aMember = await seedMember(a, "comms01b-a-member");
});

afterAll(async () => {
  await adminQuery(`delete from public.studio_sms_senders where studio_id = any($1)`, [
    [a.studioId, b.studioId],
  ]);
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Authorization is the database's decision
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("OWNER_OWN_STUDIO: the owner may claim", async () => {
    const claimed = await claim(a.studioId, a.userId);
    expect(claimed.result).toBe("claimed");
    expect(claimed.claim_key).toMatch(/^hone-sms-[0-9a-f]{32}$/);
    expect(claimed.sender_status).toBe("provisioning");
    // Attribution is the verified owner, not anything the caller supplied.
    expect((await row(a.studioId))?.provisioning_claim_by_practitioner_id).toBe(
      a.practitionerId,
    );
  });

  it("NON_OWNER_REFUSED: an active non-owner member is refused", async () => {
    const attempt = await claim(b.studioId, aMember.userId);
    // Not even a member of B, so the membership check refuses first.
    expect(attempt.result).toBe("not_a_member");

    const inOwnStudio = await claim(a.studioId, aMember.userId);
    expect(inOwnStudio.result).toBe("not_owner");
    expect(inOwnStudio.claim_key).toBeNull();
  });

  it("CROSS_STUDIO_REFUSED: studio B's owner cannot claim for studio A", async () => {
    const attempt = await claim(a.studioId, b.userId);
    expect(attempt.result).toBe("not_a_member");
    expect(attempt.claim_key).toBeNull();
    // And no row was created for A beyond the one the owner made.
    const res = await adminQuery(
      `select count(*)::int as n from public.studio_sms_senders where studio_id = $1`,
      [a.studioId],
    );
    expect((res.rows[0] as { n: number }).n).toBe(1);
  });

  it("an unknown studio is refused without leaking whether it exists", async () => {
    const attempt = await claim(
      "00000000-0000-0000-0000-000000000000",
      a.userId,
    );
    expect(attempt.result).toBe("studio_not_found");
  });
});

// ---------------------------------------------------------------------------
// 2. The claim excludes
// ---------------------------------------------------------------------------

describe("DOUBLE_SUBMIT_ONE_CLAIM", () => {
  it("a second submit while a claim is live is turned away with no key", async () => {
    const second = await claim(a.studioId, a.userId);
    expect(second.result).toBe("claim_held");
    // NO KEY. A second request holding the key would reconcile (finding
    // nothing, since the first has not purchased) and buy in parallel.
    expect(second.claim_key).toBeNull();
  });

  it("ONE LIVE SENDER PER STUDIO is enforced by the index, not by the command", async () => {
    // Bypass the command entirely and try to open a second live row directly.
    await expect(
      adminQuery(
        `insert into public.studio_sms_senders
           (studio_id, status, provisioning_claim_key, provisioning_claim_at,
            provisioning_claim_by_practitioner_id)
         values ($1, 'provisioning', $2, now(), $3)`,
        [a.studioId, `hone-sms-${"c".repeat(32)}`, a.practitionerId],
      ),
    ).rejects.toThrow(/one_live_per_studio|duplicate key/i);
  });

  it("a stale lease is taken over ON THE SAME KEY", async () => {
    const before = await row(a.studioId);
    const key = before?.provisioning_claim_key as string;

    // Age the lease past its window.
    await adminQuery(
      `update public.studio_sms_senders
          set provisioning_claim_at = now() - interval '10 minutes'
        where studio_id = $1 and status <> 'released'`,
      [a.studioId],
    );

    const takeover = await claim(a.studioId, a.userId);
    expect(takeover.result).toBe("claimed");
    // Same key: the takeover can still discover what the crashed attempt bought.
    expect(takeover.claim_key).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// 3. The write-once claim key — the anti-double-purchase invariant
// ---------------------------------------------------------------------------

describe("the claim key is write-once", () => {
  it("REFUSES a reminted key, even from the table owner", async () => {
    // NEGATIVE CONTROL, performed for real. This is the single mutation that
    // would let a retry lose its handle on an already-purchased number.
    await expect(
      adminQuery(
        `update public.studio_sms_senders
            set provisioning_claim_key = $2
          where studio_id = $1 and status <> 'released'`,
        [a.studioId, `hone-sms-${"d".repeat(32)}`],
      ),
    ).rejects.toThrow(/write-once/i);
  });

  it("refuses to clear the key", async () => {
    await expect(
      adminQuery(
        `update public.studio_sms_senders set provisioning_claim_key = null
          where studio_id = $1 and status <> 'released'`,
        [a.studioId],
      ),
    ).rejects.toThrow(/write-once|claim_evidence|claim_required/i);
  });

  it("refuses to backdate the lease", async () => {
    await expect(
      adminQuery(
        `update public.studio_sms_senders
            set provisioning_claim_at = now() - interval '1 day'
          where studio_id = $1 and status <> 'released'`,
        [a.studioId],
      ),
    ).rejects.toThrow(/forward only/i);
  });

  it("the key is globally unique across studios", async () => {
    const aKey = (await row(a.studioId))?.provisioning_claim_key as string;
    const bClaim = await claim(b.studioId, b.userId);
    expect(bClaim.claim_key).not.toBe(aKey);

    await expect(
      adminQuery(
        `update public.studio_sms_senders
            set provisioning_claim_key = $2
          where studio_id = $1 and status <> 'released'`,
        [b.studioId, aKey],
      ),
    ).rejects.toThrow(/write-once|duplicate key|claim_key_unique/i);
  });
});

// ---------------------------------------------------------------------------
// 4. INCOMPLETE_PROVISIONING cannot become ACTIVE
// ---------------------------------------------------------------------------

describe("readiness", () => {
  it("finalize without a passing test records identifiers but does NOT activate", async () => {
    const key = (await row(a.studioId))?.provisioning_claim_key as string;
    const result = await finalize(
      a.studioId,
      key,
      "+14165550100",
      pn("a"),
      mg("a"),
      false,
    );
    expect(result).toBe("provisioned_untested");

    const after = await row(a.studioId);
    expect(after?.status).toBe("provisioning");
    expect(after?.phone_number_sid).toBe(pn("a"));
    expect(after?.last_test_ok_at).toBeNull();
  });

  it("REFUSES a hand-written active row with no test proof", async () => {
    // NEGATIVE CONTROL. The constraint does not consult who is writing, so
    // even the table owner cannot activate an unproven sender.
    await expect(
      adminQuery(
        `update public.studio_sms_senders set status = 'active'
          where studio_id = $1 and status <> 'released'`,
        [a.studioId],
      ),
    ).rejects.toThrow(/active_readiness/i);
  });

  it("activates once the test passes", async () => {
    const key = (await row(a.studioId))?.provisioning_claim_key as string;
    const result = await finalize(
      a.studioId,
      key,
      "+14165550100",
      pn("a"),
      mg("a"),
      true,
    );
    expect(result).toBe("activated");
    const after = await row(a.studioId);
    expect(after?.status).toBe("active");
    expect(after?.last_test_ok_at).not.toBeNull();
  });

  it("replaying the same finalize is benign", async () => {
    const key = (await row(a.studioId))?.provisioning_claim_key as string;
    expect(
      await finalize(a.studioId, key, "+14165550100", pn("a"), mg("a"), true),
    ).toBe("already_active");
  });

  it("finalizing DIFFERENT resources against the same claim is a conflict, never an overwrite", async () => {
    const key = (await row(a.studioId))?.provisioning_claim_key as string;
    expect(
      await finalize(a.studioId, key, "+14165550999", pn("e"), mg("e"), true),
    ).toBe("conflict");
    // The recorded resource is untouched.
    expect((await row(a.studioId))?.phone_number_sid).toBe(pn("a"));
  });

  it("a claim key from another studio cannot finalize this one", async () => {
    const bKey = (await row(b.studioId))?.provisioning_claim_key as string;
    expect(
      await finalize(a.studioId, bKey, "+14165550100", pn("a"), mg("a"), true),
    ).toBe("claim_not_found");
  });
});

// ---------------------------------------------------------------------------
// 5. A failed attempt is never reset
// ---------------------------------------------------------------------------

describe("failure keeps the claim", () => {
  it("fail parks the attempt in error WITHOUT surrendering the key", async () => {
    const key = (await row(b.studioId))?.provisioning_claim_key as string;
    expect(await failAttempt(b.studioId, key, "provider_timeout")).toBe("failed");

    const after = await row(b.studioId);
    expect(after?.status).toBe("error");
    expect(after?.last_error_code).toBe("provider_timeout");
    // THE POINT: the key survives, so anything purchased under it is findable.
    expect(after?.provisioning_claim_key).toBe(key);
  });

  it("a non-conforming error tag is coerced, never stored", async () => {
    // A provider message or a phone number must not be parkable here.
    const fresh = await seedStudio("comms01b-c");
    const claimed = await claim(fresh.studioId, fresh.userId);
    await failAttempt(fresh.studioId, claimed.claim_key!, "+1 416 555 0100 rejected by carrier");
    expect((await row(fresh.studioId))?.last_error_code).toBe(
      "provider_error_unspecified",
    );
    await adminQuery(`delete from public.studio_sms_senders where studio_id = $1`, [
      fresh.studioId,
    ]);
  });

  it("REFUSES error -> off", async () => {
    // NEGATIVE CONTROL. "Reset and start over" is the gesture that abandons a
    // possibly-purchased number and buys another.
    await expect(
      adminQuery(
        `update public.studio_sms_senders set status = 'off'
          where studio_id = $1 and status = 'error'`,
        [b.studioId],
      ),
    ).rejects.toThrow(/illegal sender transition/i);
  });

  it("a retry from error reuses the same key", async () => {
    const before = (await row(b.studioId))?.provisioning_claim_key as string;
    const retry = await claim(b.studioId, b.userId);
    expect(retry.result).toBe("claimed");
    expect(retry.claim_key).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 6. Shape and provider-resource integrity
// ---------------------------------------------------------------------------

describe("provider identifiers", () => {
  it("rejects a malformed SID outright", async () => {
    const fresh = await seedStudio("comms01b-d");
    const claimed = await claim(fresh.studioId, fresh.userId);
    // Fail-closed at the schema, not only in the adapter.
    await expect(
      adminQuery(
        `update public.studio_sms_senders set phone_number_sid = 'not-a-sid'
          where studio_id = $1`,
        [fresh.studioId],
      ),
    ).rejects.toThrow(/phone_number_sid_check/i);
    expect(claimed.result).toBe("claimed");
    await adminQuery(`delete from public.studio_sms_senders where studio_id = $1`, [
      fresh.studioId,
    ]);
  });

  it("two studios cannot record the same messaging service", async () => {
    const fresh = await seedStudio("comms01b-e");
    const claimed = await claim(fresh.studioId, fresh.userId);
    // mg("a") already belongs to studio A.
    expect(
      await finalize(fresh.studioId, claimed.claim_key!, "+14165550777", pn("f"), mg("a"), true),
    ).toBe("invalid_input");
    await adminQuery(`delete from public.studio_sms_senders where studio_id = $1`, [
      fresh.studioId,
    ]);
  });

  it("resolves an inbound callback to exactly one studio", async () => {
    const res = await adminQuery(
      `select public.resolve_studio_by_sms_messaging_service($1) as studio_id`,
      [mg("a")],
    );
    expect((res.rows[0] as { studio_id: string }).studio_id).toBe(a.studioId);
  });

  it("an unknown messaging service resolves to NOBODY, not to any studio", async () => {
    const res = await adminQuery(
      `select public.resolve_studio_by_sms_messaging_service($1) as studio_id`,
      [mg("z")],
    );
    expect((res.rows[0] as { studio_id: string | null }).studio_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Privileges
// ---------------------------------------------------------------------------

describe("privileges", () => {
  it.each(["anon", "authenticated"] as const)(
    "%s cannot execute any provisioning command",
    async (role) => {
      await asRole(role, async (q) => {
        for (const call of [
          `select * from public.claim_studio_sms_provisioning($1, $2, 'CA', '416')`,
          `select public.fail_studio_sms_provisioning($1, 'hone-sms-${"0".repeat(32)}', 'x_y_z')`,
        ]) {
          await expect(q(call, [a.studioId, a.userId].slice(0, (call.match(/\$/g) ?? []).length)))
            .rejects.toThrow(/permission denied/i);
        }
      });
    },
  );

  it("authenticated cannot read a provider identifier even for its own studio", async () => {
    // The grant is COLUMN-LEVEL: status is readable, the SIDs are not.
    await asRole("authenticated", async (q) => {
      await expect(
        q(`select phone_number_sid from public.studio_sms_senders limit 1`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        q(`select provisioning_claim_key from public.studio_sms_senders limit 1`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("anon cannot read the table at all", async () => {
    await asRole("anon", async (q) => {
      await expect(
        q(`select status from public.studio_sms_senders limit 1`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("authenticated cannot write the table directly", async () => {
    await asRole("authenticated", async (q) => {
      await expect(
        q(`update public.studio_sms_senders set status = 'active'`),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
