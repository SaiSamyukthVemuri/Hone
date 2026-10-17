import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// UI-05. The native-dialog restrictions, declared once.
//
// These must be REPEATED into every config object that also sets
// `no-restricted-globals` for an overlapping file set, because ESLint flat
// config REPLACES a rule's options rather than merging them: the last matching
// object wins outright. Sharing one array is what stops the two guards from
// silently cancelling each other — see the note in the FIN-01A block.
const NATIVE_DIALOG_GLOBALS = [
  {
    name: "confirm",
    message:
      "Use ConfirmDialog (components/confirm-dialog.tsx). iOS Safari can suppress a native confirm silently, so the guard returns false and the mutation never runs.",
  },
  {
    name: "alert",
    message: "Native alert() is not used in Hone surfaces; render the message in the UI.",
  },
  {
    name: "prompt",
    message: "Native prompt() is not used in Hone surfaces; use a real form control.",
  },
];

// UI-05 ARCHITECTURE RE-ENTRY. The receiver-qualified half of the same
// restriction.
//
// `no-restricted-globals` fires only on a GLOBAL IDENTIFIER REFERENCE, so
// `window.confirm(...)` is invisible to it — a member expression is not an
// identifier reference. `no-restricted-properties` is the rule that sees those,
// and measurement (see the architecture review) showed it already covers far
// more than the dotted form:
//
//   window.confirm(x)              dotted
//   window["confirm"](x)           computed, string literal
//   window[`confirm`](x)           computed, no-substitution template
//   (window.confirm)(x)            parenthesised — ESTree has NO paren node,
//                                  so the wrapper simply does not exist here
//   (window.confirm as any)(x)     erased type wrapper
//   window.confirm!(x)             non-null assertion
//   (<typeof window.confirm>w.c)(x) angle-bracket assertion
//
// Every one of those cost a hand-written repair round in the retired resolver.
// None of them needs code here.
const NATIVE_DIALOG_RECEIVERS = ["window", "globalThis", "self"];

// P2-02 on #723 (Codex, exact head 3ef45f70). `no-restricted-properties`
// matches a member expression by the OBJECT'S SPELLING and never resolves it,
// so it rejected a legitimate local receiver that merely happens to be named
// `window`, `globalThis` or `self` — reproduced with
// `function f(self: DialogAdapter) { return self.confirm("ok") }`, which linted
// as an error. That both blocks unrelated product code and weakens the guard's
// own claim that legitimate bindings stay legal.
//
// ESLint core cannot express "this receiver is THE global", so this is the
// smallest thing that can: a local rule that does the same job and asks the
// scope analyser the one question core skips. It is declared inline — no new
// package, no new file — and it REPLACES the dialog entries in
// `no-restricted-properties` rather than sitting beside them, because two
// mechanisms firing on the same node would double-report.
//
// It still sees every wrapper form the retired resolver needed hand-written
// repairs for, because each one leaves the MemberExpression itself intact in
// the AST: dotted, computed string literal, computed no-substitution template,
// parenthesised (ESTree has no paren node), `as any`, and non-null assertion.
const NATIVE_DIALOG_PROPERTY_NAMES = ["confirm", "alert", "prompt"];

const staticPropertyName = (node) => {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : null;
  }
  const p = node.property;
  if (p.type === "Literal" && typeof p.value === "string") return p.value;
  if (
    p.type === "TemplateLiteral" &&
    p.quasis.length === 1 &&
    p.expressions.length === 0
  ) {
    return p.quasis[0].value.cooked;
  }
  return null;
};

// A binding whose every definition is ERASED at compile time (`declare const
// window`, `import type { window }`) does not shadow anything at runtime, so
// the call still reaches the real global. Treat it as global, which mirrors the
// reasoning already recorded for NATIVE_DIALOG_ERASED_SHADOWS below.
// An ambient CONTEXT, including one inherited from an enclosing `declare global
// { ... }` or `declare module`. A `var` written inside such a block carries no
// `declare` modifier of its own — the modifier is on the enclosing
// TSModuleDeclaration — so checking only the immediate parent cannot see it.
//
// This currently changes no verdict: measured across ten `declare global`
// fixtures, typescript-eslint does not register those augmentations in the
// file's scope chain, so the receiver comes out UNRESOLVED and is already
// treated as global. That is the right answer for the wrong reason, and it
// would silently invert if that scope-manager behaviour ever changed. Making
// the intent explicit is what stops a future flip from reading as correct.
const inAmbientContext = (node) => {
  for (let n = node; n; n = n.parent) {
    if (n.declare === true) return true;
    if (n.type === "TSModuleDeclaration" && (n.global === true || n.declare === true)) {
      return true;
    }
  }
  return false;
};

const isErasedDef = (def) => {
  const parent = def.parent;
  if (parent && parent.type === "ImportDeclaration" && parent.importKind === "type") return true;
  if (parent && inAmbientContext(parent)) return true;
  if (def.node && inAmbientContext(def.node)) return true;
  return false;
};

const resolvesToGlobal = (scope, name) => {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (!variable) continue;
    // No definitions at all = the environment-provided global.
    if (variable.defs.length === 0) return true;
    return variable.defs.every(isErasedDef);
  }
  return true; // never bound anywhere = global
};

const nativeDialogPlugin = {
  rules: {
    "no-native-dialog-receiver": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          confirm:
            "Use ConfirmDialog (components/confirm-dialog.tsx). iOS Safari can suppress {{object}}.confirm silently, so the guard returns false and the mutation never runs.",
          alert:
            "Native {{object}}.alert() is not used in Hone surfaces; render the message in the UI.",
          prompt:
            "Native {{object}}.prompt() is not used in Hone surfaces; use a real form control.",
        },
      },
      create(context) {
        const source = context.sourceCode ?? context.getSourceCode();
        return {
          MemberExpression(node) {
            if (node.object.type !== "Identifier") return;
            const object = node.object.name;
            if (!NATIVE_DIALOG_RECEIVERS.includes(object)) return;
            const property = staticPropertyName(node);
            if (!property || !NATIVE_DIALOG_PROPERTY_NAMES.includes(property)) return;
            const scope = source.getScope ? source.getScope(node) : context.getScope();
            if (!resolvesToGlobal(scope, object)) return;
            context.report({ node, messageId: property, data: { object } });
          },
        };
      },
    },
  },
};



// THE ONE CLASS ESLINT'S SCOPE ANALYSER CANNOT DECIDE FOR US.
//
// `declare const confirm` and `import { type confirm }` DO create a variable in
// ESLint's scope, so `no-restricted-globals` correctly believes the name is
// shadowed — but both are ERASED at runtime, so the call still reaches the
// browser global. The retired resolver tried to decide erasure semantically and
// took two findings doing it.
//
// This does not decide erasure. It FORBIDS THE ERASED SHADOW ITSELF: a tracked
// product file may not introduce a type-only or ambient binding named after a
// native dialog. That needs no resolution, and it is strictly stronger than
// judging whether such a declaration shadows.
//
// The selectors are narrow on purpose. `ImportDefaultSpecifier[local.name=...]`
// alone would also reject a legitimate VALUE default import, which measurement
// confirmed; gating on `ImportDeclaration[importKind="type"]` distinguishes them.
const NATIVE_DIALOG_NAMES = ["confirm", "alert", "prompt"];

const NATIVE_DIALOG_ERASED_SHADOWS = NATIVE_DIALOG_NAMES.flatMap((name) => {
  const why =
    `An ambient or type-only \`${name}\` is erased at runtime, so it cannot shadow the browser global — a later bare \`${name}(...)\` would still open a native dialog. Name the local binding something else.`;
  return [
    { selector: `VariableDeclaration[declare=true] > VariableDeclarator[id.name="${name}"]`, message: why },
    { selector: `TSDeclareFunction[id.name="${name}"]`, message: why },
    { selector: `TSModuleDeclaration VariableDeclarator[id.name="${name}"]`, message: why },
    { selector: `ImportDeclaration[importKind="type"] ImportSpecifier[local.name="${name}"]`, message: why },
    { selector: `ImportSpecifier[importKind="type"][local.name="${name}"]`, message: why },
    { selector: `ImportDeclaration[importKind="type"] ImportDefaultSpecifier[local.name="${name}"]`, message: why },
  ];
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // FIN-01A Slice 1 is ESM-only. This is a CODING CONSTRAINT on the code FIN
    // owns, not a proof that runtime module loading is impossible: eleven of
    // the seventeen modules in FIN's dependency closure are shared
    // infrastructure (lib/supabase/server.ts alone has 96 importers) that no
    // FIN-scoped rule can bind. The static side is proved separately by
    // compiler-backed module resolution in tests/app/finance/financials-truth.test.ts.
    //
    // FORMS THESE THREE RULES ARE KNOWN TO REJECT, each with a fixture in
    // NC-lint that asserts the expected rule id fires. The fixtures show these
    // examples are rejected; they are not a survey of everything the rules
    // reject, and the constraint may grow.
    //
    //   no-restricted-globals    a value-position `require`, `module` or
    //                            `exports` in ANY expression shape — called,
    //                            aliased, parenthesised, instantiated,
    //                            conditional, comma-sequenced, or as the object
    //                            of a dotted, computed or concatenated member.
    //   no-restricted-imports    a STATIC import or re-export of "node:module"
    //                            or "module", type-only included.
    //   no-restricted-properties `process.getBuiltinModule`, dotted or with a
    //                            literal computed key.
    //
    // WHAT THEY DO NOT REJECT, stated because an unstated gap reads as coverage:
    //
    //   * `import("node:module")` — core no-restricted-imports visits static
    //     declarations only, so a dynamic import of the loader raises nothing
    //     here.
    //   * `globalThis.process.getBuiltinModule(...)`, or aliasing `process`
    //     first — no-restricted-properties matches only when the immediate
    //     object identifier is literally `process`.
    //
    // Both were raised by Codex against an earlier wording that implied wider
    // cover. No no-restricted-syntax selectors were added to chase them: a
    // hand-written selector list is the enumeration this architecture was
    // adopted to stop. The honest move is the smaller claim, not a longer list.
    //
    // These gaps are recorded as the measured state of these rules, not as an
    // invariant. A future lint improvement that starts covering them is welcome
    // and breaks nothing here.
    //
    // `createRequire` is deliberately NOT in no-restricted-globals: it is never
    // a global, so listing it there would have looked like coverage and been
    // none. The acquisition path these rules DO reject is the static
    // node:module import. That is not the only path it has — the two gaps above
    // are others, and they are uncovered — so this is stated as one rejected
    // form rather than as the entry.
    files: ["app/(app)/financials/**/*.{ts,tsx}", "lib/finance/**/*.{ts,tsx}"],
    plugins: { "hone-dialog": nativeDialogPlugin },
    rules: {
      // THE DIALOG RESTRICTIONS ARE REPEATED HERE DELIBERATELY.
      //
      // app/(app)/financials/** is also matched by the UI-05 block below, and
      // ESLint flat config REPLACES a rule's options rather than merging them —
      // the last matching object wins outright. When UI-05 first added its
      // block it therefore DISARMED these three FIN restrictions for every file
      // under app/(app)/financials/**, silently: `require` stopped failing lint
      // there and nothing said so. Verified by probe (a `require` in that scope
      // linted clean) and raised by Codex.
      //
      // So both sets live in both objects. Whichever object wins for a given
      // file, that file keeps every restriction that applies to it.
      "no-restricted-globals": [
        "error",
        { name: "require", message: "FIN-01A is ESM-only: no CommonJS loader." },
        { name: "module", message: "FIN-01A is ESM-only: no CommonJS module object." },
        { name: "exports", message: "FIN-01A is ESM-only: no CommonJS exports object." },
        ...NATIVE_DIALOG_GLOBALS,
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "node:module", message: "FIN-01A is ESM-only: no Node loader facility." },
            { name: "module", message: "FIN-01A is ESM-only: no Node loader facility." },
          ],
        },
      ],
      // BOTH SETS, SAME REASON AS no-restricted-globals ABOVE — and this key
      // is the one my own architecture note initially got wrong. I told review
      // that `no-restricted-properties` was "a different rule key, so it cannot
      // replace FIN's options". FIN SETS THIS KEY TOO, so it can, and a probe
      // reproduced the disarm: with the UI-05 block matching this subtree and
      // carrying only the dialog set, `process.getBuiltinModule` linted clean
      // under app/(app)/financials/**.
      //
      // Repetition — not flat-config merging, which does not exist — is what
      // keeps both guards armed for these files. lib/finance/** additionally
      // depends on it: the UI-05 block does not match that path at all, so
      // these repeated entries are its ONLY dialog coverage.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "getBuiltinModule",
          message: "FIN-01A is ESM-only: no runtime acquisition of the module loader.",
        },
      ],
      "hone-dialog/no-native-dialog-receiver": "error",
      "no-restricted-syntax": ["error", ...NATIVE_DIALOG_ERASED_SHADOWS],
    },
  },
  {
    // UI-05. Native browser dialogs are not allowed in practitioner or client
    // surfaces. This is the SCOPE-AWARE half of that guard, and it exists
    // because a regex one cannot be.
    //
    // WHY A LINT RULE AND NOT (only) A TEST. The slice's source sweep asks
    // "does this file contain a call that looks native", and a bare `confirm(`
    // is ambiguous: a file may declare `function confirm()` of its own, as
    // app/(app)/calendar/PostcareSendButton.tsx does, and every bare call in it
    // is then a LOCAL call. The sweep exempts such files WHOLESALE, which means
    // a genuinely native receiver-less call inside one would be missed. Codex
    // raised exactly that, and it is not fixable with a pattern: resolving a
    // name to its binding needs a scope analysis.
    //
    // ESLint already has one. `no-restricted-globals` fires only when the
    // identifier resolves to the GLOBAL, so a local declaration shadows it
    // correctly and no exemption heuristic is needed. Same mechanism, same
    // rule, same file-scoping style the FIN-01A block above uses.
    //
    // TWO INDEPENDENT MECHANISMS, deliberately. The rule reasons about scope
    // but only over files ESLint lints; the sweep reads every .ts/.tsx under
    // these roots from disk, including any the lint config ever stops covering.
    // Neither is a superset of the other, which is the point — the earlier
    // rounds of this slice went wrong precisely because a "control" shared its
    // mechanism with the thing it checked.
    //
    // WHAT THIS DOES NOT REJECT, stated because an unstated gap reads as
    // coverage:
    //
    //   * `window.confirm(...)`, `globalThis.confirm(...)`, `self.confirm(...)`
    //     — member expressions, not global identifier references, so this rule
    //     does not see them. The source sweep does, and that is the division.
    //   * a dialog reached through an alias (`const c = window.confirm`).
    //     Neither mechanism catches that today.
    //
    // `alert` and `prompt` are included because they are the same class of
    // native dialog and both are currently at zero bare call sites, so the rule
    // arms without a migration. `confirm` is the one this slice retired.
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    // NON-OVERLAPPING WITH THE FIN-01A BLOCK, and this `ignores` is the whole
    // fix. ESLint flat config REPLACES a rule's options rather than merging
    // them, and the LAST matching object wins. Because this block matches
    // app/(app)/financials/** too and sits after FIN's, it replaced FIN's
    // `no-restricted-globals` outright and silently disarmed the ESM guard
    // there — a `require` in that scope linted clean.
    //
    // My first attempt at repairing that added the dialog restrictions INTO the
    // FIN block, which fixed nothing: FIN's block still never won for its own
    // files. Probing each direction rather than reasoning about precedence is
    // what caught it. The scopes are now disjoint, so each file is governed by
    // exactly one object, and the FIN block carries both sets for its files.
    ignores: ["app/(app)/financials/**"],
    plugins: { "hone-dialog": nativeDialogPlugin },
    rules: {
      "no-restricted-globals": ["error", ...NATIVE_DIALOG_GLOBALS],
      "hone-dialog/no-native-dialog-receiver": "error",
      "no-restricted-syntax": ["error", ...NATIVE_DIALOG_ERASED_SHADOWS],
    },
  },
];

export default eslintConfig;
