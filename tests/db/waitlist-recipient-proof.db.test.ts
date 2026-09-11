import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  adminQuery,
  asRole,
  closePool,
  resolveLocalDbUrl,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import {
  expectPostgresSameInstant,
  expectPostgresTemporalRelation,
  waitUntilBlocked,
} from "./helpers/waitlist-concurrency";

// 0192 — WAIT-03B recipient-proof authority, proved against a real PostgreSQL.
//
// The static contract (what the migration SAYS) is pinned in
// tests/migrations/0192-waitlist-recipient-proof-authority.test.ts. This file
// proves the BEHAVIOUR that file cannot see:
//
//   * that holding the bearer invitation URL really cannot redeem or decline;
//   * that the capability really is anchored by the DATABASE at 30 minutes and
//     that no caller argument exists to ask for 31;
//   * that a capability minted for one invitation really cannot act on another,
//     or on another studio's;
//   * that revoke / reissue / decline really invalidate outstanding proof;
//   * that the recipient binding is read from the STORED entry, so no
//     browser-supplied address is ever authority.
//
// Fixtures are isolated by run-unique identity (seedStudio mints random UUIDs),
// never by cleanup, so this suite is safe to re-run against the same database.

afterAll(async () => {
  await closePool();
});

const HEX64 = /^[a-f0-9]{64}$/;

type Offer = {
  studio: SeededStudio;
  serviceId: string;
  entryId: string;
  token: string;
  invitationId: string;
  email: string;
  // The STORED identity, carried so a test can assert the exact values the
  // database holds rather than a shape that merely looks plausible.
  name: string;
  phone: string | null;
};

async function seedService(studioId: string, label: string): Promise<string> {
  const r = await adminQuery(
    `insert into public.services (studio_id, name, default_duration_minutes, price_cents)
     values ($1, $2, 60, 10000) returning id`,
    [studioId, `Svc ${label}`],
  );
  return r.rows[0].id as string;
}

/**
 * Open a round through the SUPPORTED COMMAND, not a raw upsert.
 *
 * A round is now a durable row with its own identity, so there is no
 * "upsert by studio_id" to fall back on -- and a fixture that wrote the table
 * directly would be testing a path the product does not offer. Takes the
 * studio's owner, because the command re-derives authority from the session
 * user exactly as every other command here does.
 */
async function openRound(
  studioId: string,
  allowance: number,
  userId: string,
): Promise<string> {
  const r = await adminQuery(
    `select result, round_id
       from public.open_new_client_waitlist_admission_round($1, $2, $3)`,
    [studioId, userId, allowance],
  );
  expect(r.rows[0].result, "the fixture must actually open a round").toBe("opened");
  return r.rows[0].round_id as string;
}

/** A studio with an open round, a claimed entry, and one live SCOPED offer. */
async function seedOffer(
  label: string,
  allowance = 10,
  // OPTIONAL BY CONSTRUCTION, exactly as the public join form is: 0185 stores
  // the column nullable, so a null phone is an ordinary entry and the identity
  // command must return it as null rather than refusing.
  phone: string | null = null,
): Promise<Offer> {
  const studio = await seedStudio(label);
  const serviceId = await seedService(studio.studioId, label);
  await openRound(studio.studioId, allowance, studio.userId);

  const email = `p-${label}-${studio.studioId.slice(0, 8)}@harness.local`;
  const name = `Prospect ${label}`;
  const joined = await adminQuery(
    `select result, entry_id from public.join_new_client_waitlist($1, $2, $3, $4)`,
    [studio.studioId, name, email, phone],
  );
  const entryId = joined.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1, $2, $3)`, [
    studio.studioId,
    entryId,
    studio.userId,
  ]);

  const issued = await adminQuery(
    `select result, raw_token, invitation_id
       from public.issue_scoped_new_client_waitlist_invitation(
              $1, $2, $3, $4, current_date, current_date + 13, null, 72)`,
    [studio.studioId, entryId, studio.userId, serviceId],
  );
  expect(issued.rows[0].result).toBe("issued");
  return {
    studio,
    serviceId,
    entryId,
    token: issued.rows[0].raw_token as string,
    invitationId: issued.rows[0].invitation_id as string,
    email,
    name,
    phone,
  };
}

async function beginProof(token: string, ttlMinutes = 15) {
  const r = await adminQuery(
    `select result, raw_challenge, delivery_contact, expires_at, challenge_id, issued_at
       from public.begin_waitlist_invitation_proof($1, $2)`,
    [token, ttlMinutes],
  );
  return r.rows[0];
}

/**
 * The same mint, with its two instants rendered to MICROSECOND TEXT by the very
 * statement that mints them.
 *
 * WHY NOT `beginProof`. node-postgres turns a `timestamptz` into a JS `Date`
 * before any assertion can see it, and `Date` keeps MILLISECONDS while
 * PostgreSQL keeps microseconds. Two mints a few hundred microseconds apart
 * therefore arrive already identical, so a chronology check written on them is
 * not strict — it is decided by how fast the runner happened to be, and it
 * passes locally on a multi-millisecond gap while failing on CI when both
 * commands land inside one millisecond. That is not hypothetical here: the
 * capability-clock test below carries the same scar.
 *
 * Rendered to text inside PostgreSQL the value never becomes a `Date`, so it
 * can be handed back as a `timestamptz` parameter and compared at the precision
 * the database actually stored. Format matches `readStoredInstant`.
 */
async function beginProofPrecise(token: string, ttlMinutes = 15) {
  const r = await adminQuery(
    `select result, challenge_id,
            to_char(issued_at,  'YYYY-MM-DD"T"HH24:MI:SS.USOF') as issued_at_us,
            to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expires_at_us
       from public.begin_waitlist_invitation_proof($1, $2)`,
    [token, ttlMinutes],
  );
  return r.rows[0];
}

async function completeProof(token: string, challenge: string) {
  const r = await adminQuery(
    `select result, raw_capability, expires_at
       from public.complete_waitlist_invitation_proof($1, $2)`,
    [token, challenge],
  );
  return r.rows[0];
}

/** Drive a full offer to a held capability. */
async function verifiedOffer(
  label: string,
  phone: string | null = null,
): Promise<Offer & { capability: string }> {
  const offer = await seedOffer(label, 10, phone);
  const begun = await beginProof(offer.token);
  expect(begun.result).toBe("challenge_issued");
  const done = await completeProof(offer.token, begun.raw_challenge);
  expect(done.result).toBe("verified");
  return { ...offer, capability: done.raw_capability as string };
}

async function redeem(token: string, capability: string) {
  const r = await adminQuery(
    `select result, studio_id, entry_id
       from public.redeem_new_client_waitlist_invitation_verified($1, $2)`,
    [token, capability],
  );
  return r.rows[0];
}

async function decline(token: string, capability: string) {
  const r = await adminQuery(
    `select result, entry_id from public.decline_new_client_waitlist_invitation($1, $2)`,
    [token, capability],
  );
  return r.rows[0];
}

/** A studio with an open round and one CLAIMED entry that was never invited. */
async function claimedEntryOnly(
  label: string,
): Promise<{ studio: SeededStudio; entryId: string }> {
  const studio = await seedStudio(label);
  await openRound(studio.studioId, 10, studio.userId);
  const joined = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1, $2, $3, null)`,
    [
      studio.studioId,
      `Prospect ${label}`,
      `p-${label}-${studio.studioId.slice(0, 8)}@harness.local`,
    ],
  );
  const entryId = joined.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1, $2, $3)`, [
    studio.studioId,
    entryId,
    studio.userId,
  ]);
  return { studio, entryId };
}

/**
 * The gated recipient-identity read — the ONLY path by which the server may
 * see a waitlist entry's contact details. 0185 revoked every table privilege
 * on `new_client_waitlist_entries` from service_role by name, so a direct read
 * is 42501; this command is the bridge, and it opens only for a proven
 * recipient of THIS invitation.
 */
async function resolveIdentity(token: string, capability: string) {
  const r = await adminQuery(
    `select result, name, email, phone
       from public.resolve_waitlist_invitation_recipient_identity($1, $2)`,
    [token, capability],
  );
  return r.rows[0];
}

/**
 * NO IDENTITY MEANS NO IDENTITY — not merely "not resolved".
 *
 * A refusal that still carried a name or an address would defeat the whole
 * point of the command, and a test that only checked `result` would not see
 * it. Every negative below asserts all three columns are null as well.
 */
function expectNoIdentity(r: Record<string, unknown>, why: string): void {
  expect(r.result, `${why} — must not resolve`).not.toBe("resolved");
  expect(r.name, `${why} — leaked a name`).toBeNull();
  expect(r.email, `${why} — leaked an email`).toBeNull();
  expect(r.phone, `${why} — leaked a phone`).toBeNull();
}

async function invitationRow(invitationId: string) {
  const r = await adminQuery(
    `select redeemed_at, declined_at, released_at, expired_at,
            proof_challenge_id,
            proof_challenge_hash, proof_capability_hash, proof_capability_expires_at,
            proof_challenge_attempts, proof_challenge_sent_to_hash,
            scope_service_id, scope_start_date, scope_end_date, scope_allowed_weekdays
       from public.new_client_waitlist_invitations where id = $1`,
    [invitationId],
  );
  return r.rows[0];
}

// ===========================================================================
// THE CENTRAL CLAIM: POSSESSION OF THE URL IS NOT PERMISSION TO ACT
// ===========================================================================
describe("0192 — the bearer invitation URL alone cannot redeem or decline", () => {
  it("BEARER_ONLY_REDEEM: a valid token with no proof is refused, and the row does not move", async () => {
    const offer = await seedOffer("bearer-redeem");
    const fakeCapability = "a".repeat(64);

    const r = await redeem(offer.token, fakeCapability);
    expect(r.result).toBe("proof_required");

    // THE ASSERTION THAT MATTERS: the mutation did not happen.
    const row = await invitationRow(offer.invitationId);
    expect(row.redeemed_at).toBeNull();
  });

  it("BEARER_ONLY_DECLINE: the same holds for decline", async () => {
    const offer = await seedOffer("bearer-decline");
    const r = await decline(offer.token, "b".repeat(64));
    expect(r.result).toBe("proof_required");

    const row = await invitationRow(offer.invitationId);
    expect(row.declined_at).toBeNull();
  });

  it("the entry is untouched by a refused bearer decline", async () => {
    const offer = await seedOffer("bearer-entry");
    await decline(offer.token, "c".repeat(64));
    const e = await adminQuery(
      `select status from public.new_client_waitlist_entries where id = $1`,
      [offer.entryId],
    );
    expect(e.rows[0].status).toBe("invited");
  });

  it("there is NO bare-token decline to fall back to", async () => {
    // The one-argument signature must not exist at all.
    const r = await adminQuery(
      `select count(*)::int as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'decline_new_client_waitlist_invitation'
          and pg_get_function_identity_arguments(p.oid) = 'text'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("the UNGATED applied redeem_(text) is unreachable by every application role", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const r = await asRole(role, (q) =>
        q(`select has_function_privilege($1, 'public.redeem_new_client_waitlist_invitation(text)', 'EXECUTE') as ok`, [
          role,
        ]),
      );
      expect(r.rows[0].ok, `${role} must not execute the ungated redeem`).toBe(false);
    }
  });

  it("the check-then-act oracle does not exist", async () => {
    const r = await adminQuery(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='validate_waitlist_invitation_proof'`,
    );
    expect(r.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// THE PROOF IS SEPARATE, AND IT WORKS
// ===========================================================================
describe("0192 — a separate recipient proof grants the ability to act", () => {
  it("begin -> complete -> redeem succeeds, and only then", async () => {
    const offer = await verifiedOffer("happy");
    const r = await redeem(offer.token, offer.capability);
    expect(r.result).toBe("redeemed");
    expect(r.studio_id).toBe(offer.studio.studioId);

    const row = await invitationRow(offer.invitationId);
    expect(row.redeemed_at).not.toBeNull();
  });

  it("the challenge and capability are high-entropy and returned exactly once", async () => {
    const offer = await seedOffer("entropy");
    const begun = await beginProof(offer.token);
    expect(begun.raw_challenge).toMatch(HEX64);
    const done = await completeProof(offer.token, begun.raw_challenge);
    expect(done.raw_capability).toMatch(HEX64);

    // NO PLAINTEXT PERSISTED: neither secret appears anywhere in the row.
    const stored = await adminQuery(
      `select * from public.new_client_waitlist_invitations where id = $1`,
      [offer.invitationId],
    );
    const blob = JSON.stringify(stored.rows[0]);
    expect(blob).not.toContain(begun.raw_challenge);
    expect(blob).not.toContain(done.raw_capability);
    expect(blob).not.toContain(offer.token);
  });

  it("a wrong challenge is refused and counted, and five strikes close it", async () => {
    const offer = await seedOffer("attempts");
    await beginProof(offer.token);
    for (let i = 0; i < 5; i++) {
      const r = await completeProof(offer.token, "d".repeat(64));
      expect(r.result).toBe("wrong_challenge");
    }
    const sixth = await completeProof(offer.token, "d".repeat(64));
    expect(sixth.result).toBe("too_many_attempts");
  });

  it("a successful verification CONSUMES the challenge — it cannot be replayed", async () => {
    const offer = await seedOffer("replay");
    const begun = await beginProof(offer.token);
    expect((await completeProof(offer.token, begun.raw_challenge)).result).toBe("verified");
    const again = await completeProof(offer.token, begun.raw_challenge);
    expect(again.result).toBe("no_challenge");
  });

  it("redeeming BURNS the capability, so it cannot be replayed onto decline", async () => {
    const offer = await verifiedOffer("burn");
    expect((await redeem(offer.token, offer.capability)).result).toBe("redeemed");
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_capability_hash).toBeNull();
  });
});

// ===========================================================================
// TTL — DATABASE-OWNED, 30 MINUTES, 31 UNREPRESENTABLE
// ===========================================================================
describe("0192 — the capability TTL is owned by the database", () => {
  it("TTL_MAX_MINUTES: the capability expires at exactly 30 minutes on the server clock", async () => {
    const offer = await seedOffer("ttl-30");
    const begun = await beginProof(offer.token);
    const done = await completeProof(offer.token, begun.raw_challenge);
    expect(done.result).toBe("verified");

    const r = await adminQuery(
      `select proof_capability_expires_at,
              proof_capability_expires_at <= clock_timestamp() + interval '30 minutes' as within,
              proof_capability_expires_at >  clock_timestamp() + interval '29 minutes' as atleast
         from public.new_client_waitlist_invitations where id = $1`,
      [offer.invitationId],
    );
    expect(r.rows[0].within).toBe(true);
    expect(r.rows[0].atleast).toBe(true);

    // The RETURNED expiry is the STORED one, not a caller echo.
    expect(new Date(done.expires_at).toISOString()).toBe(
      new Date(r.rows[0].proof_capability_expires_at).toISOString(),
    );
  });

  it("TTL_31_REFUSED: asking for 31 minutes raises undefined_function — there is no such argument", async () => {
    const offer = await seedOffer("ttl-31");
    const begun = await beginProof(offer.token);
    let code = "NO_ERROR";
    try {
      await adminQuery(
        `select public.complete_waitlist_invitation_proof($1, $2, 31)`,
        [offer.token, begun.raw_challenge],
      );
    } catch (e) {
      code = (e as { code?: string }).code ?? "UNKNOWN";
    }
    // 42883 = undefined_function. The TTL is not refused at runtime; the
    // signature that could carry it does not exist.
    expect(code).toBe("42883");
  });

  it("only the two-argument complete_ exists", async () => {
    const r = await adminQuery(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='complete_waitlist_invitation_proof'`,
    );
    // identity_arguments carries parameter NAMES; assert the shape, not the text.
    expect(r.rows.length, "exactly one complete_ signature may exist").toBe(1);
    const args = (r.rows[0].args as string).split(",").map((a) => a.trim());
    expect(args.length).toBe(2);
    for (const a of args) expect(a).toMatch(/\btext$/);
  });

  it("an expired capability is refused, and the row does not move", async () => {
    const offer = await verifiedOffer("cap-expired");
    // The capability TTL cannot be reached by elapsed time in a test run, so
    // age the capability's own expiry column. These proof columns are B1.5
    // state the 0188 append-only trigger does not enumerate, so this is a
    // legitimate owner-side fixture rather than a bypass of a guard.
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set proof_capability_expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [offer.invitationId],
    );
    const r = await redeem(offer.token, offer.capability);
    expect(r.result).toBe("proof_expired");
    expect((await invitationRow(offer.invitationId)).redeemed_at).toBeNull();
  });

  it("an expired CHALLENGE is refused", async () => {
    const offer = await seedOffer("chal-expired");
    const begun = await beginProof(offer.token, 1);
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set proof_challenge_expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [offer.invitationId],
    );
    expect((await completeProof(offer.token, begun.raw_challenge)).result).toBe(
      "challenge_expired",
    );
  });

  it("begin_ refuses a challenge TTL outside its accepted 1..60 bound", async () => {
    const offer = await seedOffer("chal-bound");
    expect((await beginProof(offer.token, 0)).result).toBe("invalid_input");
    expect((await beginProof(offer.token, 61)).result).toBe("invalid_input");
    expect((await beginProof(offer.token, 60)).result).toBe("challenge_issued");
  });
});

// ===========================================================================
// BINDING — TO THIS INVITATION, THIS STUDIO, THIS STORED RECIPIENT
// ===========================================================================
describe("0192 — proof is bound to the stored intended invitation and recipient", () => {
  it("CROSS_INVITATION: a capability minted for one invitation cannot act on another", async () => {
    const a = await verifiedOffer("xinv-a");
    const b = await seedOffer("xinv-b");
    // b has its own live invitation and NO capability of its own.
    const r = await redeem(b.token, a.capability);
    expect(r.result).toBe("proof_required");
    expect((await invitationRow(b.invitationId)).redeemed_at).toBeNull();
  });

  it("CROSS_INVITATION: even when the target HAS its own capability, another's is refused", async () => {
    const a = await verifiedOffer("xinv2-a");
    const b = await verifiedOffer("xinv2-b");
    const r = await redeem(b.token, a.capability);
    expect(r.result).toBe("proof_invalid");
    expect((await invitationRow(b.invitationId)).redeemed_at).toBeNull();
  });

  it("CROSS_INVITATION: decline is bound the same way", async () => {
    const a = await verifiedOffer("xinv3-a");
    const b = await verifiedOffer("xinv3-b");
    const r = await decline(b.token, a.capability);
    expect(r.result).toBe("proof_invalid");
    expect((await invitationRow(b.invitationId)).declined_at).toBeNull();
  });

  it("CROSS_STUDIO: a capability from studio A cannot act on studio B's invitation", async () => {
    const a = await verifiedOffer("xstudio-a");
    const b = await verifiedOffer("xstudio-b");
    expect(a.studio.studioId).not.toBe(b.studio.studioId);
    const r = await redeem(b.token, a.capability);
    expect(r.result).toBe("proof_invalid");
    expect((await invitationRow(b.invitationId)).redeemed_at).toBeNull();
  });

  it("NO BROWSER-SUPPLIED EMAIL IS AUTHORITY: the contact comes from the stored entry", async () => {
    const offer = await seedOffer("stored-contact");
    const begun = await beginProof(offer.token);
    // begin_ returns the STORED address to the server; it accepts none.
    expect(begun.delivery_contact).toBe(offer.email);

    const stored = await adminQuery(
      `select encode(extensions.digest(lower(btrim(e.email)),'sha256'),'hex') as h
         from public.new_client_waitlist_entries e where e.id = $1`,
      [offer.entryId],
    );
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_challenge_sent_to_hash).toBe(stored.rows[0].h);
  });

  it("the entry contact is IMMUTABLE, so no shipped path can retarget a challenge", async () => {
    // 0188's transition guard refuses a contact edit outright. This is the
    // FIRST line of defence and it is structural: the retargeting attack the
    // frozen hash exists to stop cannot even be staged through a command.
    const offer = await seedOffer("retarget-refused");
    let message = "";
    try {
      await adminQuery(
        `update public.new_client_waitlist_entries set email = $2 where id = $1`,
        [offer.entryId, `attacker-${offer.studio.studioId.slice(0, 8)}@harness.local`],
      );
    } catch (e) {
      message = (e as { message?: string }).message ?? "";
    }
    expect(message).toMatch(/contact details are immutable/i);
  });

  it("and if one ever could, complete_ REFUSES the changed recipient", async () => {
    // The `recipient_changed` branch is defence in depth behind the guard
    // above. Proving it requires constructing a state no shipped path can
    // reach, so the guard is disabled owner-side for the fixture only — which
    // is itself the proof that no application role can produce this state.
    const offer = await seedOffer("retarget");
    const begun = await beginProof(offer.token);

    await adminQuery(
      `alter table public.new_client_waitlist_entries disable trigger new_client_waitlist_entries_transition_guard`,
    );
    try {
      await adminQuery(
        `update public.new_client_waitlist_entries set email = $2 where id = $1`,
        [offer.entryId, `attacker-${offer.studio.studioId.slice(0, 8)}@harness.local`],
      );
    } finally {
      await adminQuery(
        `alter table public.new_client_waitlist_entries enable trigger new_client_waitlist_entries_transition_guard`,
      );
    }

    const r = await completeProof(offer.token, begun.raw_challenge);
    expect(r.result).toBe("recipient_changed");
    expect((await invitationRow(offer.invitationId)).proof_capability_hash).toBeNull();
  });
});

// ===========================================================================
// LIFECYCLE INVALIDATION
// ===========================================================================
describe("0192 — revoke, reissue and replacement invalidate outstanding proof", () => {
  it("REISSUING a challenge replaces the old one AND kills any live capability", async () => {
    const offer = await verifiedOffer("reissue");
    const before = await invitationRow(offer.invitationId);
    expect(before.proof_capability_hash).not.toBeNull();

    const again = await beginProof(offer.token);
    expect(again.result).toBe("challenge_issued");

    const after = await invitationRow(offer.invitationId);
    expect(after.proof_capability_hash).toBeNull();

    // The capability held from before is now worthless.
    const r = await redeem(offer.token, offer.capability);
    expect(r.result).toBe("proof_required");
  });

  it("a STALE challenge stops verifying the moment a newer one is minted", async () => {
    const offer = await seedOffer("stale-challenge");
    const first = await beginProof(offer.token);
    const second = await beginProof(offer.token);
    expect(first.raw_challenge).not.toBe(second.raw_challenge);
    expect((await completeProof(offer.token, first.raw_challenge)).result).toBe(
      "wrong_challenge",
    );
    expect((await completeProof(offer.token, second.raw_challenge)).result).toBe("verified");
  });

  it("RELEASING the entry makes an outstanding capability fail closed", async () => {
    const offer = await verifiedOffer("released");
    const rel = await adminQuery(
      `select public.release_new_client_waitlist_entry($1, $2, $3) as result`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId],
    );
    expect(rel.rows[0].result).toBe("released");

    expect((await redeem(offer.token, offer.capability)).result).toBe("not_live");
    expect((await decline(offer.token, offer.capability)).result).toBe("not_live");
  });

  it("DECLINED CANNOT REDEEM: a declined invitation refuses redemption afterwards", async () => {
    const offer = await verifiedOffer("declined-then-redeem");
    expect((await decline(offer.token, offer.capability)).result).toBe("declined");

    // The capability was burned by the decline; even re-proving cannot redeem
    // a closed invitation.
    const begun = await beginProof(offer.token);
    expect(begun.result).toBe("not_live");

    const r = await redeem(offer.token, offer.capability);
    expect(r.result).toBe("not_live");
    expect((await invitationRow(offer.invitationId)).redeemed_at).toBeNull();
  });

  it("declining moves the entry invited -> released, an edge 0188 already permits", async () => {
    const offer = await verifiedOffer("decline-entry");
    expect((await decline(offer.token, offer.capability)).result).toBe("declined");
    const e = await adminQuery(
      `select status from public.new_client_waitlist_entries where id = $1`,
      [offer.entryId],
    );
    expect(e.rows[0].status).toBe("released");
  });

  it("invalidate_ clears every credential at rest", async () => {
    const offer = await verifiedOffer("invalidate");
    await adminQuery(`select public.invalidate_waitlist_invitation_proof($1)`, [
      offer.invitationId,
    ]);
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_challenge_hash).toBeNull();
    expect(row.proof_capability_hash).toBeNull();
    expect(row.proof_challenge_sent_to_hash).toBeNull();
    expect(row.proof_challenge_attempts).toBe(0);
  });

  it("an EXPIRED invitation refuses proof entirely", async () => {
    const offer = await seedOffer("inv-expired");
    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = now() - interval '4 days', expires_at = now() - interval '1 minute'
          where id = $1`,
        [offer.invitationId],
      );
    });
    expect((await beginProof(offer.token)).result).toBe("not_live");
  });
});

// ===========================================================================
// PROOF VALIDATION HAPPENS INSIDE THE LOCKED MUTATION
// ===========================================================================
describe("0192 — proof validation is INSIDE the locked mutation", () => {
  it("a concurrent release that commits first makes redeem fail closed, not race", async () => {
    const offer = await verifiedOffer("concurrent");

    // Both statements target the same invitation row. The mutation takes the
    // row lock and re-reads liveness AFTER acquiring it, so whichever commits
    // first is the one that decides — there is no check-then-act window a
    // caller could sit in.
    const [released, redeemed] = await Promise.all([
      adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as result`, [
        offer.studio.studioId,
        offer.entryId,
        offer.studio.userId,
      ]),
      redeem(offer.token, offer.capability),
    ]);

    const relResult = released.rows[0].result as string;
    const redResult = redeemed.result as string;

    // EXACTLY ONE outcome may be recorded — never both.
    const row = await invitationRow(offer.invitationId);
    const outcomes = [row.redeemed_at, row.released_at, row.declined_at, row.expired_at].filter(
      (v) => v !== null,
    );
    expect(outcomes.length).toBe(1);

    // And the pair of return codes must agree with the row.
    if (redResult === "redeemed") {
      expect(row.redeemed_at).not.toBeNull();
      expect(relResult).not.toBe("released");
    } else {
      expect(redResult).toBe("not_live");
      expect(relResult).toBe("released");
    }
  });

  it("two concurrent redemptions of the same capability yield exactly one redeemed", async () => {
    const offer = await verifiedOffer("double-redeem");
    const [a, b] = await Promise.all([
      redeem(offer.token, offer.capability),
      redeem(offer.token, offer.capability),
    ]);
    const wins = [a.result, b.result].filter((r) => r === "redeemed");
    expect(wins.length).toBe(1);
    const loser = [a.result, b.result].find((r) => r !== "redeemed");
    // The loser is refused because the capability was burned, or because the
    // invitation is already closed. Both are fail-closed.
    expect(["proof_required", "not_live"]).toContain(loser);
  });

  it("redeem and decline racing produce exactly one terminal outcome", async () => {
    const offer = await verifiedOffer("redeem-vs-decline");
    const [a, b] = await Promise.all([
      redeem(offer.token, offer.capability),
      decline(offer.token, offer.capability),
    ]);
    const row = await invitationRow(offer.invitationId);
    const outcomes = [row.redeemed_at, row.declined_at].filter((v) => v !== null);
    expect(outcomes.length).toBe(1);
    const succeeded = [a.result, b.result].filter((r) => r === "redeemed" || r === "declined");
    expect(succeeded.length).toBe(1);
  });
});

// ===========================================================================
// SCOPE, ALLOWANCE AND SAME-STUDIO STRUCTURAL FKs
// ===========================================================================
describe("0192 — a stored invitation cannot express a permission its owner did not grant", () => {
  it("SAME_STUDIO FK: a service from another studio cannot be scoped", async () => {
    const a = await seedOffer("fk-a");
    const b = await seedStudio("fk-b");
    const foreignService = await seedService(b.studioId, "fk-b");

    const joined = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
      [a.studio.studioId, "FK P", `fk-${a.studio.studioId.slice(0, 8)}@harness.local`],
    );
    const entryId = joined.rows[0].entry_id as string;
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      a.studio.studioId,
      entryId,
      a.studio.userId,
    ]);

    const r = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [a.studio.studioId, entryId, a.studio.userId, foreignService],
    );
    expect(r.rows[0].result).toBe("invalid_service");
  });

  it("the composite FK is STRUCTURAL — a direct cross-studio scope write is refused", async () => {
    const a = await seedOffer("fk-direct");
    const b = await seedStudio("fk-direct-b");
    const foreignService = await seedService(b.studioId, "fk-direct-b");

    let code = "NO_ERROR";
    try {
      await adminQuery(
        `update public.new_client_waitlist_invitations set scope_service_id = $2 where id = $1`,
        [a.invitationId, foreignService],
      );
    } catch (e) {
      code = (e as { code?: string }).code ?? "UNKNOWN";
    }
    expect(code).toBe("23503"); // foreign_key_violation
  });

  it("no round open means no invitation may issue", async () => {
    const studio = await seedStudio("no-round");
    const serviceId = await seedService(studio.studioId, "no-round");
    const joined = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
      [studio.studioId, "NR", `nr-${studio.studioId.slice(0, 8)}@harness.local`],
    );
    const entryId = joined.rows[0].entry_id as string;
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      studio.studioId,
      entryId,
      studio.userId,
    ]);
    const r = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [studio.studioId, entryId, studio.userId, serviceId],
    );
    expect(r.rows[0].result).toBe("no_round_open");
  });

  it("outstanding permission can never exceed the round allowance", async () => {
    const studio = await seedStudio("allowance");
    const serviceId = await seedService(studio.studioId, "allowance");
    await openRound(studio.studioId, 1, studio.userId);

    const ids: string[] = [];
    for (const label of ["one", "two"]) {
      const j = await adminQuery(
        `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
        [studio.studioId, label, `${label}-${studio.studioId.slice(0, 8)}@harness.local`],
      );
      const id = j.rows[0].entry_id as string;
      await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
        studio.studioId,
        id,
        studio.userId,
      ]);
      ids.push(id);
    }

    const first = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [studio.studioId, ids[0], studio.userId, serviceId],
    );
    expect(first.rows[0].result).toBe("issued");

    const second = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [studio.studioId, ids[1], studio.userId, serviceId],
    );
    expect(second.rows[0].result).toBe("round_full");
  });

  it("a declined invitation FREES permission, so a later offer is possible", async () => {
    const studio = await seedStudio("free-perm");
    const serviceId = await seedService(studio.studioId, "free-perm");
    await openRound(studio.studioId, 1, studio.userId);

    const mk = async (label: string) => {
      const j = await adminQuery(
        `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
        [studio.studioId, label, `${label}-${studio.studioId.slice(0, 8)}@harness.local`],
      );
      const id = j.rows[0].entry_id as string;
      await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
        studio.studioId,
        id,
        studio.userId,
      ]);
      return id;
    };

    const e1 = await mk("fp1");
    const issued = await adminQuery(
      `select result, raw_token from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [studio.studioId, e1, studio.userId, serviceId],
    );
    const token = issued.rows[0].raw_token as string;

    const begun = await beginProof(token);
    const done = await completeProof(token, begun.raw_challenge);
    expect((await decline(token, done.raw_capability)).result).toBe("declined");

    // The seat is free again.
    const e2 = await mk("fp2");
    const again = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [studio.studioId, e2, studio.userId, serviceId],
    );
    expect(again.rows[0].result).toBe("issued");
  });

  it("an empty weekday array authorises nothing and is refused", async () => {
    const offer = await seedOffer("weekdays");
    const j = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
      [offer.studio.studioId, "WD", `wd-${offer.studio.studioId.slice(0, 8)}@harness.local`],
    );
    const entryId = j.rows[0].entry_id as string;
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId,
      entryId,
      offer.studio.userId,
    ]);
    const r = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, $5::smallint[], 72)`,
      [offer.studio.studioId, entryId, offer.studio.userId, offer.serviceId, "{}"],
    );
    expect(r.rows[0].result).toBe("invalid_weekdays");
  });

  it("duplicate weekdays are canonicalised to a sorted DISTINCT array", async () => {
    const offer = await seedOffer("canon");
    const j = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,null)`,
      [offer.studio.studioId, "CN", `cn-${offer.studio.studioId.slice(0, 8)}@harness.local`],
    );
    const entryId = j.rows[0].entry_id as string;
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId,
      entryId,
      offer.studio.userId,
    ]);
    const r = await adminQuery(
      `select result, invitation_id from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, $5::smallint[], 72)`,
      [offer.studio.studioId, entryId, offer.studio.userId, offer.serviceId, "{4,2,2,4}"],
    );
    expect(r.rows[0].result).toBe("issued");
    const row = await invitationRow(r.rows[0].invitation_id);
    expect(row.scope_allowed_weekdays).toEqual([2, 4]);
  });
});

// ===========================================================================
// READ-ONLY RESOLVER
// ===========================================================================
describe("0192 — the read-only resolver never consumes the invitation", () => {
  it("resolving repeatedly leaves the invitation live", async () => {
    const offer = await seedOffer("resolver");
    for (let i = 0; i < 3; i++) {
      const r = await adminQuery(
        `select result, recipient_contact_hash from public.resolve_new_client_waitlist_invitation($1)`,
        [offer.token],
      );
      expect(r.rows[0].result).toBe("live");
      expect(r.rows[0].recipient_contact_hash).toMatch(HEX64);
    }
    const row = await invitationRow(offer.invitationId);
    expect(row.redeemed_at).toBeNull();
  });

  it("returns the contact HASHED, never the raw address", async () => {
    const offer = await seedOffer("resolver-hash");
    const r = await adminQuery(
      `select * from public.resolve_new_client_waitlist_invitation($1)`,
      [offer.token],
    );
    expect(JSON.stringify(r.rows[0])).not.toContain(offer.email);
  });

  it("an unknown token resolves to invalid_token rather than leaking existence", async () => {
    const r = await adminQuery(
      `select result, invitation_id from public.resolve_new_client_waitlist_invitation($1)`,
      ["f".repeat(64)],
    );
    expect(r.rows[0].result).toBe("invalid_token");
    expect(r.rows[0].invitation_id).toBeNull();
  });

  it("a malformed token is refused without a database lookup", async () => {
    const r = await adminQuery(
      `select result from public.resolve_new_client_waitlist_invitation($1)`,
      ["not-a-token"],
    );
    expect(r.rows[0].result).toBe("invalid_token");
  });
});

// ===========================================================================
// GATED RECIPIENT IDENTITY — the only bridge across 0185's revoke
// ===========================================================================
//
// THE DEFECT THIS COMMAND EXISTS FOR. B3 books the invited person into the
// scoped slot, and the public booking command requires their name, email and
// phone. Those live on the waitlist ENTRY, and 0185 revoked EVERY table
// privilege on `new_client_waitlist_entries` from service_role by name so the
// server's most privileged client cannot dump contact details. Integration
// proved the consequence: a direct service_role read returns 42501, the
// identity lookup returns null, and the booking stops before the engine.
//
// The repair is NOT a table grant. It is this narrow command, which opens for
// a proven recipient of THIS invitation and for nobody else.
describe("0192 — recipient identity is released only to a proven recipient", () => {
  it("POSITIVE: a live invitation and the CURRENT capability return the stored identity", async () => {
    const offer = await verifiedOffer("ident-ok", "+61 400 000 111");
    const r = await resolveIdentity(offer.token, offer.capability);
    expect(r.result).toBe("resolved");
    // EXACT stored values, not a plausible shape.
    expect(r.name).toBe(offer.name);
    expect(r.email).toBe(offer.email);
    expect(r.phone).toBe("+61 400 000 111");
  });

  it("POSITIVE: a null phone comes back as null — it is not a refusal", async () => {
    // The join form makes phone optional and 0185 stores it nullable, so an
    // entry without one is ordinary. It changes what the recipient is asked
    // for, never whether their identity resolves.
    const offer = await verifiedOffer("ident-nophone");
    const r = await resolveIdentity(offer.token, offer.capability);
    expect(r.result).toBe("resolved");
    expect(r.name).toBe(offer.name);
    expect(r.email).toBe(offer.email);
    expect(r.phone).toBeNull();
  });

  it("BEARER ONLY: holding the invitation URL yields no identity", async () => {
    // The whole two-authority law in one assertion. Possession may view the
    // offer and request proof; it may not learn who the offer is for.
    const offer = await seedOffer("ident-bearer");
    expectNoIdentity(
      await resolveIdentity(offer.token, "a".repeat(64)),
      "bearer possession with no capability",
    );
    expect((await resolveIdentity(offer.token, "a".repeat(64))).result).toBe("proof_required");
  });

  it("WRONG CAPABILITY: a well-formed but incorrect capability yields no identity", async () => {
    const offer = await verifiedOffer("ident-wrongcap");
    const r = await resolveIdentity(offer.token, "b".repeat(64));
    expectNoIdentity(r, "a guessed capability");
    expect(r.result).toBe("proof_invalid");
  });

  it("CROSS_INVITATION: another invitation's capability yields no identity", async () => {
    const a = await verifiedOffer("ident-xinv-a");
    const b = await verifiedOffer("ident-xinv-b");
    const r = await resolveIdentity(b.token, a.capability);
    expectNoIdentity(r, "a capability minted for a different invitation");
    expect(r.result).toBe("proof_invalid");
  });

  it("CROSS_INVITATION: a capability cannot reach an invitation that has none", async () => {
    const a = await verifiedOffer("ident-xinv2-a");
    const b = await seedOffer("ident-xinv2-b");
    const r = await resolveIdentity(b.token, a.capability);
    expectNoIdentity(r, "another invitation's capability against an unproven one");
    expect(r.result).toBe("proof_required");
  });

  it("CROSS_STUDIO: a capability from studio A cannot bleed studio B's identity", async () => {
    const a = await verifiedOffer("ident-xstudio-a");
    const b = await verifiedOffer("ident-xstudio-b");
    expect(a.studio.studioId).not.toBe(b.studio.studioId);
    const r = await resolveIdentity(b.token, a.capability);
    expectNoIdentity(r, "a capability from another studio");
    expect(r.result).toBe("proof_invalid");
    // And the reverse direction, so this is not one-way luck.
    expectNoIdentity(
      await resolveIdentity(a.token, b.capability),
      "a capability from another studio, reversed",
    );
  });

  it("EXPIRED CAPABILITY: an aged capability yields no identity", async () => {
    const offer = await verifiedOffer("ident-capexp");
    // Same fixture the redeem gate's expiry test uses: these proof columns are
    // B1.5 state the 0188 append-only trigger does not enumerate.
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set proof_capability_expires_at = clock_timestamp() - interval '1 second'
        where id = $1`,
      [offer.invitationId],
    );
    const r = await resolveIdentity(offer.token, offer.capability);
    expectNoIdentity(r, "an expired capability");
    expect(r.result).toBe("proof_expired");
  });

  it("STALE CAPABILITY: re-proving replaces it, and the old one stops resolving", async () => {
    const offer = await verifiedOffer("ident-stale");
    const old = offer.capability;
    // A new challenge CLEARS any live capability, then a new one is minted.
    const begun = await beginProof(offer.token);
    expect(begun.result).toBe("challenge_issued");
    const done = await completeProof(offer.token, begun.raw_challenge as string);
    expect(done.result).toBe("verified");
    const fresh = done.raw_capability as string;
    expect(fresh).not.toBe(old);

    expectNoIdentity(await resolveIdentity(offer.token, old), "a replaced capability");
    // ...and the CURRENT one still works, so the refusal above is about
    // staleness rather than the command having simply stopped functioning.
    expect((await resolveIdentity(offer.token, fresh)).result).toBe("resolved");
  });

  it("REPLACED MID-FLIGHT: requesting a new challenge alone invalidates the capability", async () => {
    const offer = await verifiedOffer("ident-reissue");
    await beginProof(offer.token);
    const r = await resolveIdentity(offer.token, offer.capability);
    expectNoIdentity(r, "a capability cleared by a reissued challenge");
    expect(r.result).toBe("proof_required");
  });

  it("EXPIRED INVITATION: a lapsed wall clock yields no identity", async () => {
    const offer = await verifiedOffer("ident-invexp");
    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = now() - interval '4 days', expires_at = now() - interval '1 minute'
          where id = $1`,
        [offer.invitationId],
      );
    });
    const r = await resolveIdentity(offer.token, offer.capability);
    expectNoIdentity(r, "an expired invitation");
    expect(r.result).toBe("not_live");
  });

  it("DECLINED INVITATION: yields no identity", async () => {
    const offer = await verifiedOffer("ident-declined");
    expect((await decline(offer.token, offer.capability)).result).toBe("declined");
    expectNoIdentity(
      await resolveIdentity(offer.token, offer.capability),
      "a declined invitation",
    );
  });

  it("RELEASED INVITATION: yields no identity", async () => {
    const offer = await verifiedOffer("ident-released");
    const rel = await adminQuery(
      `select public.release_new_client_waitlist_entry($1, $2, $3) as result`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId],
    );
    expect(rel.rows[0].result).toBe("released");
    const r = await resolveIdentity(offer.token, offer.capability);
    expectNoIdentity(r, "a released invitation");
    expect(r.result).toBe("not_live");
  });

  it("REDEEMED INVITATION: the offer is spent and yields no identity", async () => {
    const offer = await verifiedOffer("ident-redeemed");
    expect((await redeem(offer.token, offer.capability)).result).toBe("redeemed");
    const r = await resolveIdentity(offer.token, offer.capability);
    expectNoIdentity(r, "a redeemed invitation");
    expect(r.result).toBe("not_live");
  });

  it("malformed input is refused before any lookup", async () => {
    const offer = await verifiedOffer("ident-malformed");
    for (const [token, cap, why] of [
      ["nope", offer.capability, "a short token"],
      [offer.token, "nope", "a short capability"],
      ["Z".repeat(64), offer.capability, "a non-hex token"],
      [offer.token, "Z".repeat(64), "a non-hex capability"],
    ] as Array<[string, string, string]>) {
      const r = await resolveIdentity(token, cap);
      expectNoIdentity(r, why);
      expect(r.result, why).toBe("invalid_input");
    }
  });

  it("an unknown token is refused without disclosing anything", async () => {
    const r = await resolveIdentity("c".repeat(64), "d".repeat(64));
    expectNoIdentity(r, "an unknown token");
    expect(r.result).toBe("invalid_token");
  });

  it("CROSS_STUDIO is STRUCTURAL: the state the studio predicate guards cannot be built", async () => {
    // HONESTY NOTE, recorded because it changes what this suite is claiming.
    //
    // Removing `and e.studio_id = r.studio_id` from the identity read changes
    // NO observable behaviour — a mutation campaign confirmed this whole block
    // still passes without it. That is not a gap in the tests: it is because
    // the composite FK below makes the state that predicate guards against
    // impossible to construct. The runtime predicate is defence in depth over
    // a structural guarantee, and it is honest to say so rather than to claim
    // a behavioural proof that no test could ever produce.
    //
    // So the guarantee is proven HERE, where it actually lives. The target
    // entry is claimed but never invited, because an entry that already has a
    // live invitation trips `one_live_per_entry` first and would mask the FK.
    const a = await seedOffer("ident-fk-a");
    const other = await claimedEntryOnly("ident-fk-b");
    expect(other.studio.studioId).not.toBe(a.studio.studioId);

    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await adminQuery(
        `insert into public.new_client_waitlist_invitations
           (studio_id, entry_id, issued_by_practitioner_id, token_hash, expires_at,
            scope_service_id, scope_start_date, scope_end_date)
         values ($1, $2, $3, $4, now() + interval '3 days', $5, current_date, current_date + 13)`,
        [
          a.studio.studioId,
          other.entryId,
          a.studio.practitionerId,
          "f".repeat(64),
          a.serviceId,
        ],
      );
    } catch (e) {
      code = (e as { code?: string }).code;
      constraint = (e as { constraint?: string }).constraint;
    }
    expect(code, "a cross-studio invitation/entry pairing must be refused").toBe("23503");
    expect(constraint).toBe("new_client_waitlist_invitations_entry_same_studio_fk");
  });

  it("THE BOUNDARY HOLDS: service_role still has NO direct read of the entries table", async () => {
    // The forbidden repair, asserted directly. If a future change grants
    // service_role SELECT here, every other test in this block would still
    // pass while the privacy boundary 0185 established was gone.
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const r = await adminQuery(
        `select has_table_privilege('service_role','public.new_client_waitlist_entries',$1) as ok`,
        [priv],
      );
      expect(r.rows[0].ok, `service_role must NOT hold ${priv} on the entries table`).toBe(
        false,
      );
    }
    // Column-level too, so a narrower grant cannot slip past the table check.
    for (const col of ["name", "email", "phone"]) {
      const r = await adminQuery(
        `select has_column_privilege('service_role','public.new_client_waitlist_entries',$1,'SELECT') as ok`,
        [col],
      );
      expect(r.rows[0].ok, `service_role must NOT read ${col} directly`).toBe(false);
    }
  });

  it("and anon still holds nothing, while the owner's RLS-gated SELECT is unchanged", async () => {
    const anon = await adminQuery(
      `select has_table_privilege('anon','public.new_client_waitlist_entries','SELECT') as ok`,
    );
    expect(anon.rows[0].ok).toBe(false);
    // 0185 grants authenticated SELECT, RLS-scoped to the studio's own owner.
    // Asserted so this change is shown to have neither widened nor narrowed it.
    const auth = await adminQuery(
      `select has_table_privilege('authenticated','public.new_client_waitlist_entries','SELECT') as ok`,
    );
    expect(auth.rows[0].ok).toBe(true);
  });

  it("the command itself is server-only", async () => {
    const sig = "public.resolve_waitlist_invitation_recipient_identity(text,text)";
    for (const role of ["anon", "authenticated"]) {
      const r = await adminQuery(
        `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
        [role, sig],
      );
      expect(r.rows[0].ok, `${role} must NOT execute the identity command`).toBe(false);
    }
    const sr = await adminQuery(
      `select has_function_privilege('service_role', $1, 'EXECUTE') as ok`,
      [sig],
    );
    expect(sr.rows[0].ok).toBe(true);
  });

  it("PUBLIC holds no execute either — the revoke names it", async () => {
    // `revoke ... from public` is the one that a by-name list of the three
    // Supabase roles would miss, and PostgreSQL grants EXECUTE to PUBLIC on
    // every new function.
    const r = await adminQuery(
      `select p.proacl::text as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'resolve_waitlist_invitation_recipient_identity'`,
    );
    const acl = r.rows[0].acl as string | null;
    expect(acl, "the function must carry an explicit ACL, not the default").not.toBeNull();
    // An entry with an empty grantee is PUBLIC. It must not be there.
    expect(acl).not.toMatch(/(^|,)\{?=/);
    expect(acl).toContain("service_role=X");
  });
});

// ===========================================================================
// PRIVILEGES — EFFECTIVE, NOT SOURCE
// ===========================================================================
describe("0192 — privileges, proved against the database rather than the file", () => {
  const COMMANDS = [
    "public.waitlist_admission_round_consumed(uuid)",
    "public.open_new_client_waitlist_admission_round(uuid, uuid, integer)",
    "public.close_new_client_waitlist_admission_round(uuid, uuid)",
    "public.issue_scoped_new_client_waitlist_invitation(uuid,uuid,uuid,uuid,date,date,smallint[],integer)",
    "public.resolve_new_client_waitlist_invitation(text)",
    "public.begin_waitlist_invitation_proof(text,integer)",
    "public.complete_waitlist_invitation_proof(text,text)",
    "public.invalidate_waitlist_invitation_proof(uuid)",
    "public.redeem_new_client_waitlist_invitation_verified(text,text)",
    "public.decline_new_client_waitlist_invitation(text,text)",
    "public.resolve_waitlist_invitation_recipient_identity(text,text)",
  ];

  it("GRANTS: service_role holds EXECUTE on every command", async () => {
    for (const sig of COMMANDS) {
      const r = await adminQuery(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as ok`,
        [sig],
      );
      expect(r.rows[0].ok, `service_role must execute ${sig}`).toBe(true);
    }
  });

  it("REVOKES: neither anon nor authenticated may execute anything here", async () => {
    for (const sig of COMMANDS) {
      for (const role of ["anon", "authenticated"]) {
        const r = await adminQuery(
          `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
          [role, sig],
        );
        expect(r.rows[0].ok, `${role} must NOT execute ${sig}`).toBe(false);
      }
    }
  });

  it("the browser cannot read any proof or token column", async () => {
    for (const col of [
      "token_hash",
      "proof_challenge_hash",
      "proof_capability_hash",
      "proof_challenge_sent_to_hash",
    ]) {
      const r = await adminQuery(
        `select has_column_privilege('authenticated','public.new_client_waitlist_invitations',$1,'SELECT') as ok`,
        [col],
      );
      expect(r.rows[0].ok, `authenticated must not read ${col}`).toBe(false);
    }
  });

  it("the round table holds no DML for any browser role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        const r = await adminQuery(
          `select has_table_privilege($1,'public.studio_waitlist_admission_rounds',$2) as ok`,
          [role, priv],
        );
        expect(r.rows[0].ok, `${role} must not ${priv} the round table`).toBe(false);
      }
    }
  });

  it("RLS is enabled on the round table and scoped to the owner", async () => {
    const r = await adminQuery(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policies
                where tablename='studio_waitlist_admission_rounds') as policies
         from pg_class c where c.relname='studio_waitlist_admission_rounds'`,
    );
    expect(r.rows[0].rls).toBe(true);
    expect(r.rows[0].policies).toBe(1);
  });

  it("an owner sees only their OWN round row", async () => {
    const a = await seedOffer("rls-a");
    const b = await seedOffer("rls-b");
    const { asUser } = await import("./helpers/harness");
    const rows = await asUser(a.studio.userId, (q) =>
      q(`select studio_id from public.studio_waitlist_admission_rounds`),
    );
    const ids = rows.rows.map((x: { studio_id: string }) => x.studio_id);
    expect(ids).toContain(a.studio.studioId);
    expect(ids).not.toContain(b.studio.studioId);
  });
});

// ===========================================================================
// EXACT-HEAD REVIEW REPAIRS (9c25e0fb). Three findings, three controls.
// Each one FAILED before its repair and is kept here so it cannot regress.
// ===========================================================================
describe("0192 — the unscoped issuer is not a bypass (P1 repair)", () => {
  it("the LEGACY four-argument issuer is unreachable by every application role", async () => {
    // It answers neither of the wrapper's invariants — no open round, no
    // allowance check — so a server path calling it directly could mint an
    // invitation with every scope column NULL, outside the round entirely.
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await adminQuery(
        `select has_function_privilege($1,'public.issue_new_client_waitlist_invitation(uuid,uuid,uuid,integer)','EXECUTE') as ok`,
        [role],
      );
      expect(r.rows[0].ok, `${role} must not execute the unscoped issuer`).toBe(false);
    }
  });

  it("...and the SCOPED wrapper still issues, so the revoke disabled nothing real", async () => {
    // THE NON-REGRESSION HALF. The wrapper delegates to the function just
    // revoked; it works because it is SECURITY DEFINER owned by postgres, which
    // owns that function too. Without this assertion the revoke above could
    // pass while having broken the only supported issuance path.
    const offer = await seedOffer("revoked-issuer-still-issues");
    expect(offer.token).toMatch(HEX64);
    const row = await invitationRow(offer.invitationId);
    expect(row.scope_service_id).toBe(offer.serviceId);
  });

  it("the scoped wrapper remains service_role-reachable", async () => {
    const r = await adminQuery(
      `select has_function_privilege('service_role','public.issue_scoped_new_client_waitlist_invitation(uuid,uuid,uuid,uuid,date,date,smallint[],integer)','EXECUTE') as ok`,
    );
    expect(r.rows[0].ok).toBe(true);
  });
});

describe("0192 — a declined entry can be offered again (P1 repair)", () => {
  it("decline -> requeue -> claim -> a DIFFERENT offer ISSUES", async () => {
    // The defect: the delegated issuer's already_invited predicate tested only
    // redeemed/expired/released, so the historical declined row still matched
    // and this returned `already_invited` forever. The no-repeat-declined index
    // was built to permit exactly this flow.
    const offer = await verifiedOffer("reoffer");
    const second = await seedService(offer.studio.studioId, "reoffer-2");

    expect((await decline(offer.token, offer.capability)).result).toBe("declined");

    const rq = await adminQuery(
      `select public.requeue_new_client_waitlist_entry($1,$2,$3) as result`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId],
    );
    expect(rq.rows[0].result).toBe("requeued");
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId,
      offer.entryId,
      offer.studio.userId,
    ]);

    const again = await adminQuery(
      `select result, invitation_id from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId, second],
    );
    expect(again.rows[0].result).toBe("issued");
    expect(again.rows[0].invitation_id).not.toBe(offer.invitationId);
  });

  it("the SAME declined offer is still refused — the no-repeat rule survives the repair", async () => {
    // The repair must not turn "a different offer is possible" into "the
    // identical declined offer can be re-issued", which the partial unique
    // index exists to forbid.
    const offer = await verifiedOffer("reoffer-same");
    expect((await decline(offer.token, offer.capability)).result).toBe("declined");
    await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId,
      offer.entryId,
      offer.studio.userId,
    ]);
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId,
      offer.entryId,
      offer.studio.userId,
    ]);
    // seedOffer issues current_date .. current_date + 13, so THAT window is the
    // identical offer. A different end date is a DIFFERENT offer and must still
    // be allowed — asserting both is what makes this discriminating rather than
    // a blanket refusal.
    const identical = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId, offer.serviceId],
    );
    // A CODE, NEVER A RAISE. Before this moved to issue time, the identical
    // offer was ISSUED and the second decline died on a bare 23505 out of the
    // partial index — the failure mode 0185 forbids.
    expect(identical.rows[0].result).toBe("already_declined_offer");

    const different = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 7, null, 72)`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId, offer.serviceId],
    );
    expect(
      different.rows[0].result,
      "a DIFFERENT window is a different offer and must still issue",
    ).toBe("issued");
  });

  it("a second identical decline is therefore UNREACHABLE, so no 23505 can escape", async () => {
    const offer = await verifiedOffer("no-23505");
    expect((await decline(offer.token, offer.capability)).result).toBe("declined");
    await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId, offer.entryId, offer.studio.userId,
    ]);
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      offer.studio.studioId, offer.entryId, offer.studio.userId,
    ]);
    // The only route to a duplicate declined row is a second identical issue.
    const blocked = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
      [offer.studio.studioId, offer.entryId, offer.studio.userId, offer.serviceId],
    );
    expect(blocked.rows[0].result).toBe("already_declined_offer");
    // ...and exactly one declined row stands for this entry.
    const n = await adminQuery(
      `select count(*)::int as n from public.new_client_waitlist_invitations
        where entry_id = $1 and declined_at is not null`,
      [offer.entryId],
    );
    expect(n.rows[0].n).toBe(1);
  });
});

describe("0192 — decline takes the ENTRY lock first, so it cannot deadlock (P2 repair)", () => {
  it("racing decline against release yields ONE outcome and never a deadlock", async () => {
    // release_ and expire_ both lock the entry then the invitation. decline_
    // previously did the reverse, which is a genuine cycle: PostgreSQL aborts
    // one otherwise-valid command with 40P01 instead of returning a closed
    // lifecycle result. Run repeatedly, because a race that fires sometimes is
    // still a defect.
    const TRIALS = 8;
    let deadlocks = 0;
    for (let i = 0; i < TRIALS; i++) {
      const offer = await verifiedOffer(`race-${i}`);
      const results = await Promise.allSettled([
        decline(offer.token, offer.capability),
        adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) as result`, [
          offer.studio.studioId,
          offer.entryId,
          offer.studio.userId,
        ]),
      ]);
      for (const r of results) {
        if (r.status === "rejected" && (r.reason as { code?: string })?.code === "40P01") {
          deadlocks += 1;
        }
      }
      // Whoever won, the invitation carries EXACTLY ONE terminal outcome.
      const row = await invitationRow(offer.invitationId);
      const outcomes = [
        row.redeemed_at,
        row.declined_at,
        row.released_at,
        row.expired_at,
      ].filter((v) => v !== null);
      expect(outcomes.length, "exactly one terminal outcome per invitation").toBe(1);
    }
    expect(deadlocks, `${deadlocks}/${TRIALS} trials deadlocked (40P01)`).toBe(0);
  });

  it("every command over this pair takes the ENTRY mutex before the invitation", async () => {
    // Structural, and it is the property that makes the race above safe rather
    // than merely lucky. Read from the BUILT functions, not the migration text.
    for (const fn of [
      "decline_new_client_waitlist_invitation",
      "release_new_client_waitlist_entry",
      "expire_new_client_waitlist_invitation",
      "issue_new_client_waitlist_invitation",
    ]) {
      const r = await adminQuery(
        `select pg_get_functiondef(p.oid) as def
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname=$1`,
        [fn],
      );
      const def: string = r.rows[0].def;
      // Strip comments: a comment quoting old code reads as live code.
      const code = def
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n");
      const firstLock = code.indexOf("for update");
      expect(firstLock, `${fn} must take a row lock`).toBeGreaterThan(-1);
      const before = code.slice(0, firstLock);
      const lastEntries = before.lastIndexOf("new_client_waitlist_entries");
      const lastInvites = before.lastIndexOf("new_client_waitlist_invitations");
      expect(
        lastEntries,
        `${fn}: the FIRST 'for update' must target new_client_waitlist_entries`,
      ).toBeGreaterThan(lastInvites);
    }
  });
});

describe("0192 — the challenge carries a NON-SECRET event identity", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("begin_ returns a challenge_id, and it is stored with that challenge", async () => {
    const offer = await seedOffer("cid");
    const begun = await beginProof(offer.token);
    expect(begun.result).toBe("challenge_issued");
    expect(begun.challenge_id).toMatch(UUID);
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_challenge_id).toBe(begun.challenge_id);
  });

  it("is NOT derived from the raw challenge — the whole point of it", async () => {
    // #680's defect: a proof-send idempotency key was derived from a payload
    // containing the code, so the transmitted header became an offline verifier
    // for it. A handle that is a function of the secret is not a safe handle.
    const offer = await seedOffer("cid-independent");
    const begun = await beginProof(offer.token);
    const raw: string = begun.raw_challenge;
    const cid: string = begun.challenge_id;
    const bare = cid.replace(/-/g, "");
    expect(raw).not.toContain(bare);
    expect(bare).not.toContain(raw);
    // sha256 of the challenge must not be the id either.
    const d = await adminQuery(
      `select encode(extensions.digest($1,'sha256'),'hex') as h`,
      [raw],
    );
    expect(d.rows[0].h).not.toContain(bare);
  });

  it("a NEW challenge REPLACES the id, so a stale handle names nothing live", async () => {
    const offer = await seedOffer("cid-replace");
    const first = await beginProof(offer.token);
    const second = await beginProof(offer.token);
    expect(second.challenge_id).not.toBe(first.challenge_id);
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_challenge_id).toBe(second.challenge_id);
  });

  it("is CLEARED when the challenge is consumed", async () => {
    const offer = await seedOffer("cid-consumed");
    const begun = await beginProof(offer.token);
    expect((await completeProof(offer.token, begun.raw_challenge)).result).toBe("verified");
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_challenge_id).toBeNull();
  });

  it("is CLEARED by invalidate_", async () => {
    const offer = await seedOffer("cid-invalidated");
    await beginProof(offer.token);
    await adminQuery(`select public.invalidate_waitlist_invitation_proof($1)`, [
      offer.invitationId,
    ]);
    expect((await invitationRow(offer.invitationId)).proof_challenge_id).toBeNull();
  });

  it("id, verifier and expiry are ONE state — no two-of-three is representable", async () => {
    const offer = await seedOffer("cid-pairing");
    await beginProof(offer.token);
    // Strip the id but keep the challenge: the pairing CHECK must refuse.
    let code = "NO_ERROR";
    try {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set proof_challenge_id = null where id = $1`,
        [offer.invitationId],
      );
    } catch (e) {
      code = (e as { code?: string }).code ?? "UNKNOWN";
    }
    expect(code).toBe("23514"); // check_violation
  });

  it("is never readable by the browser, and grants nothing", async () => {
    const r = await adminQuery(
      `select has_column_privilege('authenticated','public.new_client_waitlist_invitations','proof_challenge_id','SELECT') as ok`,
    );
    expect(r.rows[0].ok).toBe(false);
    // NOT AUTHORITY: holding the id cannot redeem or decline.
    const offer = await verifiedOffer("cid-not-authority");
    const begun = await beginProof(offer.token); // fresh challenge, kills capability
    const asCapability = String(begun.challenge_id).replace(/-/g, "") + "0".repeat(32);
    const r2 = await redeem(offer.token, asCapability.slice(0, 64));
    expect(r2.result).toBe("proof_required");
  });
});

describe("0192 — decline vs expire keeps the same lock order (P2)", () => {
  it("racing decline against expire yields ONE outcome and never a deadlock", async () => {
    const TRIALS = 8;
    let deadlocks = 0;
    for (let i = 0; i < TRIALS; i++) {
      const offer = await verifiedOffer(`race-exp-${i}`);
      const results = await Promise.allSettled([
        decline(offer.token, offer.capability),
        adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) as result`, [
          offer.studio.studioId,
          offer.entryId,
          offer.studio.userId,
        ]),
      ]);
      for (const r of results) {
        if (r.status === "rejected" && (r.reason as { code?: string })?.code === "40P01") {
          deadlocks += 1;
        }
      }
      const row = await invitationRow(offer.invitationId);
      const outcomes = [
        row.redeemed_at,
        row.declined_at,
        row.released_at,
        row.expired_at,
      ].filter((v) => v !== null);
      // Expiry only RECORDS an elapsed clock, so on a live invitation it
      // refuses; either way at most one terminal outcome may be written, and
      // the loser must come back with a lifecycle result rather than an abort.
      expect(outcomes.length).toBeLessThanOrEqual(1);
      for (const r of results) {
        expect(r.status, "neither command may be aborted").toBe("fulfilled");
      }
    }
    expect(deadlocks, `${deadlocks}/${TRIALS} trials deadlocked (40P01)`).toBe(0);
  });
});

// WAIT DELIVERY-01 contract delta. The delivery layer has to state when the code
// was issued, and only the database knows: it is the post-lock instant this
// command already decided on. These prove the returned value IS that instant
// rather than a second reading that merely looks close.
describe("0192 — begin_ returns the authoritative mint instant", () => {
  it("issued_at comes back on a successful mint", async () => {
    const inv = await seedOffer("issat1");
    const r = await beginProof(inv.token, 15);
    expect(r.result).toBe("challenge_issued");
    expect(r.issued_at).not.toBeNull();
  });

  it("expires_at MINUS issued_at is exactly the accepted TTL", async () => {
    for (const ttl of [1, 15, 30, 60]) {
      // A fresh offer per TTL: seedOffer keys its studio and email off the label.
      const inv = await seedOffer(`issat2-${ttl}`);
      const r = await beginProof(inv.token, ttl);
      const delta =
        (new Date(r.expires_at as string).getTime() -
          new Date(r.issued_at as string).getTime()) / 60000;
      // EXACT, not approximate. Both come from the same v_now, so any drift
      // would mean the command read the clock twice.
      expect(delta, `ttl ${ttl}`).toBe(ttl);
    }
  });

  it("issued_at agrees with the expiry the ROW recorded, so it is the post-lock clock", async () => {
    const inv = await seedOffer("issat3");
    const r = await beginProof(inv.token, 15);
    const row = await adminQuery(
      "select proof_challenge_expires_at from public.new_client_waitlist_invitations where id = $1",
      [inv.invitationId],
    );
    const stored = new Date(row.rows[0].proof_challenge_expires_at as string).getTime();
    const derived = new Date(r.issued_at as string).getTime() + 15 * 60000;
    expect(derived).toBe(stored);
  });

  it("is NULL on every refusal — it is not a field a caller can mine", async () => {
    const inv = await seedOffer("issat4");
    for (const [token, ttl] of [
      ["nope", 15],
      ["a".repeat(64), 15],
      [inv.token, 0],
      [inv.token, 61],
    ] as Array<[string, number]>) {
      const r = await beginProof(token, ttl);
      expect(r.result).not.toBe("challenge_issued");
      expect(r.issued_at, `${r.result} must carry no instant`).toBeNull();
      expect(r.challenge_id).toBeNull();
    }
  });

  it("a REPLACEMENT challenge returns a new challenge_id AND a later, authoritative issued_at", async () => {
    const TTL = 15;
    // A DETERMINISTIC gap between the two mints, slept by POSTGRESQL. Strict
    // chronology then rests on the database's own clock having demonstrably
    // advanced, rather than on two round trips happening to straddle a tick.
    const GAP_SECONDS = 0.005;

    const inv = await seedOffer("issat5");
    const first = await beginProofPrecise(inv.token, TTL);
    expect(first.result).toBe("challenge_issued");

    await adminQuery(`select pg_sleep($1::float8)`, [GAP_SECONDS]);

    const second = await beginProofPrecise(inv.token, TTL);
    expect(second.result).toBe("challenge_issued");

    // IDENTITY is challenge_id's job and only challenge_id's. The instants
    // below are asked about CHRONOLOGY; they are never used to tell the two
    // challenges apart, so this proof does not quietly depend on timestamps
    // being unique.
    expect(second.challenge_id).not.toBe(first.challenge_id);

    // The assertion that used to run on truncated `Date`s, now decided by
    // PostgreSQL over the values it actually stored.
    await expectPostgresTemporalRelation(
      {
        sql: `select $1::timestamptz, $2::timestamptz`,
        params: [second.issued_at_us, first.issued_at_us],
        relation: "gt",
      },
      "the replacement mint must be strictly later than the mint it replaced",
    );

    // And later BY THE GAP WE MADE — so the second value is a fresh reading of
    // the clock, not the first one served again.
    await expectPostgresTemporalRelation(
      {
        sql: `select $1::timestamptz, $2::timestamptz + make_interval(secs => $3::float8)`,
        params: [second.issued_at_us, first.issued_at_us, GAP_SECONDS],
        relation: "gte",
      },
      `the replacement mint must clear the ${GAP_SECONDS}s database sleep between the two`,
    );

    // The replacement's OWN window is still exactly the TTL it was asked for.
    await expectPostgresSameInstant(
      {
        sql: `select $1::timestamptz, $2::timestamptz + make_interval(mins => $3::int)`,
        params: [second.expires_at_us, second.issued_at_us, TTL],
      },
      `the replacement's expires_at minus issued_at must be exactly the requested ${TTL}m TTL`,
    );

    // And the instant it RETURNED is the one the ROW was written from. That is
    // what makes it the database's decision instant rather than a second
    // reading that merely looks close — the claim this describe block exists
    // for, held to microsecond equality on the replacement path too.
    await expectPostgresSameInstant(
      {
        sql: `select i.proof_challenge_expires_at,
                     $2::timestamptz + make_interval(mins => $3::int)
                from public.new_client_waitlist_invitations i
               where i.id = $1`,
        params: [inv.invitationId, second.issued_at_us, TTL],
      },
      "the replacement's issued_at must be the same v_now the row's challenge expiry was written from",
    );
  });

  it("the CAPABILITY clock is untouched — still database-owned 30m, not this TTL", async () => {
    const inv = await seedOffer("issat6");
    const begun = await beginProof(inv.token, 15);
    const done = await completeProof(inv.token, begun.raw_challenge as string);
    expect(done.result).toBe("verified");
    const row = await adminQuery(
      "select proof_capability_expires_at from public.new_client_waitlist_invitations where id = $1",
      [inv.invitationId],
    );
    const minutesFromChallengeMint =
      (new Date(row.rows[0].proof_capability_expires_at as string).getTime() -
        new Date(begun.issued_at as string).getTime()) / 60000;
    // The capability lives 30 minutes from ITS OWN mint, which is at or after the
    // challenge's -- so measured from the challenge instant the gap is 30 plus
    // however long elapsed between the two commands.
    //
    // The bound is INCLUSIVE deliberately. A strict `> 30` encoded an assumption
    // about scheduling: it passed locally on a 4ms gap and failed on CI, where
    // both commands landed inside the same millisecond and the difference came
    // back as exactly 30. The claim being made is about which TTL governs, not
    // about how fast the runner is, so it is stated as a band: at least 30, under
    // 31, and nowhere near the challenge's 15.
    expect(minutesFromChallengeMint).toBeGreaterThanOrEqual(30);
    expect(minutesFromChallengeMint).toBeLessThan(31);
  });
});

// ===========================================================================
// A PROOF CHALLENGE MAY NEVER OUTLIVE THE INVITATION THAT AUTHORISES IT
// ===========================================================================
//
// THE DEFECT THIS BLOCK EXISTS TO KEEP CLOSED. `begin_waitlist_invitation_proof`
// bounded the requested TTL at 1..60 minutes and nothing else, so an invitation
// with two minutes of life left minted a fifteen-minute challenge. Nothing
// escalated: `complete_` gates on invitation liveness BEFORE it looks at the
// challenge, so a use after `expires_at` already answered `not_live`. What broke
// was TRUTH — the stored column asserted an instant the authority would never
// honour, and `begin_` RETURNS that instant to the server-side delivery caller,
// which states it to the recipient. The email promised a window that had already
// been overtaken by the invitation's own death.
//
// THE RULE IS ENFORCED AT THE MINT, WHICH IS THE ONLY PLACE IT CAN BE
// STRUCTURAL. `begin_` is the sole writer of a non-null
// proof_challenge_expires_at — the two other writes in 0192 set it to NULL — so
// the clamp makes a longer-lived challenge unrepresentable rather than merely
// refused downstream. A delivery caller may still decline to send a window it
// judges too short; that is a second opinion about output and cannot repair a
// value already persisted.
//
// EVERY TEMPORAL VERDICT HERE IS POSTGRESQL'S. node-postgres truncates
// timestamptz microseconds to JS milliseconds, so a clamp that lands exactly on
// the invitation's expiry would compare equal under a `Date` round trip whether
// or not it actually did. The comparisons run in the database.

/**
 * Run `fn` with the invitation table's append-only guard lifted.
 *
 * THE GUARD IS REAL AND LOAD-BEARING: 0188 makes identity, tenancy, token and
 * the validity window immutable — "there is no renewal or extension" — so an
 * invitation's `expires_at` cannot be moved by any shipped path. That is
 * exactly WHY this defect matters rather than an obstacle to proving it: a
 * short remaining lifetime is reached by the passage of TIME and cannot be
 * repaired by extending the invitation, so the mint is the only place the two
 * clocks can be reconciled.
 *
 * A test cannot wait fifty-eight minutes, so the fixture moves the stored
 * expiry to simulate elapsed time.
 *
 * THE `finally` IS THE WHOLE POINT, AND IT IS WHY EVERY CALLER GOES THROUGH
 * HERE. A raw disable/mutate/enable sequence restores nothing if the mutation
 * throws, an assertion fails between the two statements, or the connection
 * drops — and what it leaves behind is not a failed test but a DATABASE WITH
 * APPEND-ONLY ENFORCEMENT SWITCHED OFF. Every later test in the run then
 * silently exercises a weaker table than the one that ships, so the next
 * failure is somewhere else entirely and looks nothing like this one.
 * `alter table` is not transactional here either: a rolled-back transaction
 * does not put the trigger back.
 *
 * `fileParallelism: false` keeps the window from overlapping another suite, so
 * the only exposure that ever mattered was an unrestored one.
 */
async function withInvitationWindowMutable<T>(fn: () => Promise<T>): Promise<T> {
  await adminQuery(
    `alter table public.new_client_waitlist_invitations
       disable trigger new_client_waitlist_invitations_append_only`,
  );
  try {
    return await fn();
  } finally {
    await adminQuery(
      `alter table public.new_client_waitlist_invitations
         enable trigger new_client_waitlist_invitations_append_only`,
    );
  }
}

/**
 * Age an invitation so `interval` of its life remains.
 *
 * BOTH STAMPS MOVE, because 0188 bounds the window relative to issuance —
 * `expires_at > issued_at and expires_at <= issued_at + interval '7 days'` — so
 * dragging the expiry alone would either invert the window or leave the row
 * describing a lifetime it never had. Moving both is also the honest model of
 * what actually happens in production: nothing shortens an invitation, TIME
 * passes. `seedOffer` issues a 72-hour offer, so 71 hours of elapsed time
 * leaves exactly the last hour to play with and every offset used here — from
 * six hours down to one second past death — stays inside the constraint.
 */
async function setInvitationExpiry(invitationId: string, interval: string): Promise<void> {
  await withInvitationWindowMutable(async () => {
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set issued_at  = clock_timestamp() - interval '71 hours',
              expires_at = clock_timestamp() + $2::interval
        where id = $1`,
      [invitationId, interval],
    );
  });
}

/** The stored challenge expiry beside the invitation's own, as one row. */
const CHALLENGE_VS_INVITATION = `
  select i.proof_challenge_expires_at, i.expires_at
    from public.new_client_waitlist_invitations i
   where i.id = $1`;

async function conn(): Promise<Client> {
  const c = new Client({ connectionString: resolveLocalDbUrl() });
  await c.connect();
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("0192 — the challenge clock is bounded by the invitation clock", () => {
  it("NORMAL CASE UNCHANGED: ample remaining lifetime still grants the full requested TTL", async () => {
    // seedOffer issues a 72-hour invitation, so every accepted challenge TTL
    // (1..60 minutes) is far inside it and the clamp must not engage at all.
    for (const ttl of [1, 15, 60]) {
      const offer = await seedOffer(`clamp-normal-${ttl}`);
      const r = await adminQuery(
        `select result,
                to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expires_us,
                to_char(issued_at,  'YYYY-MM-DD"T"HH24:MI:SS.USOF') as issued_us
           from public.begin_waitlist_invitation_proof($1, $2)`,
        [offer.token, ttl],
      );
      expect(r.rows[0].result, `ttl ${ttl}`).toBe("challenge_issued");

      // EXACTLY the requested window, judged in the database at microsecond
      // precision: expires_at - issued_at = ttl minutes, to the microsecond.
      await expectPostgresSameInstant(
        {
          sql: `select $1::timestamptz, $2::timestamptz + make_interval(mins => $3::int)`,
          params: [r.rows[0].expires_us, r.rows[0].issued_us, ttl],
        },
        `ttl ${ttl} — an unclamped mint must still grant the whole requested window`,
      );

      // NON-VACUITY: the clamp had room to engage and did not. A test that
      // asserted only the invariant would pass here even if the clamp had
      // wrongly pulled the expiry back to the invitation's.
      await expectPostgresTemporalRelation(
        {
          sql: CHALLENGE_VS_INVITATION,
          params: [offer.invitationId],
          relation: "lt",
        },
        `ttl ${ttl} — the challenge must sit strictly INSIDE a 72-hour invitation`,
      );
    }
  });

  it("SHORT REMAINING: the challenge is clamped to the invitation's own expiry, never past it", async () => {
    const offer = await seedOffer("clamp-short");
    // Three minutes left against a fifteen-minute request: the old shape minted
    // a challenge twelve minutes past the invitation's death.
    await setInvitationExpiry(offer.invitationId, "3 minutes");

    const r = await beginProof(offer.token, 15);
    expect(r.result, "a live invitation still issues — clamping is not refusing").toBe(
      "challenge_issued",
    );

    // THE INVARIANT, stated as the equality the clamp actually produces: with
    // less remaining than requested, the challenge dies exactly when the
    // invitation does, to the microsecond.
    await expectPostgresSameInstant(
      {
        sql: CHALLENGE_VS_INVITATION,
        params: [offer.invitationId],
      },
      "a short-remaining invitation must pull the challenge back to its own expiry",
    );
  });

  it("THE INVARIANT HOLDS ACROSS THE WHOLE REMAINING/REQUESTED MATRIX", async () => {
    // Remaining lifetimes either side of, and exactly on, the requested window.
    // `lte` is the invariant itself; the two cases above pin which side each
    // one lands on, so this is the general claim rather than a restatement.
    for (const [label, remaining, ttl] of [
      ["far-inside", "6 hours", 15],
      ["just-inside", "16 minutes", 15],
      ["equal", "15 minutes", 15],
      ["just-outside", "14 minutes", 15],
      ["far-outside", "30 seconds", 60],
    ] as const) {
      const offer = await seedOffer(`clamp-matrix-${label}`);
      await setInvitationExpiry(offer.invitationId, remaining);

      const r = await beginProof(offer.token, ttl);
      expect(r.result, `${label} — still live, so still issued`).toBe("challenge_issued");

      await expectPostgresTemporalRelation(
        {
          sql: CHALLENGE_VS_INVITATION,
          params: [offer.invitationId],
          relation: "lte",
        },
        `${label} (${remaining} left, ${ttl}m requested) — the challenge outlived the invitation`,
      );

      // AND IT IS NEVER MINTED ALREADY DEAD. The liveness gate established
      // expires_at > now, so the clamped instant is strictly in the future for
      // every challenge this command issues. This is why the repair needs no
      // new refusal word: `challenge_issued` stays truthful at every remaining
      // lifetime, and the returned expiry reports the window actually granted.
      await expectPostgresTemporalRelation(
        {
          sql: `select i.proof_challenge_expires_at, clock_timestamp()
                  from public.new_client_waitlist_invitations i where i.id = $1`,
          params: [offer.invitationId],
          relation: "gt",
        },
        `${label} — a challenge was minted already expired`,
      );
    }
  });

  it("THE RETURNED EXPIRY IS THE PERSISTED ONE, on the clamped path too", async () => {
    const offer = await seedOffer("clamp-returned");
    await setInvitationExpiry(offer.invitationId, "4 minutes");

    // Rendered to microsecond TEXT by the statement that mints it, so the value
    // never becomes a JS Date and can be handed back as a timestamptz. A
    // millisecond round trip would hide a sub-millisecond disagreement between
    // what was returned and what was written.
    const r = await adminQuery(
      `select result,
              to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expires_us
         from public.begin_waitlist_invitation_proof($1, $2)`,
      [offer.token, 15],
    );
    expect(r.rows[0].result).toBe("challenge_issued");

    await expectPostgresSameInstant(
      {
        sql: `select $1::timestamptz, i.proof_challenge_expires_at
                from public.new_client_waitlist_invitations i where i.id = $2`,
        params: [r.rows[0].expires_us, offer.invitationId],
      },
      "the caller was told an expiry the row does not hold",
    );
  });

  it("AN EXPIRED INVITATION MINTS NOTHING — no challenge state is written at all", async () => {
    const offer = await seedOffer("clamp-expired");
    await setInvitationExpiry(offer.invitationId, "-1 second");

    const r = await beginProof(offer.token, 15);
    expect(r.result).toBe("not_live");
    expect(r.expires_at, "a refusal must not hand back an expiry").toBeNull();
    expect(r.raw_challenge).toBeNull();
    expect(r.challenge_id).toBeNull();

    // The clamp must not have quietly written a zero-length challenge on the
    // way to refusing: the row carries no challenge state whatsoever.
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_challenge_hash).toBeNull();
    expect(row.proof_challenge_id).toBeNull();
    const stored = await adminQuery(
      `select proof_challenge_expires_at from public.new_client_waitlist_invitations where id = $1`,
      [offer.invitationId],
    );
    expect(stored.rows[0].proof_challenge_expires_at).toBeNull();
  });

  it("POST-LOCK TRUTH WINS: an invitation SHORTENED while begin_ waits clamps to the NEW expiry", async () => {
    const offer = await seedOffer("clamp-lock-shorten");
    // The guard is lifted around the WHOLE dance: `alter table` needs an
    // ACCESS EXCLUSIVE lock, which the holder's row lock would block, so it
    // cannot be taken while a transaction is parked on the row.
    await withInvitationWindowMutable(async () => {
      const holder = await conn();
      const waiter = await conn();
      try {
        // The holder takes the invitation mutex begin_ must have, then moves the
        // invitation's death while the waiter is parked on it.
        await holder.query("begin");
        await holder.query(
          `select 1 from public.new_client_waitlist_invitations where id = $1 for update`,
          [offer.invitationId],
        );

        await waiter.query("begin");
        const pid = (await waiter.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const pending = waiter.query(
          `select result,
                  to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expires_us
             from public.begin_waitlist_invitation_proof($1, $2)`,
          [offer.token, 60],
        );

        // PROVE it is really parked on the lock, not merely slow — otherwise this
        // test could pass without the race it exists to describe ever happening.
        expect(
          await waitUntilBlocked(pid),
          "begin_ never blocked on the invitation mutex — this case tests nothing",
        ).not.toBeNull();

        await holder.query(
          `update public.new_client_waitlist_invitations
              set issued_at  = clock_timestamp() - interval '71 hours',
                  expires_at = clock_timestamp() + interval '2 minutes'
            where id = $1`,
          [offer.invitationId],
        );
        await holder.query("commit");

        const got = (await pending).rows[0] as { result: string; expires_us: string };
        await waiter.query("commit");

        expect(got.result).toBe("challenge_issued");

        // The value the waiter clamped against is the one it read AFTER acquiring
        // the lock. A pre-lock read would have clamped against the original
        // 72-hour expiry and granted the full 60 minutes.
        await expectPostgresSameInstant(
          {
            sql: `select $1::timestamptz, i.expires_at
                    from public.new_client_waitlist_invitations i where i.id = $2`,
            params: [got.expires_us, offer.invitationId],
          },
          "begin_ clamped against a stale pre-lock expiry",
        );
        await expectPostgresTemporalRelation(
          {
            sql: CHALLENGE_VS_INVITATION,
            params: [offer.invitationId],
            relation: "lte",
          },
          "the persisted challenge outlived the shortened invitation",
        );
      } finally {
        await holder.end().catch(() => undefined);
        await waiter.end().catch(() => undefined);
      }
    });
  });

  it("POST-LOCK TRUTH WINS: an invitation EXPIRED while begin_ waits refuses outright", async () => {
    const offer = await seedOffer("clamp-lock-expire");
    await withInvitationWindowMutable(async () => {
      const holder = await conn();
      const waiter = await conn();
      try {
        await holder.query("begin");
        await holder.query(
          `select 1 from public.new_client_waitlist_invitations where id = $1 for update`,
          [offer.invitationId],
        );

        await waiter.query("begin");
        const pid = (await waiter.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const pending = waiter.query(
          `select result, expires_at, raw_challenge
             from public.begin_waitlist_invitation_proof($1, $2)`,
          [offer.token, 15],
        );
        expect(
          await waitUntilBlocked(pid),
          "begin_ never blocked on the invitation mutex — this case tests nothing",
        ).not.toBeNull();

        // A material wait, so the liveness verdict cannot be explained by the two
        // statements landing in the same instant.
        await sleep(250);
        await holder.query(
          `update public.new_client_waitlist_invitations
              set issued_at  = clock_timestamp() - interval '71 hours',
                  expires_at = clock_timestamp() - interval '1 second'
            where id = $1`,
          [offer.invitationId],
        );
        await holder.query("commit");

        const got = (await pending).rows[0] as Record<string, unknown>;
        await waiter.query("commit");

        // The post-lock clock and the post-lock row together: the invitation died
        // during the wait, so nothing is minted for it.
        expect(got.result).toBe("not_live");
        expect(got.expires_at).toBeNull();
        expect(got.raw_challenge).toBeNull();

        const row = await invitationRow(offer.invitationId);
        expect(row.proof_challenge_hash).toBeNull();
        expect(row.proof_challenge_id).toBeNull();
      } finally {
        await holder.end().catch(() => undefined);
        await waiter.end().catch(() => undefined);
      }
    });
  });

  it("REISSUE STILL REPLACES: a clamped challenge is invalidated by the next one, exactly as before", async () => {
    const offer = await seedOffer("clamp-reissue");
    await setInvitationExpiry(offer.invitationId, "5 minutes");

    const first = await beginProof(offer.token, 15);
    expect(first.result).toBe("challenge_issued");
    const firstChallenge = first.raw_challenge as string;
    const firstId = first.challenge_id as string;

    // Verify to mint a capability, so the reissue has BOTH credentials to kill.
    const verified = await completeProof(offer.token, firstChallenge);
    expect(verified.result).toBe("verified");

    const second = await beginProof(offer.token, 15);
    expect(second.result).toBe("challenge_issued");
    expect(second.challenge_id).not.toBe(firstId);

    // The older challenge no longer verifies, and the capability minted from it
    // is gone — the clamp changed the expiry, not the replacement rule.
    const stale = await completeProof(offer.token, firstChallenge);
    expect(stale.result).toBe("wrong_challenge");
    const row = await invitationRow(offer.invitationId);
    expect(row.proof_capability_hash, "reissue must kill any live capability").toBeNull();

    // ...and the replacement is clamped too.
    await expectPostgresSameInstant(
      { sql: CHALLENGE_VS_INVITATION, params: [offer.invitationId] },
      "the replacement challenge escaped the clamp",
    );
  });

  it("THE CAPABILITY CLOCK IS UNTOUCHED: still database-owned 30 minutes, even on a clamped challenge", async () => {
    const offer = await seedOffer("clamp-capability");
    await setInvitationExpiry(offer.invitationId, "2 minutes");

    const begun = (
      await adminQuery(
        `select result, raw_challenge,
                to_char(issued_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as issued_us
           from public.begin_waitlist_invitation_proof($1, $2)`,
        [offer.token, 15],
      )
    ).rows[0] as { result: string; raw_challenge: string; issued_us: string };
    expect(begun.result).toBe("challenge_issued");
    // MICROSECOND TEXT, for the reason `beginProofPrecise` exists: node-postgres
    // renders a timestamptz as a JS Date and drops microseconds, so a stored
    // value and a returned one that differ by 793us compare EQUAL after the
    // round trip. Measured here before it was written this way.
    const done = (
      await adminQuery(
        `select result, raw_capability,
                to_char(expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') as expires_us
           from public.complete_waitlist_invitation_proof($1, $2)`,
        [offer.token, begun.raw_challenge],
      )
    ).rows[0] as { result: string; raw_capability: string; expires_us: string };
    expect(done.result).toBe("verified");

    // DELIBERATELY NOT CLAMPED, and this test pins that as a decision rather
    // than an oversight. The capability's 30 minutes is the database's own law
    // and this repair does not touch it. It is safe for it to outlast the
    // invitation because every consumer —
    // redeem_new_client_waitlist_invitation_verified, decline_, and
    // resolve_waitlist_invitation_recipient_identity — gates on invitation
    // liveness BEFORE it looks at the capability, so a capability on a dead
    // invitation answers `not_live` rather than acting.
    // `complete_` RETURNS the capability's own expiry, so the stored value and
    // the returned one are the same fact and are asserted as such — no second
    // arithmetic here that could disagree with the command's.
    await expectPostgresSameInstant(
      {
        sql: `select i.proof_capability_expires_at, $2::timestamptz
                from public.new_client_waitlist_invitations i where i.id = $1`,
        params: [offer.invitationId, done.expires_us],
      },
      "the stored capability expiry is not the one complete_ reported",
    );
    // STILL THIRTY MINUTES FROM ITS OWN MINT, stated as a band and judged in the
    // database. A strict equality would be decided by how many microseconds
    // elapsed between begin_ and complete_, not by which TTL governs; at least
    // 30 and under 31 is the claim, and 15 — the challenge's — is what a
    // regression would show. Both operands stay timestamptz throughout: the
    // microsecond text `to_char` produces is not parseable by `new Date`, which
    // is why the arithmetic does not come back to JavaScript at all.
    for (const [rel, bound, why] of [
      ["gte", "30 minutes", "the capability lost time to the challenge's TTL"],
      ["lt", "31 minutes", "the capability gained time it was never granted"],
    ] as const) {
      await expectPostgresTemporalRelation(
        {
          sql: `select i.proof_capability_expires_at,
                       $2::timestamptz + $3::interval
                  from public.new_client_waitlist_invitations i where i.id = $1`,
          params: [offer.invitationId, begun.issued_us, bound],
          relation: rel,
        },
        why,
      );
    }
    // And it genuinely does outlive the 2-minute invitation, so the claim above
    // is being exercised rather than asserted about an impossible state.
    await expectPostgresTemporalRelation(
      {
        sql: `select i.proof_capability_expires_at, i.expires_at
                from public.new_client_waitlist_invitations i where i.id = $1`,
        params: [offer.invitationId],
        relation: "gt",
      },
      "the capability no longer outlives a short invitation — the premise moved",
    );

    // The consumer's own verdict, not an argument about it.
    await setInvitationExpiry(offer.invitationId, "-1 second");
    const spent = await redeem(offer.token, done.raw_capability);
    expect(spent.result, "a live capability on a dead invitation must not act").toBe("not_live");
  });

  it("NO PLAINTEXT IS PERSISTED ON THE CLAMPED PATH EITHER", async () => {
    const offer = await seedOffer("clamp-plaintext");
    await setInvitationExpiry(offer.invitationId, "90 seconds");

    const begun = await beginProof(offer.token, 60);
    expect(begun.result).toBe("challenge_issued");
    const done = await completeProof(offer.token, begun.raw_challenge as string);
    expect(done.result).toBe("verified");

    const stored = await adminQuery(
      `select * from public.new_client_waitlist_invitations where id = $1`,
      [offer.invitationId],
    );
    const blob = JSON.stringify(stored.rows[0]);
    expect(blob).not.toContain(begun.raw_challenge);
    expect(blob).not.toContain(done.raw_capability);
    expect(blob).not.toContain(offer.token);
  });
});

// ===========================================================================
// A DECLINED INVITATION IS CLOSED TO EVERY LIFECYCLE COMMAND, NOT JUST TO
// ISSUANCE
// ===========================================================================
//
// THE CLASS THIS BLOCK CLOSES. Section 3 of 0192 replaced 0188's
// `..._one_live_per_entry` UNIQUE index -- (entry_id) WHERE redeemed_at,
// expired_at and released_at are all null -- with the four-column predicate
// that also requires `declined_at is null`. That is deliberate: it is what lets
// a declined invitation stop blocking its entry so a later offer is possible.
//
// But that index was not decoration. Its UNIQUENESS is what made an UNORDERED
// `select i.id into v_inv` over the three columns correct in 0188 and 0189: at
// most one row could match, so "the row matching" and "the current cycle" were
// the same thing by construction. Widening the index DELETED that guarantee
// while three commands were still asking the three-column question:
//
//     expire_new_client_waitlist_invitation
//     release_new_client_waitlist_entry
//     record_new_client_waitlist_conversion
//
// Section 14b redefines all three forward, each gaining `and i.declined_at is
// null`. 0188/0189/0190 are applied and frozen and are never edited.
//
// WHAT GOES WRONG WITHOUT IT. A declined row PASSES the old guards, so whichever
// row the unordered select happens to return is the one these commands act on.
// Stamping a declined row raises `one_terminal_outcome_check` (SQLSTATE 23514),
// so the command RAISES where 0185 requires it to answer with a WORD. Physical
// row order decided which branch ran -- the benign outcome was luck, not a
// guarantee, and a vacuum or plan change is enough to flip it. That is why the
// structural assertion below is stated over the PREDICATE and not over which row
// PostgreSQL happened to return.

/** JOIN -> CLAIM -> OFFER A -> verify -> DECLINE A -> REQUEUE -> CLAIM -> OFFER B. */
async function declinedThenReissued(label: string) {
  const offer = await seedOffer(`decl-${label}`);
  const svcB = await seedService(offer.studio.studioId, `${label}-B`);

  const begun = await beginProof(offer.token);
  const done = await completeProof(offer.token, begun.raw_challenge as string);
  expect(done.result, "the fixture must reach a real capability").toBe("verified");
  const dec = await adminQuery(
    `select result from public.decline_new_client_waitlist_invitation($1,$2)`,
    [offer.token, done.raw_capability],
  );
  expect(dec.rows[0].result).toBe("declined");

  await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
    offer.studio.studioId, offer.entryId, offer.studio.userId,
  ]);
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    offer.studio.studioId, offer.entryId, offer.studio.userId,
  ]);
  // A DIFFERENT offer: the no-repeat-declined rule still forbids re-issuing the
  // same one, and this fixture must not depend on relaxing it.
  const b = await adminQuery(
    `select result, raw_token, invitation_id
       from public.issue_scoped_new_client_waitlist_invitation(
              $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
    [offer.studio.studioId, offer.entryId, offer.studio.userId, svcB],
  );
  expect(b.rows[0].result, "a genuinely different later offer must remain possible").toBe("issued");
  return {
    studio: offer.studio,
    entryId: offer.entryId,
    A: offer.invitationId,
    B: b.rows[0].invitation_id as string,
    tokenB: b.rows[0].raw_token as string,
  };
}

const termsOf = async (id: string) =>
  (
    await adminQuery(
      `select declined_at is not null d, released_at is not null rel,
              expired_at is not null exp, redeemed_at is not null red
         from public.new_client_waitlist_invitations where id = $1`,
      [id],
    )
  ).rows[0];

describe("0192 §14b — a declined row is closed to expire, release and conversion", () => {
  it("THE FIXTURE ITSELF: A is declined-only, and B is the single live row", async () => {
    const f = await declinedThenReissued("shape");

    const a = await termsOf(f.A);
    expect(a.d, "A must be declined").toBe(true);
    expect([a.rel, a.exp, a.red], "A must carry NO other terminal outcome").toEqual([
      false, false, false,
    ]);

    // The invariant, stated over the PREDICATE rather than over row order.
    const counts = await adminQuery(
      `select
         count(*) filter (where redeemed_at is null and expired_at is null
                            and released_at is null)                        as three_terminal,
         count(*) filter (where redeemed_at is null and expired_at is null
                            and released_at is null and declined_at is null) as four_terminal
       from public.new_client_waitlist_invitations where entry_id = $1`,
      [f.entryId],
    );
    // ADVERSARIAL / NEGATIVE CONTROL, and it does not depend on which row
    // PostgreSQL returns first: the OLD predicate is genuinely ambiguous here
    // (two rows), while the NEW one is single-valued (one row). That ambiguity
    // IS the defect; ordering would not have fixed it.
    expect(Number(counts.rows[0].three_terminal), "the OLD predicate is ambiguous").toBe(2);
    expect(Number(counts.rows[0].four_terminal), "the NEW predicate is decisive").toBe(1);

    const live = await adminQuery(
      `select id from public.new_client_waitlist_invitations
        where entry_id = $1 and redeemed_at is null and expired_at is null
          and released_at is null and declined_at is null`,
      [f.entryId],
    );
    expect(live.rows.map((r) => r.id)).toEqual([f.B]);
  });

  it("RELEASE acts on B, and never adds a second terminal outcome to A", async () => {
    const f = await declinedThenReissued("release");
    const r = await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) r`, [
      f.studio.studioId, f.entryId, f.studio.userId,
    ]);
    // A WORD, NOT AN ERROR. Acting on the declined row would raise 23514.
    expect(r.rows[0].r).toBe("released");

    expect(await termsOf(f.B)).toMatchObject({ rel: true, d: false });
    expect(
      await termsOf(f.A),
      "A's declined_at must remain its SOLE terminal evidence",
    ).toMatchObject({ d: true, rel: false, exp: false, red: false });
  });

  it("EXPIRE adjudicates B's clock, never A's, and leaves A untouched", async () => {
    const f = await declinedThenReissued("expire");

    // B's window is open, so the truthful answer is `not_expired` -- and it must
    // be reached by reading B. A's window is aged past, so a command that
    // adjudicated A would answer differently.
    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = clock_timestamp() - interval '96 hours',
                expires_at = clock_timestamp() - interval '24 hours'
          where id = $1`,
        [f.A],
      );
    });

    const open = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) r`,
      [f.studio.studioId, f.entryId, f.studio.userId],
    );
    expect(open.rows[0].r, "B is still live, so nothing expires").toBe("not_expired");
    expect(await termsOf(f.A)).toMatchObject({ d: true, exp: false });

    // Now age B itself. Expiry must land on B.
    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = clock_timestamp() - interval '96 hours',
                expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [f.B],
      );
    });

    const done = await adminQuery(
      `select public.expire_new_client_waitlist_invitation($1,$2,$3) r`,
      [f.studio.studioId, f.entryId, f.studio.userId],
    );
    expect(done.rows[0].r).toBe("expired");
    expect(await termsOf(f.B)).toMatchObject({ exp: true, d: false });
    expect(
      await termsOf(f.A),
      "A must never receive expired_at on top of declined_at",
    ).toMatchObject({ d: true, exp: false, rel: false, red: false });
  });

  it("CONVERSION binds to B's redeemed cycle, never to historical A", async () => {
    const f = await declinedThenReissued("convert");

    const begun = await beginProof(f.tokenB);
    const done = await completeProof(f.tokenB, begun.raw_challenge as string);
    expect(done.result).toBe("verified");
    const red = await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
      [f.tokenB, done.raw_capability],
    );
    expect(red.rows[0].result).toBe("redeemed");

    const conv = await adminQuery(
      `select public.record_new_client_waitlist_conversion($1,$2,$3) r`,
      [f.studio.studioId, f.entryId, f.studio.clientId],
    );
    expect(conv.rows[0].r).toBe("converted");

    expect(await termsOf(f.B)).toMatchObject({ red: true, d: false });
    expect(
      await termsOf(f.A),
      "A stays declined-only through a conversion on a later cycle",
    ).toMatchObject({ d: true, red: false, rel: false, exp: false });
  });

  // -------------------------------------------------------------------------
  // NON-VACUITY: the repair adds awareness of a NEW terminal state. It must not
  // redefine the old ones. With no declined row anywhere, every verdict below is
  // the one 0188/0189 already gave.
  // -------------------------------------------------------------------------
  it("NO DECLINED ROW: release is unchanged", async () => {
    const o = await seedOffer("nodecl-release");
    const r = await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3) r`, [
      o.studio.studioId, o.entryId, o.studio.userId,
    ]);
    expect(r.rows[0].r).toBe("released");
    expect(await termsOf(o.invitationId)).toMatchObject({ rel: true, d: false });
  });

  it("NO DECLINED ROW: expire is unchanged, on both sides of the boundary", async () => {
    const o = await seedOffer("nodecl-expire");
    expect(
      (
        await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) r`, [
          o.studio.studioId, o.entryId, o.studio.userId,
        ])
      ).rows[0].r,
      "a live window still refuses",
    ).toBe("not_expired");

    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = clock_timestamp() - interval '96 hours',
                expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [o.invitationId],
      );
    });
    expect(
      (
        await adminQuery(`select public.expire_new_client_waitlist_invitation($1,$2,$3) r`, [
          o.studio.studioId, o.entryId, o.studio.userId,
        ])
      ).rows[0].r,
    ).toBe("expired");
  });

  it("NO DECLINED ROW: conversion is unchanged", async () => {
    const o = await seedOffer("nodecl-convert");
    const begun = await beginProof(o.token);
    const done = await completeProof(o.token, begun.raw_challenge as string);
    await adminQuery(
      `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
      [o.token, done.raw_capability],
    );
    const conv = await adminQuery(
      `select public.record_new_client_waitlist_conversion($1,$2,$3) r`,
      [o.studio.studioId, o.entryId, o.studio.clientId],
    );
    expect(conv.rows[0].r).toBe("converted");
  });
});

// ===========================================================================
// THE LOAD-BEARING PROOF: POSTGRESQL DECIDES, NOT A TEXT MATCHER
// ===========================================================================
//
// WHY THIS EXISTS. The §14b repair was first proved by a source test that read
// the migration's SQL and tried to establish that the four liveness terms were
// conjunctive. That guard was wrong four times running, each time plausibly:
// counting tokens proved presence but not relationship; checking the gaps
// between four terms proved only INTERNAL conjunction and missed how the group
// attaches at its boundaries; and inline `--` comments survived the matcher.
// Every repair required understanding a little more SQL, which is the road to
// reimplementing a parser inside a unit test.
//
// PostgreSQL already knows SQL semantics. So the semantic claim moved here.
//
// THE FIXTURE IS WHAT MAKES THIS DETERMINISTIC, and it is the whole idea.
// Take the lifecycle only as far as DECLINE A -> REQUEUE -> CLAIM and STOP:
// never issue B. The entry is then `claimed` with exactly one invitation row,
// A, which is declined. Measured on that state:
//
//     rows matching the OLD three-terminal predicate : 1   <- only A
//     rows matching the NEW four-terminal predicate  : 0   <- nothing
//
// So a command that still asks the three-terminal question has NO CHOICE but to
// select A and reach for its row lock. A second connection holds that lock. The
// caller runs under a short `statement_timeout`, so a broken implementation
// blocks and dies with 57014; a correct one never asks for that lock and
// returns its ordinary no-live-invitation answer.
//
// WHAT THIS PROVES, EXACTLY — and it is narrower than the earlier wording
// claimed. It proves that none of these paths SELECTS the declined row as the
// current cycle, requests a CONFLICTING ROW LOCK on it, or applies a TERMINAL
// MUTATION to it. It does NOT prove the row is never READ: `expire_` plainly
// scans this table in several `exists (...)` subqueries that touch A and simply
// never match or lock it. Those reads are correct and harmless, and a test that
// forbade them would be asserting a rule the product does not have.
//
// Nothing here depends on which row PostgreSQL happens to return first -- the
// weakness that made the earlier behavioural tests unable to catch the
// regression at all. There is only one candidate row, and wanting it is the
// failure.

/** JOIN -> CLAIM -> ISSUE A -> verify -> DECLINE A -> REQUEUE -> CLAIM. No B. */
async function declinedOnly(label: string) {
  const offer = await seedOffer(`lock-${label}`);
  const begun = await beginProof(offer.token);
  const done = await completeProof(offer.token, begun.raw_challenge as string);
  expect(done.result).toBe("verified");
  const dec = await adminQuery(
    `select result from public.decline_new_client_waitlist_invitation($1,$2)`,
    [offer.token, done.raw_capability],
  );
  expect(dec.rows[0].result).toBe("declined");
  await adminQuery(`select public.requeue_new_client_waitlist_entry($1,$2,$3)`, [
    offer.studio.studioId, offer.entryId, offer.studio.userId,
  ]);
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    offer.studio.studioId, offer.entryId, offer.studio.userId,
  ]);

  // THE DISCRIMINATION, asserted rather than assumed: exactly one row answers
  // the old question and none answers the new one. If this ever stops holding,
  // the tests below stop proving anything and say so here first.
  const counts = await adminQuery(
    `select
       count(*) filter (where redeemed_at is null and expired_at is null
                          and released_at is null)                        as three,
       count(*) filter (where redeemed_at is null and expired_at is null
                          and released_at is null and declined_at is null) as four
     from public.new_client_waitlist_invitations where entry_id = $1`,
    [offer.entryId],
  );
  expect(Number(counts.rows[0].three), "only the declined row answers the OLD predicate").toBe(1);
  expect(Number(counts.rows[0].four), "nothing answers the NEW predicate").toBe(0);

  return { studio: offer.studio, entryId: offer.entryId, A: offer.invitationId };
}

/**
 * Run `call` while a second connection holds `invitationId` under `for update`.
 *
 * Returns the command's result, or throws whatever PostgreSQL raised — a
 * blocked caller surfaces as 57014 (statement_timeout), which is the signal
 * that the command wanted a row it should never have considered.
 */
async function withRowLockHeld<T>(
  invitationId: string,
  call: (caller: Client) => Promise<T>,
): Promise<T> {
  const holder = await conn();
  const caller = await conn();
  try {
    await holder.query("begin");
    await holder.query(
      `select 1 from public.new_client_waitlist_invitations where id = $1 for update`,
      [invitationId],
    );
    // Short, and local to this isolated test connection. Long enough that a
    // command which does NOT want the lock always finishes; short enough that
    // one which does fails fast instead of hanging the suite.
    await caller.query("set statement_timeout = '4s'");
    return await call(caller);
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end().catch(() => undefined);
    await caller.end().catch(() => undefined);
  }
}

const declinedOnlyTerms = async (id: string) =>
  (
    await adminQuery(
      `select declined_at is not null d, released_at is not null rel,
              expired_at is not null exp, redeemed_at is not null red
         from public.new_client_waitlist_invitations where id = $1`,
      [id],
    )
  ).rows[0];

describe("0192 §14b — no lifecycle path SELECTS, LOCKS or MUTATES the declined row", () => {
  it("EXPIRE does not select or lock a historical declined row", async () => {
    const f = await declinedOnly("expire");
    const r = await withRowLockHeld(f.A, (caller) =>
      caller.query(`select public.expire_new_client_waitlist_invitation($1,$2,$3) r`, [
        f.studio.studioId, f.entryId, f.studio.userId,
      ]),
    );
    // Completed before the timeout, with its ordinary no-live-invitation answer.
    // A three-terminal selector would have SELECTED A and blocked on the held
    // lock, raising 57014 instead of ever getting here.
    expect(r.rows[0].r).toBe("not_invited");
    expect(await declinedOnlyTerms(f.A)).toMatchObject({
      d: true, rel: false, exp: false, red: false,
    });
  });

  it("RELEASE does not select or lock a historical declined row", async () => {
    const f = await declinedOnly("release");
    const r = await withRowLockHeld(f.A, (caller) =>
      caller.query(`select public.release_new_client_waitlist_entry($1,$2,$3) r`, [
        f.studio.studioId, f.entryId, f.studio.userId,
      ]),
    );
    // The entry is `claimed` with no live invitation, so release truthfully
    // takes its claim-only path. What matters is that it never touched A.
    expect(r.rows[0].r).toBe("released");
    expect(
      await declinedOnlyTerms(f.A),
      "released_at must never land on top of declined_at",
    ).toMatchObject({ d: true, rel: false, exp: false, red: false });
  });

  it("CONVERSION does not select or lock a historical declined row", async () => {
    const f = await declinedOnly("convert");
    const r = await withRowLockHeld(f.A, (caller) =>
      caller.query(`select public.record_new_client_waitlist_conversion($1,$2,$3) r`, [
        f.studio.studioId, f.entryId, f.studio.clientId,
      ]),
    );
    expect(r.rows[0].r).toBe("not_invited");
    expect(await declinedOnlyTerms(f.A)).toMatchObject({
      d: true, rel: false, exp: false, red: false,
    });
  });

  it("THE FIXTURE CAN ACTUALLY DETECT A BLOCKED CALLER — the control for the control", async () => {
    // If the held lock could never stop anything, all three tests above would
    // pass vacuously. So: run a statement that DOES want A's lock, under the
    // same holder and the same timeout, and require it to die with 57014.
    const f = await declinedOnly("vacuity");
    let code: string | undefined;
    try {
      await withRowLockHeld(f.A, (caller) =>
        caller.query(`select 1 from public.new_client_waitlist_invitations
                       where id = $1 for update`, [f.A]),
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code, "the holder must genuinely block a competing row lock").toBe("57014");
  });
});

// ===========================================================================
// THE ALLOWANCE IS A PER-ROUND QUOTA, NOT A LIFETIME CAP
// ===========================================================================
//
// THE TWO DEFECTS THIS BLOCK KEEPS CLOSED, both measured on the previous shape:
//
// 1. NO ROUND BOUNDARY. `studio_waitlist_admission_rounds` was keyed by
//    studio_id alone, so "opening the next round" could only mean overwriting
//    the single row -- and consumption, having no round to belong to, was
//    counted over the studio's entire history. Measured: allowance 1, admit and
//    convert ONE prospect, and a fresh round at allowance 1 answered
//    `round_full` with nobody in it. The quota was a lifetime cap.
//
// 2. THE REDEEM -> CONVERSION HOLE. Consumption was `outstanding` (redeemed_at
//    IS NULL) plus `converted entries`, so a redeemed-but-unconverted
//    invitation was in NEITHER term. Measured: 1 -> 0 -> 1, and a second
//    prospect admitted against an allowance of 1. That window is not a race --
//    it is the whole booking flow, a human choosing a slot.
//
// Rounds are now durable rows with their own identity, invitations are stamped
// with the round that authorised them, and consumption is counted over that
// round's invitations alone -- with redemption consuming the seat immediately.

async function openRoundFor(studio: SeededStudio, allowance: number) {
  const r = await adminQuery(
    `select result, round_id from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
    [studio.studioId, studio.userId, allowance],
  );
  return r.rows[0] as { result: string; round_id: string | null };
}
const closeRoundFor = async (studio: SeededStudio) =>
  (
    await adminQuery(`select public.close_new_client_waitlist_admission_round($1,$2) r`, [
      studio.studioId, studio.userId,
    ])
  ).rows[0].r as string;
const roundConsumed = async (roundId: string) =>
  Number(
    (await adminQuery(`select public.waitlist_admission_round_consumed($1) n`, [roundId]))
      .rows[0].n,
  );

/** A studio with a service and an open round, and a helper to offer a prospect. */
async function roundFixture(label: string, allowance: number) {
  const studio = await seedStudio(`rnd-${label}`);
  const serviceId = await seedService(studio.studioId, label);
  const opened = await openRoundFor(studio, allowance);
  expect(opened.result).toBe("opened");
  const offer = async (tag: string) => {
    const joined = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,$4)`,
      [studio.studioId, `${tag} ${label}`, `${tag}-${label}-${studio.studioId.slice(0, 6)}@h.local`, null],
    );
    const entryId = joined.rows[0].entry_id as string;
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      studio.studioId, entryId, studio.userId,
    ]);
    const r = await adminQuery(
      `select result, raw_token, invitation_id
         from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
      [studio.studioId, entryId, studio.userId, serviceId],
    );
    return {
      entryId,
      result: r.rows[0].result as string,
      token: r.rows[0].raw_token as string | null,
      invitationId: r.rows[0].invitation_id as string | null,
    };
  };
  const redeem = async (token: string) => {
    const b = await beginProof(token);
    const c = await completeProof(token, b.raw_challenge as string);
    expect(c.result).toBe("verified");
    return (
      await adminQuery(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [token, c.raw_capability],
      )
    ).rows[0].result as string;
  };
  return { studio, serviceId, roundId: opened.round_id as string, offer, redeem };
}

describe("0192 §14d — admission rounds are durable, and the quota is per round", () => {
  it("NO OPEN ROUND: nothing may issue", async () => {
    const studio = await seedStudio("rnd-noopen");
    const serviceId = await seedService(studio.studioId, "noopen");
    const joined = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,$4)`,
      [studio.studioId, "NoRound", `noround-${studio.studioId.slice(0, 6)}@h.local`, null],
    );
    const entryId = joined.rows[0].entry_id as string;
    await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
      studio.studioId, entryId, studio.userId,
    ]);
    const r = await adminQuery(
      `select result from public.issue_scoped_new_client_waitlist_invitation(
                $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
      [studio.studioId, entryId, studio.userId, serviceId],
    );
    expect(r.rows[0].result).toBe("no_round_open");
  });

  it("AT MOST ONE OPEN ROUND, and it is the DATABASE that says so", async () => {
    const f = await roundFixture("oneopen", 3);
    expect((await openRoundFor(f.studio, 5)).result).toBe("round_already_open");

    // Structural, not merely command-enforced: the partial unique index refuses
    // a second open row even on a direct write.
    await expect(
      adminQuery(
        `insert into public.studio_waitlist_admission_rounds
           (studio_id, allowance, opened_by_practitioner_id)
         values ($1, 5, $2)`,
        [f.studio.studioId, f.studio.practitionerId],
      ),
    ).rejects.toThrow(/one_open_per_studio|duplicate key/i);
  });

  it("THE SEAT IS HELD FROM REDEMPTION, not from conversion — the P1", async () => {
    const f = await roundFixture("p1", 1);
    const a = await f.offer("A");
    expect(a.result).toBe("issued");
    expect(await roundConsumed(f.roundId), "live A holds the seat").toBe(1);

    expect(await f.redeem(a.token!)).toBe("redeemed");
    expect(
      await roundConsumed(f.roundId),
      "REDEEMED but not converted must still hold the seat — this was 0",
    ).toBe(1);

    // The window that used to admit a second prospect against an allowance of 1.
    const b = await f.offer("B");
    expect(b.result, "the quota must hold during the booking flow").toBe("round_full");

    await adminQuery(`select public.record_new_client_waitlist_conversion($1,$2,$3)`, [
      f.studio.studioId, a.entryId, f.studio.clientId,
    ]);
    expect(
      await roundConsumed(f.roundId),
      "redeemed AND converted is ONE seat, never two",
    ).toBe(1);
  });

  it.each([
    ["DECLINED", "decline"],
    ["RELEASED", "release"],
    ["LAPSED", "lapse"],
  ])("%s before redemption returns the seat to the round", async (_label, how) => {
    const f = await roundFixture(`free-${how}`, 1);
    const a = await f.offer("A");
    expect(await roundConsumed(f.roundId)).toBe(1);

    if (how === "decline") {
      const b = await beginProof(a.token!);
      const c = await completeProof(a.token!, b.raw_challenge as string);
      await adminQuery(`select public.decline_new_client_waitlist_invitation($1,$2)`, [
        a.token, c.raw_capability,
      ]);
    } else if (how === "release") {
      await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
        f.studio.studioId, a.entryId, f.studio.userId,
      ]);
    } else {
      await withInvitationWindowMutable(async () => {
        await adminQuery(
          `update public.new_client_waitlist_invitations
              set issued_at = clock_timestamp() - interval '96 hours',
                  expires_at = clock_timestamp() - interval '1 minute'
            where id = $1`,
          [a.invitationId],
        );
      });
    }
    expect(await roundConsumed(f.roundId), "the seat returns to the round").toBe(0);
  });

  it("A ROUND WITH A LIVE OFFER MAY NOT CLOSE", async () => {
    const f = await roundFixture("closelive", 2);
    const a = await f.offer("A");
    expect(a.result).toBe("issued");
    expect(
      await closeRoundFor(f.studio),
      "closing would drop an answerable offer out of every round's accounting",
    ).toBe("live_offers_outstanding");

    // Settle it the way the shipped lifecycle already allows, then close.
    await adminQuery(`select public.release_new_client_waitlist_entry($1,$2,$3)`, [
      f.studio.studioId, a.entryId, f.studio.userId,
    ]);
    expect(await closeRoundFor(f.studio)).toBe("closed");
    expect(await closeRoundFor(f.studio)).toBe("no_round_open");
  });

  it("ROUND 2 STARTS AT ZERO — the proof the old model could not give", async () => {
    const f = await roundFixture("reset", 1);
    const a = await f.offer("A");
    expect(await f.redeem(a.token!)).toBe("redeemed");
    await adminQuery(`select public.record_new_client_waitlist_conversion($1,$2,$3)`, [
      f.studio.studioId, a.entryId, f.studio.clientId,
    ]);
    expect(await roundConsumed(f.roundId)).toBe(1);
    expect(await closeRoundFor(f.studio)).toBe("closed");

    const r2 = await openRoundFor(f.studio, 1);
    expect(r2.result).toBe("opened");
    expect(r2.round_id, "a new round is a NEW immutable identity").not.toBe(f.roundId);
    expect(
      await roundConsumed(r2.round_id!),
      "round 1's redeemed history must not consume round 2",
    ).toBe(0);

    const b = await f.offer("B");
    expect(b.result, "allowance 1 again, and B is admissible").toBe("issued");

    // And round 1 is retained as history, still counting its own seat.
    expect(await roundConsumed(f.roundId)).toBe(1);
    const rows = await adminQuery(
      `select count(*)::int n from public.studio_waitlist_admission_rounds where studio_id=$1`,
      [f.studio.studioId],
    );
    expect(Number(rows.rows[0].n), "closing keeps history; it does not overwrite").toBe(2);
  });

  it("AN INVITATION'S ROUND IS IMMUTABLE, and same-studio by construction", async () => {
    const f = await roundFixture("immutable", 2);
    const a = await f.offer("A");
    const other = await roundFixture("foreign", 2);

    // Stamped with the round that authorised it.
    const stamped = await adminQuery(
      `select admission_round_id from public.new_client_waitlist_invitations where id=$1`,
      [a.invitationId],
    );
    expect(stamped.rows[0].admission_round_id).toBe(f.roundId);

    // It cannot be moved — not to another round of its own studio, nor away.
    await expect(
      adminQuery(
        `update public.new_client_waitlist_invitations set admission_round_id=$2 where id=$1`,
        [a.invitationId, other.roundId],
      ),
    ).rejects.toThrow(/admission round that authorised an invitation is immutable/);
    await expect(
      adminQuery(
        `update public.new_client_waitlist_invitations set admission_round_id=null where id=$1`,
        [a.invitationId],
      ),
    ).rejects.toThrow(/admission round that authorised an invitation is immutable/);

    // CROSS-STUDIO IS STRUCTURAL: the composite FK refuses a foreign round on a
    // FRESH row, independently of the immutability trigger. A separate entry is
    // used so the one-live-per-entry index cannot answer first and mask it.
    const spare = await adminQuery(
      `select entry_id from public.join_new_client_waitlist($1,$2,$3,$4)`,
      [f.studio.studioId, "Spare", `spare-${f.studio.studioId.slice(0, 8)}@h.local`, null],
    );
    await expect(
      adminQuery(
        `insert into public.new_client_waitlist_invitations
           (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id, admission_round_id)
         values ($1,$2,$3, clock_timestamp() + interval '72 hours', $4, $5)`,
        [
          f.studio.studioId,
          spare.rows[0].entry_id,
          "f".repeat(64),
          f.studio.practitionerId,
          other.roundId,
        ],
      ),
    ).rejects.toThrow(/round_same_studio_fk|foreign key/i);
  });

  it("BOOKING FAILURE AFTER REDEMPTION: the seat stays consumed (WAIT-RECOVERY-01)", async () => {
    // The product law: a redeemed permission is spent. B2/B3 deliberately allow
    // "redeemed, booking never created" and surface it as
    // `consumed_without_booking`. Nothing here silently recycles that seat, and
    // redemption is not reversible — a future operator recovery authority
    // (WAIT-RECOVERY-01) is the only thing that may ever restore capacity.
    const f = await roundFixture("nobooking", 1);
    const a = await f.offer("A");
    expect(await f.redeem(a.token!)).toBe("redeemed");
    // No conversion is ever recorded — the booking failed.
    expect(await roundConsumed(f.roundId)).toBe(1);
    expect((await f.offer("B")).result).toBe("round_full");
  });

  it("A REDEEMED SEAT SURVIVES ITS OWN WINDOW LAPSING", async () => {
    // THE CASE THAT MAKES THE SPENT LIMB LOAD-BEARING. While a redeemed
    // invitation is still inside its original window it would be counted by the
    // outstanding limb anyway; only after that window passes does the redeemed
    // limb become the sole reason the seat is still held. A suite that never
    // ages a redeemed row would pass with that limb deleted — measured, by a
    // negative control that failed to go red.
    const f = await roundFixture("aged-redeem", 1);
    const a = await f.offer("A");
    expect(await f.redeem(a.token!)).toBe("redeemed");
    expect(await roundConsumed(f.roundId)).toBe(1);

    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set issued_at = clock_timestamp() - interval '96 hours',
                expires_at = clock_timestamp() - interval '1 minute'
          where id = $1`,
        [a.invitationId],
      );
    });

    expect(
      await roundConsumed(f.roundId),
      "a spent seat is not returned by the clock — only an UNREDEEMED offer lapses",
    ).toBe(1);
    expect((await f.offer("B")).result).toBe("round_full");
  });

  it("THE ROUND TABLE IS UNREACHABLE FOR WRITES BY EVERY BROWSER ROLE", async () => {
    // Proved behaviourally against the live catalog, not by reading GRANT text.
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["insert", "update", "delete"]) {
        const r = await adminQuery(
          `select has_table_privilege($1,'public.studio_waitlist_admission_rounds',$2) ok`,
          [role, priv],
        );
        expect(r.rows[0].ok, `${role} must not hold ${priv}`).toBe(false);
      }
    }
    // service_role holds no table privilege either — the commands are definer.
    for (const priv of ["insert", "update", "delete", "select"]) {
      const r = await adminQuery(
        `select has_table_privilege('service_role','public.studio_waitlist_admission_rounds',$1) ok`,
        [priv],
      );
      expect(r.rows[0].ok, `service_role must not hold ${priv}`).toBe(false);
    }
    // ...and the two commands ARE reachable by service_role.
    for (const fn of [
      "public.open_new_client_waitlist_admission_round(uuid, uuid, integer)",
      "public.close_new_client_waitlist_admission_round(uuid, uuid)",
    ]) {
      const r = await adminQuery(
        `select has_function_privilege('service_role',$1,'execute') ok`,
        [fn],
      );
      expect(r.rows[0].ok, `${fn} must be executable by service_role`).toBe(true);
    }
  });

  it("A NON-OWNER CANNOT OPEN OR CLOSE A ROUND", async () => {
    const f = await roundFixture("authz", 2);
    const member = await seedMember(f.studio, "authz-member");
    const opened = await adminQuery(
      `select result from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
      [f.studio.studioId, member.userId, 5],
    );
    expect(opened.rows[0].result).toBe("not_owner");
    const closed = await adminQuery(
      `select public.close_new_client_waitlist_admission_round($1,$2) r`,
      [f.studio.studioId, member.userId],
    );
    expect(closed.rows[0].r).toBe("not_owner");
  });

  it("A ROUND'S ALLOWANCE IS NEVER DEFAULTED OR INFERRED", async () => {
    const studio = await seedStudio("rnd-nodefault");
    for (const bad of [null, -1]) {
      const r = await adminQuery(
        `select result from public.open_new_client_waitlist_admission_round($1,$2,$3)`,
        [studio.studioId, studio.userId, bad],
      );
      expect(r.rows[0].result, `allowance ${bad} must be refused`).toBe("invalid_input");
    }
    // Zero is legitimate: a round that has opened but admits nobody yet.
    const ok = await openRoundFor(studio, 0);
    expect(ok.result).toBe("opened");
    expect(await roundConsumed(ok.round_id!)).toBe(0);
  });
});

// ===========================================================================
// REDEMPTION SERIALISES WITH ISSUANCE ON THE ADMISSION ROUND
// ===========================================================================
//
// THE MVCC WINDOW THIS CLOSES, and it is not a formula error -- every COMMITTED
// state counts correctly. What was missing is that an issuer could observe a
// state in which a seat had already left OUTSTANDING but its redemption had not
// yet arrived in SPENT:
//
//     TX A  redeems A before A.expires_at, stamps redeemed_at, does NOT commit
//     ...   the clock crosses A.expires_at
//     TX B  locks the round and counts. A's uncommitted redeemed_at is
//           invisible, so A is not SPENT; the clock is past expires_at, so A is
//           not OUTSTANDING. It counts ZERO and issues B.
//     TX A  commits.  ->  two seats spent against an allowance of one.
//
// Measured on the unserialised shape: R1 consumed = 2, two invitations in R1.
//
// The round row is the serialisation authority, so redemption takes it before
// the invitation and holds it to commit. These tests drive two real
// connections; a sequential mock cannot express the interleaving at all.

/** Bring an invitation's expiry to a controlled instant. Test authority only. */
async function setInvitationExpiresIn(invitationId: string, interval: string) {
  await withInvitationWindowMutable(async () => {
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set expires_at = clock_timestamp() + $2::interval where id = $1`,
      [invitationId, interval],
    );
  });
}

/** Is `pid` parked on a lock? Polls rather than sleeping a fixed time. */
async function waitUntilLockWaiting(pid: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await adminQuery(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") return true;
    await sleep(120);
  }
  return false;
}

/** A round with allowance 1, one issued+proven invitation A, and a spare entry B. */
async function raceFixture(label: string) {
  const f = await roundFixture(`race-${label}`, 1);
  const a = await f.offer("A");
  expect(a.result).toBe("issued");
  const begun = await beginProof(a.token!);
  const done = await completeProof(a.token!, begun.raw_challenge as string);
  expect(done.result).toBe("verified");
  const bEntry = await adminQuery(
    `select entry_id from public.join_new_client_waitlist($1,$2,$3,$4)`,
    [f.studio.studioId, `B ${label}`, `braceB-${label}-${f.studio.studioId.slice(0, 6)}@h.local`, null],
  );
  const bEntryId = bEntry.rows[0].entry_id as string;
  await adminQuery(`select public.claim_new_client_waitlist_entry($1,$2,$3)`, [
    f.studio.studioId, bEntryId, f.studio.userId,
  ]);
  return { ...f, a, capability: done.raw_capability as string, bEntryId };
}

const issueOn = (client: Client, f: { studio: SeededStudio; serviceId: string }, entryId: string) =>
  client.query(
    `select result from public.issue_scoped_new_client_waitlist_invitation(
              $1,$2,$3,$4, current_date, current_date + 13, null, 72)`,
    [f.studio.studioId, entryId, f.studio.userId, f.serviceId],
  );

describe("0192 — the append-only fixture restores enforcement on every exit", () => {
  // THE CONTAMINATION HAZARD THIS CLOSES. Several fixtures must age an
  // invitation to simulate elapsed time, which means lifting 0188's append-only
  // guard. Nine of them did it inline: disable, mutate, enable. If the mutation
  // threw — a bad interval, a constraint, a dropped connection — the enable
  // never ran, and `alter table` is not undone by a rollback. The suite would
  // then keep running against a table with enforcement switched off, and the
  // next failure would appear somewhere unrelated.
  //
  // Every site now goes through `withInvitationWindowMutable`, whose `finally`
  // restores the guard on every exit. These tests prove that claim rather than
  // trusting the keyword.

  const enforcementIsLive = async (invitationId: string): Promise<boolean> => {
    // BEHAVIOURAL, not metadata. `pg_trigger.tgenabled` would tell us what the
    // catalog says; this asks the table whether it still refuses a forbidden
    // write, which is the property the fixture can actually damage.
    try {
      await adminQuery(
        `update public.new_client_waitlist_invitations
            set expires_at = expires_at + interval '1 hour' where id = $1`,
        [invitationId],
      );
      return false;
    } catch {
      return true;
    }
  };

  it("a THROWING mutation still restores append-only enforcement", async () => {
    const offer = await seedOffer("fixture-throw");
    expect(await enforcementIsLive(offer.invitationId), "enforced before").toBe(true);

    await expect(
      withInvitationWindowMutable(async () => {
        // A deliberately invalid mutation: expires_at must stay after issued_at,
        // so 0188's ttl CHECK rejects this from inside the mutable window.
        await adminQuery(
          `update public.new_client_waitlist_invitations
              set expires_at = issued_at - interval '1 hour' where id = $1`,
          [offer.invitationId],
        );
      }),
    ).rejects.toThrow();

    expect(
      await enforcementIsLive(offer.invitationId),
      "the guard must be back even though the callback threw",
    ).toBe(true);
  });

  it("a THROWING ASSERTION inside the window restores it too", async () => {
    const offer = await seedOffer("fixture-assert");
    await expect(
      withInvitationWindowMutable(async () => {
        await adminQuery(
          `update public.new_client_waitlist_invitations
              set expires_at = clock_timestamp() + interval '1 hour' where id = $1`,
          [offer.invitationId],
        );
        expect(1, "a deliberate in-window failure").toBe(2);
      }),
    ).rejects.toThrow();

    expect(
      await enforcementIsLive(offer.invitationId),
      "an assertion failure must not leave the table unprotected",
    ).toBe(true);
  });

  it("NON-VACUITY: the probe can actually tell enforced from unenforced", async () => {
    // If `enforcementIsLive` returned true unconditionally, both tests above
    // would pass against a permanently disabled trigger. Inside the window the
    // forbidden write must SUCCEED — and the guard must be back afterwards.
    const offer = await seedOffer("fixture-probe");
    let insideWindow: boolean | null = null;
    await withInvitationWindowMutable(async () => {
      insideWindow = await enforcementIsLive(offer.invitationId);
    });
    expect(insideWindow, "the probe must observe the window as OPEN").toBe(false);
    expect(await enforcementIsLive(offer.invitationId), "and closed after").toBe(true);
  });

  it("LATER TESTS DO NOT INHERIT A WEAKENED DATABASE", async () => {
    // The end state every other test in this file depends on: an immutable
    // field is refused by its real message, not merely by a catalog flag.
    const offer = await seedOffer("fixture-inherit");
    await expect(
      adminQuery(
        `update public.new_client_waitlist_invitations
            set expires_at = expires_at + interval '1 hour' where id = $1`,
        [offer.invitationId],
      ),
    ).rejects.toThrow(/identity, tenancy, token and validity window are immutable/);
  });
});

describe("0192 — verified redemption serialises with same-round issuance", () => {
  it("THE EXPIRY BOUNDARY: an issuer cannot count zero while a redemption is in flight", async () => {
    const f = await raceFixture("expiry");
    await setInvitationExpiresIn(f.a.invitationId!, "2 seconds");

    const txA = await conn();
    const txB = await conn();
    try {
      await txA.query("begin");
      const red = await txA.query(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [f.a.token, f.capability],
      );
      expect(red.rows[0].result, "A redeems while still inside its window").toBe("redeemed");
      // TX A is NOT committed. It holds the round.

      // Wait on the DATABASE clock until the window has genuinely passed.
      await adminQuery(
        `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp())) + 0.5))
           from public.new_client_waitlist_invitations where id = $1`,
        [f.a.invitationId],
      );
      const past = await adminQuery(
        `select clock_timestamp() > expires_at p
           from public.new_client_waitlist_invitations where id = $1`,
        [f.a.invitationId],
      );
      expect(past.rows[0].p, "the fixture must actually cross the boundary").toBe(true);

      await txB.query("begin");
      await txB.query("set local statement_timeout = '8s'");
      const pid = (await txB.query("select pg_backend_pid() p")).rows[0].p as number;
      const pending = issueOn(txB, f, f.bEntryId);

      // THE PROPERTY. Without the round lock, B computes capacity in the gap and
      // issues. With it, B cannot even look until A resolves.
      expect(
        await waitUntilLockWaiting(pid),
        "issuance must block on the round while a redemption for it is in flight",
      ).toBe(true);

      await txA.query("commit");
      const out = await pending;
      await txB.query("commit");

      expect(out.rows[0].result, "A is now SPENT, so the seat is gone").toBe("round_full");
    } finally {
      await txA.query("rollback").catch(() => undefined);
      await txA.end().catch(() => undefined);
      await txB.query("rollback").catch(() => undefined);
      await txB.end().catch(() => undefined);
    }

    expect(await roundConsumed(f.roundId), "exactly one permission is spent").toBe(1);
    const inRound = await adminQuery(
      `select count(*)::int n from public.new_client_waitlist_invitations where admission_round_id=$1`,
      [f.roundId],
    );
    expect(Number(inRound.rows[0].n), "B was never issued").toBe(1);
    expect(await termsOf(f.a.invitationId!)).toMatchObject({ red: true });
  });

  it("SCHEDULE: ISSUE first — redemption waits, then resolves truthfully", async () => {
    const f = await raceFixture("issue-first");
    const txI = await conn();
    const txR = await conn();
    try {
      await txI.query("begin");
      // The issuer takes studio -> round and holds them.
      const issued = await issueOn(txI, f, f.bEntryId);
      expect(issued.rows[0].result, "allowance 1 is already held by live A").toBe("round_full");

      await txR.query("begin");
      await txR.query("set local statement_timeout = '8s'");
      const pid = (await txR.query("select pg_backend_pid() p")).rows[0].p as number;
      const pending = txR.query(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [f.a.token, f.capability],
      );
      expect(await waitUntilLockWaiting(pid), "redemption waits on the round").toBe(true);

      await txI.query("commit");
      const out = await pending;
      await txR.query("commit");
      // A's window is untouched here, so the truthful answer after waiting is
      // still a successful redemption.
      expect(out.rows[0].result).toBe("redeemed");
    } finally {
      await txI.query("rollback").catch(() => undefined);
      await txI.end().catch(() => undefined);
      await txR.query("rollback").catch(() => undefined);
      await txR.end().catch(() => undefined);
    }
    expect(await roundConsumed(f.roundId)).toBe(1);
  });

  it("SCHEDULE: REDEEM first — issuance waits, then sees the seat spent", async () => {
    const f = await raceFixture("redeem-first");
    const txR = await conn();
    const txI = await conn();
    try {
      await txR.query("begin");
      const red = await txR.query(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [f.a.token, f.capability],
      );
      expect(red.rows[0].result).toBe("redeemed");

      await txI.query("begin");
      await txI.query("set local statement_timeout = '8s'");
      const pid = (await txI.query("select pg_backend_pid() p")).rows[0].p as number;
      const pending = issueOn(txI, f, f.bEntryId);
      expect(await waitUntilLockWaiting(pid), "issuance waits on the round").toBe(true);

      await txR.query("commit");
      const out = await pending;
      await txI.query("commit");
      expect(out.rows[0].result).toBe("round_full");
    } finally {
      await txR.query("rollback").catch(() => undefined);
      await txR.end().catch(() => undefined);
      await txI.query("rollback").catch(() => undefined);
      await txI.end().catch(() => undefined);
    }
    expect(await roundConsumed(f.roundId)).toBe(1);
  });

  it("SCHEDULE: CLOSE vs REDEEM — one order, no deadlock", async () => {
    const f = await raceFixture("close-vs-redeem");
    const txR = await conn();
    const txC = await conn();
    try {
      await txR.query("begin");
      await txR.query(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [f.a.token, f.capability],
      );

      await txC.query("begin");
      await txC.query("set local statement_timeout = '8s'");
      const pid = (await txC.query("select pg_backend_pid() p")).rows[0].p as number;
      const pending = txC.query(
        `select public.close_new_client_waitlist_admission_round($1,$2) r`,
        [f.studio.studioId, f.studio.userId],
      );
      expect(await waitUntilLockWaiting(pid), "close waits on the same round").toBe(true);

      await txR.query("commit");
      // Redeemed is settled, so the round may close.
      expect((await pending).rows[0].r).toBe("closed");
      await txC.query("commit");
    } finally {
      await txR.query("rollback").catch(() => undefined);
      await txR.end().catch(() => undefined);
      await txC.query("rollback").catch(() => undefined);
      await txC.end().catch(() => undefined);
    }
  });

  it("SCHEDULE: RELEASE vs REDEEM — their lock graphs overlap without inverting", async () => {
    // release_ takes ENTRY -> INVITATION; redeem takes ROUND -> INVITATION.
    // Neither can hold an invitation and then reach for what the other holds,
    // so the worst case is a wait, never 40P01.
    const f = await raceFixture("release-vs-redeem");
    const txR = await conn();
    const txL = await conn();
    let deadlock: string | undefined;
    try {
      await txR.query("begin");
      await txR.query(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [f.a.token, f.capability],
      );

      await txL.query("begin");
      await txL.query("set local statement_timeout = '8s'");
      const pending = txL
        .query(`select public.release_new_client_waitlist_entry($1,$2,$3) r`, [
          f.studio.studioId, f.a.entryId, f.studio.userId,
        ])
        .catch((e: { code?: string }) => {
          deadlock = e.code;
          return { rows: [{ r: null }] };
        });
      await sleep(400);
      await txR.query("commit");
      await pending;
      await txL.query("commit").catch(() => undefined);
    } finally {
      await txR.query("rollback").catch(() => undefined);
      await txR.end().catch(() => undefined);
      await txL.query("rollback").catch(() => undefined);
      await txL.end().catch(() => undefined);
    }
    expect(deadlock, "no deadlock and no timeout").toBeUndefined();
    // Redemption won; release found nothing live to release and left A spent.
    expect(await termsOf(f.a.invitationId!)).toMatchObject({ red: true, rel: false });
    expect(await roundConsumed(f.roundId)).toBe(1);
  });

  it("LEGACY: a NULL-round invitation still redeems, and locks no round", async () => {
    // 0188..0191 invitations predate durable rounds. They consume no round's
    // allowance, so there is nothing to serialise — and no round is invented.
    const f = await raceFixture("legacy");
    await withInvitationWindowMutable(async () => {
      await adminQuery(
        `update public.new_client_waitlist_invitations set admission_round_id = null where id = $1`,
        [f.a.invitationId],
      );
    });
    expect(await roundConsumed(f.roundId), "an unrounded row consumes no round").toBe(0);

    // Hold the round; a legacy redemption must NOT wait on it.
    const holder = await conn();
    const caller = await conn();
    try {
      await holder.query("begin");
      await holder.query(
        `select 1 from public.studio_waitlist_admission_rounds where id = $1 for update`,
        [f.roundId],
      );
      await caller.query("set statement_timeout = '4s'");
      const out = await caller.query(
        `select result from public.redeem_new_client_waitlist_invitation_verified($1,$2)`,
        [f.a.token, f.capability],
      );
      expect(out.rows[0].result, "legacy redemption is unchanged").toBe("redeemed");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end().catch(() => undefined);
      await caller.end().catch(() => undefined);
    }
  });
});
