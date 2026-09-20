import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  TTL_HOURS_DEFAULT,
  TTL_HOURS_MAX,
  TTL_HOURS_MIN,
  TTL_PRESETS,
  ttlBoundLabel,
} from "@/lib/waitlist/invitation-window";
import { activeTtlPreset, emptyDraft } from "@/lib/waitlist/b4-invitation-draft";

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
// four places: the constant, the SQL `default 72` on the shipped command, a
// `?? 72` fallback in a dormant server path, and a literal `72` copied into a
// projection assertion. Three of those four were invisible to any test, so a
// change to the first would have moved the product's behaviour on one surface
// and left the other three stating the old number, with nothing failing.
//
// The bound had the same shape and a wider spread: `1` and `168` were written in
// the composer's model, repeated as literals in `invite-to-book-adapter.ts`, and
// repeated AGAIN as `min`/`max` on the composer's own number input — three
// statements, each under a comment claiming the bound was the shipped command's.
//
// So the censuses below are deliberately SOURCE-LEVEL, and they read `components`
// as well as `app` and `lib`. A behavioural test can only reach the call site it
// exercises; one of the two TTL call sites has no caller to exercise, and the
// number input's `max` is not reachable by any assertion about behaviour at all.

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
      // GUARDED, because this runs at module scope: a dangling symlink, or a
      // file removed between the readdir and the stat by an editor or a watch
      // run, would otherwise throw ENOENT during evaluation and fail all of
      // these tests with an import error instead of an assertion anyone can read.
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
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
 * make the census fail on documentation and pass on code, which is backwards.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const TS_SOURCES = sourceFiles(["app", "lib", "components"]).map((file) => ({
  file: path.relative(ROOT, file),
  code: stripComments(readFileSync(file, "utf8")),
}));

const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_SQL = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), "utf8"))
  .join("\n");

/** `create or replace function public.NAME( … )` → its parameter text. */
//
// ANCHORED ON `returns`, NOT ON THE FIRST `)`. Written `([^)]*)` the capture
// stops at the first closing paren, so a parameter with a parenthesised type —
// `p_amount numeric(10,2)` — truncates the list and the function silently drops
// out of `commandsTakingTtl`. Its call sites then drop out of the census that
// exists to catch a missing `p_ttl_hours`, which is the same shape of failure
// this file was written to close: a rule nothing can fail is not a rule.
// Every one of these declarations is followed by `returns`, so that is the
// reliable terminator.
function parseSqlFunctions(sql: string): Array<{ name: string; params: string }> {
  return [
    ...sql.matchAll(/create or replace function public\.(\w+)\s*\(([\s\S]*?)\)\s*returns/gi),
  ].map((m) => ({ name: m[1], params: m[2] }));
}

const SQL_FUNCTIONS = parseSqlFunctions(MIGRATION_SQL);

describe("the SQL declaration parser the census depends on", () => {
  it("survives a parenthesised parameter type", () => {
    // THE CENSUS IS ONLY AS GOOD AS THIS. A command whose parameters this fails
    // to read drops out of `commandsTakingTtl`, its call sites drop out of
    // `callSites`, and a call that omits `p_ttl_hours` then passes the very
    // check written to catch it — silently, and in the permissive direction.
    const fns = parseSqlFunctions(`
      create or replace function public.some_future_command(
        p_amount    numeric(10,2),
        p_ttl_hours integer default 72
      )
      returns text
    `);
    expect(fns.map((f) => f.name)).toContain("some_future_command");
    expect(fns[0].params, "the whole parameter list, not just up to the first )").toContain(
      "p_ttl_hours",
    );
  });

  it("finds the real commands it is pointed at", () => {
    const names = SQL_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("admit_new_client_waitlist_entry");
    expect(names).toContain("issue_new_client_waitlist_invitation");
    expect(names.length, "the migration tree parsed to almost nothing").toBeGreaterThan(100);
  });
});

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

  it("EVERY preset is inside the bound, not just the default", () => {
    // The same drift this file exists to close, one level down. Lower the max
    // and the composer keeps rendering a radio for the window it no longer
    // permits; a practitioner selects it and the adapter refuses the submission
    // as `invalid_ttl`, which reads as the product being broken.
    for (const preset of TTL_PRESETS) {
      expect(preset.hours, preset.label).toBeGreaterThanOrEqual(TTL_HOURS_MIN);
      expect(preset.hours, preset.label).toBeLessThanOrEqual(TTL_HOURS_MAX);
    }
  });

  it("is what a freshly opened draft carries", () => {
    expect(emptyDraft().expiresInHours).toBe(TTL_HOURS_DEFAULT);
  });
});

describe("CENSUS — the database's own default can never decide the window", () => {
  // THE COMMAND SET IS DERIVED FROM THE SQL, NOT LISTED HERE. A hand-written
  // list goes stale: a command that grows a `p_ttl_hours` parameter in a later
  // migration would be missed by a census enumerating today's names, and missed
  // silently.
  const commandsTakingTtl = new Set(
    SQL_FUNCTIONS.filter((f) => f.params.includes("p_ttl_hours")).map((f) => f.name),
  );

  /**
   * The argument object literal of a `.rpc("name", { … })` call.
   *
   * REFUSES TO GUESS. Only the inline form is understood, and anything else
   * returns `null` rather than scanning forward to the next unrelated brace
   * block in the file — which would produce a false pass whenever that block
   * happened to contain `p_ttl_hours:`, and a false failure otherwise. A call
   * rewritten to pass a named params object is reported as unverifiable, which
   * is the honest answer and the one that prompts a human to look.
   */
  function rpcArgs(code: string, at: number): string | null {
    const gap = code.slice(at, code.indexOf("{", at) === -1 ? at : code.indexOf("{", at));
    if (!/^\s*,\s*$/.test(gap)) return null;
    const open = code.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) return code.slice(open, i + 1);
      }
    }
    return null;
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

  it("can read every call site's arguments", () => {
    for (const { file, command, args } of callSites) {
      expect(
        args,
        `${file} -> ${command}: arguments are not an inline object literal, so this census cannot verify them`,
      ).not.toBeNull();
    }
  });

  it("passes p_ttl_hours explicitly at EVERY call to a command that takes one", () => {
    // THIS IS THE ONE THAT CLOSES THE HOLE. Scanning for the string
    // `p_ttl_hours` can only find call sites that already mention it, so a call
    // that OMITTED the argument — the exact mistake that lets the SQL default
    // decide — would drop out of the census rather than fail it. Starting from
    // the commands and demanding the argument is the direction that catches it.
    for (const { file, command, args } of callSites) {
      expect(args ?? "", `${file} -> ${command}`).toMatch(/\bp_ttl_hours\s*:/);
    }
  });

  it("states no numeric fallback of its own at any call site", () => {
    // `p_ttl_hours: input.ttlHours ?? 72` is the shape this forbids. It is a
    // second default, and the dormant path that carried one would have woken up
    // issuing the old window.
    //
    // NEWLINES ARE PART OF THE GAP. Written `[^,\n}]*` the check passed a
    // hand-wrapped `p_ttl_hours:\n  input.ttlHours ?? 72`, and this repo has no
    // formatter to normalise that shape away.
    //
    // NOTE WHAT THIS DOES NOT ASSERT: that the value equals TTL_HOURS_DEFAULT.
    // `issue_waitlist_preference_grant` also takes a `p_ttl_hours` and it is a
    // different clock — how long a profile-completion link stays usable, not how
    // long an invitation stays open. Its window has no business tracking this
    // one, so the rule is "no literal fallback", not "this number".
    for (const { file, command, args } of callSites) {
      const where = `${file} -> ${command}`;
      expect(args ?? "", where).not.toMatch(/p_ttl_hours\s*:[^,}]*\?\?\s*\d/);
      expect(args ?? "", where).not.toMatch(/p_ttl_hours\s*:\s*\d/);
    }
  });

  it("ANTI-VACUITY — there really IS a database default for a missing argument to hit", () => {
    // The censuses above are only worth running while omitting `p_ttl_hours`
    // would silently produce SOME window. If no command declared a default the
    // omission would be an error rather than a wrong answer, and these checks
    // would be guarding nothing.
    //
    // WHAT THIS DELIBERATELY NO LONGER ASSERTS: that the SQL default DIFFERS
    // from TTL_HOURS_DEFAULT. An earlier form did, which pinned the
    // DISAGREEMENT as the invariant and would have failed the day someone
    // aligned the migration on 48 — the actual repair for the divergence this
    // file documents. It also would have failed on setting the product default
    // to 168, which is in range and an offered preset. The rule being enforced
    // is "the application always says which window it wants", and that holds
    // whatever the database would otherwise have chosen.
    const INVITATION_COMMANDS = [
      "issue_new_client_waitlist_invitation",
      "issue_scoped_new_client_waitlist_invitation",
      "admit_new_client_waitlist_entry",
    ];
    const declared = SQL_FUNCTIONS.flatMap((f) => {
      if (!INVITATION_COMMANDS.includes(f.name)) return [];
      const m = f.params.match(/p_ttl_hours\s+integer\s+default\s+(\d+)/);
      return m ? [{ name: f.name, value: Number(m[1]) }] : [];
    });

    expect(declared.length, "no invitation command declares a TTL default").toBeGreaterThan(
      0,
    );
    for (const { name, value } of declared) {
      expect(Number.isInteger(value), `${name} declares an integer default`).toBe(true);
    }
  });

  it("CENSUS — SQL callers pass the argument too, not just TypeScript", () => {
    // THE HOLE THE TS CENSUS CANNOT SEE. 0192 and 0193 already call these
    // commands SQL-to-SQL, and those calls are POSITIONAL — there is no
    // `p_ttl_hours:` to grep for. A future migration adding a call that stops
    // one argument short would silently mint invitations on the database
    // default, and every check above would stay green.
    //
    // Arity is the observable: a caller that omits the trailing TTL passes
    // fewer arguments than the command declares.
    const paramCount = (params: string): number => {
      let depth = 0;
      let n = 1;
      for (const ch of params) {
        if (ch === "(" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "]") depth -= 1;
        else if (ch === "," && depth === 0) n += 1;
      }
      return params.trim() === "" ? 0 : n;
    };

    const ttlCommands = SQL_FUNCTIONS.filter((f) => f.params.includes("p_ttl_hours"));
    expect(ttlCommands.length).toBeGreaterThan(0);

    let callsChecked = 0;
    for (const cmd of ttlCommands) {
      const declaredArity = paramCount(cmd.params);
      const callRe = new RegExp(`public\\.${cmd.name}\\s*\\(`, "g");
      for (const m of MIGRATION_SQL.matchAll(callRe)) {
        const at = m.index ?? 0;
        // Skip DECLARATIONS and ACL/DROP statements, which carry a type
        // signature rather than arguments.
        const before = MIGRATION_SQL.slice(Math.max(0, at - 60), at).toLowerCase();
        if (before.includes("function")) continue;

        const open = at + m[0].length - 1;
        let depth = 0;
        let close = -1;
        for (let i = open; i < MIGRATION_SQL.length; i += 1) {
          if (MIGRATION_SQL[i] === "(") depth += 1;
          else if (MIGRATION_SQL[i] === ")") {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
        expect(close, `unbalanced call to ${cmd.name}`).toBeGreaterThan(open);
        const args = MIGRATION_SQL.slice(open + 1, close);
        callsChecked += 1;
        expect(
          paramCount(args),
          `${cmd.name} called with fewer arguments than it declares -- the TTL would fall back to the database default`,
        ).toBe(declaredArity);
      }
    }

    // NON-VACUITY: the scan really found the SQL-to-SQL calls that exist today
    // (0192 -> issue_new_client_waitlist_invitation, 0193 -> issue_scoped_...).
    expect(callsChecked, "no SQL-to-SQL call sites were examined").toBeGreaterThan(0);
  });
});

describe("CENSUS — the bound is stated once", () => {
  // The module that OWNS the bound is the one file allowed to write the numbers.
  const OWNER = "lib/waitlist/invitation-window.ts";
  const ADAPTER = "lib/waitlist/invite-to-book-adapter.ts";
  const COMPOSER = "components/waitlist/invite-composer.tsx";

  it("reads the files it censuses", () => {
    for (const f of [OWNER, ADAPTER, COMPOSER]) {
      expect(
        TS_SOURCES.some((s) => s.file === f),
        `${f} not found — the census would pass vacuously`,
      ).toBe(true);
    }
  });

  it("checks the submitted window against the constants, not against literals", () => {
    // The adapter must keep checking — a bound the browser could skip is not a
    // bound — but it must check against the same constants the composer offers
    // from, or the two can disagree and nothing fails.
    const adapter = TS_SOURCES.find((s) => s.file === ADAPTER)!.code;
    expect(adapter).toMatch(/expiresInHours\s*<\s*TTL_HOURS_MIN/);
    expect(adapter).toMatch(/expiresInHours\s*>\s*TTL_HOURS_MAX/);
    expect(adapter).not.toMatch(/expiresInHours\s*[<>]=?\s*\d/);
  });

  it("advertises the bound on the number input from the constants too", () => {
    // The input's own `min`/`max` are a statement of the bound that no
    // behavioural assertion can reach: they are enforced by the BROWSER, before
    // any code this repo owns runs.
    //
    // SCOPED TO THE EXPIRY INPUT. The composer has a second number field —
    // `composer-window-days`, `min={1} max={365}` — and that is the BOOKING
    // WINDOW, a different rule with a different owner. A file-wide assertion
    // against numeric bounds would have dragged it in and failed on code this
    // slice has no business touching.
    const composer = TS_SOURCES.find((s) => s.file === COMPOSER)!.code;
    const anchor = composer.indexOf('data-testid="composer-expiry-hours"');
    expect(anchor, "the expiry input's test id").toBeGreaterThan(-1);
    const element = composer.slice(composer.lastIndexOf("<input", anchor), anchor);

    expect(element).toMatch(/min=\{TTL_HOURS_MIN\}/);
    expect(element).toMatch(/max=\{TTL_HOURS_MAX\}/);
    expect(element).not.toMatch(/\b(min|max)=\{\s*\d+\s*\}/);
  });

  it("states the bound in PROSE from the constants too", () => {
    // The help text above the custom hours field read "Hours, from 1 hour to 7
    // days" as a literal. A census that greps for `min={<digits>}` cannot see a
    // sentence, so this was the one statement of the bound that survived the
    // first pass -- and the one that would keep promising seven days after the
    // bound narrowed, while the input beside it refused.
    expect(ttlBoundLabel()).toBe("Hours, from 1 hour to 7 days");
    expect(ttlBoundLabel()).toContain(String(TTL_HOURS_MAX / 24));

    const composer = TS_SOURCES.find((x) => x.file === COMPOSER)!.code;
    expect(composer).toContain("ttlBoundLabel()");
    // And the sentence is not ALSO written out anywhere.
    expect(composer).not.toMatch(/from \d+ hours? to \d+ days?/);
  });

  it("NEGATIVE CONTROL — no module outside the owner bounds the window itself", () => {
    for (const { file, code } of TS_SOURCES) {
      if (file === OWNER) continue;
      expect(code, file).not.toMatch(/expiresInHours\s*[<>]=?\s*\d/);
    }
  });
});
