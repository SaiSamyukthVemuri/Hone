import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { ESLint } from "eslint";

// UI-05 — every remaining native confirm() dialog, retired.
//
// WHY THIS IS NOT A STYLING SLICE. confirm-dialog.tsx's own docblock records
// that iOS Safari can SUPPRESS a native confirm silently. When it does, the
// guard returns false and the mutation never runs: a practitioner taps Remove
// or Archive, sees nothing happen, and cannot tell refusal from being ignored.
// Two other surfaces in this repo had already migrated for that reason and said
// so in their comments; these two were the stragglers.
//
// What the shipped dialog adds that a native one cannot: role="alertdialog",
// a focus trap, focus restored to the opener, Escape that closes ONLY while
// idle so an in-flight mutation is never abandoned, and an error region that
// keeps the dialog open so the message can be read.

// RAW SOURCE. The comment-stripping pre-pass that used to live here is RETIRED.
//
// It could not tell a comment from a string or a template, so
// `const x = `/* ${window.confirm("Remove?")} */`;` had its live interpolation
// deleted before anything looked at it, and the repo-wide zero-confirm
// assertion passed over an executing native call. Review found that at
// `75b16f20`. It is also the second time this repository has been bitten by
// strip-then-pattern-match; the first blinded a different content guard.
//
// Nothing here reconstructs comment boundaries any more. Enforcement is
// ESLint's, which parses properly; the assertions below that do read source ask
// only about markup shape, and are written so a docblock cannot satisfy them.
const read = (p: string) => readFileSync(p, "utf8");

const SCHEDULE = read("components/treatment-schedule-editor.tsx");
const PORTAL = read("components/portal-messages-card.tsx");
// Found only after the sweep was widened — see sweptFiles() for why it was
// invisible. The slice originally claimed there were TWO; there were three.
const TAGS = read("components/client-tags-card.tsx");

// ---------------------------------------------------------------------------
// WHAT USED TO BE HERE, AND WHY IT IS GONE
//
// A hand-written TypeScript AST walk (`nativeConfirmForms`) that decided
// whether a bare `confirm` resolved to the browser global. It took SEVEN
// repairs across four review rounds and still had two open defects:
//
//   lexical binding resolution · var hoisting · ambient-declaration erasure
//   method vs function name binding · ScriptKind selection · comment
//   preprocessing · transparent-wrapper unwrapping · native-global resolution
//
// Each finding was correct and each fix was local, which was the problem: the
// thing being built was a JavaScript/TypeScript name-resolution engine, one
// edge case at a time. Roadmap 7.4 / 7.7 convergence threshold.
//
// ESLint already has a scope analyser, and measurement showed it answers most
// of those questions for free — ESTree has no parenthesised-expression node at
// all, `no-restricted-properties` already matches computed access with a
// literal key, and `var` in a class static block is already scoped correctly.
// Three rule keys replaced all of it. See
// /srv/hone/handoffs/UI05_CONFIRM_GUARD_ARCH_REVIEW_2026-09-18.md.
//
// ENFORCEMENT IS NOW ESLINT'S. What remains in this file is a CENSUS/BACKSTOP:
// it answers questions lint cannot — is the tracked surface fully covered by
// the lint target set, has an exclusion drifted — and it must never re-grow
// into a resolver.
// ---------------------------------------------------------------------------

/** Every .ts/.tsx under app/ and components/, from git. */
function sweptFiles(): string[] {
  return execSync("git ls-files '*.tsx' '*.ts'", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => f.startsWith("app/") || f.startsWith("components/"));
}

/** Every .ts/.tsx under those roots, from the DISK — an independent oracle. */
function walkedFiles(exts = /\.tsx?$/): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (exts.test(entry.name)) out.push(full);
    }
  };
  walk("app");
  walk("components");
  return out;
}

/** THE coverage checker: which on-disk files a candidate list fails to cover. */
function filesNotCovered(candidate: string[], exts?: RegExp): string[] {
  const have = new Set(candidate);
  return walkedFiles(exts).filter((f) => !have.has(f));
}

// ---------------------------------------------------------------------------
// THE ENFORCEMENT MECHANISM, exercised THROUGH THE REAL eslint.config.mjs.
//
// `lintText` resolves the config for the given filePath exactly as `npm run
// lint` does, so these probes cannot drift from what ships. That matters more
// than it sounds: this repository's lint fixtures were once written against
// `lib/finance/__lint_probe.ts`, a path the block under test never matched, so
// they proved nothing about it. A hand-built config object here would repeat
// that defect.
//
// It also dissolves the ScriptKind finding by construction — the config decides
// the parser per extension, so `.ts` and `.tsx` are each parsed as themselves
// and there is no second parser mode for this file to select wrongly.
// ---------------------------------------------------------------------------

// P2-01's repair moved the RECEIVER half of the ban off `no-restricted-properties`
// and onto a scope-aware local rule, because core matched the receiver by
// spelling and rejected a legitimate local `self`/`window`/`globalThis`. The
// verdict helper must know that rule id, or every member-expression form reads
// as "not caught" for a purely cosmetic reason.
const DIALOG_RULES = new Set([
  "no-restricted-globals",
  "no-restricted-properties",
  "no-restricted-syntax",
  "hone-dialog/no-native-dialog-receiver",
]);

let eslintInstance: ESLint | null = null;
const lintProbe = (): ESLint => (eslintInstance ??= new ESLint({ cwd: process.cwd() }));

type Verdict = { caught: boolean; rules: string[]; fatal: string | null };

async function lintThroughRealConfig(
  source: string,
  filePath = "components/__ui05_probe.tsx",
): Promise<Verdict> {
  const results = await lintProbe().lintText(source, { filePath, warnIgnored: false });
  const msgs = results.flatMap((r) => r.messages);
  const fatal = msgs.find((m) => m.fatal);
  const mine = msgs.filter((m) => m.ruleId && DIALOG_RULES.has(m.ruleId));
  return {
    caught: mine.length > 0,
    rules: [
      ...new Set(
        mine.map((m) =>
          m.ruleId!.replace("hone-dialog/no-native-dialog-receiver", "properties").replace("no-restricted-", ""),
        ),
      ),
    ].sort(),
    // A parse failure would make "caught"/"not caught" meaningless either way,
    // so it is surfaced rather than folded into the verdict.
    fatal: fatal ? fatal.message : null,
  };
}

/** The effective config ESLint will actually apply to a path. */
async function effectiveRules(filePath: string): Promise<Record<string, unknown[]>> {
  const cfg = (await lintProbe().calculateConfigForFile(filePath)) as {
    rules?: Record<string, unknown[]>;
  };
  return cfg.rules ?? {};
}

/**
 * Is a rule armed at ERROR for this path? P2-01 moved the receiver half of the
 * ban onto a local scope-aware rule, which carries no option objects, so
 * `optionsOf` cannot express "armed" for it.
 */
const ruleIsError = (rules: Record<string, unknown[]>, key: string): boolean => {
  const entry = rules[key] as unknown;
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return severity === 2 || severity === "error";
};

const RECEIVER_RULE = "hone-dialog/no-native-dialog-receiver";

/** The option objects a rule carries for a path, minus the severity. */
const optionsOf = (rules: Record<string, unknown[]>, key: string): Array<Record<string, unknown>> =>
  ((rules[key] as unknown[] | undefined) ?? []).slice(1) as Array<Record<string, unknown>>;

// THE ARCHITECTURE MATRIX. Seventeen native forms, nine legitimate bindings —
// the same matrix the architecture ruling measured, kept verbatim so a change
// in the counts is a visible regression rather than a quiet re-baselining.
const NATIVE_FORMS: Array<[string, string, string?]> = [
  ["N1  bare confirm()", 'export function r(){ confirm("Remove?"); }'],
  ["N2  window.confirm", 'export function r(){ window.confirm("Remove?"); }'],
  ["N3  globalThis.confirm", 'export function r(){ globalThis.confirm("Remove?"); }'],
  ["N4  self.confirm", 'export function r(){ self.confirm("Remove?"); }'],
  ["N5  window[\"confirm\"]", 'export function r(){ window["confirm"]("Remove?"); }'],
  ["N6  window[`confirm`]", 'export function r(){ window[`confirm`]("Remove?"); }'],
  ["N7  (window.confirm)()", 'export function r(){ (window.confirm)("Remove?"); }'],
  ["N8  (confirm)()", 'export function r(){ (confirm)("Remove?"); }'],
  ["N9  (window.confirm as any)()", 'export function r(){ (window.confirm as any)("Remove?"); }'],
  ["N10 window.confirm!()", 'export function r(){ window.confirm!("Remove?"); }'],
  ["N11 declare const confirm", 'declare const confirm: (s: string) => boolean;\nexport function r(){ confirm("Remove?"); }'],
  ["N12 static-block var", 'class C { static { var confirm = 1; } }\nexport function r(){ confirm("Remove?"); }'],
  ["N13 import { type confirm }", 'import { type confirm } from "./t";\nexport function r(){ confirm("Remove?"); }'],
  ["N14 ((confirm))()", 'export function r(){ ((confirm))("Remove?"); }'],
  ["N15 declare global { var }", 'declare global { var confirm: (s: string) => boolean; }\nexport function r(){ confirm("Remove?"); }'],
  ["N16 import type confirm from", 'import type confirm from "./t";\nexport function r(){ confirm("Remove?"); }'],
  ["N17 alert / prompt", 'export function r(){ window["alert"]("x"); prompt("y"); }'],
];

const LEGITIMATE_BINDINGS: Array<[string, string, string?]> = [
  ["L1  const local", 'export function r(){ const confirm = (s: string) => true; return confirm("x"); }'],
  ["L2  function declaration", 'function confirm(s: string){ return true; }\nexport function r(){ return confirm("x"); }'],
  ["L3  parameter", 'export function r(confirm: (s: string) => boolean){ return confirm("x"); }'],
  ["L4  value import", 'import { confirm } from "./ui";\nexport function r(){ return confirm("x"); }'],
  ["L5  value default import", 'import confirm from "./ui";\nexport function r(){ return confirm("x"); }'],
  ["L6  non-global receiver", 'const dialog = { confirm(s: string){ return true; } };\nexport function r(){ return dialog.confirm("x"); }'],
  ["L7  similar names", 'export function r(onConfirm: () => void, handleConfirm: () => void){ onConfirm(); handleConfirm(); }'],
  ["L8  ConfirmDialog usage", 'import { ConfirmDialog } from "@/components/confirm-dialog";\nexport const C = ConfirmDialog;'],
  ["L9  renamed local", 'import { confirm as ask } from "./ui";\nexport function r(){ return ask("x"); }'],
  // P2-01 (Codex, exact head 3ef45f70). Core `no-restricted-properties` matched
  // the RECEIVER by spelling, so a local binding that merely happens to be
  // called `self`, `window` or `globalThis` was rejected. Each of these three
  // was a reproduced false positive before the scope-aware rule replaced it.
  ["L10 local receiver named self", 'type D = { confirm: (s: string) => boolean };\nexport function r(self: D){ return self.confirm("x"); }'],
  ["L11 local receiver named window", 'type D = { confirm: (s: string) => boolean };\nexport function r(window: D){ return window.confirm("x"); }'],
  ["L12 local receiver named globalThis", 'type D = { confirm: (s: string) => boolean };\nexport function r(globalThis: D){ return globalThis.confirm("x"); }'],
];

describe("UI-05: ESLint is the enforcement authority for native dialogs", () => {
  it("every native form in the architecture matrix is rejected — 17/17", async () => {
    const missed: string[] = [];
    const parseErrors: string[] = [];
    for (const [label, source, filePath] of NATIVE_FORMS) {
      const v = await lintThroughRealConfig(source, filePath);
      if (v.fatal) parseErrors.push(`${label}: ${v.fatal}`);
      else if (!v.caught) missed.push(label);
    }
    expect(parseErrors, `probe sources must parse: ${parseErrors.join(" | ")}`).toEqual([]);
    expect(missed, `native forms NOT rejected: ${missed.join(" | ")}`).toEqual([]);
    // Pinned so a shrinking matrix is a visible change, not a quiet one.
    expect(NATIVE_FORMS.length, "the ruling measured 17 native forms").toBe(17);
  }, 120_000);

  it("every legitimate binding stays legal — 0/12 flagged", async () => {
    const flagged: string[] = [];
    for (const [label, source, filePath] of LEGITIMATE_BINDINGS) {
      const v = await lintThroughRealConfig(source, filePath);
      if (v.caught) flagged.push(`${label} -> ${v.rules.join(",")}`);
    }
    // The requirement that keeps this mechanism honest: a guard that rejects
    // `const confirm = …` would be trading one defect for another.
    expect(flagged, `legitimate bindings wrongly rejected: ${flagged.join(" | ")}`).toEqual([]);
    expect(LEGITIMATE_BINDINGS.length, "9 from the ruling + 3 P2-01 receivers").toBe(12);
  }, 120_000);

  it("the receiver ban discriminates scope, not spelling — P2-01", async () => {
    // The pair that must not collapse into one answer. Same property, same
    // spelling, opposite verdicts, decided only by what the receiver RESOLVES
    // to. A mechanism that gets both right cannot be matching text.
    const localReceiver = await lintThroughRealConfig(
      'type D = { confirm: (s: string) => boolean };\nexport function r(self: D){ return self.confirm("x"); }',
    );
    expect(localReceiver.caught, "a local `self` is not the global").toBe(false);

    const realGlobal = await lintThroughRealConfig(
      'export function r(){ return self.confirm("x"); }',
    );
    expect(realGlobal.caught, "the real global `self` is still banned").toBe(true);

    // An ERASED shadow is not a shadow at runtime, so it must NOT buy an
    // exemption — the call still reaches the browser global. Same reasoning
    // already recorded for the bare-name erased-shadow selectors.
    const erased = await lintThroughRealConfig(
      'declare const window: { confirm: (s: string) => boolean };\nexport function r(){ return window.confirm("x"); }',
    );
    expect(erased.caught, "an ambient `declare` shadow must not exempt").toBe(true);
  }, 120_000);

  it("ambient globals from an enclosing `declare global` are classified correctly", async () => {
    // Raised at exact head c110d9b2. Investigated and NOT reproduced: across
    // these fixtures the shipped rule already returns the right verdict for
    // every one. The reason is that typescript-eslint does not register a
    // `declare global` augmentation in the file's scope chain, so the receiver
    // comes out unresolved and is treated as the global.
    //
    // That is the right answer arriving for an incidental reason, so the
    // erasure helper now recognises an enclosing ambient context explicitly
    // (changing no verdict below), and these cases are pinned so a future
    // scope-manager change cannot silently invert them.
    const cases: Array<[string, string, boolean]> = [
      [
        "declare global var self -> BANNED",
        'declare global { var self: { confirm: (m: string) => boolean } }\nexport function r(){ return self.confirm("x"); }\nexport {};',
        true,
      ],
      [
        "declare global interface Window -> BANNED",
        'declare global { interface Window { confirm: (m: string) => boolean } }\nexport function r(){ return window.confirm("x"); }\nexport {};',
        true,
      ],
      [
        "module-level declare const self (erased) -> BANNED",
        'declare const self: { confirm: (m: string) => boolean };\nexport function r(){ return self.confirm("x"); }',
        true,
      ],
      [
        // The exact fixture named in the P2-02 thread at c110d9b2.
        "declare global var window: Window & typeof globalThis -> BANNED",
        'declare global { var window: Window & typeof globalThis }\nexport function r(){ return window.confirm("x"); }\nexport {};',
        true,
      ],
      [
        "same shape via self -> BANNED",
        'declare global { var self: Window & typeof globalThis }\nexport function r(){ return self.confirm("x"); }\nexport {};',
        true,
      ],
      [
        "local param self IN A FILE THAT ALSO HAS declare global -> LEGAL",
        'declare global { var self: { confirm: (m: string) => boolean } }\ntype D = { confirm: (m: string) => boolean };\nexport function q(self: D){ return self.confirm("x"); }\nexport {};',
        false,
      ],
      [
        "plain local param self -> LEGAL",
        'type D = { confirm: (m: string) => boolean };\nexport function r(self: D){ return self.confirm("x"); }',
        false,
      ],
    ];

    const wrong: string[] = [];
    for (const [label, source, shouldBan] of cases) {
      const v = await lintThroughRealConfig(source);
      if (v.caught !== shouldBan) wrong.push(`${label} (got caught=${v.caught})`);
    }
    // Discriminating in BOTH directions: a rule that banned everything and a
    // rule that banned nothing each fail this list.
    expect(wrong, `misclassified: ${wrong.join(" | ")}`).toEqual([]);
  }, 120_000);

  it("the two OPEN defects of the retired resolver are caught by the replacement", async () => {
    // These are the reproducers from the two P2 threads at `75b16f20`. They
    // were NOT repaired in the resolver — the resolver was retired instead —
    // so this is where the claim "superseded by a verified replacement" is
    // actually proved.

    // Thread 1: `.ts` parsed as TSX made `<T>x` become JSX, so the resolver's
    // TypeAssertionExpression branch was unreachable exactly where the syntax
    // is legal. The real config parses `.ts` as TypeScript.
    const angle = await lintThroughRealConfig(
      'export function r(){ (<typeof window.confirm>window.confirm)("Remove?"); }',
      "app/__ui05_probe.ts",
    );
    expect(angle.fatal, "the .ts probe must parse as TypeScript, not JSX").toBeNull();
    expect(angle.caught, "angle-bracket assertion form must be rejected").toBe(true);

    // Thread 2: a live call inside a template literal that merely LOOKS like a
    // comment. The retired strip deleted the interpolation before anything saw
    // it; a real parser never does.
    const template = await lintThroughRealConfig(
      'export const x = `/* ${window.confirm("Remove?")} */`;',
    );
    expect(template.caught, "a call inside a comment-looking template must be rejected").toBe(true);

    const bareTemplate = await lintThroughRealConfig(
      'export const x = `/* ${confirm("Remove?")} */`;',
    );
    expect(bareTemplate.caught, "…and the bare form of it too").toBe(true);

    // DISCRIMINATING: a call in a REAL comment, and a call in a plain string,
    // must stay clean. Without these the two above would also pass against a
    // mechanism that simply matched the text `confirm(` anywhere.
    const realComment = await lintThroughRealConfig(
      '// window.confirm("Remove?")\nexport const k = 1;',
    );
    expect(realComment.caught, "a real comment is not a call").toBe(false);
    const inString = await lintThroughRealConfig('export const s = "window.confirm(x)";');
    expect(inString.caught, "a string is not a call").toBe(false);
  }, 120_000);

  it("an ordinary product file carries all three enforcement keys", async () => {
    const rules = await effectiveRules("components/client-tags-card.tsx");
    const globals = optionsOf(rules, "no-restricted-globals").map((o) => o.name);
    const props = optionsOf(rules, "no-restricted-properties").map((o) => `${o.object}.${o.property}`);
    const syntax = optionsOf(rules, "no-restricted-syntax");

    expect(globals, "bare dialog globals").toEqual(expect.arrayContaining(["confirm", "alert", "prompt"]));
    // The RECEIVER half is the scope-aware rule since P2-01; core's
    // `no-restricted-properties` matched a local `self`/`window` by spelling.
    expect(ruleIsError(rules, RECEIVER_RULE), "receiver rule armed").toBe(true);
    expect(props, "the receiver ban no longer rides on core").not.toContain("window.confirm");
    expect(syntax.length, "erased-shadow selectors").toBeGreaterThan(0);
  }, 120_000);

  it("FIN keeps EVERY existing restriction and gains the dialog set — proved on the effective config", async () => {
    // FIN SAFETY IS LOAD-BEARING, and my own architecture note got this wrong
    // once: I said `no-restricted-properties` was "a different rule key, so it
    // cannot replace FIN's options". FIN SETS THAT KEY TOO. A probe reproduced
    // the disarm. So this asserts the EFFECTIVE config, not the config source
    // text — a text scan cannot see which object wins.
    for (const finPath of ["app/(app)/financials/page.tsx", "lib/finance/money.ts"]) {
      const rules = await effectiveRules(finPath);
      const globals = optionsOf(rules, "no-restricted-globals").map((o) => o.name);
      const props = optionsOf(rules, "no-restricted-properties").map(
        (o) => `${o.object}.${o.property}`,
      );
      const imports = optionsOf(rules, "no-restricted-imports").flatMap(
        (o) => ((o.paths as Array<{ name: string }> | undefined) ?? []).map((x) => x.name),
      );
      const syntax = optionsOf(rules, "no-restricted-syntax");

      // 1. the PRE-EXISTING FIN restrictions are still forbidden
      for (const esm of ["require", "module", "exports"])
        expect(globals, `${finPath}: FIN keeps \`${esm}\``).toContain(esm);
      expect(props, `${finPath}: FIN keeps process.getBuiltinModule`).toContain(
        "process.getBuiltinModule",
      );
      expect(imports, `${finPath}: FIN keeps node:module`).toContain("node:module");

      // 2. native confirm is forbidden here too
      expect(globals, `${finPath}: bare confirm forbidden`).toContain("confirm");
      expect(
        ruleIsError(rules, RECEIVER_RULE),
        `${finPath}: receiver rule armed`,
      ).toBe(true);
      expect(syntax.length, `${finPath}: erased-shadow selectors present`).toBeGreaterThan(0);
    }
  }, 120_000);

  it("the financial subtree actually REJECTS both, not just declares both", async () => {
    // Declaring options and rejecting code are different claims. The disarm
    // incident looked fine in the source and failed in effect, so both scopes
    // are linted for real.
    const finDialog = await lintThroughRealConfig(
      'export function r(){ window.confirm("Remove?"); }',
      "app/(app)/financials/__ui05_probe.ts",
    );
    expect(finDialog.caught, "financials must reject a native dialog").toBe(true);

    const finEsm = await lintThroughRealConfig(
      'export const a = process.getBuiltinModule("fs");',
      "app/(app)/financials/__ui05_probe.ts",
    );
    expect(finEsm.rules, "financials must still reject the FIN form").toContain("properties");

    const libDialog = await lintThroughRealConfig(
      'export function r(){ window.confirm("Remove?"); }',
      "lib/finance/__ui05_probe.ts",
    );
    expect(
      libDialog.caught,
      "lib/finance gets dialog cover ONLY from the repeated set in the FIN block",
    ).toBe(true);
  }, 120_000);

  it("the repetition is deliberate — neither block relies on option merging", async () => {
    // ESLint flat config REPLACES a rule's options; it does not merge them.
    // Nothing in this mechanism may depend on merging, so the shared sets are
    // spread into BOTH objects. This pins the structural fact that made the
    // effective-config assertions above pass.
    const cfg = read("eslint.config.mjs");
    for (const [name, expected] of [
      ["NATIVE_DIALOG_GLOBALS", 2],
      ["NATIVE_DIALOG_ERASED_SHADOWS", 2],
    ] as const) {
      const spreads = (cfg.match(new RegExp(`\\.\\.\\.${name}`, "g")) ?? []).length;
      expect(spreads, `${name} must be spread into both blocks, found ${spreads}`).toBe(expected);
    }
    // The receiver half is no longer an options array, so its "both blocks"
    // fact is the plugin registration plus the rule entry — same claim, same
    // count, expressed in the shape the new mechanism actually has.
    for (const [needle, expected] of [
      ['"hone-dialog": nativeDialogPlugin', 2],
      [`"${RECEIVER_RULE}": "error"`, 2],
    ] as const) {
      const hits = cfg.split(needle).length - 1;
      expect(hits, `${needle} must appear in both blocks, found ${hits}`).toBe(expected);
    }
    // Declared once each, so the two spreads cannot drift apart.
    for (const name of [
      "NATIVE_DIALOG_GLOBALS",
      "NATIVE_DIALOG_ERASED_SHADOWS",
      // The receiver half, declared once for the same anti-drift reason.
      "nativeDialogPlugin",
    ]) {
      expect((cfg.match(new RegExp(`const ${name} =`, "g")) ?? []).length, `${name} declared once`).toBe(1);
    }
  });
});

describe("UI-05: the sweep is a CENSUS/BACKSTOP, not a semantic authority", () => {
  it("the sweep COVERS its own subjects and the whole surface on disk", () => {
    const swept = sweptFiles();
    for (const subject of [
      "components/treatment-schedule-editor.tsx",
      "components/portal-messages-card.tsx",
      "components/client-tags-card.tsx",
    ]) {
      expect(swept, `the sweep must actually read ${subject}`).toContain(subject);
    }
    expect(swept).toContain("app/layout.tsx");
    expect(swept).toContain("app/page.tsx");

    const unseen = filesNotCovered(swept);
    expect(
      unseen,
      `the sweep does not read ${unseen.length} file(s) on disk: ${unseen.slice(0, 8).join(", ")}`,
    ).toEqual([]);
    expect(swept.length).toBeGreaterThan(280);
  });

  it("EVERY tracked product file is inside the lint target set", async () => {
    // THE CENSUS ROLE, and the one question lint cannot answer about itself:
    // lint governs the files its config matches, and says nothing about a file
    // the config stops matching. This walks the tracked surface from git and
    // asks ESLint, per file, what it would actually apply.
    //
    // This replaces two earlier tests that scanned eslint.config.mjs as TEXT
    // for glob strings and rule names. A text scan cannot see which config
    // object wins for a file — which is precisely how the FIN disarm looked
    // correct in the source while being broken in effect.
    const swept = sweptFiles();
    const ungoverned: string[] = [];
    for (const f of swept) {
      const rules = await effectiveRules(f);
      const globals = optionsOf(rules, "no-restricted-globals").map((o) => o.name);
      const props = optionsOf(rules, "no-restricted-properties").map(
        (o) => `${o.object}.${o.property}`,
      );
      if (!globals.includes("confirm") || !ruleIsError(rules, RECEIVER_RULE)) ungoverned.push(f);
    }
    expect(
      ungoverned,
      `${ungoverned.length} tracked product file(s) outside the lint target set: ${ungoverned.slice(0, 8).join(", ")}`,
    ).toEqual([]);
    expect(swept.length, "the census must cover a real surface").toBeGreaterThan(280);
  }, 300_000);

  it("the ONE excluded path is excluded on purpose, and is covered elsewhere", async () => {
    // Exclusion drift is the other census question. `app/(app)/financials/**`
    // is deliberately outside the UI-05 block so it cannot replace FIN's rule
    // options — so the only acceptable state is: excluded there AND governed by
    // the FIN block, which the effective config must show.
    const rules = await effectiveRules("app/(app)/financials/page.tsx");
    const globals = optionsOf(rules, "no-restricted-globals").map((o) => o.name);
    expect(globals, "the excluded subtree is still governed").toEqual(
      expect.arrayContaining(["confirm", "require"]),
    );

    const cfg = read("eslint.config.mjs");
    const ignoreLines = cfg.match(/ignores: \[[^\]]*\]/g) ?? [];
    expect(
      ignoreLines,
      "exactly one exclusion, and it is the documented FIN overlap",
    ).toEqual(['ignores: ["app/(app)/financials/**"]']);
  }, 120_000);

  it("THE COVERAGE CHECKER BITES — the original pathspec fails it", () => {
    // Run through filesNotCovered, the same function the test above trusts.
    // Previously this comparison was re-implemented inline, so it proved the
    // broken pathspec lossy by its own copy of the logic rather than by the
    // checker that ships.
    const broken = execSync("git ls-files 'app/**/*.tsx' 'components/**/*.tsx'", {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    const missed = filesNotCovered(broken, /\.tsx$/);
    expect(missed.length, "the original pathspec must be demonstrably lossy").toBeGreaterThan(0);
    for (const subject of [
      "components/treatment-schedule-editor.tsx",
      "components/portal-messages-card.tsx",
      "components/client-tags-card.tsx",
    ]) {
      expect(missed, `the broken pathspec missed ${subject}`).toContain(subject);
    }
  });
});

describe("UI-05: the destructive-action focus contract", () => {
  const HOOK = read("components/use-return-focus.ts");
  const SURFACES = [
    ["portal-messages-card.tsx", PORTAL],
    ["client-tags-card.tsx", TAGS],
    ["treatment-schedule-editor.tsx", SCHEDULE],
  ] as const;

  it("all three surfaces use ONE shared hook, not three local copies", () => {
    for (const [name, src] of SURFACES) {
      expect(src, `${name}: imports the shared hook`).toContain(
        'from "@/components/use-return-focus"',
      );
      expect(src, `${name}: arms the handoff`).toMatch(/useReturnFocus</);
    }
  });

  it("the handoff is keyed on the DIALOG's open state, not on a list length", () => {
    // Measured, not assumed: after a successful stage removal the row does NOT
    // unmount — revalidation replaces the button's DOM node, so a list-length
    // key never fires and the opener is detached while a lookalike is on
    // screen. Keying on the dialog's own open state is the thing that works.
    expect(PORTAL).toMatch(/useReturnFocus<[^>]+>\(archiveTarget\)/);
    expect(TAGS).toMatch(/useReturnFocus<[^>]+>\(removeTarget\)/);
    expect(SCHEDULE).toMatch(/useReturnFocus<[^>]+>\(\s*confirming,/);
    expect(HOOK, "the hook documents why a list length is the wrong key").toContain(
      "does NOT unmount",
    );
  });

  it("only the SUCCESS path arms it — cancel and failure keep the primitive's restoration", () => {
    // If arming moved to the cancel path, ConfirmDialog's opener restoration
    // would be overridden where it is correct, which is the opposite defect.
    for (const [name, src] of SURFACES) {
      const armed = [...src.matchAll(/arm[A-Za-z]*Focus\(\)/g)];
      expect(armed.length, `${name}: arms exactly once`).toBe(1);
    }
    expect(PORTAL).toMatch(/if \(r\.ok\) \{\s*armHeadingFocus\(\);/);
    expect(SCHEDULE).toMatch(/if \(r\.ok\) \{[\s\S]{0,200}?armScheduleFocus\(\);/);
  });

  it("every anchor is a programmatic-only target that outlives the action", () => {
    for (const [name, src] of SURFACES) {
      const at = src.indexOf("tabIndex={-1}");
      expect(at, `${name}: anchor is out of the Tab order`).toBeGreaterThan(-1);
      // Scoped to the ANCHOR's own element, not the whole file: these cards
      // carry unrelated inputs that legitimately use `outline-none` today.
      const element = src.slice(at, at + 400);
      expect(element, `${name}: anchor uses outline-hidden`).toContain("outline-hidden");
      // DESIGN.md LAW 3/6: `outline-hidden`, never `outline-none`.
      expect(
        element.replace(/\/\/[^\n]*/g, ""),
        `${name}: anchor never outline-none`,
      ).not.toContain("outline-none");
    }
  });

  it("P3 evidence: ClientTagsCard is fixed but genuinely unmounted", () => {
    // The finding is real as code and unreachable as product, so it is fixed
    // with the shared hook and NOT given a browser proof. This is the census
    // that keeps that statement honest: if the card is ever re-surfaced, this
    // fails and whoever re-surfaced it owes the e2e proof.
    // `git grep -l` exits 1 when there are no matches, which is the expected
    // state here, so the miss is caught rather than thrown.
    let mounts = "";
    try {
      mounts = execSync("git grep -l -- '<ClientTagsCard' app components", {
        encoding: "utf8",
      }).trim();
    } catch {
      mounts = "";
    }
    expect(mounts, "ClientTagsCard is mounted somewhere — add the browser proof").toBe("");
  });
});

describe("UI-05: both surfaces use the shipped dialog with its real contract", () => {
  it("each mounts ConfirmDialog with danger tone and a busy label", () => {
    for (const [name, src] of [
      ["schedule", SCHEDULE],
      ["portal", PORTAL],
      ["tags", TAGS],
    ] as const) {
      expect(src, `${name} imports the dialog`).toContain(
        'from "@/components/confirm-dialog"',
      );
      expect(src, `${name} mounts it`).toMatch(/<ConfirmDialog/);
      expect(src, `${name} is destructive`).toMatch(/tone="danger"/);
      expect(src, `${name} names the in-flight state`).toMatch(/busyLabel="/);
    }
  });

  it("the caller still owns the mutation — pending is passed, not invented", () => {
    // The dialog is presentation. Each caller keeps its own transition and
    // passes `pending` in, which is what locks the dialog against Escape and
    // double-submit.
    expect(SCHEDULE).toMatch(/pending=\{pending\}/);
    expect(PORTAL).toMatch(/pending=\{archivePending\}/);
  });

  it("failure keeps the dialog OPEN and does not render the error twice", () => {
    // On failure each handler sets the error and leaves the dialog open, per
    // the dialog's error contract; the surface's own error paragraph is then
    // suppressed so the message is not shown in two places at once.
    expect(SCHEDULE).toMatch(/error=\{confirming \? error : null\}/);
    expect(SCHEDULE).toMatch(/\{error && !confirming && \(/);
    expect(PORTAL).toMatch(/error=\{archiveTarget \? archiveError : null\}/);
    expect(PORTAL).toMatch(/\{archiveError && !archiveTarget && \(/);
  });

  it("success closes the dialog; failure does not", () => {
    // The focus handoff sits between the branch and the close on the success
    // path; the claim under test — success closes, failure does not — is
    // unchanged.
    expect(SCHEDULE).toMatch(
      /if \(r\.ok\) \{[\s\S]{0,240}?setConfirming\(false\);/,
    );
    expect(SCHEDULE).toMatch(/\} else \{[\s\S]{0,200}?setError\(r\.error\);/);
    // P2-02 added a focus handoff on the success branch only. The claim under
    // test is unchanged — success closes the dialog, failure does not — so the
    // pin allows that one statement between the branch and the close.
    expect(PORTAL).toMatch(
      /if \(r\.ok\) \{[\s\S]{0,240}?setArchiveTarget\(null\);/,
    );
    // And the failure branch still must NOT close it.
    expect(PORTAL).toMatch(/\} else \{\s*setArchiveError\(r\.error\);\s*\}/);
  });

  it("the portal card tracks WHICH message, which confirm() carried implicitly", () => {
    // A native confirm knew its target from the call stack. A mounted dialog
    // must be told, and `runArchive` must refuse to fire without one — losing
    // that would archive whatever the last-known id happened to be.
    expect(PORTAL).toMatch(/const \[archiveTarget, setArchiveTarget\]/);
    expect(PORTAL).toMatch(/open=\{archiveTarget !== null\}/);
    expect(PORTAL).toMatch(/if \(!archiveTarget\) return;/);
    expect(PORTAL).toMatch(/fd\.set\("message_id", archiveTarget\)/);
  });

  it("the tags card tracks WHICH tag, and refuses to fire without one", () => {
    // Same defect class as the portal card: a native confirm knew its target
    // from the call stack, a mounted dialog must be told. Losing this guard
    // would remove whatever id happened to be last.
    expect(TAGS).toMatch(/const \[removeTarget, setRemoveTarget\]/);
    expect(TAGS).toMatch(/open=\{removeTarget !== null\}/);
    expect(TAGS).toMatch(/if \(!removeTarget\) return;/);
    expect(TAGS).toMatch(/error=\{removeTarget \? error : null\}/);
    expect(TAGS).toMatch(/\{error && !removeTarget && \(/);
    expect(TAGS).toMatch(/await removeAction\(fd\)/);
    expect(TAGS).toMatch(/fd\.set\("tag_id", tagId\)/);
  });

  it("no mutation contract changed — same actions, same FormData fields", () => {
    expect(SCHEDULE).toMatch(/fd\.set\("stage_id", stage\.id\)/);
    expect(SCHEDULE).toMatch(/fd\.set\("plan_id", planId\)/);
    expect(SCHEDULE).toMatch(/fd\.set\("client_id", clientId\)/);
    expect(SCHEDULE).toMatch(/await deleteAction\(fd\)/);
    expect(PORTAL).toMatch(/fd\.set\("client_id", clientId\)/);
    expect(PORTAL).toMatch(/await archiveAction\(fd\)/);
  });

  it("invents no dialog of its own, and adds no dependency", () => {
    // The point is adoption. A second modal implementation here would be the
    // opposite of the slice.
    // NOT a text scan for `role="alertdialog"` any more. Both subjects
    // legitimately MENTION it in a docblock explaining why the shipped dialog
    // is used, so that assertion only ever passed because of the comment
    // stripping this slice just retired — it was measuring the pre-pass, not
    // the markup.
    //
    // The claim is "no second dialog implementation", so it is asserted against
    // what a second implementation would have to DO and a prose sentence never
    // does: portal an overlay, declare a native <dialog>, or set aria-modal.
    for (const [name, src] of [
      ["schedule", SCHEDULE],
      ["portal", PORTAL],
      ["tags", TAGS],
    ] as const) {
      expect(src, `${name} must not portal its own overlay`).not.toMatch(/createPortal/);
      expect(src, `${name} must not declare a native <dialog>`).not.toMatch(/<dialog[\s/>]/);
      expect(src, `${name} must not set aria-modal itself`).not.toMatch(/aria-modal=/);
    }
    // ...and the one component that legitimately does is the shipped dialog,
    // so the assertion above is discriminating rather than vacuously true of
    // every file in the repository.
    expect(
      read("components/confirm-dialog.tsx"),
      "the shipped dialog is the thing that sets aria-modal",
    ).toMatch(/aria-modal=/);
    // NOT a global count pin. The earlier version asserted
    // `Object.keys(pkg.dependencies).length === 21`, which breaks this
    // slice's test on ANY legitimate dependency addition anywhere in the
    // repository — a false failure with nothing to do with confirm dialogs.
    // Codex flagged it as a P3 and the reasoning generalises: a slice test
    // should assert what the slice forbids, not a repo-wide total.
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const deps = Object.keys(pkg.dependencies);
    for (const banned of [
      "framer-motion",
      "motion",
      "lucide-react",
      "clsx",
      "tailwind-merge",
      "@astryxdesign/core",
      "@radix-ui/react-dialog",
      "@headlessui/react",
      "sweetalert2",
    ]) {
      expect(deps, `${banned} must not be a dependency`).not.toContain(banned);
    }
  });
});
