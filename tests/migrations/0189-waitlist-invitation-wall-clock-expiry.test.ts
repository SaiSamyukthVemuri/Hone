import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
  migrationState,
} from "./helpers/migration-state";

// 0189 — WAIT-03 TTL decisions must use the wall clock, taken AFTER the lock.
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half — that a transaction which begins before the deadline and
// decides after it is actually refused, including when the delay came from a
// real row lock — lives in tests/db/waitlist-invitation-wall-clock.db.test.ts.
// Neither is sufficient alone: SQL text cannot prove a race, and a behavioural
// test cannot prove a grant line was WRITTEN rather than inherited from
// Supabase's create-time defaults.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * edit 0188 instead of adding 0189 -> the "0188 is untouched" assertion
//     fails, and an APPLIED, FROZEN migration has been rewritten;
//   * put clock_timestamp() back inside a predicate -> the structural
//     assertions fail, because a predicate can be evaluated BEFORE the
//     statement blocks and re-qualified afterwards, which is the exact defect;
//   * read the clock BEFORE taking the lock -> the ordering assertions fail;
//   * drop the entry mutex from expire(), or add a second lock to redeem() ->
//     the lock-ordering assertions fail, which is how a lock inversion enters;
//   * change a signature, return type, SECURITY DEFINER posture or search_path
//     -> the preservation assertions fail;
//   * revoke by name and forget a role -> the privilege assertions fail, which
//     is the 0129 / 0164 / 0183 failure class.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0189";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by PROSE. This migration's header
// names the very constructs it forbids, so every "does not contain" assertion
// runs against comment-stripped SQL rather than the raw file.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/** The executable body of one function, comment-stripped. */
function body(fn: string): string {
  const at = CODE.indexOf(`create or replace function public.${fn}`);
  expect(at, `${fn} is not defined in ${FILE}`).toBeGreaterThan(-1);
  const end = CODE.indexOf("$$;", at);
  expect(end, `${fn} has no terminator`).toBeGreaterThan(at);
  return CODE.slice(at, end);
}

const REDEEM = "redeem_new_client_waitlist_invitation";
const EXPIRE = "expire_new_client_waitlist_invitation";

describe("0189 — identity and position", () => {
  it("is named for what it repairs", () => {
    expect(FILE).toBe("0189_waitlist_invitation_wall_clock_expiry.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so that a future
    // migration does not turn this file red. Whoever adds 0190 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is AUTHORED AND TESTED, NOT APPLIED to production", () => {
    // The honest posture for a repair in review. Hosted state advances ONLY in
    // the change that records an authorized production apply, so this asserts
    // the gap rather than hiding it. When 0189 is applied, this block moves —
    // deliberately, by a human, in that change.
    const state = migrationState();
    expect(state.repo_migration_max).toBe(VERSION);
    expect(state.hosted_migration_max).toBe("0188");
    expect(state.pending_migrations).toEqual([VERSION]);
  });
});

describe("0189 — 0188 IS FROZEN AND IS NOT EDITED", () => {
  it("0188 still hashes to the bytes production applied", async () => {
    // THE ABSOLUTE RULE OF THIS REPAIR. 0188 is applied and frozen; a
    // correction is a NEW migration. This pins the applied bytes so a future
    // "small tidy-up" of 0188 turns this red instead of silently diverging
    // production from the repository.
    const { createHash } = await import("node:crypto");
    const applied = readFileSync(
      path.join(ROOT, "supabase/migrations", fileForVersion("0188")),
      "utf8",
    );
    expect(createHash("sha256").update(applied, "utf8").digest("hex")).toBe(
      "2bf43f0d49280d0095f627f4a3a2e6e169b5111c0d988496244003db377b7bf0",
    );
    expect(Buffer.byteLength(applied, "utf8")).toBe(73564);
  });

  it("0189 creates nothing and drops nothing — it replaces two function bodies", () => {
    // SCOPE, AS AN EXECUTABLE FACT. The repair may not smuggle in a table, a
    // column, an index, a policy, a trigger or a constraint.
    expect(CODE).not.toMatch(/create\s+table/i);
    expect(CODE).not.toMatch(/alter\s+table/i);
    expect(CODE).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(CODE).not.toMatch(/drop\s+(table|index|trigger|policy|constraint|function)/i);
    expect(CODE).not.toMatch(/create\s+policy/i);
    expect(CODE).not.toMatch(/create\s+trigger/i);
    // ...and it performs no DML of its own AT APPLY TIME. The function bodies
    // legitimately contain UPDATE — that is the whole point of the repair — and
    // they run at RPC call time, never during the apply. So the check is made
    // against the executable path with every $$-quoted body removed, which is
    // the same distinction the 0187/0188 apply records draw.
    const APPLY_PATH = CODE.replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$");
    expect(APPLY_PATH).not.toMatch(/^\s*(insert|update|delete)\s/im);
    expect(APPLY_PATH).not.toMatch(/\btruncate\b/i);
  });

  it("replaces EXACTLY the two TTL authorities and nothing else", () => {
    const defs = [...CODE.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(defs.sort()).toEqual([EXPIRE, REDEEM].sort());
  });
});

describe("0189 — transactional envelope", () => {
  it("opens its own transaction and sets a lock timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    expect(CODE).toMatch(/^\s*begin;/mi);
    expect(CODE).toMatch(/commit;\s*$/mi);
    const begin = CODE.search(/begin;/i);
    const lock = CODE.search(/set\s+local\s+lock_timeout/i);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
  });
});

describe("0189 — the clock is read AFTER the lock, and only there", () => {
  it("redeem locks the invitation row BEFORE it reads the clock", () => {
    const b = body(REDEEM);
    const lock = b.search(/for update/i);
    const clock = b.indexOf("v_decision_at := clock_timestamp()");
    expect(lock, "redeem takes no row lock at all").toBeGreaterThan(-1);
    expect(clock, "redeem never reads a wall clock").toBeGreaterThan(-1);
    expect(
      clock,
      "redeem reads the clock BEFORE it takes the lock, which is the defect",
    ).toBeGreaterThan(lock);
  });

  // -----------------------------------------------------------------
  // THE ORDERING LAW FOR EXPIRE, IN FULL:
  //     ENTRY LOCK -> INVITATION LOCK -> clock -> decision/write
  //
  // The entry lock alone is NOT enough, and that was a real defect rather than
  // a theoretical one. The statement that serializes the terminal outcome is
  // the INVITATION lock, and it can block long after an earlier clock read:
  // measured 3,150 ms of provenance drift, and unbounded in principle. The
  // behavioural proof is in tests/db/waitlist-invitation-wall-clock.db.test.ts.
  // -----------------------------------------------------------------
  /** Offsets of each ordered landmark inside expire(), or -1. */
  function expireLandmarks(src: string) {
    const entryLock = src.search(
      /from public\.new_client_waitlist_entries e[\s\S]*?for update/,
    );
    const invLock = src.search(
      /from public\.new_client_waitlist_invitations i[\s\S]*?for update/,
    );
    const clock = src.indexOf("v_decision_at := clock_timestamp()");
    const decision = src.indexOf("if v_expires > v_decision_at");
    const write = src.search(/update public\.new_client_waitlist_invitations i\s*\n\s*set expired_at/);
    return { entryLock, invLock, clock, decision, write };
  }

  it("expire orders ENTRY lock -> INVITATION lock -> clock -> decision -> write", () => {
    const m = expireLandmarks(body(EXPIRE));
    for (const [name, at] of Object.entries(m)) {
      expect(at, `expire() has no ${name}`).toBeGreaterThan(-1);
    }
    expect(m.invLock, "the invitation is locked BEFORE the entry").toBeGreaterThan(m.entryLock);
    expect(m.clock, "the clock is read BEFORE the invitation lock").toBeGreaterThan(m.invLock);
    expect(m.decision, "the TTL decision precedes the clock").toBeGreaterThan(m.clock);
    expect(m.write, "the stamp precedes the decision").toBeGreaterThan(m.decision);
  });

  it("J — NON-VACUITY: removing the invitation-lock limb turns that law red", () => {
    // Codex's shape. Mutates a copy; the file on disk is never touched. Without
    // this, the ordering assertion above could be satisfied by an expire() that
    // never locks the invitation at all.
    const real = body(EXPIRE);
    expect(expireLandmarks(real).invLock).toBeGreaterThan(-1);

    // Drop ONLY the `for update` from the invitation SELECT, which is exactly
    // the pre-repair shape: identity is still read, the row is not locked.
    const poisoned = real.replace(
      /(where i\.id = v_inv\s*\n)\s*for update;/,
      "$1  ;",
    );
    expect(poisoned, "the mutation did not apply — this control is vacuous").not.toEqual(real);

    const m = expireLandmarks(poisoned);
    expect(m.invLock, "the poisoned body still appears to lock the invitation").toBe(-1);
    // ...and the law above would have failed on it.
    expect(m.clock).toBeGreaterThan(-1);
    expect(m.invLock).toBeLessThan(m.clock);
  });

  it("the current cycle is identified by LIVE STATE, never by chronology", () => {
    // 0188 stamps `issued_at := now()` = transaction_timestamp(), so issuance
    // order and issued_at order are different relations: a transaction that
    // began earlier but issues later stamps the NEWER row with the OLDER
    // instant, and two cycles inside one transaction tie exactly. The schema's
    // one_live_per_entry unique index makes "the live row" a definition rather
    // than a guess.
    const b = body(EXPIRE);
    const identify = b.slice(
      b.indexOf("select i.id into v_inv"),
      b.indexOf("if v_inv is null then"),
    );
    expect(identify).toContain("i.redeemed_at is null");
    expect(identify).toContain("i.expired_at  is null");
    expect(identify).toContain("i.released_at is null");
    // NO ordering, NO limit, NO chronology, anywhere in expire().
    expect(b, "expire() orders invitations by issued_at").not.toMatch(/order by/i);
    expect(b, "expire() still picks a cycle with limit 1").not.toMatch(/limit 1/i);
    expect(b).not.toMatch(/max\(\s*issued_at/i);
    expect(b).not.toMatch(/issued_at\s+desc/i);
  });

  it("J — NON-VACUITY: restoring issued_at ordering turns that law red", () => {
    // Mutates a copy; the file on disk is never touched.
    const real = body(EXPIRE);
    expect(real).not.toMatch(/order by/i);

    const poisoned = real.replace(
      /(select i\.id into v_inv[\s\S]*?and i\.released_at is null;)/,
      "select i.id into v_inv from x order by i.issued_at desc, i.id desc limit 1;",
    );
    expect(poisoned, "the mutation did not apply — this control is vacuous").not.toEqual(real);
    expect(poisoned).toMatch(/order by/i);
    expect(poisoned).toMatch(/issued_at\s+desc/i);
    expect(poisoned).toMatch(/limit 1/i);
  });

  it("the invitation lock is requested on the IMMUTABLE id ALONE", () => {
    // A lock request carrying the mutable live-state predicate could be
    // re-qualified away by EvalPlanQual after a concurrent redemption commits,
    // losing the row and answering as though the entry was never invited.
    // Identity is read WITHOUT a lock; the lock is taken on `id`.
    const b = body(EXPIRE);
    const lockSel = b.slice(
      b.indexOf("select i.expired_at, i.released_at, i.expires_at"),
      b.indexOf("v_decision_at := clock_timestamp()"),
    );
    expect(lockSel).toMatch(/where i\.id = v_inv\s*\n\s*for update/);
    expect(lockSel).not.toMatch(/redeemed_at is null/);
    expect(lockSel).not.toMatch(/expired_at  is null/);
    expect(lockSel).not.toMatch(/released_at is null/);
    // The identifying SELECT must NOT take a lock of its own.
    const identify = b.slice(
      b.indexOf("select i.id into v_inv"),
      b.indexOf("if v_inv is null then"),
    );
    expect(identify, "the identifying select must not lock").not.toMatch(/for update/i);
  });

  it("the no-live-row branch derives from lifecycle invariants, not chronology", () => {
    const b = body(EXPIRE);
    const branch = b.slice(
      b.indexOf("if v_inv is null then"),
      b.indexOf("select i.expired_at, i.released_at, i.expires_at"),
    );
    expect(branch).toContain("'already_redeemed'");
    expect(branch).toContain("'expired'");
    expect(branch).toContain("'not_invited'");
    expect(branch).toMatch(/i\.redeemed_at is not null/);
    expect(branch).not.toMatch(/issued_at/i);
    expect(branch).not.toMatch(/order by|limit 1/i);
  });

  it("the terminal state is read from the LOCKED row, not re-queried", () => {
    const b = body(EXPIRE);
    // Every branch reads a local populated by the locking SELECT — except
    // already_redeemed, which is the cross-cycle `exists` check 0188 used and
    // which subsumes the locked row's own redeemed_at.
    expect(b).toMatch(/if v_expired is not null then/);
    expect(b).toMatch(/if v_released is not null then/);
    expect(b).toMatch(/if v_expires > v_decision_at then/);
  });

  it("every TTL comparison uses the post-lock value, never now()", () => {
    // THE LOAD-BEARING ASSERTION. `now()` is transaction_timestamp(): fixed at
    // transaction start. A transaction that began before the deadline and
    // decided after it redeemed an expired invitation.
    for (const fn of [REDEEM, EXPIRE]) {
      expect(body(fn), `${fn} still decides with now()`).not.toMatch(/\bnow\(\)/);
    }
    // redeem compares the column under its own row lock...
    expect(body(REDEEM)).toMatch(/i\.expires_at\s*>\s*v_decision_at/);
    // ...and expire compares the value it read FROM the locked row, which is
    // stronger: the comparison cannot be re-qualified against a newer version.
    expect(body(EXPIRE)).toMatch(/v_expires\s*>\s*v_decision_at/);
  });

  it("clock_timestamp() is never evaluated inside a predicate", () => {
    // A predicate can be evaluated BEFORE the statement blocks and re-qualified
    // afterwards by EvalPlanQual, so clock_timestamp() in a WHERE clause would
    // reintroduce the same staleness by a different route. It may appear ONCE
    // per function, as the assignment into the local.
    for (const fn of [REDEEM, EXPIRE]) {
      const b = body(fn);
      const uses = [...b.matchAll(/clock_timestamp\(\)/g)].length;
      expect(uses, `${fn} evaluates clock_timestamp() more than once`).toBe(1);
      // ...and that ONE use is the assignment into the local, not a call
      // sitting in a predicate. Asserted by rebuilding the line rather than by
      // a loose "does a WHERE appear anywhere near it" regex, which a greedy
      // match makes meaningless.
      const line = b
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.includes("clock_timestamp()"));
      expect(line, `${fn} has no clock_timestamp() line`).toBeDefined();
      expect(line).toBe("v_decision_at := clock_timestamp();");
    }
  });

  it("the stamp and the comparison come from the SAME value", () => {
    // Judging a row against one instant and stamping it with another is its own
    // provenance defect: 0188's `redeemed_at = now()` recorded the
    // transaction-start instant even on a legitimate redemption.
    expect(body(REDEEM)).toMatch(/set\s+redeemed_at\s*=\s*v_decision_at/);
    expect(body(EXPIRE)).toMatch(/set\s+expired_at\s*=\s*v_decision_at/);
    expect(body(EXPIRE)).toMatch(/status\s*=\s*'expired',\s*expired_at\s*=\s*v_decision_at/);
  });

  it("does NOT text-replace now() elsewhere: issue() and release() are untouched", () => {
    // Scope discipline. issue() derives expires_at from now(); its failure
    // direction is a SHORTER real window, never a longer one, and no defect was
    // reproduced there. release() makes no clock comparison at all.
    expect(CODE).not.toContain("issue_new_client_waitlist_invitation");
    expect(CODE).not.toContain("release_new_client_waitlist_entry");
  });
});

describe("0189 — lock ordering is preserved, not inverted", () => {
  it("expire still takes the ENTRY mutex before it touches any invitation", () => {
    const b = body(EXPIRE);
    const entryLock = b.indexOf("public.new_client_waitlist_entries e");
    const invitation = b.indexOf("public.new_client_waitlist_invitations");
    expect(entryLock).toBeGreaterThan(-1);
    expect(invitation).toBeGreaterThan(entryLock);
    expect(b).toMatch(/from public\.new_client_waitlist_entries e[\s\S]*?for update/);
  });

  it("redeem takes exactly ONE lock, so it can never be the waiter in a cycle", () => {
    const b = body(REDEEM);
    expect([...b.matchAll(/for update/gi)].length).toBe(1);
    // It never reaches for the entry row, which is what would create the
    // invitation->entry order that inverts expire()'s entry->invitation order.
    expect(b).not.toContain("new_client_waitlist_entries");
  });

  it("locks the invitation by its IMMUTABLE key, so an EPQ re-check cannot lose it", () => {
    // token_hash cannot change (0188's immutability trigger). Locking on a
    // mutable outcome column would let the post-wait re-qualification drop the
    // row and hand back a spurious invalid_token.
    const b = body(REDEEM);
    expect(b).toMatch(/where i\.token_hash = v_hash\s*[\s\S]{0,40}for update/);
  });

  it("introduces no advisory lock and no second serialization primitive", () => {
    expect(CODE).not.toMatch(/pg_advisory/i);
    expect(CODE).not.toMatch(/pg_sleep/i);
    expect(CODE).not.toMatch(/lock\s+table/i);
  });
});

describe("0189 — the deployed contract is preserved", () => {
  it("both signatures and return types are byte-identical to 0188's", () => {
    expect(CODE).toContain(
      "create or replace function public.redeem_new_client_waitlist_invitation(\n  p_raw_token text\n)",
    );
    expect(CODE).toContain("returns table (result text, studio_id uuid, entry_id uuid)");
    expect(CODE).toContain(
      "create or replace function public.expire_new_client_waitlist_invitation(\n" +
        "  p_studio_id     uuid,\n  p_entry_id      uuid,\n  p_actor_user_id uuid\n)",
    );
    expect(CODE).toMatch(/returns text\s*\nlanguage plpgsql/);
  });

  it("keeps SECURITY DEFINER and the pinned search_path on both", () => {
    expect([...CODE.matchAll(/security definer/g)].length).toBe(2);
    expect(
      [...CODE.matchAll(/set search_path = pg_catalog, pg_temp/g)].length,
    ).toBe(2);
    expect([...CODE.matchAll(/language plpgsql/g)].length).toBe(2);
    expect([...CODE.matchAll(/^volatile$/gm)].length).toBe(2);
  });

  it("adds no new result word to either closed vocabulary", () => {
    const words = new Set(
      [...CODE.matchAll(/'([a-z_]+)'::text|return '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]),
    );
    // Exactly 0188's vocabulary for these two commands.
    for (const w of words) {
      expect(
        [
          "invalid_token",
          "redeemed",
          "invalid_input",
          "already_redeemed",
          "not_expired",
          "expired",
          "not_invited",
          "ok",
        ],
        `0189 introduces a new result word: ${w}`,
      ).toContain(w);
    }
    // ...and the words the repair depends on are still there.
    expect(CODE).toContain("'invalid_token'");
    expect(CODE).toContain("'not_expired'");
  });

  it("keeps redemption terminal in expire, checked before anything is written", () => {
    const b = body(EXPIRE);
    const guard = b.indexOf("already_redeemed");
    const write = b.search(/update public\.new_client_waitlist_invitations/);
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
    // Defence in depth on the entry move survives too.
    expect(b).toMatch(/status = 'invited'[\s\S]*not exists/);
  });

  it("never returns or logs token_hash", () => {
    expect(CODE).not.toMatch(/return[\s\S]{0,80}token_hash/i);
    expect(CODE).not.toMatch(/raise\s+(notice|log|warning)/i);
  });
});

describe("0189 — privileges are reasserted by name, never assumed", () => {
  // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
  // AND service_role at function-create time, and CREATE OR REPLACE preserves
  // whatever an out-of-band re-grant left behind. 0129 missed anon; 0164 missed
  // service_role. Every role is enumerated.
  for (const [fn, sig] of [
    [REDEEM, "text"],
    [EXPIRE, "uuid, uuid, uuid"],
  ] as const) {
    it(`${fn} revokes from public, anon, authenticated and service_role, then grants ONLY service_role`, () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(CODE).toContain(
          `revoke execute on function public.${fn}(${sig}) from ${role};`,
        );
      }
      expect(CODE).toContain(
        `grant  execute on function public.${fn}(${sig}) to service_role;`,
      );
      // The revoke must PRECEDE the grant, or the grant is undone.
      const rev = CODE.lastIndexOf(`revoke execute on function public.${fn}(${sig})`);
      const grant = CODE.indexOf(`grant  execute on function public.${fn}(${sig})`);
      expect(grant).toBeGreaterThan(rev);
    });

    it(`${fn} grants EXECUTE to nobody except service_role`, () => {
      const grants = [...CODE.matchAll(
        new RegExp(`grant\\s+execute on function public\\.${fn}\\([^)]*\\) to (\\w+);`, "g"),
      )].map((m) => m[1]);
      expect(grants).toEqual(["service_role"]);
    });
  }
});
