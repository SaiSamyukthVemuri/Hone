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
    // COLUMN privileges, not a whole-table grant: token_hash is the verifier
    // for a live credential and RLS scopes rows, never columns. The safe set is
    // a POSITIVE list, so a column added later is unreadable until someone
    // grants it here deliberately.
    expect(CODE).not.toMatch(
      /grant\s+select\s+on\s+public\.new_client_waitlist_invitations\s+to\s+authenticated/i,
    );
    expect(CODE).toMatch(
      /grant\s+select\s*\([\s\S]{0,400}?\)\s*on\s+public\.new_client_waitlist_invitations\s+to\s+authenticated\s*;/i,
    );
    const grant = CODE.match(
      /grant\s+select\s*\(([\s\S]{0,400}?)\)\s*on\s+public\.new_client_waitlist_invitations\s+to\s+authenticated\s*;/i,
    );
    const columns = (grant?.[1] ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    expect(columns.sort()).toEqual([
      "entry_id","expired_at","expires_at","id","issued_at",
      "issued_by_practitioner_id","redeemed_at","released_at","studio_id",
    ]);
    expect(columns, "the credential verifier is never granted").not.toContain("token_hash");
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
    // Both new tables carry exactly one owner-only SELECT policy and no more.
    // Pinned as an exhaustive list so an added INSERT/UPDATE/DELETE policy on
    // either table fails here rather than shipping.
    const policies = [...CODE.matchAll(/create\s+policy\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(policies).toEqual([
      "new_client_waitlist_invitations_owner_select",
      "new_client_waitlist_entry_events_owner_select",
    ]);
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

describe("0188 — provenance survives a cycle that issues no invitation", () => {
  it("records EVERY status change to an append-only event log, by trigger", () => {
    // THE DEFECT THIS EXISTS FOR: requeue clears the cycle evidence, and the
    // path claimed -> released -> waiting issues no invitation, so before the
    // event log an operator's claim and release left ZERO persisted state.
    expect(CODE).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.new_client_waitlist_entry_events/i,
    );
    expect(CODE).toMatch(
      /after\s+insert\s+or\s+update\s+on\s+public\.new_client_waitlist_entries[\s\S]{0,140}new_client_waitlist_entries_record_event/i,
    );
    // The append happens on ANY status change, not on a named subset.
    expect(CODE).toMatch(/new\.status\s+is\s+distinct\s+from\s+old\.status/i);
    // The requeued claimer is preserved from OLD before it is discarded.
    // SCOPED to the recording function: `old.claimed_by_practitioner_id` also
    // appears in the transition guard, so a file-wide match passes vacuously
    // even when the actor fallback has been deleted.
    const rec = CODE.slice(
      CODE.indexOf("function public.new_client_waitlist_entries_record_event"),
      CODE.indexOf("function public.new_client_waitlist_entry_events_append_only"),
    );
    expect(rec.length).toBeGreaterThan(0);
    expect(rec).toMatch(/coalesce\([\s\S]{0,200}old\.claimed_by_practitioner_id/);
  });

  it("makes the event log append-only against UPDATE and DELETE alike", () => {
    expect(CODE).toMatch(
      /before\s+update\s+or\s+delete\s+on\s+public\.new_client_waitlist_entry_events/i,
    );
  });

  it("scopes events by studio, with composite FKs to entry and actor", () => {
    const block = CODE.slice(
      CODE.indexOf("create table if not exists public.new_client_waitlist_entry_events"),
      CODE.indexOf("create index if not exists new_client_waitlist_entry_events_entry_idx"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(
      /foreign\s+key\s*\(\s*entry_id\s*,\s*studio_id\s*\)[\s\S]{0,140}references\s+public\.new_client_waitlist_entries\s*\(\s*id\s*,\s*studio_id\s*\)/i,
    );
    expect(block).toMatch(
      /foreign\s+key\s*\(\s*actor_practitioner_id\s*,\s*studio_id\s*\)[\s\S]{0,140}references\s+public\.practitioners\s*\(\s*id\s*,\s*studio_id\s*\)/i,
    );
  });

  it("gives the event log the same read-only, owner-only posture as the rest", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke all on public.new_client_waitlist_entry_events from ${role};`,
      );
    }
    expect(CODE).toContain(
      "grant select on public.new_client_waitlist_entry_events to authenticated;",
    );
    expect(CODE).toMatch(
      /is_studio_owner\(new_client_waitlist_entry_events\.studio_id\)/i,
    );
    for (const fn of [
      "public.new_client_waitlist_entries_record_event()",
      "public.new_client_waitlist_entry_events_append_only()",
    ]) {
      expect(CODE).toContain(`revoke all privileges on function ${fn}`);
    }
  });

  it("no longer claims the invitation rows carry the whole history", () => {
    // The prose that was corrected. A contract stated over a narrower set than
    // the sentence describes is the 0183 failure shape, and this file is where
    // that regression would reappear.
    expect(SQL).not.toMatch(
      /durable history of what happened to them is not lost: it lives in the\s*--\s*append-only invitation rows/i,
    );
    expect(SQL).toMatch(/new_client_waitlist_entry_events by trigger/i);
  });
});

describe("0188 — the invitations composite key is FK-referenceable", () => {
  it("adds unique (id, studio_id) on the invitations table", () => {
    expect(CODE).toMatch(
      /add\s+constraint\s+new_client_waitlist_invitations_id_studio_id_unique\s+unique\s*\(\s*id\s*,\s*studio_id\s*\)/i,
    );
  });

  it("adds it CONDITIONALLY, never drop-then-add", () => {
    // A `drop constraint if exists` here fails the moment a child FK depends on
    // it -- the exact idempotency trap this migration was already caught on for
    // the entries table.
    expect(CODE).not.toMatch(
      /drop\s+constraint\s+if\s+exists\s+new_client_waitlist_invitations_id_studio_id_unique/i,
    );
    // guard -> name check -> add, in that order, in one DO block.
    expect(CODE).toMatch(
      /if\s+not\s+exists[\s\S]{0,300}pg_constraint[\s\S]{0,300}new_client_waitlist_invitations_id_studio_id_unique[\s\S]{0,300}add\s+constraint\s+new_client_waitlist_invitations_id_studio_id_unique/i,
    );
  });

  it("is UNCONDITIONAL — never a partial/predicated uniqueness", () => {
    // PostgreSQL cannot use a predicated index as a foreign-key target, and a
    // predicate would make referenceability depend on lifecycle state: a
    // redeemed, expired or released invitation would silently stop being
    // referenceable while rows referencing it still existed.
    // Both anchors are CODE, not comments: `CODE` strips comments, so a
    // comment anchor returns -1 and the slice silently runs to end of file.
    const start = CODE.indexOf(
      "add constraint new_client_waitlist_invitations_id_studio_id_unique",
    );
    const end = CODE.indexOf(
      "create unique index if not exists new_client_waitlist_invitations_token_hash_uniq",
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(CODE.slice(start, end)).not.toMatch(/\bwhere\b/i);
  });

  it("is documented as FK-referenceability, NOT as a duplicate rule", () => {
    // It rejects nothing `primary key (id)` does not already reject. Recording
    // that in the file stops a later reader "strengthening" it into a partial
    // key, or trusting it as a duplicate control it was never able to be.
    expect(SQL).toMatch(/NOT A DUPLICATE RULE/i);
    expect(SQL).toMatch(/UNCONDITIONAL, NEVER PARTIAL/i);
  });
});

describe("0188 — requeue is the only command that re-enters the active index", () => {
  it("translates the duplicate-key refusal into a closed result code", () => {
    // Reachable WITHOUT concurrency: release an entry, let the same person
    // rejoin through the public form, then requeue the old entry. The index
    // correctly refuses the second active row -- but 0185 forbade these
    // commands to raise, because an exception is indistinguishable from
    // "the write may have committed".
    const fn = CODE.slice(
      CODE.indexOf("function public.requeue_new_client_waitlist_entry"),
      CODE.indexOf("function public.record_new_client_waitlist_conversion"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/exception\s+when\s+unique_violation\s+then/i);
    expect(fn).toMatch(/return\s+'already_active'/);
  });

  it("HANDLES the violation rather than pre-checking for it", () => {
    // A `select ... where status in (active)` before the update reintroduces
    // the read-then-write window this migration removes everywhere else: the
    // conflicting row can commit between the check and the write. Catching the
    // violation is the only form with no window.
    const fn = CODE.slice(
      CODE.indexOf("function public.requeue_new_client_waitlist_entry"),
      CODE.indexOf("function public.record_new_client_waitlist_conversion"),
    );
    // No SELECT against the entries table inside requeue at all.
    expect(fn).not.toMatch(/select[\s\S]{0,120}from\s+public\.new_client_waitlist_entries/i);
  });

  it("still clears the cycle evidence it is required to clear", () => {
    const fn = CODE.slice(
      CODE.indexOf("function public.requeue_new_client_waitlist_entry"),
      CODE.indexOf("function public.record_new_client_waitlist_conversion"),
    );
    for (const col of [
      "claimed_at",
      "claimed_by_practitioner_id",
      "invited_at",
      "expired_at",
      "released_at",
    ]) {
      expect(fn).toMatch(new RegExp(`${col}\\s*=\\s*null`, "i"));
    }
    // ...and only from the two states product semantics permit.
    expect(fn).toMatch(/status\s+in\s*\(\s*'released'\s*,\s*'expired'\s*\)/i);
  });
});

describe("0188 — redemption is terminal for the entry, not only for the token", () => {
  const expireFn = (code: string) =>
    code.slice(
      code.indexOf("function public.expire_new_client_waitlist_invitation"),
      code.indexOf("function public.release_new_client_waitlist_entry"),
    );
  const releaseFn = (code: string) =>
    code.slice(
      code.indexOf("function public.release_new_client_waitlist_entry"),
      code.indexOf("function public.requeue_new_client_waitlist_entry"),
    );

  it.each([
    ["expire", expireFn],
    ["release", releaseFn],
  ])("%s guards its ENTRY-STATUS statement against a redeemed invitation", (_n, pick) => {
    // THE DEFECT THIS EXISTS FOR. Both commands write two statements: the
    // invitation stamp (already guarded) and the entry move (was not). The
    // result code came from the entry move alone, so the two could disagree --
    // statement 1 matching zero rows while statement 2 matched one -- and the
    // command answered `expired`/`released` over a redeemed invitation. The
    // entry then left `invited`, and `converted` is reachable ONLY from
    // `invited`, so a person who accepted their invitation became
    // unconvertible with no recovery edge.
    const fn = pick(CODE);
    expect(fn.length).toBeGreaterThan(0);
    const entryUpdate = fn.slice(fn.indexOf("update public.new_client_waitlist_entries"));
    expect(entryUpdate).toMatch(
      /not\s+exists\s*\([\s\S]{0,260}new_client_waitlist_invitations[\s\S]{0,260}redeemed_at\s+is\s+not\s+null/i,
    );
    // ...and the refusal is studio-scoped like every other predicate here.
    expect(entryUpdate).toMatch(/i\.studio_id\s*=\s*p_studio_id/);
  });

  it.each([
    ["expire", expireFn],
    ["release", releaseFn],
  ])("%s answers already_redeemed rather than mislabelling it", (_n, pick) => {
    // `not_invited` would be FALSE for this case: the entry IS invited, and it
    // has been redeemed. 0185 requires closed codes precisely so a caller can
    // tell "nothing to expire" from "this person already accepted -- record the
    // conversion instead".
    const fn = pick(CODE);
    expect(fn).toMatch(/return\s+'already_redeemed'/);
  });

  it("keeps the genuine no-op codes for the unredeemed case", () => {
    // The guard must DISCRIMINATE, not over-block: an ordinary unredeemed
    // expiry/release still reports its own outcome.
    expect(expireFn(CODE)).toMatch(/return\s+'not_invited'/);
    expect(releaseFn(CODE)).toMatch(/return\s+'not_releasable'/);
  });

  it("adds no column, table or trigger to obtain the redeemed fact", () => {
    // `redeemed_at` is already write-once (append-only trigger), its row
    // undeletable (no-delete trigger) and `entry_id` immutable, so the fact is
    // durable without new state. A new column would be a second copy of a law
    // that already exists.
    expect(CODE).not.toMatch(/add\s+column[^;]*redeem/i);
    expect(CODE).not.toMatch(/create\s+table[^;]*redemption/i);
  });
});
