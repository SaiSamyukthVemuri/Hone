import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as invitationWindow from "@/lib/waitlist/invitation-window";
import { WAIT_INVITATION_TTL_HOURS } from "@/lib/waitlist/invitation-window";
import {
  COMPOSER_FIELD_NAMES,
  emptyDraft,
  inviteSubmissionFromFormData,
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

// ---------------------------------------------------------------------------
// THE TTL AUTHORITY, READ FROM THE MIGRATIONS THAT DEFINE IT
// ---------------------------------------------------------------------------
//
// `issue_new_client_waitlist_invitation` holds the only TTL guard in the
// invitation chain. Both application paths reach it — the live one through
// `admit_new_client_waitlist_entry` -> `issue_scoped_...`, the dormant one
// through `issue_scoped_...` directly — which the test above asserts rather
// than assumes.
const TTL_AUTHORITY = "issue_new_client_waitlist_invitation";

/** Migration files in APPLY ORDER, so a later redefinition wins. */
const MIGRATION_FILES = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), "utf8"));

/**
 * The body of the LAST definition of a command.
 *
 * LAST, NOT FIRST. A command redefined by a later migration is governed by that
 * later body; reading the first would pin a rule production stopped following.
 */
function latestBodyOf(name: string): string {
  let found: string | null = null;
  for (const sql of MIGRATION_FILES) {
    const marker = `create or replace function public.${name}`;
    let from = sql.indexOf(marker);
    while (from !== -1) {
      const next = sql.indexOf("create or replace function public.", from + marker.length);
      found = sql.slice(from, next === -1 ? undefined : next);
      from = sql.indexOf(marker, from + marker.length);
    }
  }
  expect(found, `no definition of ${name} found in the migrations`).not.toBeNull();
  return found!;
}

type TtlGuard = { min: number; max: number };

/** `if v_ttl < A or v_ttl > B then` -> {min: A, max: B}; null when absent. */
function ttlGuardFrom(body: string): TtlGuard | null {
  const m = body.match(/v_ttl\s*<\s*(\d+)\s*or\s*v_ttl\s*>\s*(\d+)/i);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

function ttlGuardOf(name: string): TtlGuard | null {
  return ttlGuardFrom(latestBodyOf(name));
}


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
    expect(WAIT_INVITATION_TTL_HOURS).toBe(48);
  });

  it("IS ACCEPTED BY THE DATABASE COMMAND THAT ENFORCES THE BOUND", () => {
    // DERIVED FROM THE SQL, NOT FROM A TYPESCRIPT COPY OF IT.
    //
    // This previously read `expect(48).toBeGreaterThanOrEqual(TTL_HOURS_MIN)`
    // against two constants in the same module as the 48. That proved the file
    // agreed with itself and nothing else: had the database's own guard moved,
    // the copies would have gone on asserting the old range and this would have
    // stayed green while production refused every invitation as `invalid_ttl`.
    //
    // The bound is now read out of the command that actually enforces it, so
    // the authority and the assertion cannot drift apart.
    const guard = ttlGuardOf(TTL_AUTHORITY);
    expect(
      guard,
      `no TTL guard found in ${TTL_AUTHORITY} — the assertion below would be vacuous`,
    ).not.toBeNull();
    expect(WAIT_INVITATION_TTL_HOURS).toBeGreaterThanOrEqual(guard!.min);
    expect(WAIT_INVITATION_TTL_HOURS).toBeLessThanOrEqual(guard!.max);
  });

  it("the command it derives from is the one BOTH application paths reach", () => {
    // The derivation is only worth anything if it reads the right command.
    // Chain, by delegation, each link asserted from the SQL rather than assumed:
    //
    //   admit_new_client_waitlist_entry          (live path)
    //     -> issue_scoped_new_client_waitlist_invitation
    //          -> issue_new_client_waitlist_invitation   <- the only TTL guard
    //
    // `issueScopedInvitation` (the dormant path) enters at the middle link, so
    // both application paths are governed by the same guard.
    expect(latestBodyOf("admit_new_client_waitlist_entry")).toContain(
      "public.issue_scoped_new_client_waitlist_invitation(",
    );
    expect(latestBodyOf("issue_scoped_new_client_waitlist_invitation")).toContain(
      "public.issue_new_client_waitlist_invitation(",
    );
    // And the middle link states no bound of its own, so it cannot disagree.
    expect(ttlGuardOf("issue_scoped_new_client_waitlist_invitation")).toBeNull();
  });

  it("ANTI-VACUITY — the guard parser can actually fail to find a bound", () => {
    // Every derivation above rests on this regex. A parser that silently
    // matches nothing would make the containment check pass forever, so it is
    // exercised on a body that HAS a bound and one that does not.
    expect(ttlGuardFrom("if v_ttl < 3 or v_ttl > 99 then")).toEqual({ min: 3, max: 99 });
    expect(ttlGuardFrom("if v_ttl is null then")).toBeNull();
  });

  it("A NARROWER DATABASE BOUND WOULD TURN THIS RED", () => {
    // The point of deriving: if a future migration narrows the command to, say,
    // 1..24, the fixed 48-hour window becomes illegal and every invitation
    // starts failing as `invalid_ttl`. There is no UI left to reveal that, so
    // the derived guard is the only thing standing between that migration and a
    // silent production outage. Simulated here against the real assertion.
    const narrowed = ttlGuardFrom("if v_ttl < 1 or v_ttl > 24 then")!;
    expect(WAIT_INVITATION_TTL_HOURS).toBeGreaterThan(narrowed.max);
  });

  it("is FIXED — the module offers no presets, no custom value and no default", () => {
    // NEGATIVE, AND AT THE MODULE BOUNDARY. #748 shipped the right number as a
    // DEFAULT and left the alternatives standing, so the constant was correct
    // while the product was wrong. A default implies a chooser somewhere; this
    // asserts the chooser's vocabulary does not exist to be re-imported.
    const mod = invitationWindow as unknown as Record<string, unknown>;
    // ONE EXPORT. The bound constants were removed with this finding: nothing
    // read them at runtime and they were a second, unenforceable statement of a
    // rule the database already owns.
    expect(Object.keys(mod).sort()).toEqual(["WAIT_INVITATION_TTL_HOURS"]);
    expect(mod.TTL_HOURS_MIN, "a copied bound is a fake second authority").toBeUndefined();
    expect(mod.TTL_HOURS_MAX, "a copied bound is a fake second authority").toBeUndefined();
    expect(mod.TTL_PRESETS, "presets are a chooser").toBeUndefined();
    expect(mod.TTL_HOURS_DEFAULT, "a default implies alternatives").toBeUndefined();
    expect(mod.ttlBoundLabel, "the custom field's help text").toBeUndefined();
  });

  it("A FRESH DRAFT CANNOT EXPRESS A WINDOW AT ALL", () => {
    // It used to carry `expiresInHours: TTL_HOURS_DEFAULT`. The key is gone, not
    // defaulted: a draft with no window cannot submit one, whatever the UI does.
    expect(Object.keys(emptyDraft()).sort()).toEqual([
      "allowedWeekdays",
      "serviceId",
      "windowDays",
    ]);
    expect("expiresInHours" in emptyDraft()).toBe(false);
  });

  it("PRACTITIONER FORM DATA CANNOT CHOOSE A TTL — the parser ignores one entirely", () => {
    // THE DECISIVE NEGATIVE, and it is about the SUBMISSION rather than the
    // screen. Removing a control only stops an honest browser; the boundary
    // that matters is what the server does with a hand-built POST. Both retired
    // field names are supplied here with values a practitioner could once have
    // selected, and neither reaches the submission.
    const form = new FormData();
    form.set(COMPOSER_FIELD_NAMES.entryId, "e1");
    form.set(COMPOSER_FIELD_NAMES.serviceId, "s1");
    form.set(COMPOSER_FIELD_NAMES.windowDays, "14");
    form.set(COMPOSER_FIELD_NAMES.allowedDaysPreset, "every");
    form.set("expires_in_hours", "168");
    form.set("expires_in_hours_custom", "167");

    const parsed = inviteSubmissionFromFormData(form);
    expect(parsed.ok, "the fixture must parse, or the assertion below is vacuous").toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    const submission = parsed.submission as unknown as Record<string, unknown>;
    expect(submission.expiresInHours, "a forged TTL reached the submission").toBeUndefined();
    expect("expiresInHours" in submission).toBe(false);
    expect(Object.keys(submission).sort()).toEqual([
      "allowedWeekdays",
      "entryId",
      "serviceId",
      "windowDays",
    ]);
  });

  it("the retired field names are not known to the composer's vocabulary", () => {
    const names = Object.values(COMPOSER_FIELD_NAMES);
    expect(names).not.toContain("expires_in_hours");
    expect(names).not.toContain("expires_in_hours_custom");
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

describe("CENSUS — the window is supplied once, and chosen nowhere", () => {
  // The module that OWNS the window is the one file allowed to write the number.
  const OWNER = "lib/waitlist/invitation-window.ts";
  const ADAPTER = "lib/waitlist/invite-to-book-adapter.ts";
  const COMPOSER = "components/waitlist/invite-composer.tsx";
  const DRAFT = "lib/waitlist/b4-invitation-draft.ts";
  const ACTION = "app/(app)/settings/waitlist/invite-actions.ts";
  const DORMANT = "lib/booking/waitlist-invitation.ts";

  it("reads the files it censuses", () => {
    for (const f of [OWNER, ADAPTER, COMPOSER, DRAFT, ACTION, DORMANT]) {
      expect(
        TS_SOURCES.some((s) => s.file === f),
        `${f} not found — the census would pass vacuously`,
      ).toBe(true);
    }
  });

  it("ISSUANCE USES THE CANONICAL CONSTANT, at every call that supplies a window", () => {
    // Both call sites, by name, because there are exactly two and the dormant
    // one is the one nobody would notice waking up on the wrong number.
    for (const f of [ADAPTER, DORMANT]) {
      const code = TS_SOURCES.find((s) => s.file === f)!.code;
      expect(code, `${f} must supply the window`).toMatch(
        /p_ttl_hours:\s*WAIT_INVITATION_TTL_HOURS/,
      );
      expect(code, `${f} must not name a number`).not.toMatch(/p_ttl_hours:\s*\d/);
      expect(code, `${f} must not take one from its caller`).not.toMatch(
        /p_ttl_hours:\s*[a-zA-Z_$][\w$.]*\s*\?\?/,
      );
    }
  });

  it("NO SURFACE ACCEPTS A WINDOW — the field is gone from every layer", () => {
    // ONE ASSERTION PER LAYER, because removing the control alone would leave
    // four other places a window could still arrive from.
    for (const f of [COMPOSER, DRAFT, ACTION, ADAPTER]) {
      const code = TS_SOURCES.find((s) => s.file === f)!.code;
      expect(code, `${f} still reads a submitted window`).not.toMatch(/\bexpiresInHours\b/);
    }
    const dormant = TS_SOURCES.find((s) => s.file === DORMANT)!.code;
    expect(dormant, "the dormant path still takes a ttl argument").not.toMatch(/\bttlHours\b/);
  });

  it("NO EXPIRY CONTROL RENDERS — the composer has no selector and no custom field", () => {
    // SOURCE-LEVEL ON PURPOSE. These are the test ids and field names the
    // component test drives; asserting their ABSENCE in the source catches a
    // control that renders only under a branch the component test never takes.
    const composer = TS_SOURCES.find((s) => s.file === COMPOSER)!.code;
    for (const marker of [
      "composer-expiry-hours",
      "composer-expiry-custom",
      "Invitation expires",
      "TTL_PRESETS",
      "ttlBoundLabel",
      "expires_in_hours",
    ]) {
      expect(composer, `the composer still carries ${marker}`).not.toContain(marker);
    }
  });

  it("ANTI-VACUITY — these absence checks could actually fail", () => {
    // Every assertion above is a `not.toMatch`, and a mistyped marker passes
    // forever. So the same greps are run against the PRE-SLICE shapes to prove
    // they are capable of firing.
    const sample = [
      'data-testid="composer-expiry-hours"',
      'title="Invitation expires"',
      "p_ttl_hours: input.expiresInHours,",
      "p_ttl_hours: input.ttlHours ?? TTL_HOURS_DEFAULT,",
    ].join("\n");
    expect(sample).toContain("composer-expiry-hours");
    expect(sample).toContain("Invitation expires");
    expect(sample).toMatch(/\bexpiresInHours\b/);
    expect(sample).toMatch(/\bttlHours\b/);
    expect(sample).toMatch(/p_ttl_hours:\s*[a-zA-Z_$][\w$.]*\s*\?\?/);
  });

  it("NEGATIVE CONTROL — no module outside the owner writes the window as a literal", () => {
    for (const { file, code } of TS_SOURCES) {
      if (file === OWNER) continue;
      expect(code, file).not.toMatch(/p_ttl_hours:\s*\d/);
    }
  });
});
