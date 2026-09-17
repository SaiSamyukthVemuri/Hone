import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
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
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "require", message: "FIN-01A is ESM-only: no CommonJS loader." },
        { name: "module", message: "FIN-01A is ESM-only: no CommonJS module object." },
        { name: "exports", message: "FIN-01A is ESM-only: no CommonJS exports object." },
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
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "getBuiltinModule",
          message: "FIN-01A is ESM-only: no runtime acquisition of the module loader.",
        },
      ],
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
    rules: {
      "no-restricted-globals": [
        "error",
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
      ],
    },
  },
];

export default eslintConfig;
