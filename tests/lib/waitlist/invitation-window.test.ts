import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  TTL_HOURS_DEFAULT,
  TTL_HOURS_MAX,
  TTL_HOURS_MIN,
  TTL_PRESETS,
  activeTtlPreset,
  emptyDraft,
} from "@/lib/waitlist/b4-invitation-draft";

// ===========================================================================
// THE INVITATION WINDOW IS 48 HOURS, AND IT IS STATED ONCE
// ===========================================================================
//
// Two different things are proved here, and only the first is a product fact.
//
//   1. The opportunity a recipient gets is 48 hours.
//   2. There is exactly ONE place that says so.
//
// (2) is the one worth a file. Before this slice the window's value appeared in
// four places: `TTL_HOURS_DEFAULT`, the SQL `default 72` on the shipped command,
// a `?? 72` fallback in a dormant server path, and a literal `72` copied into a
// projection assertion. Three of those four were invisible to any test, so a
// change to the first would have moved the product's behaviour on one surface
// and left the other three stating the old number, with nothing failing.
//
// The bound has the same shape and the same history: `1` and `168` were written
// in `b4-invitation-draft.ts` AND repeated as literals in
// `invite-to-book-adapter.ts`, under a comment in each saying the bound was the
// shipped command's own.
//
// So the censuses below are deliberately SOURCE-LEVEL. A behavioural test can
// only reach the call site it exercises; these read every TypeScript file under
// `app/` and `lib/` and fail on a second statement of the rule wherever it is
// added, including in a path that nothing calls yet.

const ROOT = path.resolve(__dirname, "../../..");

/** Every .ts/.tsx file under the given repo-relative roots. */
function sourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
  };
  for (const r of roots) walk(path.join(ROOT, r));
  return out;
}

/**
 * Strip `//` and block comments.
 *
 * THE CENSUSES WOULD BE VACUOUS WITHOUT THIS, in the direction that matters:
 * several modules DESCRIBE the shipped command's signature in prose, including
 * the words `p_ttl_hours` and the number 72. Counting those as call sites would
 * make the census fail on documentation and pass on code, which is exactly
 * backwards.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const TS_SOURCES = sourceFiles(["app", "lib"]).map((file) => ({
  file: path.relative(ROOT, file),
  code: stripComments(readFileSync(file, "utf8")),
}));

const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_SQL = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), "utf8"))
  .join("\n");

describe("the window a recipient actually gets", () => {
  it("is 48 hours", () => {
    expect(TTL_HOURS_DEFAULT).toBe(48);
  });

  it("is inside the bound the shipped command enforces", () => {
    expect(TTL_HOURS_DEFAULT).toBeGreaterThanOrEqual(TTL_HOURS_MIN);
    expect(TTL_HOURS_DEFAULT).toBeLessThanOrEqual(TTL_HOURS_MAX);
  });

  it("is a preset the composer actually offers, so it opens on a choice and not on Custom", () => {
    // A default outside TTL_PRESETS is not a validation failure — the value is
    // in range and the command would accept it. It is a UI defect: the composer
    // would open with every preset radio unselected and the custom field
    // holding a number nobody typed, which reads as a form already edited.
    expect(TTL_PRESETS.map((p) => p.hours)).toContain(TTL_HOURS_DEFAULT);
    expect(activeTtlPreset(TTL_HOURS_DEFAULT)).not.toBe("custom");
  });

  it("is what a freshly opened draft carries", () => {
    expect(emptyDraft().expiresInHours).toBe(TTL_HOURS_DEFAULT);
  });
});

describe("CENSUS — the database's own default can never decide the window", () => {
  // THE COMMAND SET IS DERIVED FROM THE SQL, NOT LISTED HERE. A hand-written
  // list is a list that goes stale: a command that grows a `p_ttl_hours`
  // parameter in a later migration would be missed by a census that enumerated
  // today's names, and missed silently.
  const commandsTakingTtl = new Set(
    [
      ...MIGRATION_SQL.matchAll(
        /create or replace function public\.(\w+)\s*\(([^)]*)\)/gi,
      ),
    ]
      .filter((m) => m[2].includes("p_ttl_hours"))
      .map((m) => m[1]),
  );

  /** The argument object literal of a `.rpc("name", { … })` call. */
  function rpcArgs(code: string, at: number): string {
    const open = code.indexOf("{", at);
    if (open === -1) return "";
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) return code.slice(open, i + 1);
      }
    }
    return "";
  }

  const callSites = TS_SOURCES.flatMap(({ file, code }) =>
    [...code.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)]
      .filter((m) => commandsTakingTtl.has(m[1]))
      .map((m) => ({
        file,
        command: m[1],
        args: rpcArgs(code, (m.index ?? 0) + m[0].length),
      })),
  );

  it("derives a non-empty command set from the migrations", () => {
    expect(commandsTakingTtl.size).toBeGreaterThan(0);
    expect(commandsTakingTtl).toContain("admit_new_client_waitlist_entry");
  });

  it("finds the call sites at all — the census is not scanning an empty set", () => {
    expect(callSites.length).toBeGreaterThan(0);
  });

  it("passes p_ttl_hours explicitly at EVERY call to a command that takes one", () => {
    // THIS IS THE ONE THAT CLOSES THE HOLE. Scanning for the string
    // `p_ttl_hours` can only find call sites that already mention it, so a call
    // that OMITTED the argument — the exact mistake that lets the SQL default
    // decide — would drop out of the census rather than fail it. Starting from
    // the commands and demanding the argument is the direction that catches it.
    for (const { file, command, args } of callSites) {
      expect(args, `${file} -> ${command}`).toMatch(/\bp_ttl_hours\s*:/);
    }
  });

  it("states no numeric fallback of its own at any call site", () => {
    // `p_ttl_hours: input.ttlHours ?? 72` is the shape this forbids. It is a
    // second default, and the dormant path that carried one would have woken up
    // issuing the old window.
    //
    // NOTE WHAT THIS DOES NOT ASSERT: that the value equals TTL_HOURS_DEFAULT.
    // `issue_waitlist_preference_grant` also takes a `p_ttl_hours` and it is a
    // different clock — how long a profile-completion link stays usable, not how
    // long an invitation stays open. Its window has no business tracking this
    // one, so the rule is "no literal fallback", not "this number".
    for (const { file, command, args } of callSites) {
      expect(args, `${file} -> ${command}`).not.toMatch(
        /p_ttl_hours\s*:[^,\n}]*\?\?\s*\d/,
      );
      expect(args, `${file} -> ${command}`).not.toMatch(/p_ttl_hours\s*:\s*\d/);
    }
  });

  it("ANTI-VACUITY — the database really does default to something else", () => {
    // If the SQL default were already 48 the two censuses above would still
    // pass while proving nothing, because there would be no wrong value left
    // for a missing argument to fall back to.
    const declared = [
      ...MIGRATION_SQL.matchAll(/p_ttl_hours\s+integer\s+default\s+(\d+)/g),
    ].map((m) => Number(m[1]));

    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toContain(72);
    expect(declared).not.toContain(TTL_HOURS_DEFAULT);
  });
});

describe("CENSUS — the bound is stated once", () => {
  const ADAPTER = "lib/waitlist/invite-to-book-adapter.ts";
  const adapter = TS_SOURCES.find((s) => s.file === ADAPTER);

  it("reads the adapter at all", () => {
    expect(adapter, `${ADAPTER} not found`).toBeDefined();
  });

  it("checks the submitted window against the constants, not against literals", () => {
    // The adapter must keep checking — a bound the browser could skip is not a
    // bound — but it must check against the same two constants the composer
    // offers from, or the two can disagree and nothing fails.
    expect(adapter!.code).toMatch(/expiresInHours\s*<\s*TTL_HOURS_MIN/);
    expect(adapter!.code).toMatch(/expiresInHours\s*>\s*TTL_HOURS_MAX/);
    expect(adapter!.code).not.toMatch(/expiresInHours\s*[<>]=?\s*\d/);
  });

  it("NEGATIVE CONTROL — no other module under app/ or lib/ bounds the window itself", () => {
    // `b4-invitation-draft.ts` is where the bound lives, so it is the one file
    // allowed to compare against a literal — and it does not, it declares them.
    const OWNER = "lib/waitlist/b4-invitation-draft.ts";
    for (const { file, code } of TS_SOURCES) {
      if (file === OWNER) continue;
      expect(code, file).not.toMatch(/expiresInHours\s*[<>]=?\s*\d/);
    }
  });
});
