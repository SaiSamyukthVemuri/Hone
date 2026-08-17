import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0184 — least-privilege repair for client_budget_context.
//
// 0183 is APPLIED TO PRODUCTION and therefore FROZEN. It stated its privilege
// contract as an allowlist ("authenticated gets SELECT/INSERT/UPDATE") but
// enforced it as a denylist (`revoke delete, truncate`), so every privilege it
// did not name survived from Supabase's create-time defaults — REFERENCES,
// TRIGGER and MAINTAIN. 0184 revokes everything and grants back exactly three.
//
// The behavioural half of this repair — that the tightened grants close the
// CREATE TRIGGER escalation while every trigger still fires — lives in
// tests/db/client-budget-context.db.test.ts against the real migrated
// database. This file is the source contract.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0184";
const SQL = readFileSync(
  path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)),
  "utf8",
);
// The header deliberately discusses what 0184 does NOT do (and quotes 0183's
// defective statement), so negative assertions run against executable SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

function canonicalRecord(): { hosted_note: string } {
  return JSON.parse(
    readFileSync(path.join(ROOT, "docs/production/migration-state.json"), "utf8"),
  );
}

/**
 * The canonical hosted_note names exactly ONE current record, and it is 0184's
 * supersession of 0183. Every other migration named in the note is a
 * historical chain link and must read as one.
 *
 * COUNTS rather than confirms presence: a duplicated transition clause once
 * survived six assertions that each checked a phrase in isolation.
 */
function assertSingleCurrentRecord(note: string): void {
  const occurrences = (hay: string, needle: string): number =>
    hay.split(needle).length - 1;

  expect(
    occurrences(note, "as the CURRENT hosted-state record"),
    "the canonical note must name exactly ONE current hosted record",
  ).toBe(1);

  expect(note).toContain(
    "SUPERSEDES the 0183 record as the CURRENT hosted-state record",
  );

  // Generic by migration number, so a future rewrite mislabelling a DIFFERENT
  // migration is caught too. The lookbehind excludes the one legitimate form:
  // the supersession clause names the migration being REPLACED.
  const mislabelled = [
    ...note.matchAll(/(?<!SUPERSEDES )the (\d{4}) record as the CURRENT/g),
  ].map((m) => m[1]);
  expect(
    mislabelled,
    `historical record(s) wrongly labelled CURRENT: ${mislabelled.join(", ")}`,
  ).toEqual([]);

  // The chain is still carried forward, head to oldest link.
  for (const sha of [
    "a7b8926832747319024d7c89213688b68fb363d09e88317e3bba6dbb17c6fbeb", // 0183
    "07ee23e1254329168e205f42b47c351205ebb306afc0f7d524b69c8d14ecda57", // 0182
    "2f5bcbd5854b1201835f6151debffa940e98035e6a4d88865da1d86fb3da195f", // 0181
    "f4e8535093721c6fb9c677925a3e4a8f202e3f2ad56b6d6208da608f5d2a62e6", // 0171 tail
  ]) {
    expect(note, sha).toContain(sha);
  }

  expect(
    occurrences(note, "CARRIES THE FULL CHECKSUM CHAIN FORWARD"),
    "the note must declare the chain-forward transition exactly once",
  ).toBe(1);
}

describe("0184: file and numbering", () => {
  it("is the repository maximum and carries the version exactly once", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(countVersion(VERSION)).toBe(1);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is a NEW migration — 0183 was applied and must not be edited", () => {
    // The repair could not be made in place: 0183 had reached hosted
    // production, so its bytes are frozen and a correction is a new number.
    expect(countVersion("0183")).toBe(1);
    expect(migrationState().versions).toContain("0183");
  });

  it("IS applied to production — hosted state is declared, not derived", () => {
    // THE HAND-OFF HAPPENED. This block previously asserted the PRE-APPLY
    // state (hosted 0183, pending ["0184"]) and was written to go red the
    // moment the rollout ran, so the apply could not be recorded without
    // updating the canonical record in the same change. 0184 was applied on
    // 2026-08-17 and this block was flipped in that same change.
    //
    // repo == hosted now: nothing is pending, and 0185 is available but NOT
    // claimed.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.pending_migrations).toEqual([]);
    expect(state.repo_equals_hosted).toBe(true);
    expect(state.next_free_migration).toBe("0185");
  });

  it("stamps the CURRENT apply as an OPERATOR-OBSERVED window, not a server time", () => {
    const state = migrationState();
    expect(state.hosted_applied_at).toBe("2026-08-17T12:03:01Z");
    expect(state.hosted_applied_at_precision).toMatch(/operator-observed/i);
    expect(state.hosted_applied_at_precision).toMatch(
      /NOT a server-generated migration timestamp/i,
    );
  });

  it("the canonical record carries 0184's apply evidence, honestly", () => {
    const REC = canonicalRecord();
    // What was actually captured.
    expect(REC.hosted_note).toContain(
      "aa110edadd459e0f11062e3904ea7ad54a54a75c31d9342b762a533ecc07694c",
    );
    expect(REC.hosted_note).toMatch(/DRY-RUN EXIT 0/);
    expect(REC.hosted_note).toMatch(/PUSH EXIT CODE 0 EXPLICITLY CAPTURED/);
    expect(REC.hosted_note).toMatch(/0184 \| 0184/);
    expect(REC.hosted_note).toMatch(/schema dump exit 0/i);
    // The final ACL result, which is the whole point of the migration.
    expect(REC.hosted_note).toMatch(
      /GRANT SELECT,INSERT,UPDATE ON TABLE public\.client_budget_context TO authenticated/,
    );
    expect(REC.hosted_note).toMatch(/REFERENCES, TRIGGER and MAINTAIN are gone/);
    // The limitations, stated rather than glossed.
    expect(REC.hosted_note).toMatch(
      /OPERATOR-OBSERVED CLIENT-SIDE WINDOWS, NOT SERVER-GENERATED/i,
    );
    expect(REC.hosted_note).toMatch(
      /NO production row count was captured and none is claimed/i,
    );
    // The deliberate omission is named, not hidden.
    expect(REC.hosted_note).toMatch(/set_updated_at\(\) was DELIBERATELY NOT TOUCHED/);
    // And the application has NOT shipped — production holds schema with no UI.
    expect(REC.hosted_note).toMatch(/#593 remains OPEN and UNMERGED/);
  });

  it("names exactly ONE current record — a historical link can never be CURRENT", () => {
    // Inherited from 0183's block at the handoff. The 0183 rewrite once left a
    // stale transition clause attached to 0181, so the note named two current
    // records at once; every surrounding assertion passed because each checked
    // a phrase in ISOLATION. This one COUNTS.
    assertSingleCurrentRecord(canonicalRecord().hosted_note);
  });

  it("ANTI-VACUITY: re-labelling a historical link as CURRENT is caught", () => {
    // Mutates a COPY. The real record is never touched.
    const note = canonicalRecord().hosted_note;
    expect(() => assertSingleCurrentRecord(note)).not.toThrow();
    for (const injection of [
      "the 0183 record as the CURRENT hosted-state record and CARRIES THE FULL CHECKSUM CHAIN FORWARD so no earlier apply record is dropped: ",
      "the 0181 record as the CURRENT hosted-state record ",
      "and CARRIES THE FULL CHECKSUM CHAIN FORWARD again ",
    ]) {
      const mutated = note.replace(
        "the 0182 record (0182_sterile",
        injection + "the 0182 record (0182_sterile",
      );
      expect(mutated).not.toEqual(note);
      expect(
        () => assertSingleCurrentRecord(mutated),
        `a mislabelled historical record went undetected: ${injection.slice(0, 55)}`,
      ).toThrow();
    }
  });

  it("the APPLIED bytes still hash to the recorded checksum", () => {
    // 0184 is frozen: production ran these exact bytes.
    expect(createHash("sha256").update(SQL, "utf8").digest("hex")).toBe(
      "aa110edadd459e0f11062e3904ea7ad54a54a75c31d9342b762a533ecc07694c",
    );
  });

  it("0185 is available but NOT claimed", () => {
    expect(migrationState().next_free_migration).toBe("0185");
    expect(countVersion("0185")).toBe(0);
  });

  it("never reintroduces 0158, which is permanently skipped", () => {
    expect(countVersion("0158")).toBe(0);
  });

  it("opens its own transaction with a bounded lock timeout", () => {
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
    expect(CODE.indexOf("set local lock_timeout")).toBeGreaterThan(
      CODE.indexOf("begin;"),
    );
  });
});

describe("0184: the table contract is an ALLOWLIST, not a denylist", () => {
  it("REVOKES ALL from every role before granting anything back", () => {
    // This is the whole fix. `revoke all` covers MAINTAIN — a PostgreSQL 17
    // privilege that no by-name revoke list written for 0183 could have
    // contained — and any privilege a future release invents.
    expect(CODE).toMatch(
      /revoke all on public\.client_budget_context\s*\n\s*from public, anon, authenticated, service_role;/,
    );
  });

  it("grants back EXACTLY select, insert and update, to authenticated only", () => {
    expect(CODE).toContain(
      "grant select, insert, update on public.client_budget_context to authenticated;",
    );
    // No second grant on the table to anyone else.
    const grants = CODE.match(/grant [^;]*on public\.client_budget_context[^;]*;/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain("to authenticated");
  });

  it("does NOT re-enumerate privileges to remove — that was the defect", () => {
    // A `revoke delete, truncate ...` here would be the same mistake again.
    expect(CODE).not.toMatch(/revoke [a-z, ]*delete[a-z, ]*on public\.client_budget_context/);
    expect(CODE).not.toMatch(/revoke [a-z, ]*truncate[a-z, ]*on public\.client_budget_context/);
    expect(CODE).not.toMatch(/revoke [a-z, ]*references[a-z, ]*on public\.client_budget_context/);
  });

  it("names PUBLIC as well as the three roles", () => {
    // PUBLIC currently holds nothing, but the statement must express the whole
    // contract rather than only the delta that happens to be needed today.
    expect(CODE).toMatch(/from public, anon, authenticated, service_role/);
  });

  it("grants NO delete route", () => {
    expect(CODE).not.toMatch(/grant[^;]*delete[^;]*to authenticated/);
  });
});

describe("0184: trigger-function EXECUTE", () => {
  const FUNCTIONS = [
    "client_budget_context_set_studio_id",
    "client_budget_context_immutable_fields",
    "client_budget_context_server_timestamps",
  ];

  it("revokes EXECUTE on ALL THREE 0183 trigger functions", () => {
    for (const fn of FUNCTIONS) {
      expect(CODE, fn).toMatch(
        new RegExp(
          `revoke all privileges on function public\\.${fn}\\(\\)\\s*\\n\\s*from public, anon, authenticated, service_role;`,
        ),
      );
    }
  });

  it("does NOT touch public.set_updated_at()", () => {
    // A shared helper used by many tables since 0015. Its identical permissive
    // default is a repository-wide concern, not this ticket's.
    expect(CODE).not.toContain("set_updated_at");
  });

  it("touches no function outside the three 0183 introduced", () => {
    const touched = [...CODE.matchAll(/on function public\.([a-z_]+)\(\)/g)].map(
      (m) => m[1],
    );
    expect([...new Set(touched)].sort()).toEqual([...FUNCTIONS].sort());
  });
});

// ---------------------------------------------------------------------------
// POSITIVE EXECUTABLE-STATEMENT ALLOWLIST
//
// The previous protection was a denylist of forbidden DDL keywords, and that
// is exactly why a `comment on table` slipped into a migration whose header
// claimed "no DDL": the list enumerated CREATE/ALTER/DROP and nobody thought
// of COMMENT. It is the same enumerate-what-to-exclude mistake this migration
// exists to repair at the privilege layer, made one layer up in the proof.
//
// This asserts the opposite direction — that EVERY executable statement in the
// file is one of a small, exactly-enumerated set — so any newly inserted
// statement of ANY kind fails, including one nobody anticipated.
//
// Deliberately NOT a SQL parser. 0184 has a tiny finite grammar: strip whole
// line comments, split on `;`, normalize whitespace, and match each remaining
// statement against a fixed pattern list.
// ---------------------------------------------------------------------------

/** Executable statements in file order, comments stripped and whitespace collapsed. */
function executableStatements(): string[] {
  return SQL.split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

const FN = [
  "client_budget_context_set_studio_id",
  "client_budget_context_immutable_fields",
  "client_budget_context_server_timestamps",
] as const;

/** The COMPLETE set of statements 0184 is permitted to contain. */
const ALLOWED: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "begin", re: /^begin$/i },
  { label: "set local lock_timeout", re: /^set local lock_timeout = '5s'$/i },
  {
    label: "revoke all on the table",
    re: /^revoke all on public\.client_budget_context from public, anon, authenticated, service_role$/i,
  },
  {
    label: "grant the exact three to authenticated",
    re: /^grant select, insert, update on public\.client_budget_context to authenticated$/i,
  },
  ...FN.map((fn) => ({
    label: `revoke execute on ${fn}`,
    re: new RegExp(
      `^revoke all privileges on function public\\.${fn}\\(\\) from public, anon, authenticated, service_role$`,
      "i",
    ),
  })),
  { label: "commit", re: /^commit$/i },
];

describe("0184: GRANT/REVOKE only — positive statement contract", () => {
  it("EVERY executable statement is on the allowlist", () => {
    const unexpected = executableStatements().filter(
      (s) => !ALLOWED.some((a) => a.re.test(s)),
    );
    // Naming the offender makes a failure actionable rather than a bare count.
    expect(unexpected, `unrecognised executable statement(s): ${unexpected.join(" | ")}`).toEqual([]);
  });

  it("every allowlisted statement is actually PRESENT, exactly once", () => {
    // The mirror direction: an allowlist that permits statements which were
    // silently dropped would pass the check above while the repair did nothing.
    const statements = executableStatements();
    for (const { label, re } of ALLOWED) {
      const hits = statements.filter((s) => re.test(s));
      expect(hits, label).toHaveLength(1);
    }
  });

  it("contains EXACTLY the expected number of statements, in order", () => {
    const statements = executableStatements();
    expect(statements).toHaveLength(ALLOWED.length);
    statements.forEach((s, i) => {
      expect(s, `statement ${i} should be "${ALLOWED[i].label}"`).toMatch(
        ALLOWED[i].re,
      );
    });
  });

  it("prose in comments can never satisfy an executable assertion", () => {
    // The header quotes 0183's defective `revoke delete, truncate` and
    // discusses COMMENT ON. Those words exist in the file and must not count.
    expect(SQL).toContain("comment on table");
    expect(SQL).toMatch(/revoke delete, truncate/);
    const statements = executableStatements().join(" | ");
    expect(statements).not.toMatch(/comment on/i);
    expect(statements).not.toMatch(/revoke delete, truncate/i);
  });

  it("mutates ZERO business rows", () => {
    const statements = executableStatements().join(" | ");
    expect(statements).not.toMatch(/\binsert into\b/i);
    expect(statements).not.toMatch(/\bupdate\s+public\./i);
    expect(statements).not.toMatch(/\bdelete from\b/i);
    expect(statements).not.toMatch(/\btruncate\b/i);
  });

  it("touches no other table, and nothing outside budget context", () => {
    const tables = [...CODE.matchAll(/on (?:table )?public\.([a-z_]+)(?:\s|;)/g)]
      .map((m) => m[1])
      .filter((t) => !t.startsWith("client_budget_context"));
    expect(tables).toEqual([]);

    // Blank quoted literals before the keyword sweep: the table COMMENT is
    // prose that legitimately says "not income or payment data", and matching
    // that would be the same fixed-window mistake as reading past a statement
    // boundary — asserting on text rather than on statements.
    const statements = CODE.replace(/'[^']*'/g, "''");
    for (const forbidden of [
      "treatment_plans",
      "appointments",
      "sessions",
      "stripe",
      "payment",
      "client_clinical_notes",
      "client_personal_notes",
    ]) {
      expect(statements.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("states the privilege contract in the HEADER, not in an executable statement", () => {
    // The contract must still be written down where a reader will find it —
    // it just must not cost the migration a statement it did not declare.
    expect(SQL).toMatch(/authenticated\s+SELECT \+ INSERT \+ UPDATE/);
    expect(SQL).toMatch(/anon\s+nothing/);
    expect(SQL).toMatch(/service_role\s+nothing/);
    expect(SQL).toMatch(/PUBLIC\s+nothing/);
  });
});
