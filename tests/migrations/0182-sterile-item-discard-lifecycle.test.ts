import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  countVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0182 — structured sterile-item discard lifecycle. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/sterile-item-discard-lifecycle.db.test.ts (and the current-warning
// filter in tests/db/expiring-sterile-items.db.test.ts). This file pins what a
// behavioural test cannot see: that the migration adds ONE nullable date column
// and NOTHING else — no backfill, no destructive statement, no RLS change, and
// above all no attempt to infer a discard from free text.

const ROOT = join(__dirname, "..", "..");
const FILE = "supabase/migrations/0182_sterile_item_discard_lifecycle.sql";
const SQL = readFileSync(join(ROOT, FILE), "utf8");

// EXECUTABLE SQL ONLY — line comments stripped. The header legitimately
// discusses notes, backfills and deletion in order to state that it does none
// of them, so raw-text negatives would fail on the very prose documenting the
// decision.
const EXEC = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

// EXEC minus the COMMENT ON string literals. `comment on column ... is '...'`
// IS executable SQL, but its payload is documentation, and that documentation
// necessarily uses the words the negatives below forbid ("notes", "discarded")
// in order to state what the migration must never do. Assertions about SQL
// LOGIC run against this; assertions about the documentation run against SQL.
const LOGIC = EXEC.replace(/comment on [\s\S]*?';/gi, "");

describe("0182 — migration state", () => {
  it("is the current repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0182")).toBe(true);
    expect(versionsAbove("0182")).toEqual([]);
    expect(countVersion("0182")).toBe(1);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });

  it("IS applied to production — hosted state is declared, not derived", () => {
    // THE HAND-OFF HAPPENED. This block previously asserted the PRE-APPLY state
    // (hosted still 0181, pending ["0182"], repo != hosted) and was written to
    // go red the moment the rollout ran, so the apply could not be recorded
    // without updating the canonical hosted-state record in the same change.
    // That is exactly what happened: the migration-first rollout completed on
    // 2026-08-16 — 0182 was pushed to the linked production project BEFORE #590
    // was merged as bf1b18a9 — and this block was flipped in the same change
    // that moved the canonical record.
    //
    // A file on disk still says nothing about what production has applied. The
    // claim below is the DECLARED one, read from docs/production/migration-state.json.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe("0182");
    expect(state.pending_migrations).toEqual([]);
    expect(state.repo_equals_hosted).toBe(true);
  });

  it("leaves 0183 as the next free number, available but unclaimed", () => {
    expect(migrationState().next_free_migration).toBe("0183");
  });

  it("stamps the CURRENT apply at date precision, and says so machine-readably", () => {
    // CURRENT STATE, and it moves on the next apply — which is why it lives in
    // this block and not in the permanent one below. While 0182 is the hosted
    // max, the canonical record must carry 0182's date-only stamp AND the
    // qualifier that stops a consumer reading it as midnight.
    //
    // The qualifier must survive the DERIVATION too, not just the file: reading
    // it out of the JSON while `getMigrationState()` silently dropped it is the
    // whole failure mode, since `npm run migration:state -- --json` is the
    // documented machine interface.
    const state = migrationState();
    expect(state.hosted_applied_at).toBe("2026-08-16");
    expect(
      state.hosted_applied_at,
      "an apply instant was never captured for 0182, so one must never appear here",
    ).not.toMatch(/T\d{2}:/);
    expect(state.hosted_applied_at_precision).toMatch(/DATE-ONLY/i);
    expect(state.hosted_applied_at_precision).toMatch(/NONE IS INVENTED/i);
  });
});

// ---------------------------------------------------------------------------
// MIGRATION-SOURCE CONTRACT (frozen).
//
// An APPLIED migration is frozen: the bytes in the repository must still be the
// bytes that were reviewed and pushed. The structural negatives further down
// prove what the migration DOES; these two hashes prove it is the SAME FILE.
// They are also the head of the checksum chain carried in the canonical record,
// so a silent edit here breaks the chain rather than passing quietly.
// ---------------------------------------------------------------------------
describe("0182 — migration source is the exact reviewed file", () => {
  it("still hashes to the RAW checksum recorded for the applied bytes", () => {
    const raw = createHash("sha256")
      .update(readFileSync(join(ROOT, FILE)))
      .digest("hex");
    expect(raw).toBe(
      "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57",
    );
  });

  it("still hashes to the EXECUTABLE checksum recorded for the applied bytes", () => {
    // Same normalisation the 0180 record uses: strip line comments and block
    // comments, trim trailing whitespace, drop blank lines.
    const exec = createHash("sha256")
      .update(
        EXEC.replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((l) => l.replace(/\s+$/, ""))
          .filter((l) => l.trim())
          .join("\n") + "\n",
      )
      .digest("hex");
    expect(exec).toBe(
      "799690db5fba3a4c24d0c100384784344a5b6c14c5d83a4eeec4e9418fba8fba",
    );
  });
});

// ---------------------------------------------------------------------------
// PERMANENT apply facts (must survive 0183+).
//
// These read the 0182 ledger section and the canonical record. Their job is to
// stop the apply from being over-claimed later: the push exit code, the row
// counts and the exact apply instant were NOT captured, and every future reader
// must meet that limitation rather than a tidied-up version of it.
// ---------------------------------------------------------------------------
describe("0182 — the recorded apply evidence stays honest", () => {
  const REC = JSON.parse(
    readFileSync(join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
  const LEDGER = readFileSync(
    join(ROOT, "docs/production/migration-ledger.md"),
    "utf8",
  );
  // Sliced at its own heading so a later migration prepending a new Current
  // state cannot make these assertions read the wrong block.
  const SECTION_START = LEDGER.indexOf("post-0182 apply)");
  const SECTION = LEDGER.slice(
    SECTION_START,
    LEDGER.indexOf("post-0181 apply)", SECTION_START),
  );

  it("the ledger carries a 0182 apply section", () => {
    expect(SECTION_START).toBeGreaterThan(-1);
    expect(SECTION.length).toBeGreaterThan(500);
    expect(SECTION).toContain(
      "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57",
    );
    expect(SECTION).toContain(
      "799690db5fba3a4c24d0c100384784344a5b6c14c5d83a4eeec4e9418fba8fba",
    );
  });

  it("records the UNKNOWN push exit status — the captured 0 is the DRY RUN's", () => {
    // The single most misquotable line in the record. A dry-run exit code of 0
    // says the CLI would push 0182 and nothing else; it says nothing whatever
    // about whether the push itself returned cleanly.
    expect(SECTION).toMatch(/PUSH EXIT CODE WAS NOT CAPTURED/i);
    expect(REC.hosted_note).toMatch(/PUSH EXIT CODE WAS NOT CAPTURED/);

    const zeroClaims = SECTION.match(/[^.\n|]*\bexit(?:ed)?(?: code)? \*{0,2}0\b[^.\n|]*/gi) ?? [];
    expect(zeroClaims.length).toBeGreaterThan(0);
    for (const claim of zeroClaims) {
      expect(claim, "an exit-code-0 claim that is not attributed to the dry run").toMatch(
        /dry[- ]run/i,
      );
    }
  });

  it("claims NO row-count proof and NO direct SQL verification", () => {
    expect(SECTION).toMatch(/NO ROW-COUNT PROOF/i);
    expect(SECTION).toMatch(/NOT COUNTED, AND NOT CLAIMED/i);
    expect(SECTION).toMatch(/Management API returned \*\*403\*\*/i);
    expect(REC.hosted_note).toMatch(/NO ROW-COUNT PROOF/);

    // A disclaimer is not a guard. Keeping the words "NO ROW-COUNT PROOF" while
    // ALSO appending "the history table held 181 rows" would satisfy every
    // assertion above and still smuggle in the measured count that was never
    // taken — so reject the positive claim directly, not just its absence of
    // denial. Deliberately narrow: the section legitimately discusses counting
    // in the negative ("was not row-counted", "no pre/post business-row count
    // was captured") and cites 0181's own measured total as an INFERENCE.
    const MEASURED_COUNT = /\b\d[\d,]*\s+rows?\b|\bcount\(\*\)|\brow[- ]count(?:ed)?\s*[:=]\s*\d/i;
    expect(
      SECTION.match(MEASURED_COUNT)?.[0],
      "the 0182 section states a measured row count that was never captured",
    ).toBeUndefined();
    expect(
      REC.hosted_note.match(MEASURED_COUNT)?.[0],
      "the canonical note states a measured row count that was never captured",
    ).toBeUndefined();
  });

  it("records the apply date at DATE precision in the frozen ledger section", () => {
    // Read from the LEDGER, not from migration-state.json. `hosted_applied_at`
    // is CURRENT state and must advance when 0183 is applied; pinning 0182's
    // date to it inside a block titled "must survive 0183+" would force the
    // next operator to choose between editing a permanent test and leaving
    // hosted truth stale. The current-record assertions live in the
    // current-state block above, where moving is expected.
    expect(SECTION).toMatch(/DATE ONLY/i);
    expect(SECTION).toContain("2026-08-16");
    expect(SECTION).toMatch(/No exact apply timestamp was captured/i);
    // The bounds are real and sourced; the instant is not, and must not appear
    // as 0182's apply time.
    expect(SECTION).toContain("2026-08-16T15:08:27Z");
    expect(SECTION).toMatch(/NO SERVER-SIDE APPLY TIMESTAMP EXISTS/i);
  });

  it("carries the checksum chain forward instead of dropping earlier applies", () => {
    // The chain is the reason a single canonical record can supersede its
    // predecessor without erasing it. 0182 at the head, 0181 immediately behind
    // it, and the oldest link still present.
    expect(REC.hosted_note).toContain(
      "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57",
    );
    expect(REC.hosted_note).toContain(
      "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f",
    );
    expect(REC.hosted_note).toContain(
      "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
    );
  });

  it("records the migration-first order against the real production merge", () => {
    expect(SECTION).toContain("bf1b18a920b5a1d0ddb10910335a865e96aa61bf");
    expect(SECTION).toContain("c020e1022b585daecdb2ef5ad7784e987c2fbb3d");
    expect(SECTION).toMatch(/DATABASE FIRST, before any application merge/i);
  });
});

describe("0182 — transaction envelope", () => {
  it("opens its own transaction and arms lock_timeout INSIDE it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL outside one emits 25P01 and never arms.
    const lines = SQL.split("\n").map((l) => l.trim()).filter(Boolean);
    const begin = lines.findIndex((l) => l === "begin;");
    const lock = lines.findIndex((l) => l.startsWith("set local lock_timeout"));
    const commit = lines.findIndex((l) => l === "commit;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });
});

describe("0182 — the column", () => {
  it("adds date_discarded as a NULLABLE date, idempotently", () => {
    expect(EXEC).toMatch(
      /alter table public\.record_keeping_sterile_items\s+add column if not exists date_discarded date;/,
    );
  });

  it("mirrors the record_keeping_disinfectants precedent: no default, no check", () => {
    // The sibling column (0085) is `date_discarded date` — nullable, no
    // default, no constraint. Two logbooks, one concept, one dialect.
    expect(EXEC).not.toMatch(/date_discarded[^;]*default/i);
    expect(EXEC).not.toMatch(/date_discarded[^;]*not null/i);
    expect(EXEC).not.toMatch(/check\s*\(/i);
  });

  it("documents the semantics on the column itself", () => {
    expect(SQL).toMatch(
      /comment on column public\.record_keeping_sterile_items\.date_discarded is/,
    );
  });

  it("includes a preflight note", () => {
    expect(SQL).toMatch(/PREFLIGHT/);
  });
});

describe("0182 — changes NOTHING else", () => {
  it("touches only record_keeping_sterile_items", () => {
    const alters = EXEC.match(/alter table\s+public\.[a-z_]+/gi) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const a of alters) {
      expect(a.toLowerCase()).toBe(
        "alter table public.record_keeping_sterile_items",
      );
    }
  });

  it("performs NO backfill and NO row mutation — a discard is never inferred", () => {
    // The single most important negative in this file. Deriving date_discarded
    // from `notes` is precisely the failure mode the structured column exists to
    // replace: it would read "do not discard" and "discarded the OTHER box" as
    // compliance assertions. Every existing row must arrive as NULL.
    expect(LOGIC).not.toMatch(/\bupdate\s+public\./i);
    expect(LOGIC).not.toMatch(/\binsert\s+into\b/i);
    expect(LOGIC).not.toMatch(/\bnotes\b/i);
    expect(LOGIC).not.toMatch(/\bilike\b/i);
    expect(LOGIC).not.toMatch(/\blike\b/i);
    expect(LOGIC).not.toMatch(/set\s+date_discarded/i);
  });

  it("the column comment states the semantics AND the no-inference rule", () => {
    // The documentation half of the pair above: the rule is recorded in the
    // database itself, where the next person to read the schema will find it.
    const comment = EXEC.match(/comment on [\s\S]*?';/i)?.[0] ?? "";
    expect(comment).toMatch(/NULL = no structured discard recorded/i);
    expect(comment).toMatch(/never inferred from notes/i);
    expect(comment).toMatch(
      /current inventory is not historical record existence/i,
    );
  });

  it("introduces NO destructive statement", () => {
    // These are health-inspection logbook records; 0085 deliberately ships no
    // DELETE policy and no delete affordance. Discard is a lifecycle field, and
    // must never become a deletion.
    expect(LOGIC).not.toMatch(/\bdelete\s+from\b/i);
    expect(EXEC).not.toMatch(/\bdrop\s+table\b/i);
    expect(EXEC).not.toMatch(/\bdrop\s+column\b/i);
    expect(EXEC).not.toMatch(/\btruncate\b/i);
  });

  it("changes NO RLS, grant, policy or trigger", () => {
    // The 0085 policies already scope every command by is_studio_member at the
    // ROW level, so a new column inherits tenancy exactly. The 0086 audit
    // trigger is column-generic, so it covers date_discarded without edit.
    expect(EXEC).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(EXEC).not.toMatch(/row level security/i);
    expect(EXEC).not.toMatch(/^\s*grant /im);
    expect(EXEC).not.toMatch(/^\s*revoke /im);
    expect(EXEC).not.toMatch(/create trigger|drop trigger/i);
    expect(EXEC).not.toMatch(/create (or replace )?function/i);
  });

  it("creates no index and no foreign key", () => {
    // Per-studio logbook reads are already studio-indexed and hard-capped; an
    // unused index is write cost for no read benefit. Historical FKs (0155
    // probe_inventory_item_id, 0179 actor) must be left exactly as they are.
    expect(EXEC).not.toMatch(/create index|create unique index/i);
    expect(EXEC).not.toMatch(/references\s+public\./i);
    expect(EXEC).not.toMatch(/add constraint/i);
  });

  it("adds no view or RPC — there is no SQL-side consumer to update", () => {
    expect(EXEC).not.toMatch(/create (or replace )?view/i);
  });
});
