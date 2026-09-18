import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import ts from "typescript";

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

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SCHEDULE = code("components/treatment-schedule-editor.tsx");
const PORTAL = code("components/portal-messages-card.tsx");
// Found only after the sweep was widened — see sweptFiles() for why it was
// invisible. The slice originally claimed there were TWO; there were three.
const TAGS = code("components/client-tags-card.tsx");

// ---------------------------------------------------------------------------
// ONE DEFINITION OF EACH ORACLE, used by the real sweep AND by its controls.
//
// Findings 4, 5 and 6 on this file were all the same defect at different
// removes: the coverage check built its expectation from the expression under
// test; the negative control re-implemented the coverage comparison inline;
// the synthetic control re-declared the regexes. Each "control" was a COPY of
// the thing it claimed to verify, so each would have agreed with a broken
// implementation.
//
// Patching them one at a time just moved the shape, so the plumbing is
// restructured instead: the patterns and both checkers are declared exactly
// once here, and every test below — real, synthetic and negative — calls these.
// A control can no longer silently disagree with what ships, because there is
// nothing else for it to call.
// ---------------------------------------------------------------------------

const GLOBAL_RECEIVERS = new Set(["window", "globalThis", "self"]);

/**
 * THE matcher — now LEXICAL, not textual. Returns the native-confirm forms in
 * one file's source.
 *
 * WHY THIS IS AN AST WALK AND NOT A PATTERN. The previous matcher exempted any
 * file that declared its own `confirm` ANYWHERE, wholesale. Codex showed that a
 * single unrelated binding in one scope therefore silenced a genuinely global
 * call in another:
 *
 *   function helper() { const confirm = local; confirm(); }
 *   function remove()  { confirm("Remove?"); }   // <- native, and MISSED
 *
 * The blanket exemption existed because a pattern cannot tell a call from a
 * declaration: `function confirm(` matches a bare-call regex, so without the
 * exemption every shadowing file flagged itself. An AST has no such problem —
 * a FunctionDeclaration is not a CallExpression — so the exemption is no longer
 * needed at all, and the gap it created goes with it.
 *
 * Resolution walks ENCLOSING scopes only: declarations in a sibling function do
 * not shadow. That is what makes the mixed-scope case above resolve to the
 * global and be reported.
 */
type Repairs = {
  /** A method's NAME is a property key, not a lexical binding. */
  methodNameIsNotABinding: boolean;
  /** `import type ...` / `import { type x }` introduce a TYPE, not a value. */
  typeOnlyImportIsNotAValue: boolean;
  /** `var` hoists to the enclosing FUNCTION, not to the block it sits in. */
  varHoistsToFunction: boolean;
};

/**
 * The shipped semantics. Every repair on.
 *
 * The toggles exist for ONE reason: a negative control must be able to switch a
 * single repair off and show the case goes undetected. Running the control
 * against a hand-copied "pre-repair" function would let the copy drift from the
 * thing it claims to falsify — the same defect this file already fixed once,
 * when a coverage oracle compared the sweep to a copy of itself. One definition,
 * one switch.
 */
const SHIPPED: Repairs = {
  methodNameIsNotABinding: true,
  typeOnlyImportIsNotAValue: true,
  varHoistsToFunction: true,
};

function nativeConfirmForms(
  src: string,
  fileName = "subject.tsx",
  repairs: Repairs = SHIPPED,
): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set<string>();

  const bindsConfirm = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      let hit = false;
      const declaredIn = (d: ts.Statement) => {
        if (ts.isVariableStatement(d)) {
          for (const v of d.declarationList.declarations)
            if (ts.isIdentifier(v.name) && v.name.text === "confirm") hit = true;
        } else if (
          (ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d)) &&
          d.name?.text === "confirm"
        ) {
          hit = true;
        } else if (ts.isImportDeclaration(d)) {
          const clause = d.importClause;
          // A TYPE-ONLY import introduces a TYPE, and a type binds nothing at
          // runtime — `import { type confirm } from "./types"` leaves a later
          // bare `confirm()` resolving to the browser global. Both spellings
          // count: the whole clause (`import type { confirm }`) and the single
          // specifier (`import { type confirm }`).
          const clauseIsTypeOnly = repairs.typeOnlyImportIsNotAValue && clause?.isTypeOnly === true;
          if (clause && !clauseIsTypeOnly) {
            if (clause.name?.text === "confirm") hit = true;
            const bindings = clause.namedBindings;
            if (bindings && ts.isNamedImports(bindings))
              for (const el of bindings.elements) {
                const specIsTypeOnly = repairs.typeOnlyImportIsNotAValue && el.isTypeOnly;
                if (!specIsTypeOnly && el.name.text === "confirm") hit = true;
              }
          }
        }
      };
      if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)) n.statements.forEach(declaredIn);
      if (ts.isFunctionLike(n)) {
        // Parameters bind in EVERY function-like, methods included.
        for (const param of n.parameters ?? [])
          if (ts.isIdentifier(param.name) && param.name.text === "confirm") hit = true;
        // A NAME, though, only binds for constructs whose name is actually in
        // scope: a function declaration, and a named function expression
        // (which binds its own name inside its body). A METHOD's name is a
        // property key, not a lexical binding — `{ confirm() { confirm(x) } }`
        // calls the global, and treating the key as a binding hid exactly that.
        const nameBinds = repairs.methodNameIsNotABinding
          ? ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
          : true;
        const nameNode = (n as ts.FunctionLikeDeclaration).name;
        if (nameBinds && nameNode && ts.isIdentifier(nameNode) && nameNode.text === "confirm") {
          hit = true;
        }
      }
      // `var` HOISTS. It binds throughout the nearest enclosing function
      // regardless of which block it is written in, so the statement walk above
      // — which only reads the statements of each enclosing block — cannot see
      // it. `function f() { { var confirm = x; } confirm("Remove?"); }` binds,
      // and classifying that call as the browser global was the third defect.
      if (
        repairs.varHoistsToFunction &&
        (ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isFunctionLike(n)) &&
        hoistedVarBindsConfirm(n)
      ) {
        hit = true;
      }
      if (hit) return true;
    }
    return false;
  };

  /**
   * Does a `var confirm` hoist to THIS scope?
   *
   * Descends through blocks and statements but stops at any nested function or
   * module block, because a `var` there hoists to IT, not here. That boundary is
   * what preserves the earlier mixed-scope repair: a sibling function's `var`
   * must still not silence a genuinely global call.
   *
   * `let` and `const` are deliberately excluded — they are block-scoped and are
   * already resolved correctly by the statement walk.
   */
  function hoistedVarBindsConfirm(scope: ts.Node): boolean {
    let found = false;
    const fromList = (list: ts.VariableDeclarationList) => {
      if ((list.flags & ts.NodeFlags.BlockScoped) !== 0) return;
      for (const v of list.declarations)
        if (ts.isIdentifier(v.name) && v.name.text === "confirm") found = true;
    };
    const scan = (node: ts.Node): void => {
      if (found) return;
      if (node !== scope && (ts.isFunctionLike(node) || ts.isModuleBlock(node))) return;
      if (ts.isVariableStatement(node)) fromList(node.declarationList);
      // `for (var confirm = 0; ;)` — a for-initializer list is not wrapped in a
      // VariableStatement, so it needs naming separately.
      if (
        (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        fromList(node.initializer);
      }
      ts.forEachChild(node, scan);
    };
    scan(scope);
    return found;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "confirm" && !bindsConfirm(node)) {
        found.add("bare confirm()");
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "confirm" &&
        ts.isIdentifier(callee.expression) &&
        GLOBAL_RECEIVERS.has(callee.expression.text)
      ) {
        found.add(`${callee.expression.text}.confirm`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found];
}

/**
 * The RETIRED file-wide rule, kept ONLY so a control can show the new matcher
 * catches what it missed. Never used by the sweep.
 */
function fileWideExemptionForms(src: string): string[] {
  const declaresOwn = /(?:function\s+confirm\s*\(|(?:const|let|var)\s+confirm\s*=)/;
  const bare = /(?<![\w.$])confirm\s*\(/;
  return !declaresOwn.test(src) && bare.test(src) ? ["bare confirm()"] : [];
}

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

describe("UI-05: no native confirm survives anywhere in the app", () => {
  it("app/ and components/ contain ZERO live native confirm calls", () => {
    const hits = sweptFiles().flatMap((f) => {
      const forms = nativeConfirmForms(code(f));
      return forms.length ? [`${f} (${forms.join(", ")})`] : [];
    });
    expect(hits, `native confirm still called in: ${hits.join(" | ")}`).toEqual([]);
  });

  it("the matcher MATCHES — synthetic inputs, through the shipped matcher", () => {
    // Calls nativeConfirmForms, not a re-declared copy of its regexes. A
    // negative-only sweep passes just as well when its patterns are broken,
    // and a green repository cannot demonstrate that half.
    expect(nativeConfirmForms('if (!confirm("go?")) return;')).toContain("bare confirm()");
    expect(nativeConfirmForms("confirm ('spaced')")).toContain("bare confirm()");
    expect(nativeConfirmForms("window . confirm(1)")).toContain("window.confirm");
    expect(nativeConfirmForms("globalThis.confirm(1)")).toContain("globalThis.confirm");

    // Near misses: identifiers that merely contain the word.
    expect(nativeConfirmForms("onConfirm()")).toEqual([]);
    expect(nativeConfirmForms("handleConfirm()")).toEqual([]);
    expect(nativeConfirmForms("dialog.confirm()")).toEqual([]);

    // Shadowing, resolved lexically rather than exempted wholesale.
    const shadowed = 'function confirm() { run(); }\nconst onClick = () => confirm();';
    expect(nativeConfirmForms(shadowed)).toEqual([]);
    // A declaration is not a call, so the bare form no longer needs an exemption.
    expect(nativeConfirmForms("function confirm() { run(); }")).toEqual([]);
    // ...and a QUALIFIED call in such a file is still unambiguous and caught.
    expect(nativeConfirmForms(`${shadowed}\nwindow.confirm("x")`)).toContain("window.confirm");

    // Shadowing binds in every form a scope can introduce it.
    expect(nativeConfirmForms("function outer(){ function confirm(){ run(); } confirm(); }")).toEqual([]);
    expect(nativeConfirmForms("function f(confirm){ confirm(); }")).toEqual([]);
    expect(nativeConfirmForms('import { confirm } from "./x";\nconfirm();')).toEqual([]);

    // A METHOD NAMED `confirm` IS NOT A LEXICAL BINDING. Raised by Codex
    // against the first AST revision: `ts.isFunctionLike` is true for a
    // MethodDeclaration, so its PROPERTY name was being treated as a binding
    // inside its own body. The call below resolves to the browser global.
    expect(nativeConfirmForms('const x = { confirm() { confirm("Remove?"); } };')).toContain(
      "bare confirm()",
    );
    expect(nativeConfirmForms('class C { confirm() { confirm("Remove?"); } }')).toContain(
      "bare confirm()",
    );
    // ...whereas a NAMED FUNCTION EXPRESSION does bind its own name in its body.
    expect(nativeConfirmForms("const f = function confirm() { confirm(); };")).toEqual([]);
  });

  it("MIXED local and global scopes — a sibling binding does not silence a native call", () => {
    // Codex's finding, as an executable control. An unrelated `confirm` binding
    // in one function must not exempt a genuinely global call in another.
    const mixed =
      'function helper() { const confirm = local; confirm(); }\n' +
      'function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(mixed)).toContain("bare confirm()");

    // The same call with NO binding anywhere is also caught — so the control
    // above is about scope, not about the call being detectable at all.
    expect(nativeConfirmForms('function remove() { confirm("Remove?"); }')).toContain(
      "bare confirm()",
    );
  });

  it("THE MIXED-SCOPE CONTROL BITES — the retired file-wide rule fails it", () => {
    // Without this, the test above could pass against a matcher that never had
    // the defect, and would prove nothing about the repair. The retired rule is
    // run on the same input and must MISS it.
    const mixed =
      'function helper() { const confirm = local; confirm(); }\n' +
      'function remove() { confirm("Remove?"); }';
    expect(fileWideExemptionForms(mixed), "the old rule must miss this").toEqual([]);
    expect(nativeConfirmForms(mixed), "the shipped matcher must catch it").toContain(
      "bare confirm()",
    );
  });

  it("TYPE-ONLY imports bind no value — a later bare call is still the global", () => {
    // Codex, at d356ed84. A type import is erased at runtime, so it cannot
    // shadow anything. Both spellings had been treated as value bindings, which
    // SILENCED a genuine native confirm — a false negative, the dangerous
    // direction for a guard whose whole job is to find them.
    const specifier =
      'import { type confirm } from "./types";\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(specifier)).toContain("bare confirm()");

    const clause =
      'import type { confirm } from "./types";\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(clause)).toContain("bare confirm()");

    const defaultType =
      'import type confirm from "./types";\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(defaultType)).toContain("bare confirm()");

    // ...and the repair must not over-correct: a VALUE import still binds, and
    // a mixed clause binds only the value specifier.
    const value =
      'import { confirm } from "./ui";\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(value), "a value import must still shadow").toEqual([]);

    const mixed =
      'import { type Other, confirm } from "./ui";\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(mixed), "the value half of a mixed clause binds").toEqual([]);
  });

  it("`var` HOISTS to the enclosing function, not to the block it is written in", () => {
    // Codex, at d356ed84. The statement walk only read each enclosing block's
    // own statements, so a `var` nested one block deeper was invisible and the
    // later call was reported as the browser global — a FALSE POSITIVE here,
    // the opposite direction from the two findings above.
    const hoisted = 'export function remove() { { var confirm = local; } confirm("Remove?"); }';
    expect(nativeConfirmForms(hoisted), "var binds throughout the function").toEqual([]);

    // A for-initializer list is not wrapped in a VariableStatement.
    const forVar =
      'export function remove() { for (var confirm = 0; ; ) break; confirm("Remove?"); }';
    expect(nativeConfirmForms(forVar), "a for-initializer var hoists too").toEqual([]);

    // THE DISCRIMINATING HALF. `let` is block-scoped, so the same shape with
    // `let` must still be reported. Without this the test above would also pass
    // against a matcher that simply treats any nested declaration as a binding,
    // which would be a different bug rather than hoisting.
    const blockScoped =
      'export function remove() { { let confirm = local; } confirm("Remove?"); }';
    expect(nativeConfirmForms(blockScoped), "let must NOT leak out of its block").toContain(
      "bare confirm()",
    );
    const constScoped =
      'export function remove() { { const confirm = local; } confirm("Remove?"); }';
    expect(nativeConfirmForms(constScoped), "const must NOT leak either").toContain(
      "bare confirm()",
    );

    // ...and the earlier mixed-scope repair still holds: a SIBLING function's
    // var hoists to that function, not to this one.
    const sibling =
      'function helper() { { var confirm = local; } }\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(nativeConfirmForms(sibling), "a sibling function's var must not leak").toContain(
      "bare confirm()",
    );
  });

  it("THE THREE FRESH REPAIRS BITE — each switched off misses its own case", () => {
    // Negative controls, one per finding, run against the SAME definition with
    // a single repair disabled. A test that only asserts the repaired behaviour
    // would pass just as well against a matcher that never had the defect.
    //
    // Note the two DIRECTIONS, which is the point of reading the semantics
    // rather than making things red: findings 1 and 2 were false NEGATIVES (a
    // real native confirm silenced); finding 3 was a false POSITIVE (a properly
    // bound call reported as global).

    const method = 'const x = { confirm() { confirm("Remove?"); } };';
    expect(
      nativeConfirmForms(method, "subject.tsx", { ...SHIPPED, methodNameIsNotABinding: false }),
      "pre-repair: a method name was read as a binding, silencing the call",
    ).toEqual([]);
    expect(nativeConfirmForms(method), "shipped: caught").toContain("bare confirm()");

    const typeOnly =
      'import { type confirm } from "./types";\n' +
      'export function remove() { confirm("Remove?"); }';
    expect(
      nativeConfirmForms(typeOnly, "subject.tsx", {
        ...SHIPPED,
        typeOnlyImportIsNotAValue: false,
      }),
      "pre-repair: a type-only import was read as a value, silencing the call",
    ).toEqual([]);
    expect(nativeConfirmForms(typeOnly), "shipped: caught").toContain("bare confirm()");

    const hoisted = 'export function remove() { { var confirm = local; } confirm("Remove?"); }';
    expect(
      nativeConfirmForms(hoisted, "subject.tsx", { ...SHIPPED, varHoistsToFunction: false }),
      "pre-repair: a hoisted var was invisible, so a BOUND call was reported as global",
    ).toContain("bare confirm()");
    expect(nativeConfirmForms(hoisted), "shipped: correctly bound").toEqual([]);
  });

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

  it("the SCOPE-AWARE half of the guard is configured", () => {
    // The sweep cannot resolve a name to its binding, so it exempts any file
    // declaring its own `confirm` wholesale — meaning a genuinely native
    // receiver-less call inside such a file would be missed. That gap is not
    // fixable with a pattern, and Codex raised it.
    //
    // ESLint's no-restricted-globals fires only when the identifier resolves to
    // the GLOBAL, so a local declaration shadows it correctly. This asserts the
    // rule EXISTS and is scoped to these roots; the rule itself is proved by
    // `npm run lint` in CI, and its two directions were verified against real
    // fixtures (a bare call is rejected; a shadowed local is not).
    //
    // Asserting the presence of the OTHER mechanism is not a duplicated oracle:
    // the two are deliberately independent. The rule reasons about scope but
    // only over files ESLint lints; the sweep reads every file on disk. Neither
    // is a superset, which is why both exist.
    const cfg = read("eslint.config.mjs");
    expect(cfg).toMatch(/files: \["app\/\*\*\/\*\.\{ts,tsx\}", "components\/\*\*\/\*\.\{ts,tsx\}"\]/);
    expect(cfg).toMatch(/name: "confirm"/);
    expect(cfg).toMatch(/Use ConfirmDialog/);
    // alert/prompt are the same class and were at zero call sites, so the rule
    // arms for them without a migration.
    expect(cfg).toMatch(/name: "alert"/);
    expect(cfg).toMatch(/name: "prompt"/);
  });

  it("the lint scopes are DISJOINT, so neither guard disarms the other", () => {
    // This is a regression fence for real damage I caused. ESLint flat config
    // REPLACES a rule's options rather than merging them, and the last matching
    // object wins. The UI-05 block matches app/** and originally also covered
    // app/(app)/financials/**, sitting after the FIN-01A block — so it replaced
    // FIN's `no-restricted-globals` outright and silently disarmed that lane's
    // ESM guard. A `require` under app/(app)/financials/** linted clean, and
    // nothing said so. Codex caught it.
    //
    // My first repair added the dialog restrictions INTO the FIN block and
    // fixed nothing, because FIN's block still never won for its own files.
    // The working fix is disjoint scopes plus FIN carrying both sets.
    //
    // Verified by probe in five directions (FIN require, FIN confirm,
    // lib/finance require, component confirm, shadowed local); this pins the
    // structure those probes depend on.
    const cfg = read("eslint.config.mjs");
    expect(cfg, "the dialog restrictions must be declared once").toMatch(
      /const NATIVE_DIALOG_GLOBALS = \[/,
    );
    // The UI-05 block must exclude the FIN scope...
    expect(cfg, "UI-05 must not overlap the FIN scope").toMatch(
      /ignores: \["app\/\(app\)\/financials\/\*\*"\]/,
    );
    // ...and the FIN block must carry BOTH sets, since it governs those files.
    expect(cfg, "FIN keeps its ESM restrictions").toMatch(/name: "require"/);
    expect(cfg, "FIN also gets the dialog restrictions").toMatch(
      /\.\.\.NATIVE_DIALOG_GLOBALS,/,
    );
    // Two separate spreads: one in the FIN block, one in the UI-05 block.
    expect((cfg.match(/\.\.\.NATIVE_DIALOG_GLOBALS/g) ?? []).length).toBe(2);
  });

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
    expect(SCHEDULE).toMatch(/if \(r\.ok\) \{\s*setConfirming\(false\);/);
    expect(PORTAL).toMatch(/if \(r\.ok\) \{\s*setArchiveTarget\(null\);/);
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
    for (const src of [SCHEDULE, PORTAL]) {
      expect(src).not.toMatch(/role="alertdialog"/);
      expect(src).not.toMatch(/aria-modal/);
    }
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
