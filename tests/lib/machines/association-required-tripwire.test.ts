import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

// ===========================================================================
// THE TRIPWIRE FOR THE DEFERRED DATABASE HALF (Codex, #860 4309004312(a))
// ===========================================================================
//
// WHAT WAS DEFERRED, AND WHY. 4309004312 had two halves. The APP half (b) is
// fixed: the group's channels now reach `validateSubmittedReadings`. The
// DATABASE half is NOT:
//
//   * `machine_profile_mode_contract` publishes `channels_max` but carries no
//     `association_required` column, so a profile's requirement never reaches
//     the database at all;
//   * every channel check in `record_setup_group_in_scope` sits inside
//     `if coalesce(array_length(p_channels,1),0) > 0`, so an EMPTY channel
//     list skips all of them and there is no "required" check - a direct
//     caller of the GRANTED wrappers (`record_treatment_setup_group`,
//     `record_treatment_setup_submission`; the in-scope function itself is
//     granted to no role) could append an immutable, unassociated capture.
//
// IT HAS NO TRIGGER TODAY. Nothing in the tree sets
// `associationRequired: true`: the only `channels` block belongs to
// `permanence-gemm:gemm-16`, which is BLOCKED and sets it false, and the
// synthetic fixture sets it false too. ops01 ruled the SQL deferred to the
// change that first PUBLISHES such a requirement - 0235 or the GEMM
// publication change - rather than reopening 0223, which is FINAL at blob
// 8839115f and carried by five branches.
//
// SO THIS FILE EXISTS TO MAKE THAT DEFERRAL SAFE RATHER THAN HOPEFUL. It
// asserts a PAIRING, not a state: the moment any profile declares the
// requirement, the database must already enforce it. Whoever flips that flag
// finds this red and lands the SQL in the same change.
//
// THE DEFERRED TICKET, recorded here because this is where it will be read:
// add `association_required` to the mode contract, thread it through
// `sync_machine_profile_contract` - EXPLICITLY DROPPING the old arity, or the
// previous overload lingers and keeps publishing without the flag, which is
// worse than today - and refuse an empty `p_channels` for a value reading when
// the contract requires an association.
// ===========================================================================

const root = (rel: string) => nodePath.resolve(__dirname, "../../..", rel);

/** SQL with comments stripped: LINE comments before BLOCK, as ever. */
const sql = readFileSync(
  root("supabase/migrations/0223_machine_inventory_and_setup_readings.sql"),
  "utf8",
)
  .replace(/--[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** TypeScript with comments stripped, for the same reason. */
const ts = (rel: string) =>
  readFileSync(root(rel), "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const CATALOGUES = [
  "lib/machines/catalogue.ts",
  "lib/machines/synthetic-profile.ts",
];

/**
 * Which of these sources DECLARE the requirement?
 *
 * THE ONLY PLACE THE SCAN HAPPENS, and both the live check and its proof call
 * it - the proof with the real source mutated in memory. A negative control is
 * why: when this was a precomputed `const`, blinding it to `[]` went
 * unnoticed, because today the real answer is also empty, so a hardcoded
 * detector and an honest one are indistinguishable. Testing the regex against
 * a literal did not help either; that survives the binding being replaced.
 */
const flaggedIn = (sources: ReadonlyArray<[string, string]>): string[] =>
  sources.filter(([, text]) => /associationRequired:\s*true/.test(text)).map(([rel]) => rel);

/** The live answer, from the real catalogues. */
const flagged = flaggedIn(CATALOGUES.map((rel) => [rel, ts(rel)] as [string, string]));

/**
 * Does the mode contract PUBLISH it?
 *
 * Sliced to the table's own definition, so a mention anywhere else in a
 * 3,600-line migration cannot answer for it.
 */
const tableFrom = sql.indexOf("create table if not exists public.machine_profile_mode_contract");
const tableBlock =
  tableFrom === -1 ? "" : sql.slice(tableFrom, sql.indexOf(");", tableFrom));
const published = /association_required/.test(tableBlock);

/** Does the writer REFUSE an unassociated group when the contract requires one? */
const refused = /association_required/.test(sql) && /requires an association/i.test(sql);

describe("the deferred association requirement cannot ship half-done", () => {
  it("ANTI-VACUITY: the three detectors can all see their subject", () => {
    // Without this, every assertion below passes by reading nothing.
    expect(tableFrom, "the mode-contract table was not found in 0223").toBeGreaterThan(-1);
    expect(tableBlock).toMatch(/channels_max/);
    expect(tableBlock.length).toBeGreaterThan(200);
    expect(tableBlock.length).toBeLessThan(3000);
    // THE DETECTOR FINDS A FLAG IN THE REAL SOURCE when one is there. Not a
    // literal: the same `flaggedIn` the live check uses, given the actual
    // catalogue with its declaration flipped in memory. This is what makes a
    // blinded or hardcoded detector visible.
    for (const rel of CATALOGUES) {
      const mutated = ts(rel).replace(
        /associationRequired:\s*false/,
        "associationRequired: true",
      );
      expect(
        flaggedIn([[rel, mutated]]),
        `the detector cannot see a declaration in ${rel}, so the tripwire can never fire`,
      ).toEqual([rel]);
    }
    // And both catalogues really do declare the field, in the false form.
    for (const rel of CATALOGUES) {
      expect(ts(rel), `${rel} no longer declares associationRequired at all`).toMatch(
        /associationRequired:\s*(true|false)/,
      );
    }
  });

  it("TODAY: no profile declares it, so the deferral stands", () => {
    // A statement of the fact the deferral rests on, so that if it changes the
    // reason for deferring is visibly gone.
    expect(
      flagged,
      "a profile now declares associationRequired: true — see the case below",
    ).toEqual([]);
  });

  it("THE PAIRING: a declared requirement must already be ENFORCED in the database", () => {
    // THE TRIPWIRE. Flipping the flag without the SQL would let the app demand
    // an association the database does not, so a direct caller of the granted
    // wrappers could still append an immutable, unassociated capture - which
    // is exactly 4309004312(a).
    if (flagged.length === 0) return;
    expect(
      published,
      `${flagged.join(", ")} declares associationRequired: true, but ` +
        "machine_profile_mode_contract has no association_required column, so " +
        "the requirement never reaches the database. Land the deferred " +
        "4309004312(a) SQL in THIS change: publish the column through " +
        "sync_machine_profile_contract (dropping its old arity explicitly, or " +
        "the previous overload keeps publishing without the flag) and refuse " +
        "an empty p_channels for a value reading when it is required.",
    ).toBe(true);
    expect(
      refused,
      `${flagged.join(", ")} declares associationRequired: true, but no ` +
        "writer refuses an unassociated group. Publishing the column is not " +
        "enough: record_setup_group_in_scope skips every channel check when " +
        "p_channels is empty.",
    ).toBe(true);
  });

  it("and the reverse: the database must not enforce a rule nothing declares", () => {
    // The other direction, so the pairing is an equivalence rather than a
    // one-way ratchet. A column published while no profile sets the flag is
    // not harmful, but it means the two halves have drifted and the next
    // reader should be told which one moved.
    if (!published) return;
    expect(
      flagged.length,
      "the contract publishes association_required but no profile declares it",
    ).toBeGreaterThan(0);
  });
});
