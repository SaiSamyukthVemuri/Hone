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

// ---------------------------------------------------------------------------
// DEFENCE IN DEPTH ONLY — this is NOT an integrity authority.
//
// Integrity for both 0182 evidence records is STRUCTURAL: each is pinned by
// SHA-256 (the frozen ledger section below, and the current `hosted_note` in
// the "0182 is hosted max" contract above). Those hashes catch ANY edit,
// whatever words it uses.
//
// This helper exists only to turn the most likely fabrication into a readable
// failure message instead of a bare digest mismatch. It does NOT understand
// English and makes no claim to: three consecutive reviews each found another
// wording it missed — "181 records", "measured total of 181", "row-count: 181",
// "record-count: 181", "row total: 181" — and a claim spelled out in words
// ("one hundred and eighty-one") would defeat any regex of this kind. Enumerating
// synonyms was the wrong primary mechanism and has been retired as one.
//
// Held as a SOURCE STRING and compiled fresh per call — a shared /g RegExp
// carries `lastIndex` between callers and would skip matches.
const MEASURED_COUNT_CLAIM_SOURCE = [
  // "181 rows", "181 records", "181 entries", "1,024 tuples" — but never a
  // four-digit migration id: "the 0181 record" is a chain link, not a tally.
  String.raw`\b(?!0\d{3}\b)\d+(?:,\d{3})*\s+(?:rows?|records?|entries|entry|tuples?)\b`,
  // "count(*) = 181"
  String.raw`\bcount\(\*\)`,
  // "measured total of 181" / "measured total was 181"
  String.raw`\bmeasured total (?:of|was|=)\s*\d+(?:,\d{3})*`,
  // "row-count: 181", "row-count = 181", "row count: 181", "row counted = 181"
  String.raw`\brow[- ]count(?:ed)?\s*[:=]\s*\d+(?:,\d{3})*`,
].join("|");

/** Every measured-count claim in `text`. Empty when the text asserts none. */
const measuredCountClaims = (text: string): string[] =>
  text.match(new RegExp(MEASURED_COUNT_CLAIM_SOURCE, "gi")) ?? [];

// ---------------------------------------------------------------------------
// STRUCTURAL AUTHORITY for the CURRENT 0182 evidence record.
//
// The digest of the reviewed `hosted_note` as it stands while 0182 is the
// hosted maximum. Belongs to the "0182 is current" contract ONLY — a successor
// record legitimately fails it, which is the point.
// ---------------------------------------------------------------------------
const CURRENT_0182_NOTE_SHA =
  "a6053039a86eeb278fe7fd91c781423ab63ea2b88a88a2af32fabc303b066627";

function assertCurrent0182NotePinned(note: string) {
  const sha = createHash("sha256").update(note, "utf8").digest("hex");
  expect(
    sha,
    "0182 is still current; any edit to its canonical hosted_note requires deliberate review and updating this pin",
  ).toBe(CURRENT_0182_NOTE_SHA);
}

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

  it("the CURRENT hosted_note is byte-pinned while 0182 is the hosted max", () => {
    // STRUCTURAL AUTHORITY for the current record, and the reason no language
    // regex guards it any more.
    //
    // `hosted_note` is CURRENT state and MUST be free to change when 0183 is
    // applied. But while the canonical hosted max is still 0182, that note IS
    // 0182's reviewed evidence record, and its exact bytes are known. Pinning
    // the digest catches ANY edit — an appended fabricated count in any wording,
    // a softened limitation, a quietly dropped checksum — without anyone having
    // to anticipate the vocabulary. Three reviews running, enumerating synonyms
    // missed one; a hash cannot.
    //
    // THIS PIN RETIRES AT THE 0183 HANDOFF, by construction: it lives in the
    // describe that already asserts hosted max === "0182", so the whole block
    // hands off together when the next apply moves hosted max, applied-at,
    // next-free and the note. It imposes nothing on 0183's record. 0182's
    // PERMANENT evidence is sourced from the FROZEN ledger section instead —
    // see the permanent block below, which never reads this field.
    const REC = JSON.parse(
      readFileSync(join(ROOT, "docs/production/migration-state.json"), "utf8"),
    );

    // Key truth phrases first: they fail with a readable message, and a digest
    // mismatch alone would not say WHICH guarantee was lost.
    expect(REC.hosted_note).toMatch(/PUSH EXIT CODE WAS NOT CAPTURED/);
    expect(REC.hosted_note).toMatch(/NO ROW-COUNT PROOF/);

    assertCurrent0182NotePinned(REC.hosted_note);
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
// THE LAW THIS BLOCK OBEYS, and the reason it is shaped the way it is:
//
//   MIGRATION-SPECIFIC PERMANENT EVIDENCE comes from that migration's FROZEN
//   HISTORICAL LEDGER SECTION. CURRENT STATE is allowed to move. Only genuine
//   SUCCESSOR INVARIANTS may be asserted against the canonical record.
//
// An earlier revision of this block read 0182's limitations — the uncaptured
// push exit code, the absent row count — out of `migration-state.json`'s
// `hosted_note`. That field is CURRENT state. When 0183 is applied it must
// advance and describe 0183, whose evidence may be nothing like 0182's, so
// those assertions would have forced the next operator to choose between
// restating 0182's limitations inside 0183's record and editing a block titled
// "must survive 0183+". The successor-state test at the bottom holds that line.
// ---------------------------------------------------------------------------

/**
 * 0182's permanent apply evidence.
 *
 * Reads `frozenSection` ONLY. `currentNote` is accepted so the successor-state
 * test can pass a hypothetical 0183 record through this exact function and
 * prove the evidence does not depend on it — if an assertion here is ever
 * pointed at `currentNote`, that test goes red.
 */
function assert0182PermanentEvidence(sources: {
  frozenSection: string;
  currentNote: string;
}) {
  const { frozenSection } = sources;

  // The uncaptured push exit code. The single most misquotable line in the
  // record: a dry-run exit code of 0 says the CLI would push 0182 and nothing
  // else, and says nothing whatever about whether the push itself returned.
  expect(frozenSection).toMatch(/PUSH EXIT CODE WAS NOT CAPTURED/i);
  const zeroClaims =
    frozenSection.match(/[^.\n|]*\bexit(?:ed)?(?: code)? \*{0,2}0\b[^.\n|]*/gi) ?? [];
  expect(zeroClaims.length).toBeGreaterThan(0);
  for (const claim of zeroClaims) {
    expect(claim, "an exit-code-0 claim that is not attributed to the dry run").toMatch(
      /dry[- ]run/i,
    );
  }

  // The absent row count and the unavailable direct-SQL path.
  expect(frozenSection).toMatch(/NO ROW-COUNT PROOF/i);
  expect(frozenSection).toMatch(/NOT COUNTED, AND NOT CLAIMED/i);
  expect(frozenSection).toMatch(/Management API returned \*\*403\*\*/i);

  // Date-only precision, and the reason no archaeology can improve on it.
  expect(frozenSection).toMatch(/DATE ONLY/i);
  expect(frozenSection).toContain("2026-08-16");
  expect(frozenSection).toMatch(/No exact apply timestamp was captured/i);
  expect(frozenSection).toMatch(/NO SERVER-SIDE APPLY TIMESTAMP EXISTS/i);
  // The bracket bound is real and sourced; the instant is the MERGE's, not the
  // apply's, and the section must keep saying so.
  expect(frozenSection).toContain("2026-08-16T15:08:27Z");

  // Migration-first order against the real production merge.
  expect(frozenSection).toContain("bf1b18a920b5a1d0ddb10910335a865e96aa61bf");
  expect(frozenSection).toContain("c020e1022b585daecdb2ef5ad7784e987c2fbb3d");
  expect(frozenSection).toMatch(/DATABASE FIRST, before any application merge/i);

  // The applied bytes.
  expect(frozenSection).toContain(
    "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57",
  );
  expect(frozenSection).toContain(
    "799690db5fba3a4c24d0c100384784344a5b6c14c5d83a4eeec4e9418fba8fba",
  );
}

/**
 * A genuine SUCCESSOR invariant, and the one thing this file may legitimately
 * demand of the moving canonical record: whatever record supersedes 0182 must
 * carry the checksum chain forward rather than erasing what came before.
 */
function assertCarriesChainForward(hostedNote: string) {
  expect(hostedNote).toContain(
    "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57",
  );
  expect(hostedNote).toContain(
    "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f",
  );
  expect(hostedNote).toContain(
    "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6",
  );
}

describe("0182 — the recorded apply evidence stays honest", () => {
  const REC = JSON.parse(
    readFileSync(join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
  const LEDGER = readFileSync(
    join(ROOT, "docs/production/migration-ledger.md"),
    "utf8",
  );
  // Sliced from "post-0182 apply)" — deliberately AFTER the Current/Previous
  // word — so the slice is byte-identical before and after 0183 demotes this
  // block's heading, and so a later migration prepending a new Current state
  // cannot make these assertions read the wrong block.
  const SECTION_START = LEDGER.indexOf("post-0182 apply)");
  const SECTION = LEDGER.slice(
    SECTION_START,
    LEDGER.indexOf("post-0181 apply)", SECTION_START),
  );

  it("the ledger carries a 0182 apply section", () => {
    expect(SECTION_START).toBeGreaterThan(-1);
    expect(SECTION.length).toBeGreaterThan(500);
  });

  it("the 0182 evidence section is FROZEN, byte for byte", () => {
    // THE PRIMARY ANTI-FABRICATION GUARD, and the reason the lexical checks
    // below are only defence in depth.
    //
    // A disclaimer is not a guard: an edit could keep every "NO ROW-COUNT
    // PROOF" phrase intact and still append "181 records were present", and no
    // realistic amount of regex would catch every synonym for a count. So the
    // section is pinned STRUCTURALLY — this repository already freezes applied
    // migrations by sha256 (see the 0180 record), and the ledger's own law says
    // historical sections "are never rewritten when a later migration lands".
    //
    // The slice starts after the Current/Previous word, so demoting this block
    // at 0183 leaves the hash untouched. ANY other edit — a word, a digit, an
    // appended sentence — breaks it, which is the intent. If a genuine
    // correction to 0182's record is ever needed, updating this hash is the
    // deliberate, reviewable act that records it.
    const sha = createHash("sha256").update(SECTION, "utf8").digest("hex");
    expect(
      sha,
      "the frozen 0182 evidence section changed — if that was deliberate, update this pin in the same review",
    ).toBe("64b3eb89a020873c386e7766c53a073c304188513d09ca2071be8119658ba39c");
  });

  it("states no measured count in the wordings the helper does cover", () => {
    // Defence in depth behind the hash: a clearer failure for the most likely
    // fabrication, and it covers the synonyms the old `rows`-only guard missed
    // ("181 records", "181 entries", "measured total of 181").
    //
    // Asserted as an EXACT allowlist rather than "no matches", because the
    // section legitimately cites 0181's own measurement while explicitly
    // labelling 181 an INFERENCE for 0182. Any additional match is a new count
    // claim. The leading (?!0\d{3}) keeps four-digit MIGRATION IDS from reading
    // as counts — "the 0181 record" is a chain link, not a tally.
    expect(
      measuredCountClaims(SECTION),
      "the frozen 0182 section states a measured count that was never captured",
    ).toEqual(["measured total was 180"]);
  });

  it("the defence-in-depth helper catches the wordings it enumerates — and only those", () => {
    // Each of these is the same unsupported claim in different clothes, and
    // each must fail the helper. This asserts COVERAGE OF A LIST, not coverage
    // of English — "record-count: 181", "row total: 181" and a count spelled
    // out in words all pass this helper, which is exactly why neither evidence
    // record relies on it for integrity. Both are pinned by SHA-256.
    for (const fabrication of [
      "the history table contained 181 rows",
      "181 records were present after apply",
      "a measured total of 181 entries",
      "post-apply measured total of 181",
      "count(*) = 181",
      "row-count: 181",
      "row-count = 181",
      "row count: 181",
      "row counted = 181",
    ]) {
      expect(
        measuredCountClaims(fabrication),
        `a fabricated measured count slipped past the guard: ${fabrication}`,
      ).not.toEqual([]);
    }

    // And the other half of the contract: truthful text that asserts NO count
    // must stay clean, including the negative phrasings the real record uses
    // and the chain links, which are migration ids and not tallies.
    expect(
      measuredCountClaims(
        "NO ROW-COUNT PROOF. No pre/post business-row count was captured for any " +
          "table, and the history table was not row-counted. PUSH EXIT CODE WAS NOT " +
          "CAPTURED. The 0181 record and the 0180 record remain in the chain.",
      ),
      "truthful no-count text must not trip the guard",
    ).toEqual([]);
  });

  it("the CURRENT-note pin rejects ANY edit, whatever vocabulary it uses", () => {
    // THE POINT OF THE WHOLE ARCHITECTURE, proved behaviourally rather than by
    // scanning this file's own source. The previous version of this test counted
    // occurrences of a regex fragment, which said nothing about whether the
    // design still held.
    //
    // Every injection below evaded the lexical helper at some point in review —
    // including one spelled out in words, which no regex of that kind can ever
    // catch. The structural pin rejects all of them for the same reason it
    // rejects a single stray character: it does not read English.
    const REC = JSON.parse(
      readFileSync(join(ROOT, "docs/production/migration-state.json"), "utf8"),
    );
    expect(() => assertCurrent0182NotePinned(REC.hosted_note)).not.toThrow();

    for (const injection of [
      " POST-APPLY VERIFICATION: record-count: 181.",
      " POST-APPLY VERIFICATION: entry count = 181.",
      " POST-APPLY VERIFICATION: row total: 181.",
      " POST-APPLY VERIFICATION: 181 records were present.",
      " The post-apply tally stood at one hundred and eighty-one.",
      " Unrelated fabricated prose with no count in it at all.",
      " ",
    ]) {
      expect(
        () => assertCurrent0182NotePinned(REC.hosted_note + injection),
        `an edit to the canonical note went undetected: ${injection}`,
      ).toThrow();
    }
  });

  it("records 0182's permanent evidence from the FROZEN section", () => {
    assert0182PermanentEvidence({ frozenSection: SECTION, currentNote: REC.hosted_note });
  });

  it("carries the checksum chain forward instead of dropping earlier applies", () => {
    // The chain is how one canonical record supersedes its predecessor without
    // erasing it: 0182 at the head, 0181 behind it, the oldest link still there.
    assertCarriesChainForward(REC.hosted_note);
  });

  it("survives a future 0183 apply whose evidence differs from 0182's", () => {
    // THE SUCCESSOR-STATE TEST, and the anti-vacuity proof for everything
    // above. `hosted_note` is CURRENT state: when 0183 is applied it must
    // advance and describe 0183, whose evidence may be nothing like 0182's — a
    // captured push exit code, a real row count, a precise timestamp.
    //
    // This fixture is HYPOTHETICAL. It is never written to disk and asserts
    // nothing about what 0183 will actually contain.
    const FUTURE_0183_NOTE =
      "0183_hypothetical_successor.sql APPLIED to production on 2026-09-01, MIGRATION-FIRST. " +
      "APPLY EXIT STATUS: PUSH EXIT CODE 0 WAS CAPTURED (the command was backgrounded so a " +
      "harness timeout could not obscure it). POST-APPLY VERIFICATION: hosted migration history " +
      "max 0183 recorded exactly once, 182 rows total. FINAL STATE: repository max 0183, hosted " +
      "max 0183, repo == hosted, nothing pending, next free 0184. SUPERSEDES the 0182 record and " +
      "CARRIES THE FULL CHECKSUM CHAIN FORWARD: the 0182 record " +
      "(0182_sterile_item_discard_lifecycle.sql, raw sha256 " +
      "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57, executable sha256 " +
      "799690db5fba3a4c24d0c100384784344a5b6c14c5d83a4eeec4e9418fba8fba, applied 2026-08-16), " +
      "the 0181 record (raw sha256 " +
      "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f) ... and the 0171 record " +
      "(sha256 f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6).";

    // The fixture is a REAL successor: its evidence contradicts 0182's on every
    // point this file pins, so it would break any assertion still coupled to
    // the moving record.
    expect(FUTURE_0183_NOTE).not.toMatch(/PUSH EXIT CODE WAS NOT CAPTURED/);
    expect(FUTURE_0183_NOTE).not.toMatch(/NO ROW-COUNT PROOF/);
    expect(FUTURE_0183_NOTE).toMatch(/\b182 rows\b/);

    // 0182's permanent evidence is UNAFFECTED — it lives in the frozen section.
    assert0182PermanentEvidence({
      frozenSection: SECTION,
      currentNote: FUTURE_0183_NOTE,
    });

    // And the successor invariant still binds the new record.
    assertCarriesChainForward(FUTURE_0183_NOTE);

    // THE PIN RETIRES CORRECTLY. The current-note digest belongs to the
    // "0182 is hosted max" contract alone: a legitimate successor record fails
    // it, and that is the intended behaviour, not a defect. It is asserted only
    // inside the current-state describe — which hands off wholesale at 0183 —
    // and is never consulted by the permanent evidence above, which is why the
    // call below throws while assert0182PermanentEvidence() just passed.
    expect(
      () => assertCurrent0182NotePinned(FUTURE_0183_NOTE),
      "the current-note pin must NOT be imposed on a successor record",
    ).toThrow();
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
