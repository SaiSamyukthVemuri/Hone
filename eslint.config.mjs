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
    // Every rule below was checked against a fixture before being added, and is
    // exercised by NC-lint in that file. `createRequire` is deliberately NOT in
    // no-restricted-globals: it is never a global, so the entry it actually has
    // into FIN code is the node:module import, which no-restricted-imports
    // catches. Listing it there would have looked like coverage and been none.
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
