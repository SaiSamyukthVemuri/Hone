import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// Source guards for the route-timing primitive.
//
// perf-timing lives under lib/observability/, which scripts/classify-changes.mjs
// treats as the SECURITY lane (T3) — correctly, because the module's job is to
// emit telemetry out of a clinical application and its privacy properties are
// therefore a boundary, not a detail.
//
// The unit tests in tests/lib/observability/perf-timing.test.ts prove the
// module behaves safely TODAY. These guards prove the properties that make it
// safe cannot be quietly removed TOMORROW: they read the source and the call
// sites directly, the same way tests/source-guards/self-hosted-fonts-guards.test.ts
// parses the middleware matcher.
//
// If one of these fails, do not delete the assertion. The failure means a
// change has opened a path for identifying data to reach telemetry.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const MODULE_PATH = path.join(REPO_ROOT, "lib/observability/perf-timing.ts");
const SOURCE = readFileSync(MODULE_PATH, "utf8");
/**
 * The module with its comments removed. Every assertion below is about what
 * the code DOES, and the module documents its own privacy posture at length —
 * scanning the raw text would match the prose describing a hazard rather than
 * the hazard itself.
 */
const CODE = stripComments(SOURCE);

/** Directories whose call sites must pass a literal span name. */
const CALL_SITE_ROOTS = ["app", "lib", "components"];

/**
 * Strip comments so prose that merely MENTIONS `timed()` is not mistaken for a
 * call site. Block comments go first, then trailing line comments — the
 * `[^:]` guard keeps a `https://` inside a string literal intact.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("perf-timing module source", () => {
  it("never reads the request path, headers, or cookies", () => {
    // An authenticated pathname such as /clients/<uuid> IS a client
    // identifier. The surface label must stay derived from the span name.
    expect(CODE).not.toContain("next/headers");
    expect(CODE).not.toMatch(/\bheaders\s*\(/);
    expect(CODE).not.toMatch(/\bcookies\s*\(/);
    expect(CODE).not.toContain("nextUrl");
    expect(CODE).not.toContain("pathname");
  });

  it("keeps PerfSpanId a closed union of literals, never `string`", () => {
    const union = CODE.match(
      /export type PerfSpanId =([\s\S]*?);\n/,
    )?.[1];
    expect(union, "PerfSpanId declaration not found").toBeTruthy();

    // Every alternative is a quoted "<surface>.<phase>" literal.
    const alternatives = (union as string)
      .split("|")
      .map((part) => part.replace(/\/\/.*$/gm, "").trim())
      .filter(Boolean);
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alternative of alternatives) {
      expect(alternative).toMatch(/^"[a-z-]+\.[a-z-]+"$/);
    }
    // A widened union would silently turn every guard here into a no-op.
    expect(union).not.toMatch(/\bstring\b/);
    expect(union).not.toContain("`");
  });

  it("accepts no free-text parameter on either public entry point", () => {
    // Both entry points take a PerfSpanId and (for timed) a callback. If a
    // third, caller-controlled value is ever added, it becomes the way an
    // identifier reaches telemetry.
    expect(CODE).toMatch(
      /export async function timed<T>\(\s*span: PerfSpanId,\s*fn: \(\) => Promise<T>,\s*\): Promise<T>/,
    );
    expect(CODE).toMatch(
      /export function startPerfSpan\(span: PerfSpanId\): PerfSpanHandle/,
    );
  });

  it("is server-only", () => {
    expect(CODE).toContain('import "server-only"');
  });

  it("is off unless explicitly enabled", () => {
    // A default-on measurement layer in a clinical product is a standing
    // cost and a standing risk. Enabling must stay an explicit operator act.
    expect(CODE).toMatch(
      /return process\.env\.HONE_PERF_TIMING === "1";/,
    );
  });
});

describe("perf-timing call sites", () => {
  const files = CALL_SITE_ROOTS.flatMap((root) =>
    walk(path.join(REPO_ROOT, root)),
  ).filter((file) => file !== MODULE_PATH);

  const callSites = files.flatMap((file) => {
    const text = stripComments(readFileSync(file, "utf8"));
    const matches = [...text.matchAll(/\b(timed|startPerfSpan)\(([^,)]*)/g)];
    return matches.map((match) => ({
      file: path.relative(REPO_ROOT, file),
      fn: match[1],
      firstArg: match[2].trim(),
    }));
  });

  it("finds the instrumented surfaces", () => {
    // Sanity: if this drops to zero the guards below pass vacuously.
    const surfaces = new Set(
      callSites.map((site) => site.firstArg.replace(/"/g, "").split(".")[0]),
    );
    expect(surfaces).toContain("shell");
    expect(surfaces).toContain("clients");
    expect(surfaces).toContain("client-profile");
    expect(surfaces).toContain("calendar");
    expect(surfaces).toContain("records");
  });

  it("passes a double-quoted literal span name at every call site", () => {
    // The compile-time union already rejects a widened type, but a template
    // literal built from a const would still type-check as a literal while
    // reading as dynamic. Requiring a plain quoted string keeps every span
    // name greppable and provably free of interpolated data.
    const offenders = callSites.filter(
      (site) => !/^"[a-z-]+\.[a-z-]+"$/.test(site.firstArg),
    );
    expect(
      offenders,
      `non-literal perf span name(s): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
