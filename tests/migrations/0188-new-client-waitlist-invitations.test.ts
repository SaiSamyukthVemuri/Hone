import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
  migrationState,
} from "./helpers/migration-state";

// 0188 — private waitlist invitation lifecycle (WAIT-03).
//
// THIS FILE IS THE SOURCE CONTRACT. It proves what the migration SAYS. The
// behavioural half — that the exact-N claim really partitions under
// concurrency, that a token really redeems once, and that a released token is
// really dead — must run against a migrated database. Neither is sufficient
// alone: SQL text cannot prove a race, and a behavioural test cannot prove a
// grant line was WRITTEN rather than inherited from Supabase's create-time
// defaults.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * add a raw/plaintext token column -> the token-at-rest assertions fail,
//     and the 0090/0091 doctrine has been silently reversed;
//   * widen the TTL ceiling past 7 days -> the ttl assertion fails, and a
//     product ruling has been changed by editing SQL;
//   * add a claimed/invited -> removed edge -> the removal-ruling assertion
//     fails, and a prospect could be removed while holding a live token;
//   * widen the duplicate index WITHOUT replacing join_new_client_waitlist ->
//     the coupling assertion fails, which is the defect that would tell a real
//     visitor their join failed;
//   * revoke by name instead of REVOKE ALL, or forget a role -> the privilege
//     assertions fail, which is the 0129 / 0164 / 0183 failure class.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0188";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");

// Negative assertions must never be satisfied by PROSE. This migration's
// header discusses at length what it must not do and names the very things it
// forbids, so every "does not contain" assertion runs against comment-stripped
// SQL rather than the raw file.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("0188 — identity and position", () => {
  it("is named for what it creates", () => {
    expect(FILE).toBe("0188_new_client_waitlist_invitations.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so that a future
    // migration does not turn this file red. Whoever adds 0189 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is AUTHORED AND TESTED, NOT APPLIED to production", () => {
    // The honest posture for a local candidate. Hosted state advances ONLY in
    // the change that records an authorized production apply, so this asserts
    // the gap rather than hiding it. When 0188 is applied, this block is the
    // one that moves — deliberately, by a human, in that change.
    const state = migrationState();
    expect(state.repo_migration_max).toBe(VERSION);
    expect(Number(state.repo_migration_max)).toBeGreaterThan(
      Number(state.hosted_migration_max),
    );
  });
});

describe("0188 — transactional envelope", () => {
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

  it("performs NO top-level DML — every write lives inside a function body", () => {
    // The apply must not touch business rows. Statements that begin a line at
    // column 0 are the file's executable top level; the INSERT/UPDATE inside a
    // command body is indented and runs at RPC call time, never during apply.
    expect(CODE).not.toMatch(/^(insert|update|delete|truncate)\s/mi);
  });
});

describe("0188 — the token is never stored in the clear", () => {
  it("stores a sha256 hex digest and constrains its shape", () => {
    expect(CODE).toMatch(/token_hash\s+text\s+not\s+null/i);
    expect(CODE).toMatch(/\^\[a-f0-9\]\{64\}\$/);
  });

  it("declares NO raw/plaintext token column", () => {
    // 0091 dropped the raw cancellation token from storage entirely. A column
    // named raw_token/plain_token/token here would reverse that doctrine.
    expect(CODE).not.toMatch(/^\s*(raw_token|plain_token|token)\s+text/mi);
  });

  it("derives the digest with SCHEMA-QUALIFIED pgcrypto", () => {
    // SECURITY DEFINER pins search_path to pg_catalog, pg_temp, so an
    // unqualified digest() would not resolve at run time.
    expect(CODE).toMatch(/extensions\.digest\(/);
    expect(CODE).toMatch(/extensions\.gen_random_bytes\(\s*32\s*\)/);
    // ...and never unqualified.
    expect(CODE).not.toMatch(/[^.\w]digest\s*\(/);
    expect(CODE).not.toMatch(/[^.\w]gen_random_bytes\s*\(/);
  });
});

describe("0188 — the TTL ruling is enforced by the database", () => {
  it("bounds expires_at at SEVEN DAYS and requires it to follow issued_at", () => {
    expect(CODE).toMatch(
      /expires_at\s*>\s*issued_at\s+and\s+expires_at\s*<=\s*issued_at\s*\+\s*interval\s*'7 days'/i,
    );
  });

  it("defaults to 72 hours and REFUSES out-of-range rather than clamping", () => {
    expect(CODE).toMatch(/p_ttl_hours\s+integer\s+default\s+72/i);
    expect(CODE).toMatch(/invalid_ttl/);
    // 168 hours is the same 7 days, stated where the caller can see it.
    expect(CODE).toMatch(/v_ttl\s*<\s*1\s+or\s+v_ttl\s*>\s*168/i);
  });

  it("makes renewal unrepresentable — expires_at is immutable after insert", () => {
    expect(CODE).toMatch(/new\.expires_at\s+is\s+distinct\s+from\s+old\.expires_at/i);
  });
});

describe("0188 — the removal ruling is structural", () => {
  it("declares NO claimed/invited -> removed edge in the transition matrix", () => {
    const matrix = CODE.slice(
      CODE.indexOf("v_legal := "),
      CODE.indexOf("if not v_legal"),
    );
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix).not.toMatch(/\(\s*'claimed'\s*,\s*'removed'\s*\)/);
    expect(matrix).not.toMatch(/\(\s*'invited'\s*,\s*'removed'\s*\)/);
    // The legal route out of an active state exists, and passes through
    // release or expiry.
    expect(matrix).toMatch(/\(\s*'claimed'\s*,\s*'released'\s*\)/);
    expect(matrix).toMatch(/\(\s*'invited'\s*,\s*'released'\s*\)/);
    expect(matrix).toMatch(/\(\s*'invited'\s*,\s*'expired'\s*\)/);
    expect(matrix).toMatch(/\(\s*'released'\s*,\s*'removed'\s*\)/);
  });

  it("the remove command answers release_required instead of failing opaquely", () => {
    expect(CODE).toMatch(/release_required/);
  });

  it("release and expire invalidate the live invitation in the same statement", () => {
    // Without this, an entry could leave `invited` while a usable token
    // survived — the whole point of routing removal through release.
    expect(CODE).toMatch(/set\s+released_at\s*=\s*now\(\)/i);
    expect(CODE).toMatch(/set\s+expired_at\s*=\s*now\(\)/i);
  });
});

describe("0188 — concurrency primitives are single statements", () => {
  it("claims exactly N with FOR UPDATE SKIP LOCKED", () => {
    expect(CODE).toMatch(/for\s+update\s+skip\s+locked/i);
    expect(CODE).toMatch(/limit\s+p_count/i);
    expect(CODE).toMatch(/order\s+by\s+e\.joined_at,\s*e\.id/i);
  });

  it("redeems by guarded UPDATE, with the TTL evaluated in the same statement", () => {
    const redeem = CODE.slice(
      CODE.indexOf("function public.redeem_new_client_waitlist_invitation"),
    );
    expect(redeem).toMatch(/redeemed_at\s+is\s+null/i);
    expect(redeem).toMatch(/expired_at\s+is\s+null/i);
    expect(redeem).toMatch(/released_at\s+is\s+null/i);
    expect(redeem).toMatch(/expires_at\s*>\s*now\(\)/i);
  });

  it("refuses every invalid token with ONE indistinguishable code", () => {
    const redeem = CODE.slice(
      CODE.indexOf("function public.redeem_new_client_waitlist_invitation"),
      CODE.indexOf("function public.expire_new_client_waitlist_invitation"),
    );
    const codes = [...redeem.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    // Exactly two outcomes are reachable: redeemed, or invalid_token.
    expect(new Set(codes)).toEqual(new Set(["invalid_token", "redeemed"]));
  });

  it("permits at most one LIVE invitation per entry", () => {
    expect(CODE).toMatch(
      /create\s+unique\s+index[\s\S]{0,160}new_client_waitlist_invitations_one_live_per_entry/i,
    );
  });
});

describe("0188 — the duplicate law and its coupled command", () => {
  it("widens the active-entry index to every active state", () => {
    expect(CODE).toMatch(/drop\s+index\s+if\s+exists\s+public\.new_client_waitlist_entries_one_waiting_per_email/i);
    expect(CODE).toMatch(
      /new_client_waitlist_entries_one_active_per_email[\s\S]{0,200}where\s+status\s+in\s*\(\s*'waiting'\s*,\s*'claimed'\s*,\s*'invited'\s*\)/i,
    );
  });

  it("REPLACES join_new_client_waitlist in the same migration — arbiter AND read-back", () => {
    // THE COUPLING. Widening the index while leaving the command's read-back
    // filtering on `status = 'waiting'` makes a re-submission by an already
    // claimed prospect fall through to 'unknown' — telling a real visitor the
    // join failed. Index and command may never move apart.
    expect(CODE).toMatch(/create\s+or\s+replace\s+function\s+public\.join_new_client_waitlist/i);
    expect(CODE).toMatch(
      /on\s+conflict\s*\(\s*studio_id\s*,\s*email_normalized\s*\)\s*where\s+status\s+in\s*\(\s*'waiting'\s*,\s*'claimed'\s*,\s*'invited'\s*\)/i,
    );
    // Scoped to the join body: `e.status = 'waiting'` is legitimate elsewhere
    // (the exact-N claim scans for waiting candidates by design), so a
    // file-wide negative would fail for the wrong reason.
    const join = CODE.slice(
      CODE.indexOf("function public.join_new_client_waitlist"),
      CODE.indexOf("function public.claim_new_client_waitlist_entries"),
    );
    expect(join.length).toBeGreaterThan(0);
    expect(join).toMatch(
      /e\.status\s+in\s*\(\s*'waiting'\s*,\s*'claimed'\s*,\s*'invited'\s*\)/i,
    );
    // The narrow read-back must be gone FROM THE JOIN COMMAND.
    expect(join).not.toMatch(/e\.status\s*=\s*'waiting'/i);
  });
});

describe("0188 — privilege discipline", () => {
  const COMMANDS = [
    "public.join_new_client_waitlist(uuid, text, text, text)",
    "public.remove_new_client_waitlist_entry(uuid, uuid, uuid)",
    "public.claim_new_client_waitlist_entries(uuid, uuid, integer)",
    "public.claim_new_client_waitlist_entry(uuid, uuid, uuid)",
    "public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer)",
    "public.redeem_new_client_waitlist_invitation(text)",
    "public.expire_new_client_waitlist_invitation(uuid, uuid, uuid)",
    "public.release_new_client_waitlist_entry(uuid, uuid, uuid)",
    "public.requeue_new_client_waitlist_entry(uuid, uuid, uuid)",
    "public.record_new_client_waitlist_conversion(uuid, uuid, uuid)",
  ];

  it.each(COMMANDS)("revokes %s from all four grantees, then grants service_role only", (sig) => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
    // authenticated AND service_role at create time, and PostgreSQL grants to
    // PUBLIC. Missing any one of the four is the 0129 / 0164 failure.
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(
        CODE.includes(`revoke execute on function ${sig} from ${role};`),
        `${sig} must be revoked from ${role}`,
      ).toBe(true);
    }
    expect(CODE).toContain(`grant  execute on function ${sig} to service_role;`);
    expect(CODE).not.toMatch(
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${sig.replace(/[.()*+?^${}|[\]\\]/g, "\\$&")}\\s+to\\s+(anon|authenticated|public)\\b`, "i"),
    );
  });

  it("REVOKES ALL on the table before granting anything back", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke all on public.new_client_waitlist_invitations from ${role};`,
      );
    }
    expect(CODE).toContain(
      "grant select on public.new_client_waitlist_invitations to authenticated;",
    );
  });

  it("grants the internal helper and trigger functions to NOBODY", () => {
    for (const fn of [
      "public.new_client_waitlist_resolve_owner(uuid, uuid)",
      "public.new_client_waitlist_entries_transition_guard()",
      "public.new_client_waitlist_invitations_server_timestamps()",
      "public.new_client_waitlist_invitations_append_only()",
      "public.new_client_waitlist_invitations_no_delete()",
    ]) {
      expect(CODE).toContain(`revoke all privileges on function ${fn}`);
    }
  });

  it("every command is SECURITY DEFINER with a pinned search_path", () => {
    const definers = [...CODE.matchAll(/security\s+definer/gi)].length;
    const paths = [...CODE.matchAll(/set\s+search_path\s*=\s*pg_catalog,\s*pg_temp/gi)].length;
    expect(definers).toBeGreaterThanOrEqual(11);
    expect(paths).toBeGreaterThanOrEqual(definers);
  });
});

describe("0188 — RLS", () => {
  it("enables RLS and declares exactly ONE, owner-only SELECT policy", () => {
    expect(CODE).toMatch(
      /alter\s+table\s+public\.new_client_waitlist_invitations\s+enable\s+row\s+level\s+security/i,
    );
    const policies = [...CODE.matchAll(/create\s+policy\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(policies).toEqual(["new_client_waitlist_invitations_owner_select"]);
    expect(CODE).toMatch(/for\s+select\s+to\s+authenticated/i);
    // Fully qualified — 0126 resolved a bare column against the wrong relation
    // and the check silently degraded to a tautology.
    expect(CODE).toMatch(
      /is_studio_owner\(new_client_waitlist_invitations\.studio_id\)/i,
    );
  });
});

describe("0188 — tenancy is structural", () => {
  it("ties invitations to their entry and issuer by COMPOSITE studio-scoped FK", () => {
    expect(CODE).toMatch(
      /foreign\s+key\s*\(\s*entry_id\s*,\s*studio_id\s*\)[\s\S]{0,120}references\s+public\.new_client_waitlist_entries\s*\(\s*id\s*,\s*studio_id\s*\)/i,
    );
    expect(CODE).toMatch(
      /foreign\s+key\s*\(\s*issued_by_practitioner_id\s*,\s*studio_id\s*\)[\s\S]{0,120}references\s+public\.practitioners\s*\(\s*id\s*,\s*studio_id\s*\)/i,
    );
    expect(CODE).toMatch(
      /foreign\s+key\s*\(\s*converted_client_id\s*,\s*studio_id\s*\)[\s\S]{0,120}references\s+public\.clients\s*\(\s*id\s*,\s*studio_id\s*\)/i,
    );
  });

  it("creates no appointment, client, intake or session anywhere", () => {
    // An invitation is an OPPORTUNITY. Booking remains the canonical public
    // appointment authority's job.
    expect(CODE).not.toMatch(/insert\s+into\s+public\.appointments/i);
    expect(CODE).not.toMatch(/insert\s+into\s+public\.clients/i);
    expect(CODE).not.toMatch(/insert\s+into\s+public\.sessions/i);
    expect(CODE).not.toMatch(/insert\s+into\s+public\.client_intake_forms/i);
  });

  it("adds no automatic release, sweep or scheduler", () => {
    expect(CODE).not.toMatch(/pg_cron|cron\.schedule|pg_net|net\.http/i);
  });
});
