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

// 0201 — WAIT-P1-EXIT SUCCESSOR. The exit stops reading `public.appointments`.
//
// SOURCE CONTRACT ONLY. The behaviour — both commit orders against creation and
// cancellation, the scope matrix, tenancy, privilege and idempotency — is proved
// against a real database in
// tests/db/waitlist-exit-authority-contraction.db.test.ts. An admin-connection
// source test cannot see a privilege defect, which is the lesson 0197 recorded
// after 182 passing assertions missed one.
//
// WHAT THIS FILE EXISTS TO PIN. The repair is an ABSENCE: three defects were
// closed by deleting a read, not by adding a guard. An absence is exactly the
// kind of change a later edit reintroduces without noticing, because nothing
// about the surrounding code looks wrong. So the assertions below are mostly
// negative, and each one names the defect it would let back in.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0201";
const FILE = fileForVersion(VERSION);
const SQL_BYTES = readFileSync(path.join(ROOT, "supabase/migrations", FILE));
const SQL = SQL_BYTES.toString("utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

/** The body of the one function this migration redefines. */
const CLOSE_BODY = (() => {
  const i = CODE.indexOf("create or replace function public.close_unbooked_new_client_waitlist_invitation");
  expect(i, "0201 must redefine the exit").toBeGreaterThan(-1);
  const j = CODE.indexOf("$$;", i);
  expect(j, "the redefinition must terminate").toBeGreaterThan(i);
  return CODE.slice(i, j);
})();

describe("0201 position in the chain", () => {
  it("is the repository maximum", () => {
    // Taken over from 0200, per CLAUDE.md: only the CURRENT max asserts this.
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it, and owns its number alone", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
    expect(countVersion(VERSION)).toBe(1);
  });

  it("IS APPLIED to production, and is the CURRENT hosted head", () => {
    // THE HAND-OFF THIS FILE'S PREVIOUS REVISION DEMANDED, now performed.
    //
    // It previously asserted the MIGRATION-FIRST PENDING shape and said
    // "WHOEVER APPLIES 0201 MOVES THE OTHER BLOCK: narrow 0200 to a floor the
    // way 0199, 0198, 0197, 0196 and 0191 were narrowed, and let this file take
    // the equality." 0201 was applied on 2026-09-20 under explicit per-change
    // owner authorization, from the reviewed PR #747 head
    // 1f1f582314a6aa63b503e4d3850ae52e304138f5, with the dry run and the apply
    // each naming exactly one file and NO --include-all. 0200 has been narrowed
    // to a floor accordingly.
    //
    // EQUALITY IS A CURRENT CLAIM, so exactly one file may hold it, and this is
    // now that file. WHOEVER APPLIES 0202 MOVES THIS BLOCK: narrow 0201 to a
    // floor the same way and let the new head take equality. Leaving it here
    // would go red on that apply, which is the whole reason the claim travels.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.repo_migration_max).toBe(VERSION);
    expect(state.repo_equals_hosted).toBe(true);
    expect(state.pending_migrations).toEqual([]);
    expect(state.next_free_migration).toBe("0202");
  });

  it("the applied bytes are the authorized bytes", () => {
    // The apply was authorized against an exact sha256 and the file must still
    // hash to it. An applied migration is FROZEN from here on: any later change
    // to these bytes is a change to something production has already run.
    expect(createHash("sha256").update(SQL_BYTES).digest("hex")).toBe(
      "1567610577e84cb717c77cf8451d57a97150f8fc169de33df2d48370be5ef82f",
    );
  });

  it("does not claim the next free number for anything", () => {
    expect(migrationState().next_free_migration).toBe("0202");
  });

  it("0200 IS FROZEN — this migration does not edit a single byte of it", () => {
    // THE RULE THIS PINS. 0200 is applied to production; its bytes are
    // production truth and any correction is a NEW forward migration, which is
    // what this file is. The digest is the one 0200's own test verified against
    // the applied bytes.
    //
    // IF THIS GOES RED, DO NOT UPDATE THE CONSTANT. 0200 was edited and must be
    // restored.
    const applied = "a6037f262c38df16fafe51a3178afc90c8fe2b814410eec4f2ad510fdd795158";
    const actual = createHash("sha256")
      .update(readFileSync(path.join(ROOT, "supabase/migrations", fileForVersion("0200"))))
      .digest("hex");
    expect(
      actual,
      "0200 no longer hashes to the bytes applied to production on 2026-09-20. " +
        "Applied migrations are FROZEN: restore the file and correct forward.",
    ).toBe(applied);
  });
});

describe("0201 THE REPAIR IS AN ABSENCE — the exit reads no appointment", () => {
  it("does not reference public.appointments anywhere in its executable body", () => {
    // FINDINGS 1 AND 2, CLOSED AT THE ROOT. 0200 scanned `public.appointments`
    // with no lock, while holding no lock any appointment writer takes, so a
    // creation or a cancellation could commit on either side of the read.
    // A decision that does not read the table cannot race writers to it.
    expect(
      CLOSE_BODY,
      "the exit reads public.appointments again. That is findings 1 and 2: the " +
        "read takes no lock and shares no lock with any appointment writer.",
    ).not.toMatch(/\bappointments\b/i);
  });

  it("does not reference public.clients either — the FOR SHARE went with it", () => {
    // The client lock existed only to hold the recipient binding still while the
    // appointment scan was acted upon. With no scan there is nothing to bind.
    //
    // AND IT NEVER SERIALISED AGAINST BOOKING ANYWAY: an appointment INSERT
    // takes FOR KEY SHARE on the client through the foreign key, and FOR SHARE
    // and FOR KEY SHARE do not conflict. Re-adding it would look like protection
    // and provide none.
    expect(CLOSE_BODY).not.toMatch(/\bpublic\.clients\b/i);
    expect(CLOSE_BODY).not.toMatch(/normalized_email/i);
  });

  it("records no conversion — that authority belongs to 0195 and to nothing here", () => {
    // FINDING 3, CLOSED AT THE ROOT. 0200 called
    // `record_new_client_waitlist_conversion` from inside the exit on a
    // predicate weaker than 0195's scope gate, so it could convert an entry onto
    // an appointment 0195 would have refused for service, date or weekday.
    // The exit no longer converts anything.
    expect(
      CLOSE_BODY,
      "the exit records a conversion again. Conversion is 0195's authority, " +
        "which enforces scope_service_id / scope_start_date / scope_end_date / " +
        "scope_allowed_weekdays. A second caller cannot enforce them by accident.",
    ).not.toMatch(/record_new_client_waitlist_conversion/i);
  });

  it("re-implements none of 0195's scope predicates", () => {
    // The corollary of the rule above. If the exit ever needs this question
    // answered it must CALL the authority, never copy it — the copy is what
    // diverged.
    for (const token of [
      "scope_service_id",
      "scope_start_date",
      "scope_end_date",
      "scope_allowed_weekdays",
      "extract(dow",
    ]) {
      expect(
        CLOSE_BODY.toLowerCase(),
        `the exit re-derives ${token}. 0195 owns the scope rule; a second copy ` +
          "is exactly how finding 3 arose.",
      ).not.toContain(token.toLowerCase());
    }
  });

  it("the unreachable result codes cannot be returned by the function body", () => {
    // They stay in the application's closed union for one release so a caller
    // pinned to 0200's contract never meets an unknown code, and the COMMENT ON
    // deliberately names them as unreachable — so this is scoped to the
    // executable body, which is the only place that could actually return one.
    //
    // (Scoped rather than asserted over CODE for a second reason worth writing
    // down: the shared strip idiom removes `comment on [\s\S]*?;` non-greedily,
    // so a COMMENT ON containing a semicolon mid-sentence survives into CODE
    // from that point on. CLOSE_BODY ends at `$$;`, before the comment begins.)
    expect(CLOSE_BODY).not.toMatch(/converted_instead/i);
    expect(CLOSE_BODY).not.toMatch(/booking_unresolved/i);
  });
});

describe("0201 lock order is UNCHANGED, and no new lock is taken", () => {
  it("takes the entry FOR UPDATE before the invitation FOR UPDATE", () => {
    const entryAt = CLOSE_BODY.indexOf("new_client_waitlist_entries");
    const invAt = CLOSE_BODY.indexOf("new_client_waitlist_invitations");
    expect(entryAt, "the entry must be read first").toBeGreaterThan(-1);
    expect(invAt, "the invitation must be read").toBeGreaterThan(-1);
    expect(
      entryAt,
      "the entry mutex must be taken BEFORE the invitation, as release does and " +
        "as 0200 did. This is also the order 0195 uses, which is why the exit " +
        "and the only booking path that can convert this entry serialise.",
    ).toBeLessThan(invAt);
    expect(CLOSE_BODY).toMatch(/for update/i);
  });

  it("takes NO studio lock — the deadlock a lock-based repair would have risked", () => {
    // A studio lock was the obvious repair and was rejected. It does not reach
    // `practitioner_cancel_appointment` or `mark_appointment_no_show`, which take
    // only the appointment row; it cannot close finding 2 at all, because READ
    // COMMITTED has no predicate locking; and it would have to be taken BEFORE
    // the entry, since 0195 takes studio then entry — entry-then-studio against
    // studio-then-entry is a cycle.
    expect(
      CLOSE_BODY,
      "the exit locks public.studios. That serialises an operator action against " +
        "all public booking, and must be ordered before the entry or it " +
        "deadlocks against 0195.",
    ).not.toMatch(/public\.studios/i);
  });

  it("takes no advisory lock and no explicit table lock", () => {
    expect(CLOSE_BODY).not.toMatch(/pg_advisory/i);
    expect(CLOSE_BODY).not.toMatch(/^\s*lock\s+table/im);
  });

  it("sets no isolation level — it could not take effect here", () => {
    // SERIALIZABLE would detect finding 2's phantom, and is unreachable: SET
    // TRANSACTION ISOLATION LEVEL must be the first statement of a transaction,
    // and this function is invoked mid-transaction through PostgREST.
    expect(CODE).not.toMatch(/set\s+transaction\s+isolation/i);
  });
});

describe("0201 changes exactly one function and nothing else", () => {
  it("redefines the exit and no other routine", () => {
    const created = [...CODE.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map(
      (m) => m[1],
    );
    expect(created).toEqual(["close_unbooked_new_client_waitlist_invitation"]);
  });

  it("does not touch requeue, whose 0200 redemption guard is load-bearing", () => {
    // That guard is what stops a closed cycle re-entering the queue and
    // acquiring a SECOND redeemed invitation. It is correct and is not in scope.
    expect(CODE).not.toMatch(/function\s+public\.requeue_new_client_waitlist_entry/i);
  });

  it("creates or alters no table, column, index, trigger, policy or constraint", () => {
    for (const shape of [
      /\bcreate\s+table\b/i,
      /\balter\s+table\b/i,
      /\bcreate\s+(unique\s+)?index\b/i,
      /\bdrop\s+(table|index|trigger|policy|constraint)\b/i,
      /\bcreate\s+trigger\b/i,
      /\bcreate\s+policy\b/i,
    ]) {
      expect(CODE, `0201 must be a function redefinition only; found ${shape}`).not.toMatch(shape);
    }
  });

  it("performs no DML and no backfill", () => {
    // The UPDATEs inside the function body run at call time, never during the
    // apply. This asserts the APPLY path, which is what a migration's blast
    // radius actually is.
    const applyPath = CODE.replace(/create or replace function[\s\S]*?\$\$;/gi, " ");
    for (const shape of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\btruncate\b/i]) {
      expect(applyPath, "0201's executable apply path must contain no DML").not.toMatch(shape);
    }
  });

  it("opens its own transaction with both timeouts armed inside it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare SET
    // LOCAL emits 25P01 and never arms. Same rule as every migration in this
    // schema.
    expect(CODE).toMatch(/^\s*begin;/im);
    expect(CODE).toMatch(/set\s+local\s+lock_timeout/i);
    expect(CODE).toMatch(/set\s+local\s+statement_timeout/i);
    expect(CODE.trimEnd()).toMatch(/commit;$/i);
  });
});

describe("0201 privilege posture is re-asserted by name", () => {
  it("revokes from all three application roles and PUBLIC, then grants service_role alone", () => {
    // 0129 missed `anon`, 0164 missed `service_role`, 0183 stated an allowlist
    // and enforced a denylist. The enumeration is written out because the
    // shortcut is what failed three times.
    const sig = "close_unbooked_new_client_waitlist_invitation\\(uuid, uuid, uuid\\)";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toMatch(new RegExp(`revoke execute on function public\\.${sig} from ${role};`, "i"));
    }
    expect(CODE).toMatch(new RegExp(`grant\\s+execute on function public\\.${sig} to service_role;`, "i"));
  });

  it("grants EXECUTE to nobody else", () => {
    const grants = [...CODE.matchAll(/grant\s+execute[\s\S]*?to\s+(\w+);/gi)].map((m) => m[1].toLowerCase());
    expect(grants).toEqual(["service_role"]);
  });

  it("changes no table or column privilege", () => {
    expect(CODE).not.toMatch(/grant\s+select\s*\(/i);
    expect(CODE).not.toMatch(/grant\s+(select|insert|update|delete)\s+on\s+(table\s+)?public\./i);
  });
});

describe("0201 preserves the answers 0200 already gave", () => {
  it("returns every surviving result code, unchanged", () => {
    for (const code of [
      "closed",
      "not_found",
      "invalid_input",
      "already_booked",
      "already_closed",
      "not_invited",
      "not_redeemed",
    ]) {
      expect(CLOSE_BODY, `the ${code} answer must survive`).toContain(`'${code}'`);
    }
  });

  it("keeps the exact idempotency test, not a looser one", () => {
    // `released_at = closed_at` is proof that THIS command performed THIS
    // release. "Some invitation on this entry was closed once" would describe a
    // cycle nobody asked about.
    expect(CLOSE_BODY).toMatch(/i\.closed_at\s*=\s*v_released_at/i);
  });

  it("stamps the invitation and the entry from ONE clock read", () => {
    expect((CLOSE_BODY.match(/clock_timestamp\(\)/g) ?? []).length).toBe(1);
    expect(CLOSE_BODY).toMatch(/closed_at\s*=\s*v_decision_at/i);
    expect(CLOSE_BODY).toMatch(/released_at\s*=\s*v_decision_at/i);
  });

  it("guards the entry move on the redemption, not merely on the status", () => {
    // The asymmetry that produced the original stranding defect in release and
    // expire was a guarded invitation statement beside an unguarded entry one.
    expect(CLOSE_BODY).toMatch(/status\s*=\s*'invited'[\s\S]{0,400}redeemed_at is not null/i);
  });

  it("re-derives authority from the shared resolver and trusts no caller claim", () => {
    expect(CLOSE_BODY).toMatch(/new_client_waitlist_resolve_owner\(p_studio_id, p_actor_user_id\)/i);
    expect(CLOSE_BODY).toMatch(/if v_code <> 'ok' then return v_code; end if;/i);
  });

  it("scopes the entry lookup by BOTH id and studio, so tenancy and lock are one statement", () => {
    expect(CLOSE_BODY).toMatch(/e\.id = p_entry_id and e\.studio_id = p_studio_id[\s\S]{0,80}for update/i);
  });

  it("recycles no admission seat — 0192 rules it spent from redemption", () => {
    expect(CLOSE_BODY).not.toMatch(/admission_round/i);
    expect(CLOSE_BODY).not.toMatch(/allowance/i);
  });
});
