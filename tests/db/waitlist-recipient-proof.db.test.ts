import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedStudio, type SeededStudio } from "./helpers/harness";
import {
  expectPostgresSameInstant,
  expectPostgresTemporalRelation,
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

async function openRound(studioId: string, allowance: number): Promise<void> {
  await adminQuery(
    `insert into public.studio_waitlist_admission_rounds (studio_id, allowance)
     values ($1, $2)
     on conflict (studio_id) do update set allowance = excluded.allowance`,
    [studioId, allowance],
  );
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
  await openRound(studio.studioId, allowance);

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
  await openRound(studio.studioId, 10);
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
    await adminQuery(
      `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
    );
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set issued_at = now() - interval '4 days', expires_at = now() - interval '1 minute'
        where id = $1`,
      [offer.invitationId],
    );
    await adminQuery(
      `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
    );
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
    await openRound(studio.studioId, 1);

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
    await openRound(studio.studioId, 1);

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
    await adminQuery(
      `alter table public.new_client_waitlist_invitations disable trigger new_client_waitlist_invitations_append_only`,
    );
    await adminQuery(
      `update public.new_client_waitlist_invitations
          set issued_at = now() - interval '4 days', expires_at = now() - interval '1 minute'
        where id = $1`,
      [offer.invitationId],
    );
    await adminQuery(
      `alter table public.new_client_waitlist_invitations enable trigger new_client_waitlist_invitations_append_only`,
    );
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
    "public.waitlist_admission_consumed(uuid)",
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
