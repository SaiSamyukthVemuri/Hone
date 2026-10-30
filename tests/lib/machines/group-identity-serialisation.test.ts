import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

// ===========================================================================
// EVERY SITE THAT SERIALISES A GROUP IDENTITY, PINNED
// (Codex, #860 4307426212)
// ===========================================================================
//
// THE DEFECT THAT EARNED THIS FILE. A group identity is issued by the database
// now, so a caller sends EITHER `group_key` (revise the group it names) OR
// `new_group_ref` (its own placeholder; the database names it). The initial
// save emitted `group_key: g.groupKey` unconditionally - and on that path the
// block does not exist yet, so EVERY group is new and `groupKey` is null. It
// therefore sent `{"group_key": null}`, which a JSON null makes PRESENT to the
// `?` operator: the command's exactly-one check passed, the group fell through
// to "A settings group must be named.", and the atomic create rolled the whole
// treatment area back. The entire create journey for a machine-charted area
// was refused.
//
// WHY A SWEEP AND NOT A PATCH. There are three serialisation sites and the
// defect was in the one nothing covered. I had even written the warning about
// JSON nulls at one of the three and left this one wrong, which is the
// signature of a rule that lives in a comment rather than in a test. So all
// three are pinned here, in one place, BOTH WAYS - the correct form present
// AND the broken form banned, because a spread can be added while the old
// line stays behind it.
//
// THE TWO DOORS DO NOT SHARE A RULE, and that asymmetry is the trap. The save
// command reads jsonb and tests KEY PRESENCE:
//
//     (g.value ? 'group_key') = (g.value ? 'new_group_ref')
//
// so a JSON null counts as naming something. The per-group command takes text
// parameters and tests EMPTINESS:
//
//     (btrim(coalesce(p_group_key, '')) <> '') = (btrim(coalesce(p_new_group_ref, '')) <> '')
//
// so a SQL NULL counts as naming nothing. The first cannot be sent a null; the
// second can only be sent nulls. Pinned below so the next caller does not have
// to rediscover which is which.
// ===========================================================================

const read = (rel: string) =>
  readFileSync(nodePath.resolve(__dirname, "../../..", rel), "utf8");

const QUERIES = read("lib/machines/machine-queries.ts");
const BLOCK_ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const MIGRATION = read(
  "supabase/migrations/0223_machine_inventory_and_setup_readings.sql",
);

/** The expression a `const <name> = ...` or a call's argument list spans. */
function slice(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  expect(at, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, at);
  expect(end, `terminator not found after ${from}`).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("the JSONB door is never sent a null identity", () => {
  // Both callers of `record_treatment_setup_submission` and
  // `create_block_with_initial_setup` build jsonb group objects, so both are
  // subject to the key-PRESENCE rule.
  const SITES: Array<[string, string]> = [
    [
      "recordSetupSubmission",
      slice(QUERIES, "p_groups: input.groups.map((g) => ({", "channels: g.channels,"),
    ],
    [
      "the initial save in block-actions",
      slice(
        BLOCK_ACTIONS,
        "p_setup_groups: setupGroups.map((g) => ({",
        "channels: g.channels,",
      ),
    ],
  ];

  for (const [name, body] of SITES) {
    it(`${name} emits ONE of the two keys, by spreading`, () => {
      expect(body).toMatch(
        /\.\.\.\(g\.groupKey === null\s*\?\s*\{ new_group_ref: g\.newGroupRef \}\s*:\s*\{ group_key: g\.groupKey \}\),/,
      );
    });

    it(`${name} does NOT emit a bare group_key`, () => {
      // THE HALF THAT ACTUALLY FAILED. The spread can be added while the old
      // line survives above or below it, and then a new group sends BOTH - a
      // JSON null under `group_key` plus the ref - which the command refuses
      // as naming both.
      expect(
        body,
        "a bare group_key reaches the command, so a new group sends a JSON null",
      ).not.toMatch(/^\s*group_key: g\.groupKey,$/m);
      expect(body).not.toMatch(/^\s*new_group_ref: g\.newGroupRef,$/m);
    });
  }

  it("and the command it feeds really does test PRESENCE, not emptiness", () => {
    // Without this the two tests above are pinning a shape against a rule
    // nobody has checked. If the command ever moved to an emptiness test, a
    // null would become harmless and this file would be ceremony.
    expect(MIGRATION).toContain(
      "where (g.value ? 'group_key') = (g.value ? 'new_group_ref')",
    );
  });
});

describe("the TEXT door is sent both parameters, one of them null", () => {
  it("recordSetupGroup passes the pair straight through", () => {
    // OPPOSITE OF THE JSONB DOOR, and correct here: these are named text
    // parameters, so a SQL NULL names nothing and the command's emptiness
    // test reads it as absent. Spreading would be wrong - a missing named
    // parameter would fall back to the function's default rather than being
    // seen as absent.
    const body = slice(
      QUERIES,
      'db.rpc("record_treatment_setup_group", {',
      "p_channels: input.channels,",
    );
    expect(body).toMatch(/p_group_key: input\.groupKey,/);
    expect(body).toMatch(/p_new_group_ref: input\.newGroupRef,/);
  });

  it("and the command it feeds really does test EMPTINESS, not presence", () => {
    expect(MIGRATION).toMatch(
      /\(btrim\(coalesce\(p_group_key, ''\)\) <> ''\)\s*\n?\s*=\s*\(btrim\(coalesce\(p_new_group_ref, ''\)\) <> ''\)/,
    );
  });
});

describe("there is no FOURTH site", () => {
  it("nothing else in the application names either key", () => {
    // The guard against this recurring. A new serialisation site shows up here
    // as an unpinned file rather than as a refused save in production.
    const FILES = [
      "lib/machines/machine-queries.ts",
      "lib/machines/setting-groups.ts",
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
      "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
      "components/machines/machine-reading-entry.tsx",
      "components/machines/machine-first-setup-panel.tsx",
      "components/machines/machine-first-setup-connected.tsx",
    ];
    const emitters = FILES.filter((f) => {
      const src = read(f)
        // Comments discuss both keys at length, and a prose mention is not a
        // serialisation site.
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, " ");
      return /new_group_ref|group_key:/.test(src);
    });
    // EXACTLY the two jsonb builders plus the text door, all in two files.
    expect(emitters.sort()).toEqual(
      [
        "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
        "lib/machines/machine-queries.ts",
      ].sort(),
    );
  });
});
