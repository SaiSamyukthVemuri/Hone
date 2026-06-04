// PR #153 (test harness): Vitest stub for Next's `server-only`
// marker. Importing the real module from a Node test would throw
// because the package is bundler-only. This stub is empty by design;
// the actual server-only enforcement is provided by Next at build.
export {};
