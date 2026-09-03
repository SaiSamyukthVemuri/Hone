import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
  migrationState,
} from "./helpers/migration-state";

// 0190 — WAIT-03: the requested TTL must start when the invitation is ISSUED.
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half — that an aged transaction and a transaction parked on the
// entry mutex both receive their full window, measured in PostgreSQL — lives in
// tests/db/waitlist-invitation-ttl-anchor.db.test.ts. Neither is sufficient
// alone: SQL text cannot prove a lock wait, and a behavioural test cannot prove
// a grant line was WRITTEN rather than inherited from Supabase's create-time
// defaults.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * edit 0188 or 0189 instead of adding 0190 -> the frozen-hash assertions
//     fail, and an APPLIED migration has been rewritten;
//   * put `now()` back into the window arithmetic -> the anchor assertions
//     fail, which is the whole defect;
//   * leave the BEFORE INSERT trigger clobbering issued_at -> the trigger
//     assertions fail, and repairing the command alone achieves nothing;
//   * read the clock a second time on the issue path -> the single-authority
//     assertion fails, which is how issued_at and invited_at drift apart;
//   * take the canonical instant BEFORE the entry mutex -> the ordering
//     assertion fails;
//   * change a signature, result word, SECURITY DEFINER posture or search_path
//     -> the preservation assertions fail;
//   * revoke by name and forget a role -> the privilege assertions fail, which
//     is the 0129 / 0164 failure class.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0190";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by PROSE. This migration's header
// quotes the very construct it forbids (`now() + make_interval(...)`), so every
// "does not contain" assertion runs against comment-stripped SQL.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

/**
 * The migration's own statements: comment-stripped SQL with every
 * `create or replace function ... $$;` block removed. A function body contains
 * ordinary DML that is the command's RUNTIME behaviour, not schema change made
 * by this file, so the "touches nothing else" assertions must not see it.
 */
const OUTSIDE_FUNCTIONS = CODE.replace(
  /create or replace function[\s\S]*?\$\$;/g,
  "",
);

/** The executable body of one function, comment-stripped. */
function body(fn: string): string {
  const at = CODE.indexOf(`create or replace function public.${fn}`);
  expect(at, `${fn} is not defined in ${FILE}`).toBeGreaterThan(-1);
  const end = CODE.indexOf("$$;", at);
  expect(end, `${fn} has no terminator`).toBeGreaterThan(at);
  return CODE.slice(at, end);
}

const ISSUE = "issue_new_client_waitlist_invitation";
const STAMPS = "new_client_waitlist_invitations_server_timestamps";

describe("0190 — identity and position", () => {
  it("is named for what it repairs", () => {
    expect(FILE).toBe("0190_waitlist_invitation_ttl_anchor.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so that a future
    // migration does not turn this file red. Whoever adds 0191 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is AUTHORED ABOVE the hosted head and is the only pending file", () => {
    // MIGRATION-FIRST. 0190 is reviewed but NOT applied; production is still
    // running 0189. Parity returns only when an AUTHORIZED apply advances
    // hosted state, and this assertion is what will turn red if someone records
    // that apply without actually performing it.
    const state = migrationState();
    expect(state.repo_migration_max).toBe(VERSION);
    expect(state.hosted_migration_max).toBe("0189");
    expect(state.pending_migrations).toEqual([VERSION]);
  });
});

describe("0190 — 0188 AND 0189 ARE FROZEN AND ARE NOT EDITED", () => {
  it("0188 still hashes to the bytes production applied", async () => {
    const { createHash } = await import("node:crypto");
    const applied = readFileSync(
      path.join(ROOT, "supabase/migrations", fileForVersion("0188")),
      "utf8",
    );
    expect(createHash("sha256").update(applied, "utf8").digest("hex")).toBe(
      "2bf43f0d49280d0095f627f4a3a2e6e169b5111c0d988496244003db377b7bf0",
    );
  });

  it("0189 still hashes to the bytes production applied", async () => {
    // THE ABSOLUTE RULE OF THIS REPAIR. 0189 is applied and frozen; a
    // correction is a NEW migration. The finding that produced 0190 was raised
    // AGAINST 0189, which is exactly the situation in which someone reaches for
    // the original file.
    const { createHash } = await import("node:crypto");
    const applied = readFileSync(
      path.join(ROOT, "supabase/migrations", fileForVersion("0189")),
      "utf8",
    );
    expect(createHash("sha256").update(applied, "utf8").digest("hex")).toBe(
      "3abb5ff14778958114057cd358bd59d5b9a91cc50b5fa33ee837ff5fc9d8c46e",
    );
  });
});

describe("0190 — transactional envelope", () => {
  it("opens its own transaction and sets a lock timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    const commit = CODE.indexOf("commit;");
    expect(begin, "no begin;").toBeGreaterThan(-1);
    expect(lock, "no lock_timeout").toBeGreaterThan(begin);
    expect(commit, "no commit;").toBeGreaterThan(lock);
  });
});

describe("0190 — the window is anchored to the post-lock issuance instant", () => {
  it("computes expires_at from the canonical instant, never from now()", () => {
    const b = body(ISSUE);
    expect(b).toContain("v_expires := v_decision_at + make_interval(hours => v_ttl)");
    // The defect, spelled exactly as 0189 had it.
    expect(b).not.toContain("v_expires := now()");
  });

  it("reads NO transaction-bound clock anywhere on the issue path", () => {
    // `now()` and `transaction_timestamp()` are the same value, and either one
    // reintroduces the defect.
    const b = body(ISSUE);
    expect(b).not.toMatch(/\bnow\s*\(\s*\)/);
    expect(b).not.toMatch(/\btransaction_timestamp\s*\(\s*\)/);
  });

  it("reads the clock EXACTLY ONCE, so the three stamps cannot drift apart", () => {
    // Two reads microseconds apart would put issued_at, expires_at and
    // invited_at out of step — the defect class 0189 removed one layer up.
    const b = body(ISSUE);
    expect((b.match(/clock_timestamp\s*\(\s*\)/g) ?? []).length).toBe(1);
  });

  it("takes that single instant AFTER the entry mutex", () => {
    const b = body(ISSUE);
    const lock = b.indexOf("for update");
    const clock = b.indexOf("v_decision_at := clock_timestamp()");
    expect(lock, "the entry mutex is gone").toBeGreaterThan(-1);
    expect(clock, "the canonical instant is gone").toBeGreaterThan(lock);
  });

  it("stamps issued_at, expires_at and invited_at from that one value", () => {
    const b = body(ISSUE);
    // issued_at is now supplied explicitly rather than left to the trigger.
    expect(b).toMatch(/insert into public\.new_client_waitlist_invitations[\s\S]*issued_at/);
    expect(b).toContain("v_hash, v_decision_at, v_expires, v_actor");
    expect(b).toContain("invited_at = v_decision_at");
  });
});

describe("0190 — the timestamp trigger stops discarding that instant", () => {
  it("no longer overwrites issued_at unconditionally", () => {
    const b = body(STAMPS);
    // The whole pre-0190 body. Leaving it makes the command repair inert.
    expect(b).not.toMatch(/^\s*new\.issued_at := now\(\);\s*$/m);
    expect(b).not.toMatch(/\bnow\s*\(\s*\)/);
  });

  it("still refuses an instant the transaction has not reached", () => {
    // The guard the trigger existed for — "issue time is the server's, never
    // the caller's" — is preserved as a validation rather than a clobber.
    const b = body(STAMPS);
    expect(b).toContain("new.issued_at is null or new.issued_at > clock_timestamp()");
    expect(b).toContain("new.issued_at := clock_timestamp()");
  });
});

describe("0190 — the deployed contract is preserved", () => {
  it("keeps the issue signature, result type and definer posture", () => {
    expect(CODE).toContain(
      "create or replace function public.issue_new_client_waitlist_invitation(",
    );
    expect(CODE).toContain("p_ttl_hours     integer default 72");
    expect(CODE).toContain(
      "returns table (result text, raw_token text, expires_at timestamptz)",
    );
    const b = body(ISSUE);
    expect(b).toContain("security definer");
    expect(b).toContain("set search_path = pg_catalog, pg_temp");
  });

  it("keeps every refusal word the command already spoke", () => {
    const b = body(ISSUE);
    for (const word of [
      "invalid_input",
      "invalid_ttl",
      "not_found",
      "not_claimed",
      "already_invited",
      "invited",
    ]) {
      expect(b, `the ${word} result word was dropped`).toContain(`'${word}'`);
    }
  });

  it("keeps the TTL range refusal, and never silently clamps", () => {
    const b = body(ISSUE);
    expect(b).toContain("if v_ttl < 1 or v_ttl > 168 then");
    expect(b).not.toMatch(/least\s*\(|greatest\s*\(/);
  });

  it("keeps token hashing unchanged", () => {
    const b = body(ISSUE);
    expect(b).toContain("encode(extensions.gen_random_bytes(32), 'hex')");
    expect(b).toContain("encode(extensions.digest(v_raw, 'sha256'), 'hex')");
  });

  it("keeps the one-live-per-entry guard in the command", () => {
    const b = body(ISSUE);
    expect(b).toContain("i.redeemed_at is null and i.expired_at is null and i.released_at is null");
  });

  it("changes no table, column, index, constraint, policy or trigger definition", () => {
    // Scoped to the migration's OWN statements. `insert into` and `update ...`
    // appear inside the issue command's body, where they are the runtime
    // behaviour being preserved, not schema change performed by this file.
    for (const forbidden of [
      "alter table",
      "create table",
      "create index",
      "create unique index",
      "drop index",
      "create policy",
      "drop policy",
      "create trigger",
      "drop trigger",
      "insert into",
      "update ",
      "delete from",
      "truncate",
      "alter default privileges",
    ]) {
      expect(
        OUTSIDE_FUNCTIONS.toLowerCase().includes(forbidden),
        `0190 contains "${forbidden}" outside a function body — it is meant to replace two function bodies and nothing else`,
      ).toBe(false);
    }
  });

  it("replaces exactly two function bodies, and no others", () => {
    const defined = [...CODE.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(defined.sort()).toEqual([ISSUE, STAMPS].sort());
  });
});

describe("0190 — privileges are reasserted by name, never assumed", () => {
  // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
  // AND service_role at function-create time. 0129 missed anon and 0164 missed
  // service_role; every role is named explicitly.
  const ISSUE_SIG = "public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer)";
  const STAMPS_SIG = "public.new_client_waitlist_invitations_server_timestamps()";

  it("revokes the issue command from every role, then grants only service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE, `issue is not revoked from ${role}`).toContain(
        `revoke execute on function ${ISSUE_SIG} from ${role};`,
      );
    }
    expect(CODE).toContain(`grant  execute on function ${ISSUE_SIG} to service_role;`);
  });

  it("grants the trigger function to NO application role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE, `the trigger function is not revoked from ${role}`).toContain(
        `revoke execute on function ${STAMPS_SIG} from ${role};`,
      );
    }
    expect(
      CODE.includes(`grant  execute on function ${STAMPS_SIG}`),
      "the trigger function was granted to an application role",
    ).toBe(false);
  });
});
