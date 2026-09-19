import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0200 — WAIT-P1-EXIT. The redeemed-but-unbooked escape hatch.
//
// SOURCE CONTRACT ONLY. Behaviour — the refusals, the race, idempotency, the
// capacity ruling and the audit trail — is proved against a real database in
// tests/db/waitlist-redeemed-unbooked-exit.db.test.ts. An admin-connection
// source test cannot see a privilege defect, which is the lesson 0197 recorded
// after 182 passing assertions missed one.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0200";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

const FN = "close_unbooked_new_client_waitlist_invitation";
const SIG = `public.${FN}(uuid, uuid, uuid)`;

/**
 * THE CLOSE COMMAND'S OWN BODY, BOUNDED AT ITS TERMINATOR.
 *
 * An earlier revision sliced from the function header to the END OF FILE, which
 * silently swallowed the `requeue` redefinition that follows it — so the
 * result-code census reported requeue's codes as the close command's, and a
 * per-statement assertion could match the wrong function entirely. Bounded at
 * the first `$$;` after the header, which is this function's own.
 */
const FN_BODY = (() => {
  const from = CODE.indexOf(`function public.${FN}`);
  if (from < 0) throw new Error(`0200 no longer defines ${FN}`);
  const end = CODE.indexOf("$$;", from);
  if (end < 0) throw new Error(`${FN} has no terminator`);
  return CODE.slice(from, end);
})();

describe("0200 position in the chain", () => {
  it("is the repository maximum", () => {
    // Taken over from 0198 (and 0199 before it, whose own file lives on the
    // WAIT S3 branch), per CLAUDE.md: only the CURRENT max asserts this.
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it, and owns its number alone", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
    expect(countVersion(VERSION)).toBe(1);
  });

  it("IS THE PENDING SUFFIX — authored here, NOT applied", () => {
    // MIGRATION-FIRST PENDING, the ordinary pre-apply shape: the repository sits
    // exactly one migration above hosted, and `pending_migrations` names this
    // one and nothing else. Nothing in this repository may claim 0200 is
    // applied until an operator applies it and records it.
    const state = migrationState();
    expect(state.pending_migrations).toEqual([VERSION]);
    expect(state.repo_migration_max).toBe(VERSION);
    expect(Number(state.hosted_migration_max)).toBe(Number(VERSION) - 1);
    expect(state.repo_equals_hosted).toBe(false);
  });

  it("the hosted head this branch declares is the one production actually has", () => {
    // THE NUMBER THIS LANE HAD TO REPAIR BEFORE IT COULD AUTHOR ANYTHING.
    //
    // 0199 is APPLIED to production but its file and apply record live on the
    // WAIT S3 branch, which is deliberately held. A branch taken from production
    // therefore derives `next free = 0199` — a number production has already
    // used. This lane carries 0199 so the derivation is honest, and the number
    // it then derives is 0200, which is what the WAIT current-state audit
    // expected.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe("0199");
    expect(state.versions).toContain("0199");
  });
});

describe("0200 is ATOMIC and arms its own lock timeout", () => {
  it("opens its own transaction and commits it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a migration
    // that does not open one applies statement by statement and can leave the
    // schema half-changed.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
  });

  it("sets lock_timeout INSIDE the transaction", () => {
    // A bare `SET LOCAL` outside a transaction emits 25P01 and never arms — the
    // trap CLAUDE.md records. This file takes ACCESS EXCLUSIVE on a table the
    // booking path writes, so an unarmed timeout is a production stall.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
  });

  it("makes no hosted claim in its own SQL", () => {
    // The apply record is the ledger's and migration-state.json's job.
    expect(SQL).not.toMatch(/\bAPPLIED\b/);
    expect(SQL).not.toMatch(/hosted_migration_max/);
  });
});

describe("0200 adds no table rewrite and no destructive statement", () => {
  it("adds both close columns as plain nullable columns", () => {
    // No default and no generation expression, so PostgreSQL updates the
    // catalogue and does not rewrite the heap.
    expect(CODE).toMatch(/add column if not exists closed_at\s+timestamptz\s*,/);
    expect(CODE).toMatch(/add column if not exists closed_by_practitioner_id\s+uuid\s*;/);
    expect(CODE).not.toMatch(/closed_at[^;]*\bdefault\b/);
    expect(CODE).not.toMatch(/closed_at[^;]*generated always/);
  });

  it("drops nothing that carries data, and deletes nothing", () => {
    expect(CODE).not.toMatch(/drop table/i);
    expect(CODE).not.toMatch(/drop column/i);
    expect(CODE).not.toMatch(/truncate/i);
    expect(CODE).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("rewrites no history and edits no applied migration's objects it does not own", () => {
    // The ONE function redefined here is the invitations append-only trigger,
    // and it is carried through with a single arm added. Nothing else that 0188
    // or 0192 owns is touched.
    const redefined = [...CODE.matchAll(/create or replace function\s+public\.(\w+)/gi)].map(
      (m) => m[1],
    );
    expect(redefined.sort()).toEqual(
      [
        FN,
        "new_client_waitlist_invitations_append_only",
        // NARROWED, NOT WEAKENED — see the dedicated block below.
        "requeue_new_client_waitlist_entry",
      ].sort(),
    );
  });
});

describe("0200 does not weaken any shipped exit", () => {
  it("redefines none of release, expire, remove, conversion or booking", () => {
    // THE RULING THIS SLICE WAS GIVEN: the state is closed by ADDING a command,
    // never by relaxing a guard that exists because relaxing it caused a defect.
    // `requeue` is the single exception and it is NARROWED, never relaxed —
    // proved separately below.
    for (const fn of [
      "release_new_client_waitlist_entry",
      "expire_new_client_waitlist_invitation",
      "remove_new_client_waitlist_entry",
      "record_new_client_waitlist_conversion",
      "issue_new_client_waitlist_invitation",
      "redeem_new_client_waitlist_invitation",
      "redeem_new_client_waitlist_invitation_verified",
      "create_waitlist_public_appointment",
    ]) {
      expect(CODE, `0200 redefines ${fn}`).not.toMatch(
        new RegExp(`create or replace function\\s+public\\.${fn}\\b`, "i"),
      );
    }
  });

  it("narrows requeue by ADDING a refusal, and relaxes nothing it already had", () => {
    // WHY REQUEUE AT ALL. 0195's premise — "an entry cannot acquire a second
    // invitation once one is redeemed" — held only because a redeemed entry was
    // stuck at `invited`. This migration unsticks it, so it owes the premise at
    // the one door that would break it.
    const body = CODE.slice(CODE.indexOf("function public.requeue_new_client_waitlist_entry"));
    const fn = body.slice(0, body.indexOf("$$;"));

    // THE ADDED GUARD.
    expect(fn).toMatch(/redeemed_at is not null/);
    expect(fn).toMatch(/return 'already_redeemed'/);

    // AND 0188'S BODY, INTACT. Each of these is a line a careless redefinition
    // drops — the duplicate handler most of all, because it lives in an
    // exception block rather than in a guard.
    for (const kept of [
      "new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id)",
      "when unique_violation then",
      "return 'already_active'",
      "return 'not_requeueable'",
      "return 'requeued'",
      "claimed_by_practitioner_id = null",
      "status in ('released','expired')",
    ]) {
      expect(fn, `the requeue redefinition dropped: ${kept}`).toContain(kept);
    }

    // It accepts no MORE states than before — the guard adds a refusal, so the
    // accepted set is unchanged. And the guard is SCOPED to exactly that set,
    // which is what keeps every pre-existing refusal's word intact: an
    // `invited` entry still answers `not_requeueable`, as two shipped DB tests
    // assert by name.
    const statusSets = [...fn.matchAll(/status\s+in \('[a-z',]+'\)/g)].map((m) =>
      m[0].replace(/\s+/g, " "),
    );
    expect(statusSets).toEqual([
      "status in ('released','expired')",
      "status in ('released','expired')",
    ]);
    // SCOPED TO THE ACCEPTED STATES, AND FROM A VALUE READ UNDER THE LOCK.
    // Both halves matter: the scope is what keeps `invited` answering
    // `not_requeueable`, and reading it under the lock is what stops a
    // concurrent close from changing the answer after the decision.
    const guard = fn.slice(0, fn.indexOf("return 'already_redeemed'"));
    expect(guard, "the guard is not scoped to the states requeue accepts").toMatch(
      /v_status in \('released','expired'\)/,
    );
    expect(
      guard.indexOf("v_status in ('released','expired')"),
      "the guard reads the status before the row is locked",
    ).toBeGreaterThan(guard.indexOf("for update"));
  });

  it("restates requeue's grant contract rather than leaving it implied", () => {
    const sig = "public.requeue_new_client_waitlist_entry(uuid, uuid, uuid)";
    for (const grantee of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(`revoke execute on function ${sig} from ${grantee};`);
    }
    expect(CODE).toContain(`grant  execute on function ${sig} to service_role;`);
  });

  it("does not touch the consumed-count definition or the admission round", () => {
    // 0192 rules that a REDEEMED seat is spent and is not recycled. Freeing it
    // here would silently redefine the per-round quota for every caller.
    expect(CODE).not.toMatch(/waitlist_admission_round_consumed/);
    expect(CODE).not.toMatch(/studio_waitlist_admission_rounds/);
    expect(CODE).not.toMatch(/admission_round_id\s*=/);
  });

  it("stamps no terminal invitation outcome", () => {
    // redeemed / expired / released / declined are mutually exclusive by CHECK,
    // and the redemption already made the token permanently unusable. Writing
    // one here would fail the constraint AND overstate what happened.
    //
    // THE STATEMENT, NOT A WINDOW OF CHARACTERS. An earlier revision sliced a
    // fixed 400 characters after the UPDATE and caught the ENTRY update that
    // follows it, which legitimately writes `released_at` — the assertion was
    // reading the wrong statement and would have gone green on a real defect
    // somewhere else. The invitation UPDATE ends at its own semicolon.
    const from = FN_BODY.indexOf("update public.new_client_waitlist_invitations");
    expect(from, "the command no longer updates the invitation at all").toBeGreaterThan(0);
    const stmt = FN_BODY.slice(from, FN_BODY.indexOf(";", from));
    expect(stmt).toMatch(/set\s+closed_at\s*=/);
    for (const terminal of ["expired_at", "declined_at", "redeemed_at", "released_at"]) {
      expect(
        stmt.slice(0, stmt.indexOf("where")),
        `the close stamps ${terminal} on the invitation`,
      ).not.toMatch(new RegExp(`\\b${terminal}\\s*=`));
    }
  });

  it("adds no new entry status and no new transition edge", () => {
    // `invited -> released` is an edge the 0188 transition guard already
    // permits, and the one `decline` already uses. No status vocabulary moves.
    expect(CODE).not.toMatch(/new_client_waitlist_entries_status_check/);
    expect(CODE).not.toMatch(/new_client_waitlist_entries_transition_guard/);
    expect(CODE).not.toMatch(/new_client_waitlist_entries_cycle_evidence_check/);
  });
});

describe("0200's command is owner-authorised, server-only and clock-owning", () => {
  it("is SECURITY DEFINER with a pinned search_path", () => {
    const body = FN_BODY;
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("re-derives authority through the shared owner resolver", () => {
    // Not a role from the caller, and not a practitioner id from the browser.
    expect(CODE).toMatch(/new_client_waitlist_resolve_owner\(p_studio_id, p_actor_user_id\)/);
  });

  it("takes the entry mutex before it reads anything about the invitation", () => {
    const body = FN_BODY;
    const entryLock = body.indexOf("from public.new_client_waitlist_entries e");
    const inviteRead = body.indexOf("from public.new_client_waitlist_invitations i");
    expect(entryLock).toBeGreaterThan(0);
    expect(inviteRead).toBeGreaterThan(entryLock);
    expect(body.slice(entryLock, inviteRead)).toMatch(/for update/);
  });

  it("scopes every entry lookup by BOTH id and studio_id", () => {
    const body = FN_BODY;
    const bare = [...body.matchAll(/new_client_waitlist_entries\b[\s\S]{0,300}?;/g)].filter(
      (m) => !/studio_id/.test(m[0]),
    );
    expect(bare.map((m) => m[0].slice(0, 120)), "an entry statement is not tenant-scoped").toEqual(
      [],
    );
  });

  it("reads its own clock and accepts none from the caller", () => {
    const body = FN_BODY;
    expect(body).toMatch(/v_decision_at\s*:=\s*clock_timestamp\(\)/);
    // One read, used for both stamps.
    expect([...body.matchAll(/clock_timestamp\(\)/g)]).toHaveLength(1);
    expect(body).toMatch(/closed_at\s*=\s*v_decision_at/);
    expect(body).toMatch(/released_at\s*=\s*v_decision_at/);
    // No timestamp parameter exists to supply one.
    expect(body.slice(0, body.indexOf("returns text"))).not.toMatch(/timestamptz/);
  });
});

describe("0200's grants are an allowlist written by name", () => {
  it("revokes EXECUTE from all four grantees before the single grant", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
    // AND service_role at create time, and PostgreSQL grants to PUBLIC. 0129
    // missed `anon`; 0164 missed `service_role`.
    for (const grantee of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        CODE,
        `${grantee} is not revoked from ${FN} by name`,
      ).toContain(`revoke execute on function ${SIG} from ${grantee};`);
    }
    expect(CODE).toContain(`grant  execute on function ${SIG} to service_role;`);
  });

  it("grants EXECUTE to service_role and to nobody else", () => {
    const grants = [...CODE.matchAll(new RegExp(`grant\\s+execute on function ${SIG.replace(/[()]/g, "\\$&")} to (\\w+)`, "g"))];
    expect(grants.map((m) => m[1])).toEqual(["service_role"]);
  });

  it("the revokes come before the grant, so the grant is not undone", () => {
    const lastRevoke = CODE.lastIndexOf(`revoke execute on function ${SIG}`);
    const grant = CODE.indexOf(`grant  execute on function ${SIG}`);
    expect(lastRevoke).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(lastRevoke);
  });

  it("widens the authenticated SELECT by COLUMN, and only for the two lifecycle stamps", () => {
    // 0188's column-level model exists because a table-wide grant once returned
    // `token_hash` to an authenticated session. Nothing credential-bearing moves.
    expect(CODE).toMatch(
      /grant select \(closed_at, closed_by_practitioner_id\)\s+on public\.new_client_waitlist_invitations to authenticated;/,
    );
    expect(CODE).not.toMatch(/grant select on public\.new_client_waitlist_invitations/);
    // THE WITHHELD SET IS TESTED ON THE GRANT STATEMENTS, NOT ON THE FILE.
    // `token_hash` appears legitimately in the append-only guard this file
    // carries forward from 0192; a whole-file ban read as a privilege assertion
    // while actually forbidding a frozen line of someone else's trigger.
    const grants = [...CODE.matchAll(/grant select[\s\S]{0,200}?;/g)].map((m) => m[0]);
    expect(grants, "0200 issues no SELECT grant at all").not.toHaveLength(0);
    for (const g of grants) {
      for (const withheld of ["token_hash", "proof_", "scope_", "admission_round_id"]) {
        expect(g, `a SELECT grant here exposes ${withheld}`).not.toContain(withheld);
      }
      expect(g, "a SELECT grant here reaches anon").not.toMatch(/to anon\b/);
    }
  });
});

describe("0200's close record cannot drift from its own rules", () => {
  it("binds the actor to the same studio by composite FK, on delete restrict", () => {
    expect(CODE).toMatch(
      /foreign key \(closed_by_practitioner_id, studio_id\)\s*references public\.practitioners \(id, studio_id\) on delete restrict/,
    );
  });

  it("requires all-or-nothing evidence, and only on a redeemed cycle", () => {
    expect(CODE).toMatch(/\(closed_at is null\) = \(closed_by_practitioner_id is null\)/);
    expect(CODE).toMatch(/closed_at is null or redeemed_at is not null/);
  });

  it("makes the open redeemed cycle unique, so no query has to guess which", () => {
    expect(CODE).toMatch(
      /create unique index if not exists new_client_waitlist_invitations_one_open_redeemed_per_entry[\s\S]{0,200}?where redeemed_at is not null and closed_at is null/,
    );
  });

  it("carries 0192's append-only body forward unchanged, plus ONE new arm", () => {
    const guard = CODE.slice(
      CODE.indexOf("function public.new_client_waitlist_invitations_append_only"),
    );
    const body = guard.slice(0, guard.indexOf("$$;"));
    // Everything 0192 protected is still protected.
    for (const frozen of [
      "new.token_hash is distinct from old.token_hash",
      "new.expires_at is distinct from old.expires_at",
      "old.admission_round_id is not null",
      "old.redeemed_at is not null and new.redeemed_at is distinct from old.redeemed_at",
      "old.expired_at is not null and new.expired_at is distinct from old.expired_at",
      "old.released_at is not null and new.released_at is distinct from old.released_at",
    ]) {
      expect(body, `the append-only guard dropped: ${frozen}`).toContain(frozen);
    }
    // And the close is write-once.
    expect(body).toContain("old.closed_at is not null and new.closed_at is distinct from old.closed_at");
    expect(body).toContain("old.closed_by_practitioner_id is not null");
  });
});

describe("0200 answers the states it refuses with distinguishable words", () => {
  it("returns every code the server action maps, and no undeclared one", () => {
    // The action's union and this list are the same contract read from two
    // sides; a code added to one and not the other is how a real refusal falls
    // through to "please try again".
    const body = FN_BODY;
    const returned = new Set(
      [...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]),
    );
    expect([...returned].sort()).toEqual(
      [
        "already_booked",
        "already_closed",
        // The stranded-appointment REPAIR, not a refusal. `booking_exists` was
        // removed with the dead-end copy that named an operation the product
        // has no control for.
        "converted_instead",
        "booking_unresolved",
        "closed",
        "invalid_input",
        "not_found",
        "not_invited",
        "not_redeemed",
      ].sort(),
    );
    expect(
      returned.has("booking_exists"),
      "the refusal that named a nonexistent operator action is back",
    ).toBe(false);
  });

  it("the action file declares exactly those, plus the propagated owner codes", () => {
    const action = readFileSync(
      path.join(ROOT, "app/(app)/settings/waitlist/actions.ts"),
      "utf8",
    );
    const union = action.slice(
      action.indexOf("type CloseUnbookedInvitationResult"),
      action.indexOf("const CLOSE_REFUSALS"),
    );
    for (const code of [
      "closed",
      "converted_instead",
      "not_found",
      "not_invited",
      "not_redeemed",
      "already_booked",
      "booking_unresolved",
      "already_closed",
    ]) {
      expect(union, `the action does not declare ${code}`).toContain(`"${code}"`);
    }
    expect(union).toContain("OwnerResolutionResult");
  });

  it("PINS THE TWO INVARIANTS NO BEHAVIOUR CAN REACH", () => {
    // BOTH OF THESE CAME OUT OF THE NEGATIVE-CONTROL CAMPAIGN, which found them
    // by NOT going red. A mutation that a test suite cannot observe is not a
    // free pass — it means the property has to be pinned where it can be seen,
    // or the next person simplifies it away as dead weight.
    //
    // 1. THE ENTRY UPDATE'S `status = 'invited'` PREDICATE.
    //    Deleting it changes nothing observable, because step 3 has already
    //    returned for every non-invited status under the entry mutex — exactly
    //    what the line's own comment claims, now measured rather than asserted.
    //    It stays as the backstop 0188 and 0192 both keep for the same reason:
    //    a guarded invitation statement beside an unguarded entry statement is
    //    the asymmetry that produced the original stranding defect.
    const move = FN_BODY.slice(FN_BODY.indexOf("update public.new_client_waitlist_entries"));
    expect(move.slice(0, move.indexOf("returning"))).toMatch(/and status = 'invited'/);

    // 2. IDEMPOTENCY'S EXACT-INSTANT COMPARISON.
    //    `i.closed_at = v_released_at` cannot be told from `i.closed_at is not
    //    null` by any reachable state, because the one-way rule means an entry
    //    with a closed cycle can never be released a SECOND time — so the
    //    ambiguous history the equality defends against is unreachable TODAY.
    //    It is defence for the slice that makes re-invitation possible, and
    //    that slice will not think to add it.
    const gate = FN_BODY.slice(0, FN_BODY.indexOf("return 'already_closed'"));
    expect(
      gate,
      "the retry test no longer compares the two stamps that share one clock read",
    ).toMatch(/i\.closed_at\s*=\s*v_released_at/);
    expect(
      gate,
      "the retry test degraded to 'any closed invitation on this entry'",
    ).not.toMatch(/i\.closed_at\s+is not null/);
  });

  it("RECORDS a booking it finds, rather than refusing over it", () => {
    // THE REVIEW FINDING THIS REPLACES: the old `booking_exists` refusal told
    // the owner to record the booking, and nothing in the product invokes
    // `record_new_client_waitlist_conversion` — so the entry stayed `invited`
    // and Close kept returning the same refusal.
    const body = FN_BODY;
    const check = body.slice(body.indexOf("from public.appointments a"));
    // The SAME recipient binding 0195 enforces, so a neighbour's appointment
    // cannot convert this prospect.
    expect(check).toMatch(/c\.normalized_email\s*=\s*v_entry_email/);
    expect(check).toMatch(/a\.status\s*<>\s*'cancelled'/);
    expect(check).toMatch(/a\.created_at\s*>=\s*v_redeemed_at/);
    // COMPOSE, DO NOT DUPLICATE: the conversion is recorded by the command that
    // owns it, and this file re-implements none of it.
    expect(body).toMatch(/record_new_client_waitlist_conversion\(/);
    expect(body).toMatch(/return 'converted_instead'/);
    // AMBIGUITY REFUSES RATHER THAN GUESSING which client to convert to.
    expect(body).toMatch(/v_booked_count > 1/);
    expect(body).toMatch(/return 'booking_unresolved'/);
    // And the repaired path never stamps an operator close over a conversion.
    const repair = body.slice(body.indexOf("if v_booked_count = 1"));
    expect(repair.slice(0, repair.indexOf("return 'converted_instead'"))).not.toMatch(
      /closed_at\s*=/,
    );
  });

  it("requeue decides UNDER the entry mutex, not from an unlocked pre-check", () => {
    // THE P1 REVIEW FINDING. An unlocked guard is defeated by the command it
    // guards against: a requeue that reads `invited`, falls through, then blocks
    // inside its own UPDATE re-evaluates against a just-committed `released` row
    // and resurrects the entry.
    const body = CODE.slice(CODE.indexOf("function public.requeue_new_client_waitlist_entry"));
    const fn = body.slice(0, body.indexOf("$$;"));

    const lock = fn.indexOf("for update");
    const guard = fn.indexOf("return 'already_redeemed'");
    const write = fn.indexOf("update public.new_client_waitlist_entries");
    expect(lock, "requeue takes no row lock at all").toBeGreaterThan(0);
    expect(guard, "requeue has no redeemed guard").toBeGreaterThan(lock);
    expect(write, "the write does not follow the guard").toBeGreaterThan(guard);

    // The lock is on THIS entry, scoped by both id and studio.
    const lockStmt = fn.slice(fn.lastIndexOf("select", lock), fn.indexOf(";", lock));
    expect(lockStmt).toMatch(/new_client_waitlist_entries/);
    expect(lockStmt).toMatch(/e\.id = p_entry_id and e\.studio_id = p_studio_id/);

    // AND THE EXCLUSION IS RESTATED ON THE WRITE, so a guarded read can never
    // sit beside an unguarded write.
    const upd = fn.slice(write, fn.indexOf("returning id into v_hit", write));
    expect(upd, "the UPDATE does not re-state the redeemed exclusion").toMatch(
      /not exists[\s\S]{0,240}redeemed_at is not null/,
    );
  });
});
