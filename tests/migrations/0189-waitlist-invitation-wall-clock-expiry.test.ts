import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
  migrationState,
} from "./helpers/migration-state";
import {
  CANONICAL_EDGES,
  MECHANISM_EVIDENCE,
  PREDECESSOR_RELEASE,
  TEMPORAL_EDGES,
  VERDICT_EVIDENCE,
} from "../db/helpers/temporal-edges";

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
const RELEASE = "release_new_client_waitlist_entry";

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

  it("replaces EXACTLY the nine timestamp authorities and nothing else", () => {
    // RELEASE joined them: it makes no TTL comparison, but it STAMPS twice and
    // both stamps used now(). Measured, it recorded a release six milliseconds
    // BEFORE the issued_at of the invitation it released.
    const defs = [...CODE.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(defs.sort()).toEqual([
      "claim_new_client_waitlist_entries",
      "claim_new_client_waitlist_entry",
      "issue_new_client_waitlist_invitation",
      "new_client_waitlist_entries_record_event",
      "record_new_client_waitlist_conversion",
      "remove_new_client_waitlist_entry",
      EXPIRE, REDEEM, RELEASE,
    ].sort());
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
    for (const fn of [REDEEM, EXPIRE, RELEASE]) {
      expect(body(fn), `${fn} still decides with now()`).not.toMatch(/\bnow\(\)/);
      expect(body(fn), `${fn} uses a statement clock`).not.toMatch(/statement_timestamp|transaction_timestamp/);
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
    for (const fn of [REDEEM, EXPIRE, RELEASE]) {
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

  it("issue() is replaced, but its INVITATION stamps are deliberately untouched", () => {
    // Scope discipline, and the boundary moved once on evidence. issue()
    // derives expires_at from now(); its failure direction is a SHORTER real
    // window, never a longer one, and no defect was reproduced there, so it
    // stays as applied. release() was ALSO excluded on the grounds that it makes
    // no clock comparison — true, and beside the point, because it stamps. It is
    // now in scope; issue() is still not.
    // issue() is in scope for its ENTRY evidence (invited_at) because a census
    // path inverted on it. Its INVITATION stamps are not: no path inverts on
    // them, issue() writes the invitation BEFORE the entry so
    // issued_at <= invited_at stays truthful, and moving expires_at would change
    // the window of every future invitation.
    const b = body("issue_new_client_waitlist_invitation");
    expect(b).toMatch(/invited_at = v_decision_at/);
    expect(b).toMatch(/v_expires := now\(\) \+ make_interval/);
    expect(CODE).not.toContain("new_client_waitlist_invitations_server_timestamps");
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

  it("keeps SECURITY DEFINER and the pinned search_path on every replacement", () => {
    // 8 commands carry SECURITY DEFINER and volatility; the 9th replacement is
    // the event TRIGGER function, which has neither by design (0188 defines it
    // as a plain trigger function) but does carry the pinned search_path.
    expect([...CODE.matchAll(/security definer/g)].length).toBe(8);
    expect([...CODE.matchAll(/^volatile$/gm)].length).toBe(8);
    expect(
      [...CODE.matchAll(/set search_path = pg_catalog, pg_temp/g)].length,
    ).toBe(9);
    expect([...CODE.matchAll(/language plpgsql/g)].length).toBe(9);
  });

  it("adds no new result word to any closed vocabulary", () => {
    // DERIVED FROM 0188, not transcribed. The invariant is "0189 introduces no
    // word 0188 does not already contain", so the allowlist cannot drift out of
    // date as more of 0188's commands come into scope — and a genuinely new
    // word still fails.
    const frozen = readFileSync(
      path.join(ROOT, "supabase/migrations", fileForVersion("0188")),
      "utf8",
    );
    const words = (src: string) =>
      new Set(
        [...src.matchAll(/'([a-z_]+)'::text|return '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]),
      );
    const before = words(frozen);
    for (const w of words(CODE)) {
      expect(before, `0189 introduces a new result word: ${w}`).toContain(w);
    }
    // ...and the words this repair depends on are still there.
    expect(CODE).toContain("'invalid_token'");
    expect(CODE).toContain("'not_expired'");
    expect(CODE).toContain("'already_redeemed'");
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
    [RELEASE, "uuid, uuid, uuid"],
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

// ---------------------------------------------------------------------------
// RELEASE — the same ordering law, with a CONDITIONAL invitation lock.
//
// 0188 permits release from 'claimed', 'invited' AND 'expired'. A claimed entry
// may have no invitation at all, so requiring one would change the product. The
// lock is therefore conditional while the clock read is not: there is exactly
// ONE clock_timestamp() call site, placed after every lock the path took, and
// both stamps come from it.
// ---------------------------------------------------------------------------
describe("0189 — release stamps from one post-lock instant", () => {
  const b = () => body(RELEASE);

  it("orders ENTRY lock -> INVITATION lock -> clock -> stamps", () => {
    const src = b();
    const entryLock = src.search(/from public\.new_client_waitlist_entries e[\s\S]*?for update/);
    const invLock = src.search(/where i\.id = v_inv\s*\n\s*for update/);
    const clock = src.indexOf("v_decision_at := clock_timestamp()");
    const invStamp = src.search(/set released_at = v_decision_at/);
    const entryStamp = src.search(/set status = 'released', released_at = v_decision_at/);
    for (const [name, at] of Object.entries({ entryLock, invLock, clock, invStamp, entryStamp })) {
      expect(at, `release() has no ${name}`).toBeGreaterThan(-1);
    }
    expect(invLock, "the invitation is locked before the entry").toBeGreaterThan(entryLock);
    expect(clock, "the clock is read before the invitation lock").toBeGreaterThan(invLock);
    expect(invStamp).toBeGreaterThan(clock);
    expect(entryStamp).toBeGreaterThan(clock);
  });

  it("the invitation lock is CONDITIONAL, so the claim-only path still works", () => {
    // A `claimed` entry legitimately has no invitation. Requiring one would be a
    // product change, not a timestamp repair.
    expect(b()).toMatch(/if v_inv is not null then\s*\n\s*perform 1[\s\S]*?for update;\s*\n\s*end if;/);
    // ...and the clock read sits OUTSIDE that conditional.
    const src = b();
    const endIf = src.indexOf("end if;", src.indexOf("if v_inv is not null then"));
    expect(src.indexOf("v_decision_at := clock_timestamp()")).toBeGreaterThan(endIf);
  });

  it("BOTH stamps come from the SAME single clock read", () => {
    const src = b();
    expect([...src.matchAll(/clock_timestamp\(\)/g)].length).toBe(1);
    expect([...src.matchAll(/v_decision_at/g)].length).toBeGreaterThanOrEqual(3); // assign + 2 stamps
    expect(src).not.toMatch(/released_at\s*=\s*(now|clock_timestamp|statement_timestamp)\(\)/);
  });

  it("identifies the live invitation structurally, never by chronology", () => {
    const src = b();
    const identify = src.slice(src.indexOf("select i.id into v_inv"), src.indexOf("if v_inv is not null then"));
    expect(identify).toContain("i.redeemed_at is null");
    expect(identify).toContain("i.expired_at  is null");
    expect(identify).toContain("i.released_at is null");
    expect(identify, "the identifying select must not lock").not.toMatch(/for update/i);
    expect(src, "release() orders invitations").not.toMatch(/order by/i);
    expect(src).not.toMatch(/issued_at/i);
  });

  it("preserves 0188's legal source states and its redeemed guard", () => {
    const src = b();
    expect(src).toContain("status in ('claimed','invited','expired')");
    expect(src).toMatch(/not exists \(\s*\n\s*select 1[\s\S]*?redeemed_at is not null\)/);
    expect(src).toContain("'already_redeemed'");
    expect(src).toContain("'not_releasable'");
    expect(src).toContain("'released'");
    expect(src).toContain("'invalid_input'");
  });

  it("never rewrites terminal evidence: the invitation update keeps all three guards", () => {
    // An invitation already carrying expired_at must keep it; the one-outcome
    // CHECK forbids a second terminal column, and this is where that is honoured.
    expect(b()).toMatch(
      /set released_at = v_decision_at\s*\n\s*where i\.id = v_inv\s*\n\s*and i\.redeemed_at is null and i\.expired_at is null and i\.released_at is null;/,
    );
  });

  it("K — NON-VACUITY: restoring the now() stamps turns these laws red", () => {
    // Mutates a copy; the file on disk is never touched.
    // Reconstruct 0188's actual shape: drop the post-lock capture entirely and
    // stamp from now(), which is what the frozen function does.
    const real = b();
    const poisoned = real
      .replace(/\n\s*v_decision_at := clock_timestamp\(\);/, "")
      .replace(/v_decision_at/g, "now()");
    expect(poisoned, "the mutation did not apply — this control is vacuous").not.toEqual(real);
    expect(poisoned).toMatch(/set released_at = now\(\)/);
    expect(poisoned).toMatch(/set status = 'released', released_at = now\(\)/);
    // The single post-lock read is gone, which is exactly the defect.
    expect([...poisoned.matchAll(/clock_timestamp\(\)/g)].length).toBe(0);
    // ...while the REAL body still satisfies the law.
    expect([...real.matchAll(/clock_timestamp\(\)/g)].length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE TEMPORAL CLASS, CLOSED.
//
// Four reviews found the same defect in a different command. These assert the
// property rather than the instances: nothing in 0189 decides or stamps from a
// transaction-bound clock, and the lifecycle event log takes the transition's
// own evidence rather than a second reading of the moment.
// ---------------------------------------------------------------------------
describe("0189 — no transaction-bound clock survives anywhere", () => {
  it("no replaced function uses now(), transaction_timestamp or statement_timestamp", () => {
    // CODE is comment-stripped, so the prose above that names these does not
    // satisfy the assertion.
    // EXACTLY ONE now() survives in the whole file, and it is the deliberate
    // §6 exception: issue()'s expires_at derivation, which no census path
    // inverts and which is internally consistent with 0188's issued_at trigger.
    const nows = [...CODE.matchAll(/\bnow\(\)/g)].length;
    expect(nows, "a transaction-bound clock crept back in").toBe(1);
    expect(CODE).toMatch(/v_expires := now\(\) \+ make_interval/);
    expect(CODE).not.toMatch(/transaction_timestamp/);
    expect(CODE).not.toMatch(/statement_timestamp/);
    // ...and no LIFECYCLE stamp anywhere uses it.
    expect(CODE).not.toMatch(/_at\s*=\s*now\(\)/);
  });

  it("replaces every command that stamps entry lifecycle evidence", () => {
    const defs = [...CODE.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    for (const fn of [
      "redeem_new_client_waitlist_invitation",
      "expire_new_client_waitlist_invitation",
      "release_new_client_waitlist_entry",
      "claim_new_client_waitlist_entries",
      "claim_new_client_waitlist_entry",
      "issue_new_client_waitlist_invitation",
      "record_new_client_waitlist_conversion",
      "remove_new_client_waitlist_entry",
      "new_client_waitlist_entries_record_event",
    ]) {
      expect(defs, `0189 does not replace ${fn}`).toContain(fn);
    }
    expect(defs).toHaveLength(9);
  });

  it("every replaced COMMAND reads the clock exactly once", () => {
    for (const fn of [
      "redeem_new_client_waitlist_invitation",
      "expire_new_client_waitlist_invitation",
      "release_new_client_waitlist_entry",
      "claim_new_client_waitlist_entries",
      "claim_new_client_waitlist_entry",
      "issue_new_client_waitlist_invitation",
      "record_new_client_waitlist_conversion",
      "remove_new_client_waitlist_entry",
    ]) {
      const uses = [...body(fn).matchAll(/clock_timestamp\(\)/g)].length;
      expect(uses, `${fn} reads the clock ${uses} times`).toBe(1);
    }
  });

  it("every entry-lifecycle stamp comes from the post-lock instant", () => {
    // Two legitimate shapes, and both are post-lock:
    //   * a local captured after the entry mutex (the single-row commands), and
    //   * a value derived FROM the locked candidates inside one SQL statement
    //     (bulk claim, which has no single entry to lock first).
    expect(body("claim_new_client_waitlist_entries")).toMatch(/claimed_at\s*=\s*d\.decision_at/);
    for (const [fn, col] of [
      ["claim_new_client_waitlist_entry", "claimed_at"],
      ["issue_new_client_waitlist_invitation", "invited_at"],
      ["record_new_client_waitlist_conversion", "converted_at"],
      ["remove_new_client_waitlist_entry", "removed_at"],
    ] as const) {
      const b = body(fn);
      expect(b, `${fn} does not stamp ${col} from v_decision_at`).toMatch(
        new RegExp(`${col}\\s*=\\s*v_decision_at`),
      );
    }
  });

  it("the entry mutex precedes the clock in every command that takes one", () => {
    // claim_new_client_waitlist_entries is the exception BY DESIGN: it uses
    // FOR UPDATE SKIP LOCKED, which never waits, so there is no wait for a
    // stamp to be backdated across.
    for (const fn of [
      "expire_new_client_waitlist_invitation",
      "release_new_client_waitlist_entry",
      "claim_new_client_waitlist_entry",
      "issue_new_client_waitlist_invitation",
      "record_new_client_waitlist_conversion",
      "remove_new_client_waitlist_entry",
    ]) {
      const b = body(fn);
      const lock = b.search(/from public\.new_client_waitlist_entries e[\s\S]*?for update/);
      const clock = b.indexOf("v_decision_at := clock_timestamp()");
      expect(lock, `${fn} takes no entry lock`).toBeGreaterThan(-1);
      expect(clock, `${fn} reads no clock`).toBeGreaterThan(-1);
      expect(clock, `${fn} reads the clock BEFORE the entry mutex`).toBeGreaterThan(lock);
    }
    // claim_new_client_waitlist_entries reads its clock INSIDE the
    // candidate-dependent statement instead, which is stronger than a post-lock
    // local: see the dedicated block below.
    expect(body("claim_new_client_waitlist_entries")).toContain("for update skip locked");
  });

  it("issue leaves the INVITATION's own stamps alone, deliberately", () => {
    // §6 boundary, kept: no census path attributes an inversion to issued_at or
    // expires_at, issue() writes the invitation BEFORE the entry so
    // issued_at <= invited_at stays truthful, and moving expires_at would change
    // the window of every future invitation.
    const b = body("issue_new_client_waitlist_invitation");
    expect(b).toMatch(/v_expires := now\(\) \+ make_interval/);
    expect(b).toMatch(/invited_at = v_decision_at/);
    // ...and the 0188 issued_at trigger is NOT replaced here.
    expect(CODE).not.toContain("new_client_waitlist_invitations_server_timestamps");
  });
});

describe("0189 — the lifecycle event log takes the transition's own evidence", () => {
  const trig = () => body("new_client_waitlist_entries_record_event");

  it("passes occurred_at explicitly instead of falling through to the column default", () => {
    const b = trig();
    expect([...b.matchAll(/occurred_at/g)].length).toBeGreaterThanOrEqual(2); // both arms
    expect(b).toMatch(/coalesce\(new\.joined_at, clock_timestamp\(\)\)/);
  });

  it("maps every status to its own canonical evidence column", () => {
    const b = trig();
    for (const [status, col] of [
      ["claimed", "claimed_at"],
      ["invited", "invited_at"],
      ["converted", "converted_at"],
      ["expired", "expired_at"],
      ["released", "released_at"],
      ["removed", "removed_at"],
    ] as const) {
      expect(b, `${status} does not map to ${col}`).toMatch(
        new RegExp(`when '${status}'\\s*then new\\.${col}`),
      );
    }
    // `waiting` deliberately has none: requeue clears the cycle evidence.
    expect(b).toMatch(/else null/);
    expect(b).toMatch(/coalesce\(v_at, clock_timestamp\(\)\)/);
  });

  it("takes no time from the caller: no GUC, no setting, no argument", () => {
    const b = trig();
    expect(b).not.toMatch(/current_setting|set_config|pg_catalog\.set_config/);
    expect(b).not.toMatch(/\bnow\(\)/);
  });

  it("NON-VACUITY: dropping the explicit occurred_at restores the default", () => {
    const real = trig();
    const poisoned = real.replace(/,\s*occurred_at\)/g, ")");
    expect(poisoned, "the mutation did not apply — this control is vacuous").not.toEqual(real);
    expect(poisoned).not.toMatch(/,\s*occurred_at\)/);
    // The real body still names the column in both insert lists.
    expect([...real.matchAll(/,\s*occurred_at\)/g)].length).toBe(2);
  });
});


// ---------------------------------------------------------------------------
// BULK CLAIM — the clock is read INSIDE the candidate-dependent statement.
//
// A standalone `v_decision_at := clock_timestamp();` is its own PL/pgSQL
// statement; under READ COMMITTED the statement AFTER it takes a fresh
// snapshot, so a requeue committing in that gap is visible to the candidate
// scan while the stamp is not. FOR UPDATE SKIP LOCKED governs contention and
// does not close it. Measured on the old shape: claimed_at 113 ms before the
// `waiting` event of the requeue that created the row it claimed.
// ---------------------------------------------------------------------------
describe("0189 — bulk claim derives its instant from the candidates", () => {
  const b = () => body("claim_new_client_waitlist_entries");

  it("takes NO standalone clock assignment", () => {
    expect(
      b(),
      "the clock is captured as its own statement again — the snapshot gap is back",
    ).not.toMatch(/v_decision_at\s*:=\s*clock_timestamp\(\)/);
    expect(b(), "an unused decision local was left behind").not.toMatch(/v_decision_at/);
  });

  it("reads the clock FROM the candidates CTE, so it cannot precede the locks", () => {
    const src = b();
    expect(src).toMatch(/decision as materialized \(\s*\n\s*select clock_timestamp\(\) as decision_at\s*\n\s*from candidates/);
    const candidates = src.indexOf("candidates as materialized");
    const decision = src.indexOf("decision as materialized");
    const clock = src.indexOf("clock_timestamp()");
    expect(candidates).toBeGreaterThan(-1);
    expect(decision).toBeGreaterThan(candidates);
    expect(clock).toBeGreaterThan(candidates);
    // the locks are acquired in the CTE the clock reads from
    expect(src.slice(candidates, decision)).toContain("for update skip locked");
  });

  it("MATERIALIZED on BOTH CTEs, so the planner cannot hoist the clock", () => {
    // Without it the planner may inline `decision` and evaluate clock_timestamp()
    // while the candidate scan is still running — the same defect, new shape.
    const src = b();
    expect(src).toMatch(/with candidates as materialized/);
    expect(src).toMatch(/decision as materialized/);
    expect([...src.matchAll(/as materialized/g)].length).toBe(2);
  });

  it("every winner is stamped from that ONE decision row", () => {
    const src = b();
    expect(src).toMatch(/claimed_at\s*=\s*d\.decision_at/);
    expect(src).toMatch(/from candidates c\s*\n\s*cross join decision d/);
    expect(src).toMatch(/select clock_timestamp\(\) as decision_at\s*\n\s*from candidates\s*\n\s*limit 1/);
  });

  it("zero candidates stays a zero-row result: decision depends on candidates", () => {
    // `decision` selects FROM `candidates`, so an empty candidate set yields an
    // empty decision and the cross join updates nothing — no exception, and no
    // clock side effect.
    const src = b();
    const dec = src.slice(src.indexOf("decision as materialized"), src.indexOf("claimed as ("));
    expect(dec).toContain("from candidates");
  });

  it("preserves exact-N, queue order, studio isolation and SKIP LOCKED", () => {
    const src = b();
    expect(src).toContain("order by e.joined_at, e.id");
    expect(src).toContain("limit p_count");
    expect(src).toContain("for update skip locked");
    expect(src).toContain("e.studio_id = p_studio_id");
    expect(src).toContain("t.status    = 'waiting'");
    expect(src).toContain("claimed_by_practitioner_id = v_actor");
  });

  it("J — NON-VACUITY: hoisting the clock out of the CTE turns these laws red", () => {
    const real = b();
    const poisoned = real
      .replace(/  decision as materialized \([\s\S]*?\),\n/, "")
      .replace(/\n      cross join decision d/, "")
      .replace(/claimed_at\s*=\s*d\.decision_at/, "claimed_at                 = v_decision_at")
      .replace("begin\n", "begin\n  v_decision_at := clock_timestamp();\n");
    expect(poisoned, "the mutation did not apply — this control is vacuous").not.toEqual(real);
    expect(poisoned).not.toMatch(/decision as materialized/);
    expect(poisoned).toMatch(/claimed_at\s*=\s*v_decision_at/);
    // ...and the real body still satisfies every law above.
    expect(real).toMatch(/decision as materialized/);
    expect(real).not.toMatch(/v_decision_at/);
  });

  it("the known-false SKIP LOCKED rationale is gone from the executable file", () => {
    // The old comment claimed SKIP LOCKED made the standalone capture safe. It
    // is replaced, not softened; the file may only mention it while explaining
    // that it was wrong.
    const raw = SQL.slice(
      SQL.indexOf("create or replace function public.claim_new_client_waitlist_entries"),
    );
    const upToBody = raw.slice(0, raw.indexOf("$$;"));
    expect(upToBody).toMatch(/was WRONG|reasoning was WRONG/);
    expect(upToBody).toMatch(/STATEMENT SNAPSHOT|statement snapshot/i);
  });
});

// ---------------------------------------------------------------------------
// TEMPORAL CLOSURE — DERIVED FROM THE IMPLEMENTING TESTS, NOT DECLARED.
//
// WHAT WAS HERE BEFORE, AND WHY IT WAS WORTHLESS. This section used to hold a
// hand-written table of edges, each carrying a label, and its only assertion
// was that each label was one of the two labels the table allowed:
//
//     expect(["EXECUTED_RACE", "STRUCTURALLY_IMPOSSIBLE"]).toContain(row.proof)
//
// Since the table was a literal in the same file, that could not fail. It
// certified an edge — RELEASE/EXPIRE -> REQUEUE — as structurally impossible
// while `requeue_new_client_waitlist_entry` was not even in the mutex census it
// appealed to, and it would have stayed green if every race test behind it were
// deleted. It proved that we had typed an allowed word.
//
// WHAT REPLACES IT. tests/db/helpers/temporal-edges.ts holds identities and
// REQUIRED EVIDENCE — never a result. This guard reads the implementing test for
// each edge and fails unless the evidence its proof kind demands is present, by
// tokens taken from the manifest itself rather than retyped here. Deleting a
// race test, dropping a lock proof, or removing an edge's registration turns
// this red. EVIDENCE -> CLOSURE, never LABEL -> CLOSURE.
//
// The three proof kinds are not interchangeable, and which one an edge needs was
// MEASURED rather than assumed — see the manifest's note on REQUEUE, which was
// written as an executed race until the database declined to produce one.
// ---------------------------------------------------------------------------
describe("0189 — temporal closure is derived from executable evidence", () => {
  const DB_TEST = "tests/db/waitlist-invitation-wall-clock.db.test.ts";
  const dbPath = path.join(ROOT, DB_TEST);

  it("the implementing test file the manifest points at exists", () => {
    expect(existsSync(dbPath), `${DB_TEST} is missing`).toBe(true);
  });

  const dbSrc = readFileSync(dbPath, "utf8");

  /**
   * WHERE AN EDGE IS CONSIDERED REGISTERED. Only two positions count: the id
   * passed literally to `edgeTitle("…", …)`, or the leading element of a tuple
   * in a parameterised test's data array. An id that merely appears somewhere in
   * the file — `id === "JOIN->CLAIM" ? … : …` inside a shared body, say — is NOT
   * a registration.
   *
   * This distinction is load-bearing, and was found by mutation: deleting the
   * JOIN->CLAIM tuple left an incidental mention behind, and a `includes(id)`
   * check happily certified an edge whose test had just been removed.
   */
  const registrationOf = (id: string): RegExp =>
    new RegExp(`(edgeTitle\\(\\s*"${id}")|(\\[\\s*"${id}"\\s*,)`);

  /** The smallest `describe(...)` block containing `needle`. */
  const enclosingDescribe = (needle: string): string => {
    const at = dbSrc.search(new RegExp(needle));
    if (at < 0) return "";
    const start = dbSrc.lastIndexOf("\ndescribe(", at);
    if (start < 0) return "";
    const open = dbSrc.indexOf("{", dbSrc.indexOf("=>", start));
    let depth = 0;
    for (let i = open; i < dbSrc.length; i += 1) {
      if (dbSrc[i] === "{") depth += 1;
      else if (dbSrc[i] === "}") {
        depth -= 1;
        if (depth === 0) return dbSrc.slice(open, i);
      }
    }
    return "";
  };

  it("every proof helper the manifest requires is actually DEFINED in the test file", () => {
    // A required token that no function defines would be satisfiable by a
    // comment. Each one must be a real function in the implementing file.
    for (const token of [
      ...Object.values(MECHANISM_EVIDENCE),
      ...Object.values(VERDICT_EVIDENCE),
    ]) {
      const fn = token.replace("(", "");
      expect(
        new RegExp(`(async )?function ${fn}\\(`).test(dbSrc),
        `${fn} is required as evidence but is not defined in ${DB_TEST}`,
      ).toBe(true);
    }
  });

  it("every canonical WAIT-03 transition is represented by at least one edge", () => {
    for (const canonical of CANONICAL_EDGES) {
      expect(
        TEMPORAL_EDGES.some((e) => e.canonical === canonical),
        `no edge implements the canonical transition ${canonical}`,
      ).toBe(true);
    }
    // ...and no edge invents a canonical transition of its own.
    for (const e of TEMPORAL_EDGES) {
      expect(CANONICAL_EDGES, `${e.id} names an unknown canonical edge`).toContain(e.canonical);
    }
  });

  it("edge ids are unique, so one test cannot certify two edges by accident", () => {
    const ids = TEMPORAL_EDGES.map((e) => e.id);
    expect(new Set(ids).size, `duplicate edge ids: ${ids.join(", ")}`).toBe(ids.length);
  });

  describe("each edge is certified by its implementing test, or not at all", () => {
    for (const edge of TEMPORAL_EDGES) {
      it(`${edge.id} — ${edge.proof}`, () => {
        // 1. The edge is REGISTERED: its id appears in the implementing file.
        //    Deleting the test, or the loop tuple that generates it, removes
        //    this and the edge loses its proof.
        const marker = registrationOf(edge.id);
        expect(
          marker.test(dbSrc),
          `${edge.id} has no implementing test in ${DB_TEST} — an id mentioned ` +
            `elsewhere in a shared body is not a registration`,
        ).toBe(true);

        const block = enclosingDescribe(marker.source);
        expect(block.length, `${edge.id} is not inside a describe block`).toBeGreaterThan(0);

        // 2. It is registered THROUGH the shared helper, so the manifest and the
        //    test cannot drift into two independent spellings of the same name.
        expect(
          /\bit\(\s*edgeTitle\(/.test(block),
          `${edge.id}'s test does not take its title from edgeTitle()`,
        ).toBe(true);

        // 3. The MECHANISM its proof kind demands is exercised.
        expect(
          block.includes(MECHANISM_EVIDENCE[edge.proof]),
          `${edge.id} claims ${edge.proof} but its test never calls ${MECHANISM_EVIDENCE[edge.proof]})`,
        ).toBe(true);

        // 4. Every VERDICT it claims is asserted.
        for (const verdict of edge.verdicts) {
          expect(
            block.includes(VERDICT_EVIDENCE[verdict]),
            `${edge.id} claims a ${verdict} verdict but its test never calls ${VERDICT_EVIDENCE[verdict]})`,
          ).toBe(true);
        }

        // 5. An executed race must RELEASE the predecessor inside the test —
        //    otherwise "the successor was blocked" is the whole story and the
        //    ordering after the release was never observed.
        if (edge.proof === "EXECUTED_BLOCKING_RACE") {
          expect(
            PREDECESSOR_RELEASE.some((t) => block.includes(t)),
            `${edge.id} parks its successor but never releases the predecessor`,
          ).toBe(true);
        }
      });
    }
  });

  it("no edge is certified by a label alone", () => {
    // The failure mode this whole section replaced: a row whose proof kind names
    // a mechanism no test performs. Asserted directly, over every row.
    const uncertified = TEMPORAL_EDGES.filter((e) => {
      if (!registrationOf(e.id).test(dbSrc)) return true;
      const block = enclosingDescribe(registrationOf(e.id).source);
      return !block || !block.includes(MECHANISM_EVIDENCE[e.proof]);
    });
    expect(
      uncertified.map((e) => e.id),
      "these edges carry a proof kind that no implementing test performs",
    ).toEqual([]);
  });

  it("REDEEM -> CONVERT is an executed race specifically", () => {
    // It is the one edge whose predecessor does not share the successor's entry
    // mutex — REDEEM takes only the invitation lock — so no visibility or
    // predicate argument is available to it. If this edge is ever reclassified,
    // the reclassification is the thing to review.
    const e = TEMPORAL_EDGES.find((x) => x.id === "REDEEM->CONVERT")!;
    expect(e.proof).toBe("EXECUTED_BLOCKING_RACE");
  });
});
