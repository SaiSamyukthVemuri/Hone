import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0162 — an intake may only become 'reviewed' from a genuinely
// SUBMITTED row, reviewed by the caller's own active practitioner IN THAT
// STUDIO, at a timestamp the DATABASE stamps.
//
// This test carries the REPO migration-max pin (it moved off the 0161 test when
// 0162 landed). 0162 is NOT applied: repo max is 0162 while hosted max is still
// 0161, so unlike 0159/0160/0161 this file is deliberately NOT checksum-frozen —
// it may still be revised until it is applied.
//
// Behavioural proof lives in tests/db/intake-review-db-boundary.db.test.ts,
// which runs the whole adversarial matrix against a real migrated database.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0162_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
// PROSE view: comment markers stripped so a rationale sentence that wraps
// across lines still reads as one sentence.
const PROSE = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
// CODE view: comments removed entirely, so a rationale that NAMES a forbidden
// construct cannot be mistaken for the construct itself.
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const FLAT_CODE = CODE.replace(/\s+/g, " ");
const statements = CODE.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("0162 — intake review transition integrity (repo migration-max tripwire)", () => {
  it("is present, 0161 precedes it, exactly one 0162, and it is the repo max", () => {
    expect(FILE).toMatch(/^0162_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0161_"))).toBe(true);
    expect(files.filter((f) => /^0162_/.test(f))).toHaveLength(1);
    // Nothing beyond 0162 may exist.
    expect(files.filter((f) => /^01(6[3-9]|[7-9]\d)_/.test(f))).toEqual([]);
    expect(files.filter((f) => /^0[2-9]\d\d_/.test(f))).toEqual([]);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(162);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("declares its dependency and its migration-max transition", () => {
    expect(PROSE).toMatch(/DEPENDS ON: migration 0118/i);
    expect(PROSE).toMatch(/Migration max 0161 -> 0162/i);
  });
});

describe("0162 — it REPLACES the 0118 function rather than adding a second trigger", () => {
  it("uses CREATE OR REPLACE on the existing function name", () => {
    expect(FLAT_CODE).toMatch(
      /create or replace function public\.enforce_intake_terminal_immutability\(\)/,
    );
  });

  it("keeps the 0118 trigger NAME, timing and table", () => {
    expect(FLAT_CODE).toMatch(
      /create trigger client_intake_forms_terminal_immutability before update on public\.client_intake_forms/,
    );
    expect(FLAT_CODE).toMatch(
      /execute function public\.enforce_intake_terminal_immutability\(\)/,
    );
    // Exactly one trigger is created — no competing second guard.
    expect(FLAT_CODE.match(/create trigger/gi) ?? []).toHaveLength(1);
  });

  it("preserves SECURITY INVOKER and the pinned empty search_path", () => {
    expect(FLAT_CODE).toMatch(/security invoker/);
    expect(FLAT_CODE).not.toMatch(/security definer/);
    expect(FLAT_CODE).toMatch(/set search_path = ''/);
  });
});

describe("0162 — the incoming review contract", () => {
  it("gates on an incoming transition into reviewed", () => {
    expect(FLAT_CODE).toMatch(
      /if new\.status = 'reviewed' and old\.status is distinct from 'reviewed' then/,
    );
  });

  it("requires OLD.status = submitted", () => {
    expect(FLAT_CODE).toMatch(/if old\.status <> 'submitted' then/);
    expect(SQL).toMatch(
      /An intake can only be marked reviewed after the client submits it\./,
    );
  });

  it("requires a non-null OLD.submitted_at", () => {
    expect(FLAT_CODE).toMatch(/if old\.submitted_at is null then/);
    expect(SQL).toMatch(
      /An intake cannot be marked reviewed without a recorded submission\./,
    );
  });

  it("forbids rewriting submitted_at in the same statement", () => {
    expect(FLAT_CODE).toMatch(
      /if new\.submitted_at is distinct from old\.submitted_at then/,
    );
  });

  it("requires a non-null reviewed_by", () => {
    expect(FLAT_CODE).toMatch(/if new\.reviewed_by is null then/);
  });

  it("validates the reviewer as ACTIVE, owned by auth.uid(), AND in the intake's studio", () => {
    // All four predicates must be present in the single EXISTS lookup.
    expect(FLAT_CODE).toMatch(/from public\.practitioners p/);
    expect(FLAT_CODE).toMatch(/p\.id = new\.reviewed_by/);
    expect(FLAT_CODE).toMatch(/p\.active = true/);
    expect(FLAT_CODE).toMatch(/p\.studio_id = old\.studio_id/);
    expect(FLAT_CODE).toMatch(/p\.user_id = auth\.uid\(\)/);
    // and a null caller can never satisfy it
    expect(FLAT_CODE).toMatch(/auth\.uid\(\) is not null/);
  });

  it("the studio check uses OLD.studio_id, so a forged NEW.studio_id cannot help", () => {
    expect(FLAT_CODE).toMatch(/p\.studio_id = old\.studio_id/);
    expect(FLAT_CODE).not.toMatch(/p\.studio_id = new\.studio_id/);
  });
});

describe("0162 — reviewed_at is database-authoritative", () => {
  it("STAMPS reviewed_at with transaction_timestamp() on the valid transition", () => {
    expect(FLAT_CODE).toMatch(
      /new\.reviewed_at := transaction_timestamp\(\)/,
    );
  });

  it("does not merely accept a non-null caller-supplied reviewed_at", () => {
    // There must be no bare "reviewed_at is null -> raise" acceptance path that
    // would let any non-null forged value through.
    expect(FLAT_CODE).not.toMatch(/if new\.reviewed_at is null then\s*raise/);
  });

  it("documents the authority change and its application compatibility", () => {
    expect(PROSE).toMatch(/database is now authoritative|DATABASE IS NOW AUTHORITATIVE/i);
    expect(PROSE).toMatch(/markIntakeReviewedAction/);
    expect(PROSE).toMatch(/never reads or asserts the value it sent/i);
  });
});

describe("0162 — the service-role decision is explicit and evidenced", () => {
  it("places the review contract BEFORE the auth.uid() is null early return", () => {
    const gateIdx = FLAT_CODE.indexOf(
      "if new.status = 'reviewed' and old.status is distinct from 'reviewed'",
    );
    const exemptIdx = FLAT_CODE.indexOf("if auth.uid() is null then return new");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(exemptIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(exemptIdx);
  });

  it("still exempts service role from the END-USER rules (client submission keeps working)", () => {
    expect(FLAT_CODE).toMatch(/if auth\.uid\(\) is null then return new; end if;/);
  });

  it("documents the caller audit that justifies rejecting service-role reviews", () => {
    expect(PROSE).toMatch(/exactly ONE place in the whole\s*repository/i);
    expect(PROSE).toMatch(/in_progress -> submitted/);
    expect(PROSE).toMatch(/FAILS CLOSED/i);
  });
});

describe("0162 — the 0118 contract is preserved, plus three hardenings", () => {
  it("keeps answers immutable on terminal rows", () => {
    expect(SQL).toMatch(
      /Submitted intake answers are immutable; create a new intake to amend\./,
    );
  });

  it("keeps submitted_at immutable after submission", () => {
    expect(SQL).toMatch(/submitted_at is immutable after submission\./);
  });

  it("keeps the terminal -> in_progress prohibition", () => {
    expect(SQL).toMatch(
      /A submitted or reviewed intake cannot be reverted to draft\./,
    );
  });

  it("keeps reviewed attribution immutable", () => {
    expect(SQL).toMatch(/Review attribution is immutable once reviewed\./);
  });

  it("HARDENING: reviewed is terminal — no regression to any earlier state", () => {
    expect(FLAT_CODE).toMatch(
      /if old\.status = 'reviewed' and new\.status is distinct from 'reviewed' then/,
    );
    expect(SQL).toMatch(/A reviewed intake cannot return to an earlier state\./);
    // and the rationale names the two-step laundering path it closes
    expect(PROSE).toMatch(/attribution-laundering/i);
  });

  it("HARDENING: only the CLIENT may submit — no authenticated in_progress -> submitted", () => {
    // Found by adversarial review: without this the section-1 contract is
    // bypassable in two statements (forge the submission, then review against
    // the evidence you just manufactured).
    expect(FLAT_CODE).toMatch(
      /if new\.status = 'submitted' and old\.status is distinct from 'submitted' then/,
    );
    expect(SQL).toMatch(/Only the client can submit their own intake\./);
    // It must sit AFTER the service-role early return, so the public tokenized
    // submit route (service role) keeps working.
    const exemptIdx = FLAT_CODE.indexOf("if auth.uid() is null then return new");
    const ruleIdx = FLAT_CODE.indexOf(
      "if new.status = 'submitted' and old.status is distinct from 'submitted'",
    );
    expect(exemptIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(exemptIdx);
  });

  it("HARDENING: review metadata cannot be attached to a non-reviewed row", () => {
    expect(FLAT_CODE).toMatch(/if new\.status <> 'reviewed'/);
    expect(SQL).toMatch(
      /Review metadata can only be recorded when an intake is marked reviewed\./,
    );
  });
});

describe("0162 — refusals are safe", () => {
  it("every raise uses the fixed check_violation SQLSTATE", () => {
    // NOTE: do not terminate the match on ';' — one message legitimately
    // contains a semicolon ("...are immutable; create a new intake to amend.").
    // Match through to the errcode clause instead, and require that the number
    // of raises equals the number of errcode clauses so none can slip through
    // without one.
    const raiseCount = (CODE.match(/raise exception/g) ?? []).length;
    const codes = CODE.match(/raise exception[\s\S]*?using errcode = '([a-z_]+)'/g) ?? [];
    expect(raiseCount).toBeGreaterThanOrEqual(8);
    expect(codes).toHaveLength(raiseCount);
    for (const r of codes) {
      expect(r).toMatch(/using errcode = 'check_violation'$/);
    }
  });

  it("no exception message interpolates row, actor or tenant identity", () => {
    // Scan the WHOLE raise statement, through to its terminating semicolon —
    // adversarial review showed that stopping at `using errcode` let a trailing
    // `, detail = 'intake ' || old.id` clause slip past unnoticed, which would
    // leak the very identifiers this check exists to keep out of the error.
    const raiseStarts = [...CODE.matchAll(/raise exception/g)].map((m) => m.index ?? 0);
    expect(raiseStarts.length).toBeGreaterThanOrEqual(8);
    for (const start of raiseStarts) {
      const tail = CODE.slice(start);
      // Terminate on the first semicolon that is NOT inside a quoted string.
      let depth = 0;
      let end = tail.length;
      for (let i = 0; i < tail.length; i++) {
        if (tail[i] === "'") depth ^= 1;
        else if (tail[i] === ";" && depth === 0) {
          end = i + 1;
          break;
        }
      }
      const stmt = tail.slice(0, end);
      expect(stmt).not.toMatch(/%/);
      expect(stmt, "no string concatenation into an error payload").not.toMatch(/\|\|/);
      expect(stmt, "no DETAIL/HINT/COLUMN payload channels").not.toMatch(
        /\b(detail|hint|column|constraint|table|schema)\s*=/i,
      );
      expect(stmt).not.toMatch(/new\.(id|studio_id|client_id|reviewed_by|reviewed_at)/);
      expect(stmt).not.toMatch(/old\.(id|studio_id|client_id|reviewed_by|reviewed_at)/);
      expect(stmt).not.toMatch(/auth\.uid\(\)/);
    }
  });
});

describe("0162 — transaction + lock safety (the 0159/0160/0161 lesson)", () => {
  it("opens and closes exactly one explicit transaction", () => {
    expect(statements.filter((s) => s.toLowerCase() === "begin")).toHaveLength(1);
    expect(statements.filter((s) => s.toLowerCase() === "commit")).toHaveLength(1);
    expect(statements.filter((s) => /^rollback/i.test(s))).toEqual([]);
  });

  it("arms a SET LOCAL lock_timeout INSIDE that transaction", () => {
    expect(FLAT_CODE).toMatch(/begin; set local lock_timeout = '5s';/);
  });

  it("explains why the file opens its own transaction", () => {
    expect(PROSE).toMatch(/does NOT wrap a migration file in an explicit\s*transaction/i);
    expect(PROSE).toMatch(/25P01/);
  });

  it("contains nothing illegal inside a transaction block", () => {
    expect(FLAT_CODE).not.toMatch(/create index concurrently/i);
    expect(FLAT_CODE).not.toMatch(/alter type .* add value/i);
    expect(FLAT_CODE).not.toMatch(/\bvacuum\b/i);
  });

  it("is replayable: the trigger is dropped-if-exists before being created", () => {
    expect(FLAT_CODE).toMatch(
      /drop trigger if exists client_intake_forms_terminal_immutability on public\.client_intake_forms/,
    );
  });
});

describe("0162 — scope safety: no schema, data or grant changes", () => {
  it("creates no table, column, constraint, index, policy or grant", () => {
    expect(FLAT_CODE).not.toMatch(/create table/i);
    expect(FLAT_CODE).not.toMatch(/alter table/i);
    expect(FLAT_CODE).not.toMatch(/add column/i);
    expect(FLAT_CODE).not.toMatch(/drop column/i);
    expect(FLAT_CODE).not.toMatch(/create index/i);
    expect(FLAT_CODE).not.toMatch(/create policy/i);
    expect(FLAT_CODE).not.toMatch(/drop policy/i);
    expect(FLAT_CODE).not.toMatch(/\bgrant\b/i);
    expect(FLAT_CODE).not.toMatch(/\brevoke\b/i);
  });

  it("rewrites no business row: no UPDATE/INSERT/DELETE/TRUNCATE statements", () => {
    // The only assignment is the trigger-local NEW.reviewed_at stamp.
    expect(FLAT_CODE).not.toMatch(/\bupdate public\./i);
    expect(FLAT_CODE).not.toMatch(/\binsert into\b/i);
    expect(FLAT_CODE).not.toMatch(/\bdelete from\b/i);
    expect(FLAT_CODE).not.toMatch(/\btruncate\b/i);
  });

  it("touches only client_intake_forms and reads only practitioners", () => {
    const tables = new Set(
      (FLAT_CODE.match(/public\.[a-z_]+/g) ?? []).map((t) => t.replace("public.", "")),
    );
    tables.delete("enforce_intake_terminal_immutability");
    expect([...tables].sort()).toEqual(["client_intake_forms", "practitioners"]);
  });

  it("carries the read-only pre-apply audit as counts only, with no identity columns", () => {
    expect(PROSE).toMatch(/READ-ONLY PRE-APPLY AUDIT \(counts only/i);
    expect(PROSE).toMatch(/Zero rows does not replace the guard/i);
    // The audit query selects no identifying column.
    expect(PROSE).not.toMatch(/select f\.id/);
    expect(PROSE).not.toMatch(/f\.responses[^_]/);
    expect(PROSE).not.toMatch(/f\.practitioner_notes/);
  });
});
