import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0180 — card-on-file replacement integrity. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/card-replacement-atomicity.db.test.ts, including the negative
// control that reproduces the pre-0180 two-write data loss. This file pins what
// a behavioural test cannot see: what the migration is allowed to contain.
//
// ---------------------------------------------------------------------------
// WHEN A SUCCESSOR IS AUTHORED (0181+), ONLY THE CURRENT-STATE BLOCK GOES RED.
// Convert "is the current repository maximum" to "is no longer the repository
// maximum" plus versionsAbove(...).toContain("0181"), keep countVersion("0180")
// === 1, and let 0181's own test become the single current-state tripwire
// (CLAUDE.md §2). When 0180 is APPLIED, add a PERMANENT block that reads the
// FROZEN 0180 ledger entry and the frozen migration bytes — never
// migration-state.json.hosted_note, which is current state and will move.
// ---------------------------------------------------------------------------

const FILE = "supabase/migrations/0180_card_payment_method_replacement_integrity.sql";
const SQL = readFileSync(join(__dirname, "..", "..", FILE), "utf8");

// Executable SQL only — the header deliberately DESCRIBES the removed
// two-write pattern, so a raw-text scope assertion would fail on its own prose.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0180 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0180")).toBe(true);
    expect(versionsAbove("0180")).toEqual([]);
    expect(countVersion("0180")).toBe(1);
  });

  it("leaves 0181 free", () => {
    expect(countVersion("0181")).toBe(0);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });
});

describe("0180 — production truth: PENDING", () => {
  const rec = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "docs/production/migration-state.json"), "utf8"),
  );

  it("is authored but NOT yet applied — hosted stays at 0179", () => {
    // Recording the apply is a SEPARATE change that also converts this block
    // and hands 0179's floor forward.
    expect(rec.hosted_migration_max).toBe("0179");
    expect(Number.parseInt(rec.hosted_migration_max, 10)).toBeLessThan(180);
  });
});

describe("0180 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const b = lines.findIndex((l) => l === "begin;");
    expect(b).toBeGreaterThanOrEqual(0);
    expect(lines[b + 1]).toBe("set local lock_timeout = '5s';");
    expect(lines[lines.length - 1]).toBe("commit;");
  });
});

describe("0180 — installs exactly one command, service_role only", () => {
  it("creates only save_client_card_on_file", () => {
    const fns = [...EXEC.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    expect(fns).toEqual(["save_client_card_on_file"]);
  });

  it("revokes from PUBLIC, anon, authenticated AND service_role by name, then grants service_role", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to all of them at
    // create time; 0129 missed anon and 0164 missed service_role. Enumerate.
    expect(EXEC).toMatch(/revoke execute on function public\.save_client_card_on_file\([\s\S]*?\)\s*from public, anon, authenticated, service_role;/);
    expect(EXEC).toMatch(/grant execute on function public\.save_client_card_on_file\([\s\S]*?\)\s*to service_role;/);
  });

  it("is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(EXEC).toMatch(/security definer/);
    expect(EXEC).toMatch(/set search_path = ''/);
  });
});

describe("0180 — the atomicity contract", () => {
  it("does the retire and the insert in the SAME function body", () => {
    const body = EXEC.slice(
      EXEC.indexOf("create or replace function public.save_client_card_on_file"),
      EXEC.indexOf("comment on function"),
    );
    const retire = body.search(/update public\.client_payment_methods/);
    const insert = body.search(/insert into public\.client_payment_methods/);
    expect(retire).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(retire);
    // No COMMIT between them — the whole function is one transaction.
    expect(body.slice(retire, insert)).not.toMatch(/commit/i);
  });

  it("serialises concurrent replacements per (studio, client, mode)", () => {
    expect(EXEC).toMatch(/pg_advisory_xact_lock/);
    // The lock key must be mode-scoped, matching the partial unique index.
    expect(EXEC).toMatch(/p_stripe_livemode then 't' else 'f'/);
  });

  it("re-checks idempotency UNDER the lock before writing", () => {
    const lockAt = EXEC.indexOf("pg_advisory_xact_lock");
    const idemAt = EXEC.indexOf("outcome := 'idempotent'");
    expect(lockAt).toBeGreaterThan(-1);
    expect(idemAt).toBeGreaterThan(lockAt);
  });

  it("validates lineage with a distinguishable errcode so callers can classify it", () => {
    expect(EXEC).toMatch(/customer_lineage_mismatch' using errcode = '22023'/);
    expect(EXEC).toMatch(/signature_lineage_mismatch' using errcode = '22023'/);
  });

  it("retires only the SAME-mode active card", () => {
    const body = EXEC.slice(EXEC.indexOf("update public.client_payment_methods"));
    const stmt = body.slice(0, body.indexOf("returning"));
    expect(stmt).toMatch(/cpm\.stripe_livemode = p_stripe_livemode/);
    expect(stmt).toMatch(/cpm\.status = 'active'/);
  });
});

describe("0180 — DB-FIRST rollout contract (deployment skew)", () => {
  const ROUTE = readFileSync(
    join(__dirname, "..", "..", "app/api/stripe/webhook/route.ts"),
    "utf8",
  );
  const RUNBOOK = readFileSync(
    join(__dirname, "..", "..", "docs/runbooks/0180-card-replacement-integrity-rollout.md"),
    "utf8",
  );

  it("THE TRIPWIRE: the app calls the new command unconditionally, so the DB must go first", () => {
    // If this ever stops being true — i.e. someone adds a feature flag or a
    // fallback — the rollout order below must be re-derived, not assumed.
    expect(ROUTE).toMatch(/admin\.rpc\(\s*\n?\s*"save_client_card_on_file"/);
    // No conditional guarding the call, and no fallback to the old two writes.
    expect(ROUTE).not.toMatch(/if\s*\([^)]*save_client_card_on_file/);
    expect(ROUTE).not.toMatch(/\.update\(\{ status: "removed"/);
    expect(ROUTE).not.toMatch(/\.from\("client_payment_methods"\)\s*\n\s*\.insert\(\{/);
  });

  it("an RPC-absent failure must NOT be able to look like success", () => {
    // NEW APP + OLD DB is data-safe only because the missing command throws and
    // the parent releases the claim. If this ever became a `return`, the event
    // would be marked processed and the card silently lost.
    const handler = ROUTE.slice(ROUTE.indexOf("async function handleSetupIntentSucceeded"));
    const saveBlock = handler.slice(handler.indexOf("if (saveErr) {"));
    expect(saveBlock).toMatch(/throw new Error\(\s*\n?\s*`save_client_card_on_file_failed/);
    // Only the command's own lineage refusal (22023) is terminal.
    const terminalGuard = saveBlock.slice(0, saveBlock.indexOf("throw new Error("));
    expect(terminalGuard).toMatch(/saveErr\.code === "22023"/);
  });

  it("the rollout runbook states DB-FIRST and both skew directions explicitly", () => {
    // Markdown hard-wraps, so assert against whitespace-normalised prose rather
    // than guessing where the line breaks fall.
    const FLAT = RUNBOOK.replace(/\s+/g, " ");
    expect(FLAT).toMatch(/\*\*while the OLD application is still deployed\*\*/);
    expect(RUNBOOK).toMatch(/0180 IS MIGRATION-FIRST \(DB-FIRST\)/);
    expect(RUNBOOK).toMatch(/OLD app \+ NEW db/);
    expect(RUNBOOK).toMatch(/NEW app \+ OLD db/);
    expect(RUNBOOK).toMatch(/NOT OPERATIONALLY SAFE/);
    // The two explicitly rejected shortcuts.
    expect(RUNBOOK).toMatch(/No fallback to the old two-write implementation/);
    expect(RUNBOOK).toMatch(/No "merge quickly/);
    // Merge is step 6, after verification.
    expect(RUNBOOK).toMatch(/Only then merge PR #562/);
    expect(RUNBOOK).toMatch(/0181 becomes available only after/);
  });

  it("0180 is additive, which is what makes OLD-app-on-NEW-db safe", () => {
    // The runbook's safety claim is only true while this holds; scope
    // discipline below pins it independently.
    expect(EXEC).not.toMatch(/\balter table\b/i);
    expect(EXEC).not.toMatch(/\bdrop function\b/i);
  });
});

describe("0180 — scope discipline", () => {
  it("changes no table, index, policy or grant on any table", () => {
    expect(EXEC).not.toMatch(/\balter table\b/i);
    expect(EXEC).not.toMatch(/\bcreate table\b/i);
    expect(EXEC).not.toMatch(/\bdrop table\b/i);
    expect(EXEC).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(EXEC).not.toMatch(/\bdrop index\b/i);
    expect(EXEC).not.toMatch(/\bcreate policy\b/i);
    expect(EXEC).not.toMatch(/\bdrop policy\b/i);
    // Grants are limited to this one function.
    const grants = EXEC.match(/\b(grant|revoke)\b[^;]*;/gi) ?? [];
    for (const g of grants) expect(g).toContain("save_client_card_on_file");
  });

  it("mutates ZERO business rows", () => {
    // The only DML is inside the command body, operating on the row the caller
    // is creating. No migration-time backfill, no sweeping update.
    const top = EXEC.replace(
      EXEC.slice(
        EXEC.indexOf("create or replace function public.save_client_card_on_file"),
        EXEC.indexOf("comment on function"),
      ),
      "",
    );
    expect(top).not.toMatch(/\binsert into\b/i);
    expect(top).not.toMatch(/\bupdate public\./i);
    expect(top).not.toMatch(/\bdelete from\b/i);
  });

  it("touches no unrelated payment surface", () => {
    for (const t of [
      "appointments",
      "appointment_audit",
      "sessions",
      "payment_charge_attempts",
      "manual_fee_charge_attempts",
      "stripe_events",
      "studio_payment_settings",
    ]) {
      expect(EXEC).not.toMatch(new RegExp(`(insert into|update|delete from)\\s+public\\.${t}\\b`, "i"));
    }
  });
});
