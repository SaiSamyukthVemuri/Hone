import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// CHART-SESSION-01 / #699 — THE CTA IS WITHHELD, AND THIS PROVES IT
// ===========================================================================
//
// `lib/dashboard/session-resolution.ts` decides a chart CTA whose zero-branch
// routes to `sessions/new?appointment_id=…`, i.e. into `start_session`. That
// RPC is NOT appointment-safe yet: with `p_appointment_id` supplied it can
// still reuse a session linked to a DIFFERENT appointment (finding
// 4008020858), because its coalesce window has no appointment term.
//
// So the resolver ships as a TESTED, UNREACHABLE decision.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE WAS REWRITTEN — both P1s had ONE root cause
// ---------------------------------------------------------------------------
//
// The first version hand-enumerated repository and Git topology instead of
// deriving it, and was wrong twice for the same reason.
//
//   4010764250 — pathspecs of the form `components/**/*.ts*` require at least
//   one INTERMEDIATE directory, so every file sitting directly in a runtime
//   root was invisible: 8 of 310 in app, 58 of 70 in components, 12 of 308 in
//   lib. 78 files, and among them `components/client-appointment-timeline.tsx`
//   — one of only two files that renders a CTA reaching the unsafe RPC. The
//   guard was blind to the file it most needed to watch.
//
//   4010764256 — it called `git merge-base HEAD origin/claude/build-hone-saas-hOex7`.
//   The `changes` CI job sets `fetch-depth: 0`; the `validate` job, which is
//   what actually runs this file, sets none and so takes actions/checkout's
//   depth-1 default. The remote-tracking ref does not exist there, the call
//   throws, and the test dies BEFORE asserting anything — indistinguishable
//   from a real violation.
//
// THE RULE THIS FILE NOW FOLLOWS: derive, never enumerate, and never consult
// Git history. `git ls-files` reads the INDEX, which every checkout has —
// shallow clone, worktree, tarball, fork. No merge-base, no origin/*, no
// `git show`. Content comes from the filesystem so one tree is read
// throughout; the old version mixed `git grep` (working tree) with
// `git show HEAD:` (commit) and could disagree with itself.
//
// DELETE THIS FILE in the same change that makes the CTA reachable — and only
// after the migration proving appointment-scoped coalescence is applied.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../..");

/**
 * Every tracked file, from the index. No pathspec globs: the glob is exactly
 * what went wrong, so extension and directory filtering happens in JS where
 * the semantics are explicit and can themselves be tested.
 */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Directories that are tests or tooling, not shipped runtime. */
const NON_RUNTIME = /^(tests|e2e|e2e-google|e2e-mobile|e2e-payment|scripts)\//;

/**
 * Production-facing runtime: every tracked .ts/.tsx that is not a test or a
 * script. Derived, so `middleware.ts`, `instrumentation.ts`, a new top-level
 * directory, or a file added directly under components/ are all included
 * automatically — none of which the previous pathspecs reached.
 */
function runtimeFiles(): string[] {
  return trackedFiles().filter(
    (f) => /\.tsx?$/.test(f) && !NON_RUNTIME.test(f),
  );
}

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

/** Comment-stripped, so prose naming a label cannot read as the label shipping. */
function code(source: string): string {
  return source.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const RESOLVER = "lib/dashboard/session-resolution.ts";

describe("the enumeration is mechanically complete", () => {
  // This suite guards the GUARD. Both P1s were enumeration mistakes, so the
  // file set is asserted directly rather than trusted.
  const runtime = runtimeFiles();

  it("includes ROOT-LEVEL files in every runtime directory", () => {
    // The exact shape `d/**/*.ts*` could not match. `client-appointment-timeline`
    // is the one that mattered: it renders a CTA into the unsafe RPC.
    for (const f of [
      "components/client-appointment-timeline.tsx",
      "lib/dashboard/next-action.ts",
      RESOLVER,
    ]) {
      expect(runtime, `${f} must be scanned`).toContain(f);
    }
  });

  it("includes Next.js entry points that live OUTSIDE app/components/lib", () => {
    // middleware runs on every request and was never scanned before.
    for (const f of ["middleware.ts", "instrumentation.ts", "next.config.ts"]) {
      expect(runtime, `${f} must be scanned`).toContain(f);
    }
  });

  it("includes nested files too — the fix did not trade one blind spot for another", () => {
    expect(runtime).toContain("app/(app)/dashboard/page.tsx");
    expect(runtime).toContain("app/(app)/clients/[id]/sessions/new/actions.ts");
  });

  it("scans every tracked runtime .ts/.tsx, losing none to a glob", () => {
    const all = trackedFiles().filter(
      (f) => /\.tsx?$/.test(f) && !NON_RUNTIME.test(f),
    );
    expect(runtime.length).toBe(all.length);
    // Sanity floor: the repository is large, so a collapse to a handful means
    // the derivation broke rather than the repository shrinking.
    expect(runtime.length).toBeGreaterThan(400);
  });

  it("excludes tests, so the resolver's own suite cannot self-trip the guard", () => {
    expect(runtime).not.toContain("tests/lib/dashboard/session-resolution.test.ts");
    expect(runtime.some((f) => NON_RUNTIME.test(f))).toBe(false);
  });
});

describe("the resolver exists but is NOT reachable", () => {
  it("is imported by NO production-facing runtime file", () => {
    // A specifier search over the COMPLETE runtime set catches every import
    // form that names the module — static, `export * from` barrel, and dynamic
    // `import()` all contain the literal specifier.
    const importers = runtimeFiles()
      .filter((f) => f !== RESOLVER)
      .filter((f) => code(read(f)).includes("session-resolution"));
    expect(
      importers,
      "wiring the resolver in exposes Start charting before start_session is appointment-safe",
    ).toEqual([]);
  });

  it("renders 'Start charting' as a CTA label in NO runtime file", () => {
    // Two tracked files mention the phrase legitimately and neither renders it:
    //   app/(app)/dashboard/page.tsx            a comment listing CTA names
    //   app/resources/...paper-records/page.tsx a marketing heading
    // The comment is removed by `code()`; the marketing page is not a
    // practitioner CTA surface and is excluded by path.
    const rendering = runtimeFiles()
      .filter((f) => f !== RESOLVER && !f.startsWith("app/resources/"))
      .filter((f) => code(read(f)).includes("Start charting"));
    expect(
      rendering,
      "a runtime file renders Start charting before start_session is appointment-safe",
    ).toEqual([]);
  });

  it("does not add the label to the dashboard's shipped CTA union", () => {
    const nextAction = read("lib/dashboard/next-action.ts");
    expect(nextAction).not.toMatch(/Start charting/);
    expect(nextAction).not.toMatch(/Open chart/);
    expect(nextAction).not.toMatch(/View charts/);
    expect(nextAction).toMatch(/Review Before Today/);
  });
});

// ---------------------------------------------------------------------------
// SCOPE PINS — content digests, NOT a diff against a remote-tracking ref
// ---------------------------------------------------------------------------
//
// "This lane adds no migration and edits no start_session caller" was
// previously asserted with `git merge-base … origin/<base>`, which does not
// exist in the shallow checkout that runs this file. The claim is re-expressed
// as a property of the TREE rather than of a diff: the protected files must
// hash to known values, and the migration inventory must match. Same
// protection, no ancestry, and it works in any checkout.
//
// These digests are DELIBERATE PINS. Regenerate one only when you intend to
// change the file it protects — a forward merge that legitimately touches a
// protected file should require that acknowledgement, which is the point.

/** Pinned inventory facts, regenerated only with a deliberate migration change. */
const MIGRATION_COUNT = 190;
const HIGHEST_MIGRATION = "0191_studio_sms_sender_provisioning.sql";

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
}

/** The existing `start_session` callers — the LIVE defect surface (4008020858). */
const PROTECTED: ReadonlyArray<[string, string]> = [
  [
    "app/(app)/clients/[id]/sessions/new/actions.ts",
    "471250fa512a86abc2f93e8dc1ef7fb2cc4b24901442ff4610cf524e27da8d13",
  ],
  [
    "app/(app)/clients/[id]/sessions/new/page.tsx",
    "f1baa2483fb37e60fa5161c3f5ae96625d34ce25d36bc6a76e364357efc35d9c",
  ],
  [
    "app/(app)/dashboard/page.tsx",
    "d466c006d5a868670339f5e691ea6a9fae1a1cd40db305f60c4bfa0c40d77d6c",
  ],
  [
    "lib/dashboard/next-action.ts",
    "296a62eaf278cd14e2c6d4e9059bc4ddefe0e2e0dfe0467bd1157bb46323d9a0",
  ],
  [
    "components/client-appointment-timeline.tsx",
    "232e1d078d667845c504c249f66cdfd01c8146612288ddef18ca0d7e543d813d",
  ],
];

describe("scope pins hold without consulting Git history", () => {
  it("leaves every existing start_session caller byte-identical", () => {
    const drifted = PROTECTED.filter(([f, want]) => sha256(f) !== want).map(
      ([f]) => f,
    );
    expect(
      drifted,
      "repairing these is a DATABASE change; this lane must not alter their behaviour",
    ).toEqual([]);
  });

  it("adds no migration SQL — the number is not ours to allocate", () => {
    // 0196 is owned by WAIT #703. The next safe number is re-derived from the
    // integration tree after #703 settles; 0197 is not assumed.
    //
    // READS THE FILESYSTEM, NOT THE INDEX. `git ls-files` would miss a
    // migration that exists on disk but has not been `git add`ed — and a
    // negative control proved exactly that: dropping 0197 into the directory
    // left this check green until it read the directory instead.
    const migrations = readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(migrations.length).toBe(MIGRATION_COUNT);
    expect(migrations[migrations.length - 1]).toBe(HIGHEST_MIGRATION);
  });
});
