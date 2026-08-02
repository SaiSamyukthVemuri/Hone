import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// PR A / migration 0159. THE DOCS TRUTH GUARD for a PERMANENTLY RETIRED capability.
//
// PRODUCT DECISION (authoritative, 2026-07-29): Hone will NOT offer signed or
// cryptographically finalized clinical records. Practitioner-signed snapshots,
// immutable finalized records, "snapshot v2", cryptographic clinical-record hashes
// as a product feature, and any correction/amendment workflow built around signed
// snapshots are PERMANENTLY REJECTED — not paused, not deferred, not awaiting a UI.
// Treatment sessions stay ORDINARY EDITABLE operational records; practitioners fix
// ordinary charting mistakes by editing them.
//
// WHY THIS GUARD EXISTS. Migration 0159 stops the capability from RUNNING, and
// tests/db/clinical-finalization-retired.db.test.ts proves that against a real
// database. Neither stops the capability from being RE-PLANNED. Before this PR the
// documentation set carried ~27 forward-looking statements that read as standing
// instructions to finish the rejected thing — "PARKED", "DORMANT", "Next gate", "a
// later phase", "enablement needs separate authorization", roadmap SEC-09's "close
// any remaining gaps in immutable snapshots, amendment attribution…", and a
// machine-readable capability manifest that parked the entry mid-ladder with no
// terminal state. None of those statements was factually wrong about production;
// every one was wrong about the FUTURE. tests/docs/ had seven guards at the time
// (payments, agentic-readiness, runbook, docs-drift) and NOT ONE covered a clinical
// row, so the suite was green while the docs told the next author to build it.
// A green suite was not evidence. This guard closes that blind spot.
//
// HOW IT AVOIDS OVERCORRECTING. "correction", "amendment", "immutable", "finalized"
// and "snapshot" all have legitimate, unrelated uses in this repo — append-only
// clinical NOTES (where a correction IS a new row), append-only consent signatures,
// `buffer_minutes_snapshot` / `policy_snapshot_hash` columns, database backups, and
// Stripe webhook idempotency. A blunt keyword ban would break all of them, so:
//   * banned FRAMING words are only looked for inside a block that also mentions
//     signed clinical finalization (§"blockFramingViolations"), never globally;
//   * a banned word that is explicitly NEGATED ("not parked"), explicitly HISTORICAL
//     ("previously", "~~struck~~") or inside a block that repudiates the framing
//     ("It is none of those") is allowed — a document must be free to say what it
//     supersedes;
//   * HISTORICAL, APPEND-ONLY logs are deliberately OUT of scope. docs/13's decision
//     log and docs/14's per-PR entries are point-in-time records; rewriting them
//     would falsify history. Only their maintained current blocks are scanned.
//   * §"no overcorrection" asserts the legitimate unrelated wording is still there.
//
// IF YOU TRIPPED THIS GUARD: the fix is almost never to delete the assertion. Either
// your wording re-opened a retired capability (change the wording), or you are
// reintroducing the capability on purpose — which needs a NEW product decision
// record superseding docs/decisions/clinical-finalization-retired.md §7, an
// architecture review, a legal/privacy review, a migration plan and fresh operator
// acceptance. A flag flip, a roadmap ID or "just re-enable it for one tenant" is not
// enough, and neither is editing this file.

const ROOT = path.resolve(__dirname, "../..");

const DECISION_RECORD_PATH = "docs/decisions/clinical-finalization-retired.md";
const MIGRATION_PATH = "supabase/migrations/0159_retire_signed_clinical_records.sql";
const DB_GUARD_PATH = "tests/db/clinical-finalization-retired.db.test.ts";

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

/**
 * The maintained slice of a file whose remainder is append-only history — from the
 * line matching `startRe` up to (not including) the next line matching `endRe`.
 * Line-based on purpose: a character-offset search makes `^## ` match the tail of
 * `### SEC-09`.
 */
function slice(doc: string, startRe: RegExp, endRe: RegExp, label: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => startRe.test(l));
  expect(
    start,
    `${label}: could not find the maintained block (${startRe}). If the heading was ` +
      `renamed, point this guard at the new one — do NOT widen it to the whole file, ` +
      `because the rest is append-only history that must not be rewritten.`,
  ).toBeGreaterThanOrEqual(0);
  const rel = lines.slice(start + 1).findIndex((l) => endRe.test(l));
  const end = rel < 0 ? lines.length : start + 1 + rel;
  return lines.slice(start, end).join("\n");
}

const DECISION = read(DECISION_RECORD_PATH);
const MIGRATION = read(MIGRATION_PATH);
const README = read("README.md");
const DB_RLS = read("docs/09_DATABASE_AND_RLS.md");
const HANDOFF_CURRENT = slice(
  read("docs/14_AI_HANDOFF.md"),
  /^## Current produ/m,
  /^---$/m,
  "docs/14",
);
const BACKLOG_ACTIVE = slice(
  read("docs/13_BACKLOG_AND_DECISIONS.md"),
  /^## Active decisions and queue/m,
  /^## Decision log/m,
  "docs/13",
);
const CURRENT_STATE = read("docs/production/current-state.md");
const CAPABILITY_REGISTER = read("docs/production/capability-register.md");
const KNOWN_LIMITATIONS = read("docs/production/known-limitations.md");
const ROADMAP = read("docs/roadmap/CANONICAL_ROADMAP.md");
const WAVE1 = read("docs/roadmap/WAVE1_DESIGN.md");
const TRUTH_REGISTER = read("docs/marketing/product-truth-register.md");
const MANIFEST_RAW = read("docs/roadmap/CAPABILITY_MANIFEST.json");
const NOTES_CONTRACT = read("docs/clinical-notes-append-only-contract.md");
const DOMAIN_MODEL = read("docs/02_DOMAIN_MODEL.md");

/**
 * Every CURRENT-AUTHORITATIVE prose document, i.e. every document a reader is
 * entitled to treat as a statement about what Hone is and will be. Historical logs
 * are excluded by design (see the header) — docs/13 and docs/14 contribute only
 * their maintained current blocks.
 */
const CURRENT_AUTHORITATIVE: ReadonlyArray<readonly [string, string]> = [
  ["docs/decisions/clinical-finalization-retired.md", DECISION],
  ["README.md", README],
  ["docs/09_DATABASE_AND_RLS.md", DB_RLS],
  ["docs/14_AI_HANDOFF.md (Current production summary block)", HANDOFF_CURRENT],
  ["docs/13_BACKLOG_AND_DECISIONS.md (Active decisions and queue)", BACKLOG_ACTIVE],
  ["docs/production/current-state.md", CURRENT_STATE],
  ["docs/production/capability-register.md", CAPABILITY_REGISTER],
  ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
  ["docs/roadmap/CANONICAL_ROADMAP.md", ROADMAP],
  ["docs/roadmap/WAVE1_DESIGN.md", WAVE1],
  ["docs/marketing/product-truth-register.md", TRUTH_REGISTER],
] as const;

/**
 * Split a markdown document into the smallest units that carry one claim: one
 * bullet (with its wrapped continuation lines), one table row, one heading, one
 * paragraph. Proximity has to be measured inside a claim — a whole-file or
 * fixed-character window would drag an unrelated neighbouring bullet in.
 */
function blocks(doc: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.join("\n").trim()) out.push(cur.join("\n"));
    cur = [];
  };
  for (const line of doc.split("\n")) {
    const isBlank = /^\s*$/.test(line);
    const startsNew =
      isBlank ||
      /^\s*(?:[-*+]|\d+\.)\s/.test(line) || // bullet / numbered item
      /^\s*\|/.test(line) || //               table row
      /^\s*#{1,6}\s/.test(line); //           heading
    if (startsNew) {
      flush();
      if (!isBlank) cur.push(line);
    } else {
      cur.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Does this block talk about the RETIRED signed-record system? Deliberately does
 * NOT match "clinical notes", "consent signature", "policy snapshot" or a database
 * backup — those are unrelated capabilities that must keep their wording.
 */
const SIGNED_RECORD_MENTION =
  /(clinical[ -]record|clinical finaliz\w*|finaliz\w*[ -]clinical|signed[ -](?:clinical|snapshot|structured)|signed[ -]record(?:s)?[ -](?:correction|amendment|workflow|ledger|system|snapshot|lineage|capability|finaliz\w*)|finalized (?:record|session|clinical|artifact)|finalization (?:boundary|flag|controls?)|finalize_session|correct_finalized_session|amend_finalized_session|build_session_snapshot|clinical_record_snapshots|clinical_record_amendments|clinical_audit_events|clinical_finalization_enabled|clinical_corrections_enabled|snapshot v2|SEC-09)/i;

/**
 * Framings that would turn the retirement back into a plan. The optional third
 * member is a false-positive escape tested against the match plus what follows it —
 * English reuses these words ("`authenticated` **held** EXECUTE" is a privilege
 * fact, not a project status), and a guard that cried wolf would get deleted.
 */
const FORWARD_FRAMINGS: ReadonlyArray<readonly [string, RegExp, RegExp?]> = [
  ["parked", /\bparked\b/gi],
  ["dormant", /\bdormant\b/gi],
  ["deferred", /\bdeferred\b/gi],
  ["planned / upcoming / coming soon", /\b(?:planned|upcoming|coming soon|roadmapped)\b/gi],
  ["next gate", /\bnext gate\b/gi],
  ["a later phase", /\b(?:a later phase|a future phase|phase 3)\b/gi],
  ["a launch requirement", /\blaunch (?:requirement|blocker|gate)\b/gi],
  ["in the queue / on the backlog", /\b(?:in|on) the (?:active )?(?:queue|backlog)\b/gi],
  ["pending approval of a UI", /\b(?:pending|awaiting)(?: customer)? approval\b/gi],
  ["needs separate authorization", /\b(?:separate|explicit|further) authorization\b/gi],
  [
    "held",
    /\bheld\b/gi,
    // "held EXECUTE / held SELECT / held the grant" — the transitive verb, not a status.
    /^held\s+[`'"*]{0,2}(?:execute|select|insert|update|delete|truncate|references|trigger|the|a|an|it|them|no|nothing|only|by|on)\b/i,
  ],
  ["will be enabled", /\benable\w*\b[^.;|\n]{0,40}\bfinaliz/gi],
  ["will be enabled", /\benable\w*\b[^.;|\n]{0,40}clinical_(?:finalization|corrections)_enabled/gi],
];

/**
 * A negation or supersession marker glued to the match — no sentence boundary in
 * between — makes the mention a statement ABOUT the retired framing rather than an
 * instance of it. "not parked", "no longer dormant", "~~held~~" are all fine.
 */
const ATTACHED_NEGATOR =
  /(?:\bnot\b|\bno\b|\bnone\b|\bnever\b|\bneither\b|\bnor\b|\bcannot\b|\bcan't\b|\bimpossible\b|\bno longer\b|\bpreviously\b|\bformerly\b|\bsupersede[ds]?\b|\bsuperseding\b|\bstale\b|\brather than\b|\binstead of\b|~~)[^.;!?]{0,28}$/i;

/** …and the same idea for a table-row LABEL, where the answer follows the label. */
// The negator must ATTACH to the framing word ("parked: no", "dormant — n/a",
// "deferred? Never"), not merely appear somewhere in the next 44 characters. The
// looser form excused ordinary re-parking prose — "parked, not abandoned", "dormant
// — no studio has the flag on today" — which is exactly the drift this guard exists
// to stop. `\bno\b` is dropped entirely: it matches far too much English.
// The negator must ATTACH to the framing word, and it must be a negator that can
// only be negating THAT word. Deliberately excluded: a bare `not`/`never`/`no`
// following the framing, because "parked, not abandoned" and "dormant — no studio
// has the flag on today" negate a DIFFERENT word while leaving the framing intact —
// which is exactly the drift this guard exists to stop. `RETIRED`, `no longer`,
// `none` and `n/a` cannot be read any other way. A leading negator ("not parked") is
// handled separately by ATTACHED_NEGATOR, and a whole-block repudiation
// ("rewritten from parked to RETIRED") by BLOCK_REPUDIATION.
const TRAILING_NEGATOR =
  // `|` is allowed because a markdown table cell boundary sits between the row
  // label and its answer: `| **Next gate** | None — RETIRED |`.
  /^[\s*_~|]*(?:[-—:,(]|->|→|to)?[\s*_~|]*(?:is|are|was|were|it is|they are)?[\s*_~|]*(?:no longer|none\b|n\/a\b|RETIRED)/i;

/** A block may also repudiate the framing wholesale, and then quote it freely. */
const BLOCK_REPUDIATION =
  /(?:it is none of those|none of those apply|not any of those|no longer applies|\bsupersede[ds]\b|for the record[,:]|original instruction|struck through|rewritten from|previously (?:described|framed|recorded) as|amended \d{4}-\d{2}-\d{2})/i;

type Violation = { file: string; framing: string; match: string; block: string };

/**
 * A list item's exculpating context usually sits in the list lead-in above it ("The
 * following are **permanently rejected**, not deferred:"), so walk back over the
 * sibling items to that lead-in. Context counts for NEGATION only — never for the
 * mention itself, which must be inside the block, or an unrelated neighbouring
 * bullet could drag a claim in.
 */
function leadIn(parts: string[], i: number): string {
  // A table row is a self-contained claim: never let the row above it exculpate it,
  // or a neighbouring "RETIRED" row would silently license the row beside it.
  if (/^\s*\|/.test(parts[i])) return "";
  const acc: string[] = [];
  for (let j = i - 1, hops = 0; j >= 0 && hops < 8; j--, hops++) {
    acc.unshift(parts[j]);
    if (!/^\s*(?:[-*+]|\d+\.)\s/.test(parts[j])) break; // reached the lead-in
  }
  return acc.join("\n");
}

function framingViolations(file: string, doc: string): Violation[] {
  const found: Violation[] = [];
  const all = blocks(doc);
  all.forEach((block, i) => {
    if (!SIGNED_RECORD_MENTION.test(block)) return;
    const ctx = `${leadIn(all, i)}\n${block}`;
    if (BLOCK_REPUDIATION.test(ctx)) return;
    for (const [framing, re, except] of FORWARD_FRAMINGS) {
      for (const m of block.matchAll(re)) {
        const at = m.index ?? 0;
        const before = ctx.slice(0, ctx.length - block.length + at);
        const after = block.slice(at + m[0].length);
        if (except && except.test(block.slice(at, at + m[0].length + 40))) continue;
        if (ATTACHED_NEGATOR.test(before)) continue;
        if (TRAILING_NEGATOR.test(after)) continue;
        found.push({ file, framing, match: m[0], block });
      }
    }
  });
  return found;
}

function describeViolations(v: Violation[]): string {
  return v
    .map(
      (x) =>
        `\n  ${x.file}: framing "${x.framing}" (matched "${x.match}") appears in a block ` +
        `about signed clinical finalization:\n    ${x.block.replace(/\n/g, "\n    ").slice(0, 600)}`,
    )
    .join("\n");
}

const WHY_RETIRED =
  "Signed / finalized clinical records are RETIRED by product decision (2026-07-29), " +
  "not paused. Describing them as parked, dormant, deferred, planned, a next gate, a " +
  "later phase, held or a launch requirement tells the next author to build a capability " +
  "the product owner permanently rejected — which is exactly the drift this guard exists " +
  "to stop. State the retirement, or say what it supersedes ('not parked', 'previously " +
  "described as parked'). See " +
  DECISION_RECORD_PATH +
  " §7.";

// ===========================================================================
// 1. The decision record exists and carries every load-bearing statement.
// ===========================================================================

describe("the decision record", () => {
  it("exists at the exact path the migration and the app comment point at", () => {
    expect(
      exists(DECISION_RECORD_PATH),
      `${DECISION_RECORD_PATH} is missing. Migration 0159's column, function and trigger ` +
        `comments all tell a practitioner (and a future engineer) to read it, and the ` +
        `session-detail page points at it too. Deleting or moving it breaks the only ` +
        `written record of WHY the capability is gone.`,
    ).toBe(true);
    // The pointers really do point here — a renamed file must be renamed everywhere.
    expect(MIGRATION).toContain(DECISION_RECORD_PATH);
    expect(read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx")).toContain(
      DECISION_RECORD_PATH,
    );
  });

  it("states the decision as a retirement, and lists what is permanently rejected", () => {
    expect(DECISION).toMatch(/^# Decision — signed \/ finalized clinical records are RETIRED/m);
    expect(DECISION).toMatch(/will \*\*not\*\* offer signed or cryptographically finalized clinical records/i);
    expect(DECISION).toMatch(/permanently rejected\*\*, not deferred/i);
    for (const rejected of [
      /practitioner-signed clinical snapshots/i,
      /immutable finalized clinical records/i,
      /"snapshot v2"/i,
      /cryptographic clinical-record hashes/i,
      /correction \/ amendment workflow built around signed snapshots/i,
      /clinical_finalization_enabled/,
      /clinical_corrections_enabled/,
      /practitioner-facing \*\*Finalize\*\* controls/i,
      /signed-record \*\*Correction\*\* controls/i,
    ]) {
      expect(DECISION, `the decision record must name this as rejected: ${rejected}`).toMatch(
        rejected,
      );
    }
  });

  it("says treatment records stay ordinary and editable — the point of the decision", () => {
    expect(DECISION).toMatch(/Treatment sessions remain ordinary, editable operational records/i);
    expect(DECISION).toMatch(/fixes it by \*\*editing the record through the normal charting commands\*\*/i);
    // The freeze state is what made finalization harmful; say that it is gone.
    expect(DECISION).toMatch(/no state in which ordinary charting becomes read-only/i);
  });

  it("says ordinary audit, attribution, provenance and tenant isolation are RETAINED", () => {
    expect(DECISION).toMatch(/What is explicitly NOT given up/i);
    expect(DECISION).toMatch(/must not be\s*weakened or removed/i);
    for (const table of [
      "public.session_audit",
      "public.record_keeping_audit_events",
      "public.session_copy_operations",
      "public.admin_action_events",
      "public.client_portal_access_events",
    ]) {
      expect(
        DECISION,
        `the decision record must name ${table} as an ACTIVE ordinary audit trail, so nobody ` +
          `cites this retirement as licence to weaken audit`,
      ).toContain(table);
    }
    expect(DECISION).toMatch(/Actor attribution and timestamps/i);
    expect(DECISION).toMatch(/Whole-session-copy provenance/i);
    expect(DECISION).toMatch(/Tenant isolation/i);
    // …and the things the retirement explicitly does NOT permit.
    expect(DECISION).toMatch(/cross-studio change of any kind/i);
    expect(DECISION).toMatch(/assigning one client's session to another client/i);
    expect(DECISION).toMatch(/browser users bypassing application commands/i);
    expect(DECISION).toMatch(/`TRUNCATE` by `authenticated`/);
    expect(DECISION).toMatch(/removing, rewriting or pruning audit data/i);
    // clinical_audit_events is NOT the operational trail — the name misleads.
    expect(DECISION).toMatch(/clinical_audit_events[\s\S]{0,400}not\b[\s\S]{0,200}operational audit trail/i);
  });

  it("records the ONE retained legacy artifact, and refuses to delete or rehash it", () => {
    expect(DECISION).toMatch(/\*\*exactly one\*\* finalized session/i);
    expect(DECISION).toMatch(/9d37c51a-6237-42ef-b9d3-28a567c2bfa8/);
    expect(DECISION).toMatch(/non-Willow controlled-test studio/i);
    expect(DECISION).toMatch(/retained, readable and unchanged/i);
    expect(DECISION).toMatch(/\*\*not deleted\*\*/i);
    expect(DECISION).toMatch(/\*\*not regenerated\*\*/i);
    expect(DECISION).toMatch(/Willow Electrolysis \| \*\*0\*\* non-draft sessions/i);
  });

  it("says reintroduction is a NEW decision, not a backlog item or a flag flip", () => {
    expect(DECISION).toMatch(/Reintroducing this would be a new decision, not a backlog item/i);
    expect(DECISION).toMatch(/new explicit product decision/i);
    expect(DECISION).toMatch(/architecture review/i);
    expect(DECISION).toMatch(/legal \/ privacy review/i);
    expect(DECISION).toMatch(/migration plan/i);
    expect(DECISION).toMatch(/fresh acceptance/i);
    expect(DECISION).toMatch(/There is no roadmap ID to pick up/i);
  });

  it("names the enforcement mechanisms, and that 0159 drops nothing", () => {
    expect(DECISION).toContain(MIGRATION_PATH);
    expect(DECISION).toMatch(/studios_clinical_finalization_retired/);
    expect(DECISION).toMatch(/studios_clinical_corrections_retired/);
    expect(DECISION).toMatch(/sessions_guard_retired_finalization/);
    expect(DECISION).toMatch(/fully immutable legacy evidence/i);
    expect(DECISION).toMatch(/\*\*0159 drops nothing\.\*\*/);
    expect(DECISION).toMatch(/guard_finalized_clinical_write/);
    expect(DECISION).toMatch(/`sessions\.record_status`\s*\nis kept|`sessions\.record_status` is kept/);
    expect(DECISION).toContain(DB_GUARD_PATH);
  });

  it("records that no document ever promised a snapshot v2 (nothing was walked back)", () => {
    // The prior sweep verified this: "snapshot v2" appeared ONLY in inline comments
    // inside a deleted DB test file. Claiming we removed published snapshot-v2
    // promises would itself be a false claim, so the record says the opposite.
    expect(DECISION).toMatch(/no Hone document ever promised a "snapshot v2"/i);
    expect(DECISION).toMatch(/existed only in\s*\n?inline comments inside a database test file/i);
  });
});

// ===========================================================================
// 2. The enforcement the documents describe is really in the migration.
// ===========================================================================

describe("migration 0159 backs the documented posture", () => {
  it("pins both flags false, revokes the retired RPCs, and guards the lifecycle", () => {
    expect(MIGRATION).toMatch(/check \(clinical_finalization_enabled = false\)/);
    expect(MIGRATION).toMatch(/check \(clinical_corrections_enabled = false\)/);
    for (const fn of [
      "public.finalize_session",
      "public.correct_finalized_session",
      "public.amend_finalized_session",
      "public.amend_finalized_session_with_image",
      "public.build_session_snapshot",
    ]) {
      const re = new RegExp(
        `revoke all on function ${fn.replace(/[.]/g, "\\.")}[\\s\\S]{0,160}?from public, anon, authenticated, service_role`,
      );
      expect(MIGRATION, `0159 must revoke EXECUTE on ${fn} from every runtime role`).toMatch(re);
    }
    expect(MIGRATION).toMatch(/create trigger sessions_guard_retired_finalization/);
    expect(MIGRATION).toMatch(/clinical_record_snapshots_retired_no_insert/);
    expect(MIGRATION).toMatch(/clinical_record_amendments_retired_no_insert/);
    expect(MIGRATION).toMatch(/clinical_audit_events_retired_no_insert/);
    expect(MIGRATION).toMatch(/grant select on table public\.session_block_areas to authenticated/);
  });

  it("drops nothing, exactly as every document claims", () => {
    // `drop trigger/policy/constraint if exists` immediately followed by a CREATE is
    // idempotent re-creation, not removal. A dropped TABLE, COLUMN or FUNCTION would
    // destroy the legacy artifact or make 0119/0120 unreplayable.
    for (const forbidden of [/drop\s+table/i, /drop\s+column/i, /drop\s+function/i, /truncate\s+table/i, /\bdelete\s+from\b/i]) {
      expect(
        MIGRATION,
        `0159 must stay additive and non-destructive (${forbidden}). The one legacy finalized ` +
          `artifact is retained audit history: deleting it destroys evidence, and rehashing it ` +
          `fabricates evidence.`,
      ).not.toMatch(forbidden);
    }
  });

  it("does NOT claim the sessions/blocks/entries/images DML revocation (that is the follow-up PR)", () => {
    // PR B moves those callers onto narrow reviewed commands FIRST. Documenting the
    // revocation before it happens would be an overclaim, and doing it now would
    // break live charting the moment the migration applied.
    for (const [name, doc] of [
      ["migration 0159", MIGRATION],
      ["docs/09", DB_RLS],
      [DECISION_RECORD_PATH, DECISION],
    ] as const) {
      const claims = blocks(doc).filter(
        (b) =>
          /revoke[\s\S]{0,80}\b(?:insert|update|delete)\b[\s\S]{0,120}from authenticated/i.test(b) &&
          /public\.(?:sessions|session_blocks|electrolysis_entries|laser_entries|treatment_images)\b/.test(
            b,
          ),
      );
      expect(
        claims,
        `${name} appears to claim row-DML on sessions/session_blocks/electrolysis_entries/` +
          `laser_entries/treatment_images is revoked from authenticated. It is NOT — the ` +
          `deployed app still writes all five directly, so 0159 deliberately leaves them. ` +
          `That is PR B, after the callers move onto narrow reviewed commands.`,
      ).toEqual([]);
    }
    expect(DB_RLS).toMatch(/is \*\*not\*\* revoked — the deployed\s*\napplication still writes all five directly/);
  });
});

// ===========================================================================
// 3. No current-authoritative document reframes the retirement as a plan.
// ===========================================================================

describe("no current-authoritative doc describes the retired capability as coming", () => {
  it("the scanned set is the real one — every file is present and non-trivial", () => {
    for (const [name, doc] of CURRENT_AUTHORITATIVE) {
      expect(doc.length, `${name} is empty or missing from the truth-guard scan set`).toBeGreaterThan(
        200,
      );
    }
    // The guard must actually be looking at clinical rows in the production docs; if a
    // rewrite dropped the subject entirely, the framing scan would pass vacuously.
    for (const [name, doc] of [
      ["README.md", README],
      ["docs/09_DATABASE_AND_RLS.md", DB_RLS],
      ["docs/14 current block", HANDOFF_CURRENT],
      ["docs/production/current-state.md", CURRENT_STATE],
      ["docs/production/capability-register.md", CAPABILITY_REGISTER],
      ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
      ["docs/roadmap/CANONICAL_ROADMAP.md", ROADMAP],
      ["docs/marketing/product-truth-register.md", TRUTH_REGISTER],
    ] as const) {
      expect(
        blocks(doc).some((b) => SIGNED_RECORD_MENTION.test(b) && /\bretired\b/i.test(b)),
        `${name} must still carry a clinical-finalization row and it must say RETIRED. ` +
          `Silently deleting the subject is not the same as retiring it: a reader who never ` +
          `sees the decision will re-propose the capability.`,
      ).toBe(true);
    }
  });

  for (const [name, doc] of CURRENT_AUTHORITATIVE) {
    it(`${name} carries no parked/dormant/deferred/planned framing near a signed-record mention`, () => {
      const v = framingViolations(name, doc);
      expect(v, `${WHY_RETIRED}${describeViolations(v)}`).toEqual([]);
    });
  }

  it("no current-authoritative doc says Hone will enable either retired flag", () => {
    const all: Violation[] = [];
    for (const [name, doc] of CURRENT_AUTHORITATIVE) {
      for (const block of blocks(doc)) {
        for (const m of block.matchAll(
          /\b(?:will|shall|plan(?:s|ned)? to|intend(?:s)? to|once|when|after|before)\b[^.;|\n]{0,120}\benabl\w+\b[^.;|\n]{0,80}(?:clinical_(?:finalization|corrections)_enabled|finaliz\w+)/gi,
        )) {
          const before = block.slice(0, m.index ?? 0);
          if (ATTACHED_NEGATOR.test(before)) continue;
          if (BLOCK_REPUDIATION.test(block)) continue;
          all.push({ file: name, framing: "promise to enable a retired flag", match: m[0], block });
        }
      }
    }
    expect(
      all,
      `A document promises to enable clinical_finalization_enabled or ` +
        `clinical_corrections_enabled. No role can: migration 0159 pins both false with CHECK ` +
        `constraints. ${WHY_RETIRED}${describeViolations(all)}`,
    ).toEqual([]);
  });

  it("the docs state the affirmative posture: pinned false, unreachable, retained artifact", () => {
    expect(README).toMatch(/RETIRED by product decision \(2026-07-29\)/);
    expect(README).toMatch(/ordinary editable operational records/i);
    expect(DB_RLS).toMatch(/Signed and cryptographically finalized clinical records are RETIRED/);
    expect(DB_RLS).toMatch(/They are not parked, not\s*\ndormant and not a later phase/);
    expect(DB_RLS).toMatch(/pinned `false`/);
    expect(DB_RLS).toMatch(/fully immutable legacy evidence/i);
    expect(DB_RLS).toMatch(/session_block_areas/);
    expect(DB_RLS).toMatch(/TRUNCATE.{0,60}REFERENCES.{0,60}TRIGGER/s);
    expect(HANDOFF_CURRENT).toMatch(/RETIRED by product decision 2026-07-29/);
    expect(HANDOFF_CURRENT).toMatch(/not parked and not coming back/i);
  });

  it("no doc promises snapshot v2 or a signed structured-area correction framework", () => {
    const all: Violation[] = [];
    for (const [name, doc] of CURRENT_AUTHORITATIVE) {
      const parts = blocks(doc);
      parts.forEach((block, i) => {
        const ctx = `${leadIn(parts, i)}\n${block}`;
        for (const m of block.matchAll(
          /\b(?:snapshot v2|structured-area (?:signed-)?corrections?|signed structured-area\w*)\b/gi,
        )) {
          const before = ctx.slice(0, ctx.length - block.length + (m.index ?? 0));
          const after = block.slice((m.index ?? 0) + m[0].length);
          // A mention is fine only as a refusal: "no snapshot v2", "…is retired".
          const refused =
            ATTACHED_NEGATOR.test(before) ||
            TRAILING_NEGATOR.test(after) ||
            BLOCK_REPUDIATION.test(ctx) ||
            /\bretired\b|\brejected\b|permanently/i.test(ctx);
          if (refused) continue;
          all.push({ file: name, framing: "snapshot v2 / signed structured-area corrections", match: m[0], block });
        }
      });
    }
    expect(
      all,
      `Snapshot v2 and signed structured-area corrections are RETIRED, not deferred, and no ` +
        `document ever promised them in the first place (the phrase existed only in inline ` +
        `comments in a since-deleted DB test). ${WHY_RETIRED}${describeViolations(all)}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 4. The canonical roadmap and the machine-readable manifest carry the terminal
//    state. These two are what a future agent reads to decide what to build.
// ===========================================================================

describe("roadmap SEC-09 is retired in place", () => {
  it("keeps the ID, marks it RETIRED, and forbids opening work against it", () => {
    expect(
      ROADMAP,
      `SEC-09 must be RETIRED IN PLACE, not deleted: the roadmap declares itself canonical and ` +
        `requires new work to map to a roadmap ID, so a silently removed ID invites someone to ` +
        `re-add it.`,
    ).toMatch(/### SEC-09: Clinical finalization, amendments, and chart contract — \*\*RETIRED \(2026-07-29\)\*\*/);
    const sec09 = slice(ROADMAP, /^### SEC-09:/m, /^### SEC-10|^## /m, "roadmap SEC-09");
    expect(sec09).toMatch(/\*\*Status: RETIRED\.\*\*/);
    expect(sec09).toMatch(/no work maps to it and none may be opened against it/i);
    expect(sec09).toMatch(/permanently rejected/i);
    expect(sec09).toContain(DECISION_RECORD_PATH);
    // The original standing instruction may remain ONLY as a quoted, superseded relic.
    const original = /Close any remaining gaps in immutable snapshots, amendment attribution/;
    if (original.test(ROADMAP)) {
      const block = blocks(ROADMAP).find((b) => original.test(b))!;
      expect(
        block,
        `The SEC-09 instruction "close any remaining gaps in immutable snapshots, amendment ` +
          `attribution…" is a standing order to build the rejected capability. It may survive ` +
          `ONLY inside an explicit superseded/original-instruction marker.`,
      ).toMatch(/superseded|original instruction/i);
    }
    expect(sec09).toMatch(/retained and must not be weakened/i);
    expect(sec09).toMatch(/`clinical_audit_events` is \*\*not\*\* one of them/);
  });

  it("WAVE1 slice 7 is cancelled, and its synthetic-tenant enablement step is impossible", () => {
    expect(WAVE1).toMatch(/\*\*Clinical finalization — CANCELLED \/ RETIRED \(2026-07-29\)\.\*\*/);
    expect(WAVE1).toMatch(/this\s*\n?\s*slice will never be written/i);
    expect(WAVE1).toMatch(/no tenant, synthetic or real, can enable finalization/i);
    expect(WAVE1).toContain(DB_GUARD_PATH);
  });
});

describe("the capability manifest carries a terminal rejection state", () => {
  const manifest = JSON.parse(MANIFEST_RAW) as Record<string, unknown>;

  function entry(): Record<string, unknown> {
    const caps = (manifest.capabilities ?? manifest) as Record<string, Record<string, unknown>>;
    const found = caps.clinical_finalization_amendments;
    expect(
      found,
      `CAPABILITY_MANIFEST.json must keep the clinical_finalization_amendments entry — it is ` +
        `the only MACHINE-READABLE status artifact, and a deleted entry reads as "never ` +
        `existed" rather than "retired".`,
    ).toBeTruthy();
    return found;
  }

  it("the 7-axis ladder gains an explicit terminal marker rather than sitting mid-rung", () => {
    const e = entry();
    expect(
      e.retired,
      `The ladder (designed → code_complete → deployed → enabled → exercised → approved → ` +
        `generally_available) has NO terminal rejection rung, so an entry left at rung 3 reads ` +
        `as "in progress". clinical_finalization_amendments must carry retired: true.`,
    ).toBe(true);
    expect(e.retired_on).toBe("2026-07-29");
    expect(e.retired_decision_record).toBe(DECISION_RECORD_PATH);
    expect(e.retired_enforced_by_migration).toBe("0159");
    // Enablement is not merely off — it is impossible.
    expect(e.enabled).toBe(false);
    expect(e.enabled_possible).toBe(false);
  });

  it("its notes say RETIRED / TERMINAL and no longer say parked pending UI approval", () => {
    const notes = String(entry().notes ?? "");
    expect(notes).toMatch(/RETIRED -- TERMINAL|RETIRED — TERMINAL/);
    expect(notes).toMatch(/NOT a Hone product capability/i);
    expect(notes).toMatch(/ORDINARY EDITABLE operational records/i);
    // The old note read "parked pending customer approval of UI". It may only appear as
    // an explicitly superseded quotation.
    const parked = /parked pending customer approval/i;
    if (parked.test(notes)) {
      expect(
        notes,
        `The manifest note "parked pending customer approval of UI" must be marked superseded, ` +
          `not left standing. ${WHY_RETIRED}`,
      ).toMatch(/superseded/i);
    }
    expect(notes).toMatch(/session_audit/);
    expect(notes).toMatch(/client_clinical_notes/);
  });
});

// ===========================================================================
// 5. The decision record is linked from the documents it governs.
// ===========================================================================

describe("the decision record is reachable from the docs it governs", () => {
  const LINK = /decisions\/clinical-finalization-retired\.md/;
  const GOVERNED: ReadonlyArray<readonly [string, string]> = [
    ["README.md", README],
    ["docs/09_DATABASE_AND_RLS.md", DB_RLS],
    ["docs/14_AI_HANDOFF.md (Current production summary block)", HANDOFF_CURRENT],
    ["docs/production/current-state.md", CURRENT_STATE],
    ["docs/production/capability-register.md", CAPABILITY_REGISTER],
    ["docs/production/known-limitations.md", KNOWN_LIMITATIONS],
    ["docs/roadmap/CANONICAL_ROADMAP.md", ROADMAP],
    ["docs/roadmap/WAVE1_DESIGN.md", WAVE1],
    ["docs/marketing/product-truth-register.md", TRUTH_REGISTER],
  ] as const;

  for (const [name, doc] of GOVERNED) {
    it(`${name} links to the decision record`, () => {
      expect(
        doc,
        `${name} states the retirement but does not link ${DECISION_RECORD_PATH}. A reader who ` +
          `cannot reach the reasoning will re-litigate it — and the reasoning is the part that ` +
          `stops the capability coming back.`,
      ).toMatch(LINK);
    });
  }

  it("the decision record links back to the production docs and the roadmap it supersedes", () => {
    for (const back of [
      "../production/current-state.md",
      "../production/capability-register.md",
      "../production/known-limitations.md",
      "../roadmap/CANONICAL_ROADMAP.md",
      "../roadmap/CAPABILITY_MANIFEST.json",
      "../roadmap/WAVE1_DESIGN.md",
      "../marketing/product-truth-register.md",
    ]) {
      expect(DECISION, `the decision record must point at ${back}`).toContain(back);
    }
  });
});

// ===========================================================================
// 6. The retired surfaces are gone from the application, and cannot come back
//    quietly through a call site.
// ===========================================================================

describe("no application surface invokes the retired capability", () => {
  it("the finalize / signed-correction UI and server actions are deleted", () => {
    for (const gone of [
      "app/(app)/clients/[id]/sessions/[sessionId]/FinalizeSessionCard.tsx",
      "app/(app)/clients/[id]/sessions/[sessionId]/RecordVersionsPanel.tsx",
      "app/(app)/clients/[id]/sessions/[sessionId]/finalize-actions.ts",
      "app/(app)/clients/[id]/sessions/[sessionId]/correction-actions.ts",
    ]) {
      expect(
        exists(gone),
        `${gone} is back. Practitioner-facing Finalize and signed-record Correction controls ` +
          `are permanently rejected; re-adding one needs a new product decision, not a PR.`,
      ).toBe(false);
    }
  });

  it("the DB-lane retirement guard exists (this unit guard only covers wording)", () => {
    expect(
      exists(DB_GUARD_PATH),
      `${DB_GUARD_PATH} is the only proof the retirement HOLDS against a real database. This ` +
        `docs guard proves the documents agree with it; it cannot replace it.`,
    ).toBe(true);
  });
});

// ===========================================================================
// 7. NO OVERCORRECTION. "correction", "amendment", "immutable", "finalized" and
//    "snapshot" have legitimate unrelated uses. They must all survive.
// ===========================================================================

describe("no overcorrection — unrelated capabilities keep their wording", () => {
  it("append-only clinical NOTES are untouched and NOT retired (a correction is a new row)", () => {
    expect(NOTES_CONTRACT).toMatch(/# Clinical notes — append-only \+ access contract/);
    expect(NOTES_CONTRACT).toMatch(/A correction\/revision is a\s*\n?\s*\*\*new row\*\*/);
    expect(NOTES_CONTRACT).toMatch(/never overwritten in place/i);
    expect(NOTES_CONTRACT).toMatch(/client_clinical_notes_no_update/);
    expect(NOTES_CONTRACT).not.toMatch(/\bretired\b/i);
    // Nothing anywhere may claim the NOTES capability is retired: it is live for every
    // studio, has no flag, and has nothing to do with 0119/0120.
    const wrong: Violation[] = [];
    for (const [name, doc] of CURRENT_AUTHORITATIVE) {
      for (const block of blocks(doc)) {
        if (/client_clinical_notes|clinical notes/i.test(block) && /\bretired\b/i.test(block)) {
          // Allowed only when the block is distinguishing them ("unrelated, NOT retired").
          if (/not retired|unrelated|nothing to do with|untouched/i.test(block)) continue;
          wrong.push({ file: name, framing: "clinical NOTES described as retired", match: "", block });
        }
      }
    }
    expect(
      wrong,
      `Append-only clinical NOTES (client_clinical_notes, 0126/0127) are LIVE for every studio ` +
        `and are NOT part of the retirement. Only the signed-snapshot system (0119/0120) is ` +
        `retired.${describeViolations(wrong)}`,
    ).toEqual([]);
    // The decision record itself must call this out, so a future sweep does not conflate them.
    expect(DECISION).toMatch(/Unrelated, and deliberately untouched/i);
    expect(DECISION).toContain("clinical-notes-append-only-contract.md");
  });

  it("consent-signature immutability and the *_snapshot columns keep their wording", () => {
    expect(DOMAIN_MODEL).toMatch(/`client_consent_signatures`: append-only immutable/);
    expect(DOMAIN_MODEL).toMatch(/a deny is still a signed record/i);
    expect(DOMAIN_MODEL).toMatch(/buffer_minutes_snapshot/);
    expect(DOMAIN_MODEL).toMatch(/policy_snapshot_hash/);
    // docs/02 frames none of this as clinical finalization, so it needs no retirement note.
    expect(framingViolations("docs/02_DOMAIN_MODEL.md", DOMAIN_MODEL)).toEqual([]);
  });

  it("Stripe webhook idempotency and the payment ledgers keep their wording", () => {
    const payments = read("docs/06_PAYMENTS_AND_STRIPE.md");
    expect(payments).toMatch(/for idempotency \(short-circuits re-delivery\)/);
    expect(payments).toMatch(/refund_idempotency_key/);
  });

  it("ordinary session audit is still described as ACTIVE, not swept up in the retirement", () => {
    for (const [name, doc] of [
      ["docs/09_DATABASE_AND_RLS.md", DB_RLS],
      [DECISION_RECORD_PATH, DECISION],
    ] as const) {
      expect(doc, `${name} must still name session_audit as an active audit trail`).toMatch(
        /session_audit/,
      );
    }
    expect(DB_RLS).toMatch(/`clinical_audit_events` is \*\*not\*\* Hone's operational audit trail/);
  });
});

// ---------------------------------------------------------------------------
// 5. POST-APPLY TRUTH (added 2026-07-30, after migration 0159 was applied).
//
// 0159 is APPLIED in production. The documents must say so, must not regress to
// "not yet applied", and must keep the two distinctions that are easy to blur:
//   * the DB retirement is live NOW, but the practitioner-facing dead code is
//     only removed when PR #482 deploys; and
//   * 0160 is a SEPARATE, UNAPPLIED migration — it must never be described as
//     already applied, and its lock-timeout defect must stay recorded.
// ---------------------------------------------------------------------------

const MIGRATION_LEDGER = read("docs/production/migration-ledger.md");

/**
 * Markdown prose is hard-wrapped and often nested in a blockquote, so a sentence
 * spans lines as `… did not\n> arm …`. Flatten blockquote markers and runs of
 * whitespace so an assertion pins the SENTENCE rather than the line breaks —
 * without weakening it into a bare substring test.
 */
function flat(doc: string): string {
  return doc
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * The ledger's "Correcting prior stale statements" section QUOTES stale phrases
 * in order to refute them, so a naive stale-phrase scan fires on the correction
 * itself. Drop that section before scanning; it is asserted separately below.
 */
const LEDGER_WITHOUT_CORRECTIONS = MIGRATION_LEDGER.split(
  /^## Correcting prior stale statements$/m,
)[0];

describe("post-apply truth — migration 0159 is applied in production", () => {
  const APPLIED_DOCS = [
    ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
    ["docs/production/current-state.md", CURRENT_STATE],
    ["docs/production/capability-register.md", CAPABILITY_REGISTER],
    ["docs/09_DATABASE_AND_RLS.md", DB_RLS],
    [DECISION_RECORD_PATH, DECISION],
  ] as const;

  it("the ledger records the verified apply: date, window and full checksum", () => {
    expect(MIGRATION_LEDGER).toMatch(/2026-07-30T13:25:39Z/);
    expect(MIGRATION_LEDGER).toMatch(/13:25:43Z/);
    expect(
      MIGRATION_LEDGER,
      "the ledger must carry the COMPLETE sha256 of the applied 0159 file, not an abbreviation",
    ).toMatch(/ea39fc360cc75609a92a3686d677486720e9d234c4b70b81a07913c31fb889f8/);
  });

  it("every current-state document says 0159 is applied, not pending", () => {
    for (const [name, doc] of APPLIED_DOCS) {
      expect(doc, `${name} must state that 0159 is APPLIED to production`).toMatch(
        /0159[^.\n]{0,120}\bapplied\b/i,
      );
    }
  });

  it("no current-state document still claims 0159 is unapplied", () => {
    // Scoped to sentences that name 0159, so unrelated historical "not yet
    // applied" prose about 0093/0094/0095/0096 is untouched.
    const STALE =
      /0159[^.\n]{0,160}?\b(?:not (?:yet )?applied|unapplied|is pending|awaiting (?:migration|authorization)|needs migration-only)/i;
    const REVERSE =
      /\b(?:not (?:yet )?applied|unapplied|awaiting migration-only authorization)[^.\n]{0,80}?0159/i;
    const SCANNED = APPLIED_DOCS.map(([name, doc]) =>
      name === "docs/production/migration-ledger.md"
        ? ([name, LEDGER_WITHOUT_CORRECTIONS] as const)
        : ([name, doc] as const),
    );
    for (const [name, doc] of SCANNED) {
      expect(doc, `${name} still describes 0159 as unapplied`).not.toMatch(STALE);
      expect(doc, `${name} still describes 0159 as unapplied`).not.toMatch(REVERSE);
    }
  });

  it("the ledger's corrections section explicitly retires the old 0159-pending wording", () => {
    const corrections = MIGRATION_LEDGER.split(
      /^## Correcting prior stale statements$/m,
    )[1];
    expect(
      corrections,
      "the corrections section must list the superseded 0159 claims so a reader who meets " +
        "them in dated prose knows they are dead",
    ).toBeTruthy();
    expect(flat(corrections)).toMatch(
      /"0159 is in repo but not yet applied"[^—]*—[^.]*\*\*0159 was applied/,
    );
  });

  it("the ledger states hosted max 0164 and repo max 0165 (0165 is written, NOT applied)", () => {
    // Pinned to the specific rows. An existence check is not enough: the ledger
    // names 0159 in several places, so a flipped hosted-max row would still find
    // a match somewhere else in the file.
    // 0162 (intake review transition integrity) was APPLIED to production
    // 2026-08-02, so hosted and repo are level again. The assertions below are
    // the reverse of what they enforced while it was still an unapplied DRAFT.
    expect(
      MIGRATION_LEDGER,
      "the ledger's Hosted (production) migration max row must read 0164",
    ).toMatch(
      /\|\s*\*\*Hosted \(production\) migration max\*\*\s*\|\s*\*\*0164\*\*/,
    );
    expect(
      MIGRATION_LEDGER,
      "the ledger's Repo migration max row must read 0165 (0165 is written but NOT applied)",
    ).toMatch(/\|\s*\*\*Repo migration max\*\*\s*\|\s*\*\*0165\*\*/);
    expect(
      MIGRATION_LEDGER,
      "…and must record 0161 as APPLIED with its checksum, not as pending",
    ).toMatch(
      new RegExp(
        "0161[\\s\\S]{0,240}APPLIED 2026-07-30[\\s\\S]{0,160}" +
          "e2a3e4a770c79799042b542d9f2fcbdc13d2a9f1e30774221c1777ccbae33a46" ,
      ),
    );
    expect(
      MIGRATION_LEDGER,
      "…and must record 0162 as APPLIED with its frozen checksum, not as pending",
    ).toMatch(
      new RegExp(
        "0162[\\s\\S]{0,240}APPLIED 2026-08-02[\\s\\S]{0,200}" +
          "41ccc745536806a417614b92202634811f0ae9e854f584f26badbf6ec01c1088",
      ),
    );
    expect(
      MIGRATION_LEDGER,
      "…and must record 0163 as APPLIED with its frozen checksum, not as pending",
    ).toMatch(
      new RegExp(
        "0163[\\s\\S]{0,240}APPLIED 2026-08-02[\\s\\S]{0,800}" +
          "71bc681aa87740af7696cb602c188acc9bbd9be6d0989dcc1f09000f3d8960d6",
      ),
    );
    expect(
      MIGRATION_LEDGER,
      "no ledger row may still describe 0161 or 0162 as unapplied",
    ).not.toMatch(/016[12][^.\n]{0,80}\b(?:NEVER been applied|is unapplied)/i);
    expect(
      MIGRATION_LEDGER,
      "no ledger row may still assert a hosted/production migration max of 0157 or 0159",
    ).not.toMatch(/\|\s*\*\*(?:Hosted \(production\)|Repo) migration max\*\*\s*\|\s*\*\*015[79]\*\*/);
  });

  it("production migration max is stated as 0164 where a max is asserted", () => {
    for (const [name, doc] of [
      ["docs/production/migration-ledger.md", MIGRATION_LEDGER],
      ["docs/production/current-state.md", CURRENT_STATE],
      ["docs/09_DATABASE_AND_RLS.md", DB_RLS],
      ["README.md", README],
      ["docs/roadmap/CANONICAL_ROADMAP.md", ROADMAP],
    ] as const) {
      expect(doc, `${name} must assert production migration max 0164`).toMatch(
        /(?:migration max|max)[^.\n]{0,80}\b0164\b/i,
      );
      expect(
        doc,
        `${name} must not still assert a production migration max of 0157, 0159, 0161, 0162 or 0163`,
      ).not.toMatch(
        /production\s+migration\s+max\s*(?:=|is|:)?\s*\*{0,2}(?:015[79]|016[123])\b/i,
      );
    }
  });

  it("0158 stays absent and permanently skipped; 0160 AND 0161 are both APPLIED", () => {
    expect(MIGRATION_LEDGER).toMatch(/0158[^.\n]{0,120}\bskipped\b/i);
    expect(MIGRATION_LEDGER).toMatch(/\bnever be applied\b/i);
    // 0160 is APPLIED as of 2026-07-30. This assertion is the reverse of what it
    // was before the apply, and is pinned to the ledger's own status row.
    expect(
      MIGRATION_LEDGER,
      "the ledger's 0160 row must state it is APPLIED, not pending",
    ).toMatch(/\|\s*\*\*`0160`\*\*\s*\|\s*\*\*APPLIED 2026-07-30\*\*/);
    expect(
      MIGRATION_LEDGER,
      "no current ledger row may still describe 0160 as unapplied or not authorized",
    ).not.toMatch(/`0160`[^.\n]{0,60}\b(?:remains|is)\s+\*\*(?:unapplied|NOT applied)/i);
    // 0161 is APPLIED as of 2026-07-30. This assertion has now been reversed
    // twice: first from "no 0161 exists" to "present but unapplied", and now to
    // "applied". Each reversal is deliberate and matches production.
    expect(
      MIGRATION_LEDGER,
      "the ledger must describe 0161 as APPLIED",
    ).toMatch(/`0161`[\s\S]{0,200}APPLIED 2026-07-30/i);
    expect(MIGRATION_LEDGER).not.toMatch(/no `0161` exists|There is no `0161`/i);
  });

  it("the UI/source cleanup is described as SHIPPED, now that #482 has merged and deployed", () => {
    // Superseded 2026-07-30. This guard previously asserted the opposite — that the
    // cleanup was still *pending* — which was correct while #482 was unmerged. #482
    // merged at d77d4434 and deployed successfully, so the pending wording became the
    // false claim and this guard now pins the reverse.
    expect(
      CURRENT_STATE,
      "current-state must now say the Finalize/Correction surfaces are REMOVED — #482 merged " +
        "and deployed, so 'pending deployment' is no longer true",
    ).toMatch(/Correction controls \| \*\*REMOVED — both from the database and from the deployed source\.\*\*/);
    expect(
      CURRENT_STATE,
      "current-state must cite the merge SHA as the evidence that the source removal shipped",
    ).toMatch(/d77d44346addd98f4829f757531011bc7ca0c0d1/);
    expect(
      CURRENT_STATE,
      "current-state must not still describe the source removal as pending a deployment",
    ).not.toMatch(/source removal pending/i);
  });

  it("states both halves of the removal: flags pinned false AND the source deleted", () => {
    expect(CURRENT_STATE).toMatch(/clinical_finalization_enabled/);
    expect(
      CURRENT_STATE,
      "the DB half must still be stated — flags pinned false by validated CHECK and EXECUTE revoked",
    ).toMatch(/validated CHECK constraint and revoked `EXECUTE` from every runtime role/);
    expect(
      CURRENT_STATE,
      "the source half must name the four deleted files so a reader can verify the claim",
    ).toMatch(/FinalizeSessionCard[\s\S]{0,160}RecordVersionsPanel/);
    expect(
      CURRENT_STATE,
      "and must state plainly that no such surface exists in the running application",
    ).toMatch(/no Finalize or signed-Correction surface in the running application/i);
  });

  it("the 0120 GUC permit is documented as REMOVED, never as still honoured", () => {
    expect(DB_RLS).toMatch(/REMOVED by 0159 and is no longer honoured/);
    expect(DB_RLS).not.toMatch(/the write-guard honours \*\*only\*\* when/);
    expect(CURRENT_STATE).toMatch(/hone\.correction_session_id[^.\n]{0,80}\*\*removed\*\*/i);
  });

  it("records the SET LOCAL anomaly and does not imply the apply was atomic", () => {
    const L = flat(MIGRATION_LEDGER);
    expect(L).toMatch(/WARNING \(25P01\)/);
    expect(L).toMatch(/SET LOCAL can only be used in transaction blocks/);
    expect(L, "the ledger must say the five-second timeout did not arm").toMatch(
      /five-second lock timeout did not arm/i,
    );
    expect(L, "the ledger must state plainly that the apply was NOT atomic").toMatch(
      /the apply was therefore NOT atomic/,
    );
    expect(
      L,
      "the ledger must record that completeness was verified section-by-section rather than " +
        "assumed from rollback",
    ).toMatch(/independently verified/i);
  });

  it("forbids rewriting EITHER applied migration — 0159 and 0160 are both immutable now", () => {
    const L = flat(MIGRATION_LEDGER);
    expect(L).toMatch(
      /Do not "fix" the lock-timeout line in `0159` — it is already applied\./,
    );
    expect(
      L,
      "the ledger must record that 0160's identical lock-timeout line HAS BEEN corrected — it was, " +
        "in PR #483, so demanding the correction as future work is now the false claim",
    ).toMatch(/same `set local lock_timeout` line in `0160` HAS BEEN CORRECTED/);
    expect(
      L,
      "…and that 0160 was then APPLIED, so it too is now immutable. This assertion is the reverse " +
        "of what it was before 2026-07-30; an applied migration is never edited.",
    ).toMatch(
      /`0160` was subsequently applied to production on 2026-07-30[^.]*and must not be edited either/i,
    );
  });

  it("the applied 0159 file still carries the exact line the ledger's checksum covers", () => {
    // Pins the applied artifact: if someone edits 0159 to 'fix' the lock timeout,
    // the recorded checksum silently stops describing the file on disk.
    expect(
      MIGRATION,
      "0159 is APPLIED. Its text must not be edited — amend a NEW migration instead.",
    ).toMatch(/set local lock_timeout = '5s';/);
  });
});
