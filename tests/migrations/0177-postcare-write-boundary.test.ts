import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0177 — B8 postcare write boundary. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/postcare-write-boundary.db.test.ts. This file pins what a
// behavioural test cannot see: what the migration is allowed to contain, and
// what it must never emit.

const FILE = "supabase/migrations/0177_postcare_write_boundary.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header deliberately NAMES
// what it does not touch (snapshot_appointment_buffer, B6/B7 objects, payments)
// so a reader knows those omissions are decisions; a scope assertion over raw
// text would fail on the very prose documenting the discipline.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const CLAIM =
  EXEC.match(
    /create or replace function public\.claim_postcare_send[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";
const SETTLE =
  EXEC.match(
    /create or replace function public\.settle_postcare_send[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";
// The ONE pre-existing object 0177 is permitted to replace. Everything else
// from 0173 / B6 / B7 stays untouched, which the scope suite below pins.
const BLOCKING =
  EXEC.match(
    /create or replace function public\.appointment_has_blocking_dependents[\s\S]*?\n\$\$;/,
  )?.[0] ?? "";

describe("0177 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0177")).toBe(true);
    expect(versionsAbove("0177")).toEqual([]);
    expect(countVersion("0177")).toBe(1);
  });

  it("leaves 0178 free", () => {
    expect(countVersion("0178")).toBe(0);
  });
});

describe("0177 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    // `supabase db push` does not wrap a migration file in a transaction, so a
    // bare SET LOCAL emits 25P01 and never arms.
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const b = lines.findIndex((l) => l === "begin;");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(lines[b + 1]).toBe("set local lock_timeout = '5s';");
    expect(lines[lines.length - 1]).toBe("commit;");
  });

  it("sets no statement_timeout", () => {
    expect(SQL).not.toMatch(/statement_timeout/);
  });
});

describe("0177 — STANDING PROHIBITION: snapshot_appointment_buffer untouched", () => {
  it("never references it in executable SQL", () => {
    // Production carries out-of-band GUC behaviour there which this
    // repository's migration source does not represent, so re-emitting it from
    // repo source could DELETE live production behaviour.
    expect(EXEC).not.toMatch(/snapshot_appointment_buffer/i);
  });
});

describe("0177 — claim_postcare_send", () => {
  it("has the exact signature and posture", () => {
    expect(CLAIM).not.toBe("");
    expect(CLAIM).toMatch(/p_appointment_id\s+uuid/);
    expect(CLAIM).toMatch(/p_studio_id\s+uuid/);
    expect(CLAIM).toMatch(/p_actor_practitioner_id uuid/);
    expect(CLAIM).toMatch(/p_is_resend\s+boolean/);
    expect(CLAIM).toMatch(/security definer/);
    expect(CLAIM).toMatch(/set search_path = pg_catalog, pg_temp/);
    // It returns the token the settlement requires.
    expect(CLAIM).toMatch(/claimed_at\s+timestamptz/);
  });

  it("validates the supplied server-resolved practitioner is ACTIVE and SAME-STUDIO", () => {
    // Deliberately NOT "authenticates". service_role is a transport identity,
    // so the database cannot verify who is behind the connection: the trusted
    // call site authenticates the human and resolves the practitioner, and the
    // command validates that supplied id, rejecting inactive and cross-studio
    // actors. A service_role caller could still name a different active
    // same-studio practitioner — the residual trust lives in the call site, and
    // the title used to claim otherwise.
    expect(CLAIM).toMatch(/from public\.practitioners p/);
    expect(CLAIM).toMatch(/p\.studio_id = p_studio_id/);
    expect(CLAIM).toMatch(/p\.active = true/);
    expect(CLAIM).toMatch(/'not_authorized'/);
  });

  it("locks the appointment and scopes it to the studio", () => {
    expect(CLAIM).toMatch(/from public\.appointments a[\s\S]*?for update/);
    expect(CLAIM).toMatch(/a\.studio_id = p_studio_id/);
  });

  it("is COMPLETED-only", () => {
    expect(CLAIM).toMatch(/status <> 'completed'/);
    expect(CLAIM).toMatch(/'not_completed'/);
  });

  it("distinguishes first send from resend by the existing sent_at", () => {
    expect(CLAIM).toMatch(/postcare_email_sent_at is null/);
    expect(CLAIM).toMatch(/postcare_email_sent_at is not null/);
    expect(CLAIM).toMatch(/'already_sent'/);
    expect(CLAIM).toMatch(/'never_sent'/);
  });

  it("owns the five-minute stale window itself — never a caller parameter", () => {
    expect(CLAIM).toMatch(/interval '5 minutes'/);
    expect(CLAIM).toMatch(/'already_claimed'/);
    // No caller-supplied window, and no caller-supplied timestamp at all.
    expect(CLAIM).not.toMatch(/p_stale|p_now|p_claimed_at|p_timestamp/);
  });

  it("MILLISECOND-truncates the claim token — load-bearing, not cosmetic", () => {
    // The token leaves as JSON and returns through a JavaScript Date, which
    // carries milliseconds. A microsecond value would be rounded in transit and
    // no settlement would ever match its own claim, so nothing would be
    // recorded as sent. Proved end-to-end in the DB round-trip test.
    expect(CLAIM).toMatch(/date_trunc\('milliseconds', now\(\)\)/);
    expect(CLAIM).not.toMatch(/v_now\s*:=\s*now\(\);/);
  });

  it("stamps claim and last_attempt with ONE instant and increments attempts", () => {
    expect(CLAIM).toMatch(/postcare_email_claimed_at\s+= v_now/);
    expect(CLAIM).toMatch(/postcare_email_last_attempt_at = v_now/);
    expect(CLAIM).toMatch(/postcare_email_send_attempts\s+= coalesce\(a\.postcare_email_send_attempts, 0\) \+ 1/);
  });
});

describe("0177 — settle_postcare_send", () => {
  it("has the exact signature and posture", () => {
    expect(SETTLE).not.toBe("");
    expect(SETTLE).toMatch(/p_claimed_at\s+timestamptz/);
    expect(SETTLE).toMatch(/p_success\s+boolean/);
    expect(SETTLE).toMatch(/p_retryable\s+boolean/);
    expect(SETTLE).toMatch(/security definer/);
    expect(SETTLE).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("requires the token, locks the row, and compares it EXACTLY", () => {
    expect(SETTLE).toMatch(/p_claimed_at is null/);
    expect(SETTLE).toMatch(/for update/);
    expect(SETTLE).toMatch(
      /postcare_email_claimed_at is distinct from p_claimed_at/,
    );
    expect(SETTLE).toMatch(/'stale_claim'/);
  });

  it("uses the DATABASE clock for both settlement stamps", () => {
    expect(SETTLE).toMatch(/v_now\s*:=\s*now\(\)/);
    expect(SETTLE).toMatch(/postcare_email_sent_at\s+= v_now/);
    expect(SETTLE).toMatch(/postcare_email_failed_at\s+= v_now/);
  });

  it("success clears the failure state and the claim", () => {
    const branch = SETTLE.match(/if coalesce\(p_success, false\) then[\s\S]*?return;/)?.[0] ?? "";
    expect(branch).toMatch(/postcare_email_failed_at = null/);
    expect(branch).toMatch(/postcare_email_last_error = null/);
    expect(branch).toMatch(/postcare_email_claimed_at = null/);
  });

  it("derives last_error from p_retryable ALONE, and accepts no provider payload", () => {
    // A raw provider error can carry recipient addresses and vendor internals,
    // and this column is rendered to practitioners.
    expect(SETTLE).toMatch(/coalesce\(p_retryable, false\)/);
    expect(SETTLE).toMatch(/Temporary email provider error/);
    expect(SETTLE).toMatch(/The email provider rejected the send/);
    expect(SETTLE).not.toMatch(/p_error|p_message|p_detail|p_payload|p_reason/);
  });

  it("FAILURE never touches sent_at — a failed resend keeps the real one", () => {
    // Erasing it would turn a delivery record into a lie in exactly the dispute
    // where it matters.
    const failure = SETTLE.slice(SETTLE.indexOf("v_err := case"));
    expect(failure).toMatch(/postcare_email_failed_at\s+= v_now/);
    expect(failure).toMatch(/postcare_email_claimed_at = null/);
    expect(failure).not.toMatch(/postcare_email_sent_at\s+=/);
  });
});

describe("0177 — the ONE permitted B4 helper replacement", () => {
  // Independent-review P1-2. A claim that has not settled is an unresolved
  // EXTERNAL side effect, and 0173's blocking-dependents helper could not see
  // it: it checked postcare_email_sent_at only. An owner could therefore reopen
  // a completed appointment in the window between claim and settlement, and the
  // aftercare email would still land — for a visit that is no longer completed.
  //
  // 0173 is applied production history and stays frozen, so the narrow fix
  // ships here. This suite pins BOTH halves: that the replacement happens, and
  // that it is the ONLY thing 0177 replaces.

  it("replaces appointment_has_blocking_dependents with the exact 0173 signature", () => {
    expect(BLOCKING).not.toBe("");
    expect(BLOCKING).toMatch(/p_appointment_id uuid/);
    expect(BLOCKING).toMatch(/p_studio_id\s+uuid/);
    expect(BLOCKING).toMatch(/returns text/);
    // Same posture as 0173: a read-only helper, definer, pinned search_path.
    expect(BLOCKING).toMatch(/\bstable\b/);
    expect(BLOCKING).toMatch(/security definer/);
    expect(BLOCKING).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("carries all FIVE existing blocker classes, in the 0173 order", () => {
    const order = [...BLOCKING.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect(order).toEqual([
      "rescheduled",
      "linked_session",
      "payment_state",
      "manual_fee",
      "postcare_sent",
      // ...and the new class is appended LAST, which is load-bearing: during a
      // resend both postcare classes match, and the practitioner must still be
      // told the stronger fact — aftercare has ALREADY been emailed.
      "postcare_in_flight",
    ]);
  });

  it("preserves each existing class's predicate verbatim", () => {
    // A replacement that kept the NAMES but quietly changed a WHERE clause
    // would pass an order assertion. These are the 0173 predicates.
    expect(BLOCKING).toMatch(/a\.rescheduled_to_appointment_id is not null/);
    expect(BLOCKING).toMatch(/from public\.sessions s[\s\S]*?s\.deleted_at is null/);
    expect(BLOCKING).toMatch(
      /from public\.appointment_payments ap[\s\S]*?ap\.payment_status <> 'method_saved'/,
    );
    expect(BLOCKING).toMatch(/from public\.manual_fee_charge_attempts m/);
    expect(BLOCKING).toMatch(/a\.postcare_email_sent_at is not null/);
    // Every branch stays studio-scoped.
    expect((BLOCKING.match(/studio_id = p_studio_id/g) ?? []).length).toBe(6);
  });

  it("adds the new class on an UNCONDITIONAL claim, not a fresh-claim window", () => {
    // The five-minute window governs who may RECLAIM a send. It says nothing
    // about whether the external side effect resolved, and a claim that went
    // stale is the state whose outcome Hone never learned — the most dangerous
    // one to reopen an appointment underneath, not the least.
    expect(BLOCKING).toMatch(/a\.postcare_email_claimed_at is not null/);
    expect(BLOCKING).not.toMatch(/5 minutes|interval/);
    expect(BLOCKING).toMatch(/return 'postcare_in_flight'/);
  });

  it("re-states the service-role-only EXECUTE posture rather than assuming it", () => {
    // CREATE OR REPLACE preserves the ACL, but the 0169 doctrine is to name
    // every verb rather than depend on what a replace happens to keep.
    expect(SQL).toMatch(
      /revoke execute on function public\.appointment_has_blocking_dependents\(uuid, uuid\)\s*\n?\s*from public, anon, authenticated;/,
    );
    expect(SQL).toMatch(
      /grant execute on function public\.appointment_has_blocking_dependents\(uuid, uuid\)\s*\n?\s*to service_role;/,
    );
  });

  it("updates the function comment to name the new class", () => {
    const c =
      SQL.match(
        /comment on function public\.appointment_has_blocking_dependents\(uuid, uuid\) is[\s\S]*?;/,
      )?.[0] ?? "";
    expect(c).toContain("postcare_in_flight");
    expect(c).toContain("postcare_sent");
  });

  it("REDEFINES nothing else from 0173 — the two commands keep their bodies", () => {
    // They call the helper BY NAME, so they pick the new class up without being
    // re-emitted. Re-emitting them would drag 0173's whole body into an
    // unapplied migration for no reason and widen the blast radius.
    for (const fn of [
      "revert_appointment_outcome",
      "set_appointment_notes",
      "appointment_actor_role",
      "lock_appointment_for_command",
      "write_appointment_audit",
    ]) {
      expect(
        EXEC,
        `0177 must not redefine ${fn}`,
      ).not.toMatch(new RegExp(`create or replace function public\\.${fn}`));
      // ...and no body was smuggled in under another DDL verb either.
      expect(EXEC).not.toMatch(new RegExp(`(create|drop|alter) function public\\.${fn}`));
    }
    // set_appointment_notes is not mentioned by 0177 in ANY form.
    expect(EXEC).not.toMatch(/public\.set_appointment_notes/);
  });

  it("touches revert_appointment_outcome ONLY through a standalone COMMENT ON", () => {
    // The single intentional exception. 0173 is frozen, but its catalog
    // description now says "five ... blocking-dependent classes", which pg's
    // own \df+ / pg_description would keep reporting. A comment is DDL, so the
    // truthful fix is a comment — not a redefinition.
    const mentions = [...EXEC.matchAll(/public\.revert_appointment_outcome/g)];
    expect(mentions).toHaveLength(1);
    expect(EXEC).toMatch(
      /comment on function public\.revert_appointment_outcome\(uuid, uuid, uuid, text, text\) is/,
    );
  });

  it("the updated catalog description states SIX classes and names the new one", () => {
    const c =
      SQL.match(
        /comment on function public\.revert_appointment_outcome\(uuid, uuid, uuid, text, text\) is[\s\S]*?';/,
      )?.[0] ?? "";
    expect(c).not.toBe("");
    expect(c).toContain("six independent blocking-dependent classes");
    expect(c).not.toContain("five independent blocking-dependent classes");
    expect(c).toContain("postcare_in_flight");
    // Every other clause of the 0173 description is preserved verbatim, so the
    // comment stays a full contract rather than becoming a changelog entry.
    for (const clause of [
      "completed/no_show/cancelled -> confirmed",
      "Owner-only, studio- and appointment-scoped, expected-status concurrency",
      "72h window anchored to the audit event that established the current outcome (absent baseline REFUSES)",
      "23P01 mapped to slot_conflict",
      "Exactly one audit row on success, none on refusal",
      "Service-role only.",
    ]) {
      expect(c, `preserved clause missing: ${clause}`).toContain(clause);
    }
  });

  it("0177 defines exactly THREE functions", () => {
    const defined = [...EXEC.matchAll(/create or replace function public\.(\w+)/g)]
      .map((m) => m[1])
      .sort();
    expect(defined).toEqual([
      "appointment_has_blocking_dependents",
      "claim_postcare_send",
      "settle_postcare_send",
    ]);
  });
});

describe("0177 — privilege closure", () => {
  it("revokes UPDATE on exactly the six postcare columns from service_role", () => {
    const revoke = SQL.match(/revoke update \([\s\S]*?\) on table public\.appointments from service_role;/)?.[0] ?? "";
    expect(revoke).not.toBe("");
    for (const col of [
      "postcare_email_claimed_at",
      "postcare_email_failed_at",
      "postcare_email_last_attempt_at",
      "postcare_email_last_error",
      "postcare_email_send_attempts",
      "postcare_email_sent_at",
    ]) {
      expect(revoke, `must revoke ${col}`).toContain(col);
    }
  });

  it("grants EXECUTE only to service_role on both commands", () => {
    for (const fn of ["claim_postcare_send", "settle_postcare_send"]) {
      expect(SQL).toMatch(
        new RegExp(`revoke execute on function public\\.${fn}\\([\\s\\S]*?\\)\\s*\\n?\\s*from public, anon, authenticated;`),
      );
      expect(SQL).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?\\)\\s*\\n?\\s*to service_role;`),
      );
    }
  });

  it("grants no new UPDATE back to anyone", () => {
    expect(EXEC).not.toMatch(/grant update/i);
  });
});

describe("0177 — scope discipline", () => {
  it("adds no appointment_audit event", () => {
    // The seven writers it replaces produce none, and B8 is boundary hardening
    // rather than a new event taxonomy.
    expect(EXEC).not.toMatch(/appointment_audit/);
  });

  it("does not rewrite B6 or B7 objects", () => {
    for (const obj of [
      "mark_appointment_complete",
      "appointment_transition_allowed",
      "enforce_appointment_transition",
      "appointments_enforce_transition_trg",
      "appointments_set_updated_at_trg",
      "appointments_set_capacity_enabled_trg",
      "public_cancel_appointment_with_token",
      "appointment_policy_acknowledgements",
    ]) {
      expect(EXEC, `0177 must not touch ${obj}`).not.toContain(obj);
    }
  });

  it("does not touch reservations, the Google outbox, or payments", () => {
    for (const obj of [
      "studio_calendar_reservations",
      "calendar_sync_outbox",
      "calendar_event_links",
      "payment_charge_attempts",
      "stripe",
    ]) {
      expect(EXEC.toLowerCase()).not.toContain(obj);
    }
  });

  it("creates no trigger or index, and alters no table", () => {
    expect(EXEC).not.toMatch(/create trigger|drop trigger|create index|alter table/i);
  });

  it("performs NO data mutation at apply time", () => {
    // The DML inside function BODIES runs per call, never at migration apply.
    const outside = EXEC.split(CLAIM)
      .join("")
      .split(SETTLE)
      .join("")
      .split(BLOCKING)
      .join("");
    for (const verb of ["insert into", "delete from"]) {
      expect(outside.toLowerCase()).not.toContain(verb);
    }
    // The only `update` outside the bodies is the REVOKE UPDATE statement.
    const updates = (outside.toLowerCase().match(/update/g) ?? []).length;
    expect(updates).toBe(1);
    expect(outside).toMatch(/revoke update \(/);
  });
});

// ---------------------------------------------------------------------------
// PRODUCTION TRUTH — 0177 was APPLIED on 2026-08-10.
//
// Per CLAUDE.md §2 the CURRENT maximum migration's own test is the one that
// carries the repo/hosted tripwire, and hosted state is DECLARED (never derived
// from filenames) in docs/production/migration-state.json. This block is where
// that lives for 0177; it is deliberately the only place that asserts the
// rest-state relationship, so there is no second source of truth.
//
// WHEN 0178 IS AUTHORED, THE FIRST TEST BELOW GOES RED. That is the hand-off,
// not a defect: repo max moves to 0178 while hosted stays 0177 until it is
// applied. The amendment is the same one 0174 received — convert the equality
// to a FLOOR (`>= 177`) and let 0178's own test carry the tripwire. Do NOT
// instead weaken it here and leave two owners.
// ---------------------------------------------------------------------------
describe("0177 — production truth: APPLIED 2026-08-10", () => {
  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
  );
  const LEDGER = readFileSync(
    join(__dirname, "..", "..", "docs/production/migration-ledger.md"),
    "utf8",
  );

  it("the declared hosted max is 0177 — repository and production agree, nothing pending", () => {
    expect(rec.hosted_migration_max).toBe("0177");
    expect(isRepoMax(rec.hosted_migration_max)).toBe(true);
    expect(versionsAbove(rec.hosted_migration_max)).toEqual([]);
  });

  it("the record carries the sha256 of the exact 0177 bytes that were applied", async () => {
    // THE FREEZE. If this hash ever changes, an applied migration has been
    // edited and a recorded production apply fact has been falsified. A future
    // semantic change is 0178+, never a rewrite of these bytes.
    const { createHash } = await import("node:crypto");
    const bytes = readFileSync(join(__dirname, "..", "..", FILE));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe("a9c15f1c92a7deb24c8e04dbf123e82806fe35f28be814b84222c1c13ae82744");
    expect(rec.hosted_note).toContain(sha);
  });

  it("the record states the privilege closure that B8 exists to produce", () => {
    // The one outcome a reader must be able to trust without opening a psql
    // session: after 0177 there is no appointment write grant left to revoke.
    expect(rec.hosted_note).toMatch(/SELECT ONLY/);
    expect(rec.hosted_note).toMatch(/COLUMN-LEVEL UPDATE GRANTS ARE ZERO/);
    expect(rec.hosted_note).toMatch(/7 -> 0/);
  });

  it("the ledger's CURRENT STATE block describes 0177, not a superseded boundary", () => {
    // The stale header this reconciliation fixed said "post-0173 apply" long
    // after 0174-0176 had landed, so the top of the canonical ledger contradicted
    // its own later entries.
    const current = LEDGER.slice(
      LEDGER.indexOf("## Current state"),
      LEDGER.indexOf("## Previous state"),
    );
    expect(current).toContain("post-0177 apply");
    expect(current).toContain("0177_postcare_write_boundary.sql");
    expect(current).toContain("a9c15f1c92a7deb24c8e04dbf123e82806fe35f28be814b84222c1c13ae82744");
    expect(current).toContain("2358082737ef47e30d68883dedbbfea930590d8f");
    // hosted == repo, and the next number is free.
    expect(current).toMatch(/hosted == repo/);
    expect(current).toMatch(/0178/);
    // ...and it no longer claims an older migration is the current boundary.
    expect(current).not.toMatch(/post-0173 apply/);
  });

  it("the ledger carries a 0177 rollout entry with the app-first evidence", () => {
    const entry = LEDGER.slice(LEDGER.indexOf("## 0177 — APPOINTMENT BOUNDARY B8"));
    expect(entry).not.toBe("");
    expect(entry).toMatch(/APP-FIRST/);
    expect(entry).toMatch(/2358082737ef47e30d68883dedbbfea930590d8f/);
    expect(entry).toMatch(/appointments \*\*312 → 312\*\*/);
    expect(entry).toMatch(/postcare_in_flight last/i);
    expect(entry).toMatch(/be4b3ac1/); // snapshot buffer unchanged
    expect(entry).toMatch(/B8 CLOSED/);
  });
});
