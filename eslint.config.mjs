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
];

export default eslintConfig;
