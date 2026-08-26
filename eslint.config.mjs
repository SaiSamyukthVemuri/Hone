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
    // WHAT THESE THREE RULES MECHANICALLY REJECT, measured form by form and
    // pinned one fixture each in NC-lint. This list is the constraint; the
    // constraint is not larger than this list.
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
    //     here. The static ESM guard happens to flag it today, but only because
    //     `node:module` does not RESOLVE in this repository; that would stop
    //     being true the moment @types/node reached the resolution path, so it
    //     is not a loader rule and is not claimed as one.
    //   * `globalThis.process.getBuiltinModule(...)`, or aliasing `process`
    //     first — no-restricted-properties matches only when the immediate
    //     object identifier is literally `process`.
    //
    // Both were raised by Codex against an earlier wording that implied wider
    // cover. NO no-restricted-syntax SELECTORS WERE ADDED TO CHASE THEM: a
    // hand-written selector list is the enumeration this architecture was
    // adopted to stop, and no existing general rule closes the class. The
    // honest move is the smaller claim, not a longer list.
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
