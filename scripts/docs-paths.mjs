// ---------------------------------------------------------------------------
// What CI counts as documentation: the ONE rule both the changed-path
// classifier (docs-only diffs) and the test-dependency scanner (which files a
// test reads as documents) use.
//
// Its own module so neither imports the other for it. The scanner's CLI used
// to reach the rule through classify-changes.mjs, which imports the scanner,
// and that cycle left its top-level await unsettled: `node
// scripts/test-dependencies.mjs` exited 13 with no output (Codex, #1053
// 4355661335). This module imports nothing.
// ---------------------------------------------------------------------------

/** Docs and records that never change runtime behaviour. */
export const DOCS = [
  /^docs\//,
  /^README\.md$/,
  /^CLAUDE\.md$/,
  /\.md$/,
  /^\.github\/(ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)/,
];

export const isDocsPath = (file) => DOCS.some((re) => re.test(file));
