import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

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
async function seedOffer(label: string, allowance = 10): Promise<Offer> {
  const studio = await seedStudio(label);
  const serviceId = await seedService(studio.studioId, label);
  await openRound(studio.studioId, allowance);

  const email = `p-${label}-${studio.studioId.slice(0, 8)}@harness.local`;
  const joined = await adminQuery(
    `select result, entry_id from public.join_new_client_waitlist($1, $2, $3, null)`,
    [studio.studioId, `Prospect ${label}`, email],
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
  };
}

async function beginProof(token: string, ttlMinutes = 15) {
  const r = await adminQuery(
    `select result, raw_challenge, delivery_contact, expires_at
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
async function verifiedOffer(label: string): Promise<Offer & { capability: string }> {
  const offer = await seedOffer(label);
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

async function invitationRow(invitationId: string) {
  const r = await adminQuery(
    `select redeemed_at, declined_at, released_at, expired_at,
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
