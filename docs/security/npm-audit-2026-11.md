# npm audit, November 2026: what was fixed and what remains

Recorded 2026-11-04 on branch `ops/deps-audit-20261104`, cut from production
`8dedcf694`. This was a lockfile-only update. `package.json` is unchanged and
nothing moved to a new major version. Source review: the operator's
`NPM-AUDIT-REVIEW-20261104` (handoff, outside the repo).

Toolchain: node 24.22.1 and npm 11.19.1, the same node version CI pins. Counts
come from `npm audit --json` run on a clean `npm ci` of the committed lockfile.

| | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| Before (full tree) | 2 | 8 | 24 | 0 | 34 |
| After (full tree) | 0 | 1 | 20 | 0 | 21 |
| Before (`--omit=dev`) | 2 | 6 | 8 | 0 | 16 |
| After (`--omit=dev`) | 0 | 1 | 7 | 0 | 8 |

npm audit counts one entry per package. Each count above is a package carrying
one or more advisories.

## This is not blanket acceptance

Each remaining finding below is a **recorded exception**. Its row gives its
reason and its own revisit trigger. When that trigger fires, re-check that row
on its own. Clearing one row does not clear the others, and a new advisory
against any of these packages is a new finding, not covered here. Re-run
`npm audit --json` whenever `package-lock.json` changes.

Class key:
- **runtime**: ships in the deployed server or browser bundle.
- **build-only**: in the production dependency tree, but it runs only during
  `next build`.
- **dev-only**: absent from `npm ls --omit=dev`.

## Fixed in this change

| Package | Before → after | Advisories cleared | Class |
|---|---|---|---|
| `@sentry/nextjs` (direct) | 10.66.0 → **10.76.1** (deliberately not 10.78.0, see below) | GHSA-mchm-gjx6-7h55 (critical, tunnel-route middleware bypass, <10.75.2). The package is still listed, at moderate, because of `glob` (see below). | runtime |
| `@sentry/webpack-plugin` | 5.4.0 → 5.4.1 | none on its own. It is still listed because of `glob`. | build-only |
| `dompurify` (via posthog-js) | 3.4.12 → 3.4.17 | GHSA-cg2g-xh64-v4q7 (critical), GHSA-mrv2-3pqr-j5jr, GHSA-55q2-fjhq-7xh7, GHSA-6688-9rhm-gjv2, GHSA-c6gr-qvv4-5v3f | runtime (posthog-js product-tours chunk) |
| `fflate` (via posthog-js) | 0.4.8 → 0.4.9 | GHSA-px8p-9vwx-vf98 | runtime |
| `vitest` (direct) | 4.1.8 → 4.1.12 | GHSA-82fw-gwwq-j7x9 | dev-only |
| `@vitest/coverage-v8` (direct) | 4.1.8 → 4.1.12 | inherited from vitest | dev-only |
| `@vitest/mocker` | 4.1.8 → 4.1.12 | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | dev-only |
| `vite` | 8.0.16 → 8.3.5 | GHSA-rq7h-c2jc-7f22, GHSA-9jrq-w75r-8gcw, GHSA-587h-7wmj-h5pm, GHSA-r825-w8mm-5pxw, GHSA-698v-4r3x-3vcv | dev-only |
| `js-yaml` | 4.1.1 → 4.3.2 | GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh | dev-only |
| `brace-expansion` | 1.1.14 → 1.1.21; 5.0.6/5.0.7 → 5.0.12 | GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr | build-only / dev-only |
| `nanoid` | 3.3.12 → 3.3.20 | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8 | build-only |
| `source-map-js` | 1.2.1 → 1.2.2 | GHSA-68fv-2mgg-jv7q | build-only |
| `browserslist` | 4.28.6 → 4.29.5 | GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g | build-only |
| `baseline-browser-mapping` | 2.10.43 → 2.11.35 | GHSA-w5vr-8v7q-w6rv | build-only |
| `fast-uri` | 3.1.3 → 3.1.9 | GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7, GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-qw65-cvwx-89v3, GHSA-hrr3-gc8f-f4qj, GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp | build-only |
| `postcss` (top-level, via tailwind/vite) | 8.5.15 → 8.5.32 | the four postcss advisories listed below, for this copy only | build-only / dev-only |

The 2 criticals and 7 of the 8 highs are cleared. 13 audit entries are gone.

### Why `@sentry/nextjs` is at 10.76.1 and not >=10.76.2

At 10.76.2 and later, `@sentry/nextjs` stops depending on
`@sentry/bundler-plugin-core` and loads `@sentry/bundler-plugins/core` instead.
`tests/lib/observability/e2e-build-sentry-overrides.test.ts` requires
`node_modules/@sentry/bundler-plugin-core` by path. At 10.78.0 it therefore
fails 2 tests with `Cannot find module`. That test is the real-code proof that
`localE2eBuildSentryOverrides()` keeps the e2e build from uploading to Sentry.

This change is lockfile-only, so it does not edit that test. It takes the
newest in-range version that keeps the test resolvable, 10.76.1. That version
still clears the critical, which is fixed from 10.75.2. Audit-wise, 10.76.1 and
10.78.0 differ only by one extra moderate entry, `@sentry/bundler-plugin-core`
(row R2). Both stay listed because of `glob`.

Webpack-path evidence:
- Hone builds with webpack. `next build` uses `@sentry/webpack-plugin` 5.4.1,
  which uses `@sentry/bundler-plugins` 10.78.0. It does not use
  `@sentry/bundler-plugin-core`, which `@sentry/nextjs` loads only in its
  run-after-production-compile path.
- The webpack plugin already used `@sentry/bundler-plugins` before this change
  (10.66.0 via webpack-plugin 5.4.0). So the committed test was already probing
  a sibling module of the one the webpack build uses. This gap existed before
  this change and is not fixed here.
- A scratch run, never committed, pointed the test's `PLUGIN_CORE` at
  `@sentry/bundler-plugins/build/cjs/core/index.js` in this exact tree. All 11
  tests passed: the negative control (without the override, a token is present
  and sentry-cli launches) and the override (an explicit empty token, zero
  launches).

Follow-up, which is also the revisit trigger for the Sentry pin: repoint
`PLUGIN_CORE` at `@sentry/bundler-plugins/core` in its own change, then bump
`@sentry/nextjs` to the latest 10.x.

### Expected but not cleared: `glob` and the Sentry chain

The source review expected `glob` and the four Sentry entries to clear with
the Sentry bump. They did not:

- GHSA-3g3m-2fjr-6pw4 affects `glob >=9.0.0 <=14.0.1`.
- `@sentry/bundler-plugins` requires `glob ^13.0.6`, both at 10.78.0 (the
  newest 10.x) and at 11.10.0 (the newest 11.x).
- The newest 13.x release is 13.0.6.

So no Sentry release in any major can resolve a fixed `glob` without an npm
`overrides` entry, which would be a `package.json` change. Those entries are
recorded as exceptions below, as rows R1 and R2.

## Remaining findings (21)

GHSA-g3hv-75wg-m249 is "minimatch has potential denial of service via
globparts amplification", `minimatch <11.0.1`. The ESLint rows below inherit
it.

| # | Package | Sev | Advisory | Dependency path | Class | Why it is not exploitable in Hone as configured | Why it is not fixed now | Revisit trigger |
|---|---|---|---|---|---|---|---|---|
| R1 | `glob` 13.0.6 | moderate | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): AbortSignal cancellation bypass allows post-timeout filesystem traversal | `@sentry/nextjs` → `@sentry/bundler-plugin-core` / `@sentry/bundler-plugins` → `glob` | build-only | `glob` is used only by Sentry's source-map upload step during `next build` (`next.config.ts`, `withSentryConfig`: `widenClientFileUpload`, `sourcemaps.deleteSourcemapsAfterUpload`). It walks Hone's own build output. Nothing in Hone passes an AbortSignal to glob or uses one as a security boundary. Hone's own code never imports `glob` (grep of `app/ lib/ components/ scripts/`: none). | The fix needs `glob >=14.0.2`. Every published `@sentry/bundler-plugins` (10.78.0 and 11.10.0) requires `^13.0.6`, as does `@sentry/bundler-plugin-core` 5.3.0. The only route is a `package.json` `overrides` entry, which is out of scope for a lockfile-only change. | A `@sentry/nextjs` 10.x release whose bundler plugin accepts `glob >=14.0.2`, or a glob 13.x backport. |
| R2 | `@sentry/nextjs` 10.76.1 (direct), `@sentry/bundler-plugin-core` 5.3.0, `@sentry/bundler-plugins` 10.78.0, `@sentry/webpack-plugin` 5.4.1 | moderate (4 entries) | inherited from R1 (GHSA-3g3m-2fjr-6pw4). The critical GHSA-mchm-gjx6-7h55 is **fixed**. | `@sentry/nextjs` → `@sentry/bundler-plugin-core` → `glob`; `@sentry/nextjs` → `@sentry/webpack-plugin` → `@sentry/bundler-plugins` → `glob` | build-only, listed against a runtime package | The same as R1. The runtime SDK does not call glob, which is used only in the build plugin. The fixed critical needed `tunnelRoute`, which Hone has never used. `next.config.ts` says "NO tunnelRoute" (#828 G-07/G-26). Browser events go through Hone's own `app/monitoring/route.ts`, with `Sentry.init({ tunnel: "/monitoring" })` in `instrumentation-client.ts`. | The same as R1. Also, the `@sentry/bundler-plugin-core` entry exists only because of the 10.76.1 pin (see above). | The same as R1, and the `PLUGIN_CORE` repoint follow-up, which removes the `bundler-plugin-core` entry. |
| R3 | `minimatch` 10.2.6 (under `glob`) | moderate | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `@sentry/bundler-plugins` → `glob` → `minimatch` | build-only | The advisory needs attacker-controlled glob patterns. The patterns here are Sentry's fixed upload globs over Hone's own build output. | `glob` 13.x requires `minimatch ^10`, so the fix needs `minimatch >=11.0.1`, which is glob 14. That is blocked as in R1. | The same as R1. |
| R4 | `minimatch` 3.1.5 and 10.2.5 (ESLint copies) | moderate | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `eslint` / `@eslint/*` / `eslint-plugin-*` → `minimatch` 3.x; `@typescript-eslint/typescript-estree` → `minimatch` 10.x | dev-only | ESLint matches Hone's own config globs over Hone's own source, locally and in CI. No untrusted pattern reaches it. | ESLint 9 and the plugins in `eslint-config-next` 15.5.28 depend on `minimatch` 3.x / 10.x. npm's suggested "fix" is a nonsensical downgrade (`eslint 4.0.0`, `eslint-config-next 12.0.4`). The real fix needs upstream releases on minimatch 11, or the ESLint 10 / Next 16 majors. | eslint 9.x, typescript-eslint 8.x or `eslint-config-next` 15.x moves to `minimatch >=11.0.1`, or the Next 16 / ESLint major-upgrade ticket. |
| R5 | `eslint` 9.39.4 (direct) | moderate | inherited (GHSA-g3hv-75wg-m249) | root → `eslint` → `minimatch`, `@eslint/config-array`, `@eslint/eslintrc`, `@eslint-community/eslint-utils` | dev-only | as R4 | as R4 | as R4 |
| R6 | `@eslint/config-array` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint` → `@eslint/config-array` → `minimatch` | dev-only | as R4 | as R4 | as R4 |
| R7 | `@eslint/eslintrc` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint` → `@eslint/eslintrc` → `minimatch` | dev-only | as R4 | as R4 | as R4 |
| R8 | `@eslint-community/eslint-utils` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint` / `@typescript-eslint/utils` → `@eslint-community/eslint-utils` → `eslint` | dev-only | as R4 | as R4 | as R4 |
| R9 | `eslint-config-next` 15.5.28 (direct) | moderate | inherited (GHSA-g3hv-75wg-m249) | root → `eslint-config-next` → `@typescript-eslint/*`, `eslint-plugin-import`, `-jsx-a11y`, `-react` | dev-only | as R4 | Pinned to `next` 15.5.28. A newer major tracks Next 16. | as R4 |
| R10 | `@typescript-eslint/eslint-plugin` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint-config-next` → `@typescript-eslint/eslint-plugin` | dev-only | as R4 | as R4 | as R4 |
| R11 | `@typescript-eslint/parser` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint-config-next` → `@typescript-eslint/parser` → `typescript-estree` | dev-only | as R4 | as R4 | as R4 |
| R12 | `@typescript-eslint/type-utils` | moderate | inherited (GHSA-g3hv-75wg-m249) | `@typescript-eslint/eslint-plugin` → `type-utils` | dev-only | as R4 | as R4 | as R4 |
| R13 | `@typescript-eslint/typescript-estree` | moderate | inherited (GHSA-g3hv-75wg-m249) | `@typescript-eslint/parser` → `typescript-estree` → `minimatch` 10.2.5 | dev-only | as R4 | as R4 | as R4 |
| R14 | `@typescript-eslint/utils` | moderate | inherited (GHSA-g3hv-75wg-m249) | `@typescript-eslint/eslint-plugin` → `utils` | dev-only | as R4 | as R4 | as R4 |
| R15 | `eslint-plugin-import` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint-config-next` → `eslint-plugin-import` → `minimatch` | dev-only | as R4 | as R4 | as R4 |
| R16 | `eslint-plugin-jsx-a11y` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint-config-next` → `eslint-plugin-jsx-a11y` → `minimatch` | dev-only | as R4 | as R4 | as R4 |
| R17 | `eslint-plugin-react` | moderate | inherited (GHSA-g3hv-75wg-m249) | `eslint-config-next` → `eslint-plugin-react` → `minimatch` | dev-only | as R4 | as R4 | as R4 |
| R18 | `postcss` 8.4.31 (nested, under `next` only) | **high** | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) (high), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) (high), [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | `next` 15.5.28 → `postcss` 8.4.31 (exact pin) | build-only | postcss runs at build time over Hone's own CSS only. `postcss.config.mjs` loads just `@tailwindcss/postcss`. The source-map advisories need attacker-controlled `sourceMappingURL` comments in the CSS being processed. The `</style>` XSS needs stringified attacker CSS embedded in HTML. Hone processes no user-supplied CSS. The top-level postcss copy is fixed (8.5.32). | `next` 15.5.28 pins `postcss` to exactly `8.4.31`. npm's only offer is `next@16.4.5`, a major upgrade and its own migration ticket. | A Next 15.5.x release that bumps its nested postcss to >=8.5.23, or the Next 16 upgrade ticket. Also any change that feeds user-supplied CSS through the build. |
| R19 | `next` 15.5.28 (direct) | moderate | inherited from R18 (the nested postcss) | root → `next` → `postcss` 8.4.31 | runtime package, build-only finding | as R18. The audit lists `next` only because of its nested postcss. It lists no advisory against Next itself at 15.5.28. | as R18 | as R18 |
The 21 remaining audit entries are:

- R1 (`glob`, 1 entry)
- R2 (Sentry, 4 entries)
- R3 + R4 (`minimatch`, 1 entry; npm lists all three copies under one entry)
- R5–R17 (the ESLint chain, 13 entries)
- R18 (nested `postcss`, 1 entry)
- R19 (`next`, 1 entry)

Total: 1 + 4 + 1 + 13 + 1 + 1 = 21. Under `--omit=dev`, 8 remain: R1, R2 (4), R3, R18 and R19. All 8 are build-only.

## Follow-ups (not done here)

- Repoint `PLUGIN_CORE` in
  `tests/lib/observability/e2e-build-sentry-overrides.test.ts` at
  `@sentry/bundler-plugins/core`, the module the webpack build actually uses.
  Then bump `@sentry/nextjs` to the latest 10.x. See "Why `@sentry/nextjs` is
  at 10.76.1" above.
- Raise the `@sentry/nextjs` floor in `package.json` (at least `^10.75.2`), so
  that a fresh resolve can never drop below the version that fixes the tunnel
  advisory. The lockfile already holds that guarantee today. A `package.json`
  change was not strictly necessary, so it is left for a separate change.
- The comment at `lib/supabase/middleware.ts` near line 61 still says
  `tunnelRoute: "/monitoring" in next.config.ts`. That wording is stale. The
  tunnel is Hone's own `app/monitoring/route.ts`.
