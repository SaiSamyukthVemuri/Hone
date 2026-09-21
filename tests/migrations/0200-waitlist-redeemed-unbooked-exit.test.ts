import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

/** The digest verified immediately before the production write on 2026-09-20. */
const APPLIED_SHA256 = "a6037f262c38df16fafe51a3178afc90c8fe2b814410eec4f2ad510fdd795158";

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
  it("is no longer the repository maximum — 0201 is", () => {
    // HANDED OFF, per CLAUDE.md: only the CURRENT max may assert `isRepoMax`,
    // and 0201 now holds it. This block moved rather than being deleted, which
    // is the hand-off this file's own previous revision asked for.
    //
    // NOTE THE ASYMMETRY, WHICH IS CORRECT: 0201 takes the REPO max, and 0200
    // KEEPS the HOSTED-head claim below, because 0201 is authored and NOT
    // applied. Those are two different claims and only the first has moved.
    expect(isRepoMax(VERSION)).toBe(false);
    expect(versionsAbove(VERSION)).toEqual(["0201"]);
    expect(countVersion(VERSION)).toBe(1);
  });

  it("IS APPLIED to production, and hosted has not gone backwards past it", () => {
    // HANDED OFF EXACTLY AS THIS BLOCK REQUIRED. Its previous revision said
    // "WHOEVER APPLIES 0201 moves this block: narrow 0200 to a floor the same
    // way, and let the new head take equality." 0201 was applied to production
    // on 2026-09-20 under explicit per-change owner authorization, from the
    // reviewed PR #747 head 1f1f582314a6aa63b503e4d3850ae52e304138f5, so this
    // file now keeps only a FLOOR — `hosted >= 0200` — which is the durable
    // fact about an older applied migration and stays true forever.
    //
    // Equality is a CURRENT claim and exactly one file may hold it;
    // tests/migrations/0201-waitlist-exit-authority-contraction.test.ts does.
    // Re-asserting equality here would be the mechanical sweep CLAUDE.md
    // forbids, and would go red on the next apply.
    const state = migrationState();
    expect(Number(state.hosted_migration_max)).toBeGreaterThanOrEqual(Number(VERSION));
    expect(state.pending_migrations).not.toContain(VERSION);
  });

  it("is no longer the applied head — 0201 is, and the chain is back at PARITY", () => {
    // SUPERSEDED TWICE, AND BOTH TRANSITIONS ARE THE POINT.
    //
    // This first asserted PARITY at 0200. Authoring 0201 returned the chain to
    // MIGRATION-FIRST PENDING — repo one above hosted, `0201` the pending
    // suffix. Applying 0201 on 2026-09-20 closed that gap the ordinary way, so
    // the chain is at PARITY again, one migration higher.
    //
    // 0200 has now given up BOTH claims it once held: the repository maximum
    // (to 0201's authoring) and the hosted head (to 0201's apply). What it
    // keeps is the floor above, which no later apply can falsify.
    const state = migrationState();
    expect(state.pending_migrations).toEqual([]);
    expect(state.repo_equals_hosted).toBe(true);
    expect(state.repo_migration_max).toBe("0201");
    expect(state.hosted_migration_max).toBe("0201");
    expect(state.next_free_migration).toBe("0202");
  });

  it("0199 is still carried, still frozen, and was NOT re-applied", () => {
    // THE NUMBER THIS LANE HAD TO REPAIR BEFORE IT COULD AUTHOR ANYTHING: 0199
    // was applied to production while its file lived only on the held WAIT S3
    // branch, so a branch taken from production derived `next free = 0199` — a
    // number production had already used. #740 reconciled that into production
    // history, and this branch normal-merged it.
    //
    // What stays true forever: 0199 is in the repository exactly once, and this
    // migration sits above it rather than beside it.
    const state = migrationState();
    expect(state.versions).toContain("0199");
    expect(state.versions.filter((v: string) => v === "0199")).toHaveLength(1);
    expect(Number(VERSION)).toBeGreaterThan(199);
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
    // The apply record is the ledger's and migration-state.json's job. A
    // migration file that claimed to be applied would be a second,
    // unverifiable source for that fact.
    expect(SQL).not.toMatch(/\bAPPLIED\b/);
    expect(SQL).not.toMatch(/hosted_migration_max/);
  });

  it("IS APPLIED, AND THEREFORE FROZEN — it still hashes to the applied bytes", () => {
    // THE BYTE-IDENTITY LINK, taken over from 0199 with the apply. This one
    // value ties together four things that can otherwise drift apart: what was
    // reviewed on #741, what the owner authorized, what production actually
    // ran, and what this repository still contains.
    //
    // IF THIS GOES RED, DO NOT UPDATE THE CONSTANT. The file was edited and
    // must be restored; applied history is FROZEN and any correction is a NEW
    // forward migration.
    const digest = createHash("sha256")
      .update(readFileSync(path.join(ROOT, "supabase/migrations", FILE)))
      .digest("hex");
    expect(
      digest,
      `${FILE} no longer hashes to the bytes applied to production on ` +
        `2026-09-20. Applied migrations are FROZEN: restore the file, and put ` +
        `any correction in a new forward migration.`,
    ).toBe(APPLIED_SHA256);
  });

  it("is recorded in the ledger under its COMPLETE sha256, and as APPLIED", () => {
    // A truncated or mis-transcribed hash is not a record — the 0197 apply was
    // refused once for exactly that.
    const ledger = readFileSync(path.join(ROOT, "docs/production/migration-ledger.md"), "utf8");
    expect(ledger, "the ledger must carry 0200's COMPLETE sha256").toContain(APPLIED_SHA256);
    expect(ledger, "the ledger's current block must record 0200 as APPLIED").toMatch(
      // Anchored by SECTION: the match must sit between "## Current state" and
      // the first "## Previous state", so a stale record in a preserved section
      // can never satisfy it.
      /## Current state(?:(?!## Previous state)[\s\S])*?0200_waitlist_redeemed_unbooked_exit\.sql`? \| \*\*APPLIED\*\*/,
    );
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
    // THE REFUSAL IS SCOPED TO THE STATES REQUEUE ACCEPTS, which is what keeps
    // `invited` answering `not_requeueable` — the word two shipped DB tests pin
    // by name, and the right word: requeue has always refused `invited`, for
    // reasons that have nothing to do with redemption.
    const named = fn.slice(fn.indexOf("if v_hit is not null then return 'requeued'"));
    expect(named, "the refusal is not scoped to the states requeue accepts").toMatch(
      /e\.status\s+in \('released','expired'\)/,
    );
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

describe("0200 — SUPERSEDED BY 0201, recorded and not deleted", () => {
  // ⚠️ STATUS AS OF 2026-09-20: ALL THREE MANIFESTATIONS BELOW ARE FIXED.
  //
  // `0201_waitlist_exit_authority_contraction.sql` landed through #747 and is
  // APPLIED to production. It does not patch 0200 -- 0200 is frozen and its
  // bytes are unchanged -- it forward-redefines the command so that Close
  // STOPS READING `public.appointments` at all. Verified against production
  // itself: the live `close_unbooked_new_client_waitlist_invitation` contains
  // no reference to that table, no `scope_*` predicate and no conversion call.
  //
  // A decision that does not depend on appointments cannot race appointment
  // writers in either commit order, so 1 and 2 are ELIMINATED rather than
  // mitigated, and 3 has no second scope predicate left to disagree with 0195.
  //
  // THE ANALYSIS BELOW IS KEPT because it is why 0201 is shaped the way it is,
  // and because the assertions in this block still pin 0200's FROZEN bytes --
  // which must never change, superseded or not. Read it as history.
  //
  // ONE ROOT CAUSE, THREE MANIFESTATIONS, ALL RAISED AFTER 0200 WAS APPLIED.
  //
  // THE ROOT CAUSE: the repair path's appointment aggregate is an UNLOCKED READ,
  // and nothing serialises it with the writers of `public.appointments`. Unlike
  // the atomic invitation-booking path, ordinary booking and cancellation do not
  // take the waitlist-entry mutex, so they neither block on this read nor are
  // blocked by it. Everything below follows from that one fact, and a successor
  // migration should fix THAT rather than any one symptom. 0201 did exactly
  // that: it removed the read instead of trying to serialise it.
  //
  //   1. CANCELLATION AFTER THE READ (raised 05476154). The aggregate observes
  //      `status <> 'cancelled'`; a cancellation commits; Close answers
  //      `converted_instead` for an entry whose only qualifying appointment is
  //      now cancelled.
  //
  //   2. CREATION AFTER THE READ (raised 1da21490) — the mirror. The aggregate
  //      observes zero rows; a qualifying appointment commits; Close answers
  //      `closed` and releases an entry whose prospect really did book. This is
  //      the worse of the two directions: `record_new_client_waitlist_conversion`
  //      requires `invited`, and the entry is now `released`, so the conversion
  //      can no longer be recorded at all.
  //
  //   3. SCOPE IS NOT CONSULTED (raised 286397d8). See the separate test below.
  //
  // ON MANIFESTATION 1 SPECIFICALLY, measured rather than assumed: no
  // cancellation path touches the waitlist entry (checked across 0176 and 0173),
  // so the ORDINARY flow already produces that end state — book through 0195,
  // cancel later, and the entry stays `converted` with a cancelled appointment
  // and `remove_` answering `not_removable`. The defect there is the
  // non-determinism, not an otherwise-unreachable state. Manifestation 2 has no
  // such mitigation and was the one that weighed most when 0201 was scoped.
  //
  // WHAT IT IS AND IS NOT — measured, not assumed:
  //
  //   * NO CANCELLATION PATH TOUCHES THE WAITLIST ENTRY. Verified across
  //     0176 and 0173: cancelling never reverses a recorded conversion.
  //   * SO THE ORDINARY FLOW ALREADY PRODUCES THIS STATE. A prospect who books
  //     through 0195 and later cancels leaves the entry `converted` with a
  //     cancelled appointment, and `remove_new_client_waitlist_entry` answers
  //     `not_removable` on it. That is shipped, accepted behaviour.
  //   * THE DEFECT IS THEREFORE NARROWER than "marks an entry booked with no
  //     appointment": it is that one real-world instant can yield `closed` OR
  //     `converted_instead` depending on microsecond ordering. Both outcomes
  //     are individually reachable and individually defensible; the
  //     non-determinism between them is the part worth closing.
  //
  // WHY IT IS NOT FIXED HERE. `0200` is APPLIED to production (2026-09-20) and
  // is therefore FROZEN — CLAUDE.md: "An applied migration is frozen — never
  // edit it. Write a new one." Locking the matched appointment, or revalidating
  // its status under a lock immediately before the conversion, is a FORWARD
  // MIGRATION. That needs its own number from a fresh single-allocator
  // decision, its own review, and its own explicit apply authorization. None of
  // those exist, so this is recorded rather than silently carried.
  //
  // THIS BLOCK ASSERTS THE FROZEN FACTS ONLY. It deliberately does not pin the
  // racy outcome as correct — a future forward migration should change the
  // behaviour, and a test asserting today's behaviour would obstruct it.
  it("the aggregate that reads appointments takes no lock — the root cause is real", () => {
    const from = FN_BODY.indexOf("from public.appointments a");
    expect(from, "the repair no longer reads appointments").toBeGreaterThan(0);
    const stmt = FN_BODY.slice(FN_BODY.indexOf("select count(distinct"), FN_BODY.indexOf(";", from));
    expect(stmt).toMatch(/a\.status\s*<>\s*'cancelled'/);
    expect(
      stmt,
      "an appointment lock appeared in an APPLIED migration — its bytes must not change",
    ).not.toMatch(/for (share|update)/);
  });

  // SECOND OBSERVATION, RAISED AT 286397d8, SAME FROZEN FILE.
  //
  // THE SCOPE GAP. A redeemed invitation can carry an offer scope --
  // `scope_service_id`, `scope_start_date`, `scope_end_date`,
  // `scope_allowed_weekdays` (0192 §2) -- and 0195's atomic booking path
  // enforces all four before it will book. This repair's aggregate does NOT:
  // it filters on studio, recipient email, non-cancelled status and
  // `created_at >= redeemed_at` only. So an appointment the prospect made
  // through ORDINARY public booking, outside the offer, is treated as the
  // stranded invitation booking and the conversion is recorded against it.
  //
  // HOW MUCH THIS MATTERS, STATED HONESTLY RATHER THAN TALKED UP OR DOWN.
  // `record_new_client_waitlist_conversion` records that a client the canonical
  // booking authority already created CORRESPONDS TO THIS PROSPECT -- its own
  // comment says exactly that, and says nothing about which slot. A person who
  // redeemed and then booked anything in that studio under the same address has
  // become a client, which is what the entry exists to record; `converted` is
  // arguably MORE truthful there than `released`. What is genuinely inaccurate
  // is this file's own justification, which calls the match "the pre-0195
  // stranded shape" -- an out-of-scope booking is not that.
  //
  // EITHER WAY IT IS A FORWARD MIGRATION, and the reviewer says so too: re-read
  // the redeemed invitation's scope and repair only an appointment satisfying
  // it. It cannot be done by editing this file.
  it("the aggregate does not consult the invitation's offer scope — recorded, not fixed", () => {
    const from = FN_BODY.indexOf("from public.appointments a");
    const stmt = FN_BODY.slice(FN_BODY.indexOf("select count(distinct"), FN_BODY.indexOf(";", from));
    for (const scoped of ["scope_service_id", "scope_start_date", "scope_end_date", "scope_allowed_weekdays"]) {
      expect(
        stmt,
        `${scoped} appeared in an APPLIED migration — its bytes must not change`,
      ).not.toContain(scoped);
    }
    // What it DOES bind on, which is the recipient rule 0195 also enforces.
    expect(stmt).toMatch(/c\.normalized_email\s*=\s*v_entry_email/);
  });

  // TWO COMMENTS INSIDE THE FROZEN FILE ARE WRONG, AND A READER WILL BELIEVE
  // THEM. Raised at ce6583a2. Both are mine, both predate changes I made to the
  // same file before the apply, and neither can now be edited. The corrections
  // live here because this is maintained and the migration is not.
  //
  // ── CORRECTION 1 — 0200:142 ──────────────────────────────────────────────
  // The header says the entry's own lifecycle is restored such that "a later
  // cycle can issue a genuinely new invitation once the entry is REQUEUED AND
  // CLAIMED".
  //
  // THAT IS FALSE, and it is contradicted by this very migration. Section 5
  // narrows `requeue_new_client_waitlist_entry` to REFUSE any entry holding a
  // redeemed invitation, which is precisely the entry a close produces. The
  // paragraph was written before that guard existed and was never revisited.
  //
  // THE TRUE PATH after a close is: `remove_new_client_waitlist_entry` (which
  // accepts `released`), after which the person may rejoin through the public
  // form as a NEW entry with a new `joined_at`. The same entry is never
  // re-offered -- that is the one-way invariant the guard exists to hold.
  //
  // ── CORRECTION 2 — 0200:686 ──────────────────────────────────────────────
  // The requeue section header says "THE GUARD IS A PRE-CHECK, AND HERE THAT IS
  // SAFE", and argues 0188's handled-not-pre-checked rule does not transfer.
  //
  // THAT IS THE ABANDONED DESIGN, left behind in the file. The implementation
  // twenty lines below deliberately puts `not exists (...)` ON THE UPDATE,
  // because the unlocked pre-check WAS racy: a close committing between the
  // guard's statement and the UPDATE's was invisible to the first and visible
  // to the second, and the entry was resurrected to `waiting`. That was
  // reproduced end to end with the window forced open before the shape changed.
  //
  // THE TRUE CONTRACT is the one 0188 states and this file follows in code:
  // handled, not pre-checked. One statement decides and writes; the reads
  // around it only report.
  it("both wrong comments are still present in the frozen file, exactly as applied", () => {
    // ASSERTED, NOT JUST DESCRIBED. If either string disappears, someone edited
    // an applied migration -- which the digest test below also catches, but this
    // says WHICH line and why it mattered.
    expect(
      SQL,
      "0200:142's requeue claim changed — an applied migration was edited",
      // Matched across the comment's line wrap, so a re-flow of the same words
      // does not read as an edit while a changed CLAIM still does.
    ).toMatch(/a later cycle can issue a genuinely new invitation once the entry is[\s\S]{0,12}requeued and claimed/);
    expect(
      SQL,
      "0200:686's pre-check claim changed — an applied migration was edited",
    ).toContain("THE GUARD IS A PRE-CHECK, AND HERE THAT IS SAFE.");
  });

  it("and the CODE contradicts both of them, which is what makes them wrong", () => {
    // CORRECTION 1: requeue refuses a redeemed entry, so "requeued and claimed"
    // is unreachable for a closed one.
    const rq = CODE.slice(CODE.indexOf("function public.requeue_new_client_waitlist_entry"));
    const fn = rq.slice(0, rq.indexOf("$$;"));
    expect(fn).toMatch(/redeemed_at is not null/);
    expect(fn).toMatch(/return 'already_redeemed'/);

    // CORRECTION 2: the exclusion is on the UPDATE, and nothing tests
    // `redeemed_at` before it — the opposite of "the guard is a pre-check".
    const write = fn.indexOf("update public.new_client_waitlist_entries");
    expect(fn.slice(0, write), "a pre-check exists after all").not.toMatch(/redeemed_at/);
    expect(
      fn.slice(write, fn.indexOf("returning id into v_hit", write)),
    ).toMatch(/not exists[\s\S]{0,240}redeemed_at is not null/);
  });

  it("the file still hashes to the applied bytes, so this window cannot be patched in place", () => {
    // The same digest the apply was gated on. If someone "fixes" the window by
    // editing this file, this goes red and the frozen-history rule is enforced.
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(ROOT, "supabase/migrations", FILE)))
        .digest("hex"),
    ).toBe(APPLIED_SHA256);
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

  it("the action file is NO LONGER cross-read here — 0201 owns that contract", () => {
    // HANDED OFF, the same way `isRepoMax` is. This used to require the action
    // union to declare 0200's vocabulary including `converted_instead` and
    // `booking_unresolved`. 0201 RETIRED both: Close stops reading
    // `public.appointments`, so the deployed command cannot return them, and
    // the action file correctly no longer declares them.
    //
    // Keeping the old assertion here would force the application layer to keep
    // declaring codes the database can never produce — a test pinning a
    // superseded contract against live code. The cross-read moved to
    // tests/migrations/0201-waitlist-exit-authority-contraction.test.ts, which
    // asserts it against the command that is actually deployed.
    const action = readFileSync(
      path.join(ROOT, "app/(app)/settings/waitlist/actions.ts"),
      "utf8",
    );
    const union = action.slice(
      action.indexOf("type CloseUnbookedInvitationResult"),
      action.indexOf("const CLOSE_REFUSALS"),
    );
    for (const retired of ["converted_instead", "booking_unresolved"]) {
      expect(
        union,
        `the action still declares ${retired}, which 0201 made unreachable`,
      ).not.toContain(`"${retired}"`);
    }
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
    // THE MATCHED IDENTITY IS LOCKED AND RE-COMPARED BEFORE IT IS USED.
    // The aggregate takes no lock, and the conversion command checks only
    // studio membership — so without this, an email edit committing in between
    // converts the entry to a client that no longer satisfies the binding.
    // 0195 Step 3's idiom, on the same table, for the same reason.
    const repairBlock = body.slice(body.indexOf("if v_booked_count = 1"));
    const guarded = repairBlock.slice(0, repairBlock.indexOf("record_new_client_waitlist_conversion"));
    expect(guarded, "the matched client is not locked before the conversion").toMatch(
      /from public\.clients c[\s\S]{0,200}for share/,
    );
    expect(guarded, "the binding is not re-compared under that lock").toMatch(
      /v_client_email <> v_entry_email/,
    );
    expect(guarded, "a re-pointed identity is not refused").toMatch(/return 'booking_unresolved'/);

    // AMBIGUITY REFUSES RATHER THAN GUESSING which client to convert to.
    expect(body).toMatch(/v_booked_count > 1/);
    expect(body).toMatch(/return 'booking_unresolved'/);
    // And the repaired path never stamps an operator close over a conversion.
    const repair = body.slice(body.indexOf("if v_booked_count = 1"));
    expect(repair.slice(0, repair.indexOf("return 'converted_instead'"))).not.toMatch(
      /closed_at\s*=/,
    );
  });

  it("requeue's redeemed exclusion lives ON THE WRITE, not in a pre-check", () => {
    // THE P1 REVIEW FINDING. An unlocked pre-check is defeated by the command it
    // guards against: under READ COMMITTED a close committing BETWEEN the guard
    // statement and the UPDATE is invisible to the first and visible to the
    // second, so the guard declines to fire and the write resurrects the entry.
    // Reproduced end to end, with that window forced open, before the repair.
    const body = CODE.slice(CODE.indexOf("function public.requeue_new_client_waitlist_entry"));
    const fn = body.slice(0, body.indexOf("$$;"));

    const write = fn.indexOf("update public.new_client_waitlist_entries");
    expect(write, "requeue no longer writes the entry").toBeGreaterThan(0);
    const upd = fn.slice(write, fn.indexOf("returning id into v_hit", write));
    expect(upd, "the redeemed exclusion is not on the statement that writes").toMatch(
      /not exists[\s\S]{0,240}redeemed_at is not null/,
    );

    // NOTHING DECIDES BEFORE THE WRITE. Any `redeemed_at` test ahead of the
    // UPDATE is exactly the pre-check that was reproduced as defective.
    expect(
      fn.slice(0, write),
      "a redeemed pre-check is back ahead of the write",
    ).not.toMatch(/redeemed_at/);

    // AND NO ROW LOCK IS TAKEN. `waitlist-invitation-wall-clock` measured that
    // requeue is "excluded by its own predicate, not parked by a lock", and
    // 0188's own comment rules this class of test must be HANDLED, NOT
    // PRE-CHECKED. A lock here would change a concurrency contract that suite
    // pins, and buy nothing this predicate does not already give.
    expect(fn, "requeue started taking a row lock").not.toMatch(/for update/);

    // The refusal is named AFTER the write, from the same authority.
    const after = fn.slice(fn.indexOf("if v_hit is not null then return 'requeued'"));
    expect(after).toMatch(/return 'already_redeemed'/);
    expect(after.indexOf("return 'not_requeueable'")).toBeGreaterThan(
      after.indexOf("return 'already_redeemed'"),
    );
  });
});
