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
 * Remove WHOLE-LINE comments only, so prose that merely MENTIONS `timed()` is
 * not mistaken for a call site.
 *
 * Deliberately not an inline stripper. Removing a `//` sequence from the middle
 * of a line is unsafe here because comment delimiters occur inside string,
 * template and regex literals throughout this codebase, and truncating a line
 * would delete real code that follows it — a guard that can silently erase the
 * very code it is checking is worse than no guard at all.
 *
 * The trade this makes is deliberate and one-directional: a trailing comment
 * on a code line survives, so prose there can produce a FALSE POSITIVE. That
 * is a loud failure a human resolves, which is the safe direction for a
 * security-lane assertion. It can never produce a false negative.
 */
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const isWholeLineComment =
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*");
      return isWholeLineComment ? "" : line;
    })
    .join("\n");
}

type CallSite = { fn: string; firstArg: string };

/** Every `timed(` / `startPerfSpan(` call site in a source text. */
function findCallSites(text: string): CallSite[] {
  return [...stripComments(text).matchAll(/\b(timed|startPerfSpan)\(([^,)]*)/g)].map(
    (match) => ({ fn: match[1], firstArg: match[2].trim() }),
  );
}

/** A span name that is a plain double-quoted `<surface>.<phase>` literal. */
function isLiteralSpanName(arg: string): boolean {
  return /^"[a-z-]+\.[a-z-]+"$/.test(arg);
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

  const callSites = files.flatMap((file) =>
    findCallSites(readFileSync(file, "utf8")).map((site) => ({
      ...site,
      file: path.relative(REPO_ROOT, file),
    })),
  );

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
      (site) => !isLiteralSpanName(site.firstArg),
    );
    expect(
      offenders,
      `non-literal perf span name(s): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guards must not be able to pass VACUOUSLY.
//
// Every assertion above runs against comment-stripped source, so the stripper
// is load-bearing: if it can delete real code, a prohibited construct sails
// through unseen. These cases pin the exact hazard — comment delimiters inside
// string, template and regex literals — against synthetic sources.
// ---------------------------------------------------------------------------

describe("the comment stripper cannot hide a violation", () => {
  it("keeps a call site that follows a string containing a comment delimiter", () => {
    const source = 'const sep = "//"; startPerfSpan(`${prefix}.domain`);';
    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(isLiteralSpanName(sites[0].firstArg)).toBe(false);
  });

  it("keeps a call site that follows a block-comment delimiter in a string", () => {
    const source = 'const s = "/*"; timed(`clients.${phase}`, run);';
    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(isLiteralSpanName(sites[0].firstArg)).toBe(false);
  });

  it("keeps a call site that follows a URL literal", () => {
    const source = 'const u = "https://hone.care"; timed(`a.${b}`, run);';
    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(isLiteralSpanName(sites[0].firstArg)).toBe(false);
  });

  it("keeps a call site that follows a regex literal containing a slash pair", () => {
    const source = 'const re = /a\\/\\/b/; startPerfSpan(spanFromRequest());';
    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(isLiteralSpanName(sites[0].firstArg)).toBe(false);
  });

  it("does not preserve prohibited code hidden behind a string delimiter", () => {
    // Codex's exact counterexample against the previous inline stripper: the
    // old version reduced this to `const value = "` and the headers() read
    // vanished. Whole-line stripping leaves it visible.
    const source = 'const value = "//" + headers();';
    expect(stripComments(source)).toContain("headers()");
  });

  it("still removes whole-line prose that merely mentions a call", () => {
    const source = [
      "// this file explains timed() and startPerfSpan() at length",
      "/**",
      " * More prose about timed(\"a.b\").",
      " */",
      'timed("clients.domain", run);',
    ].join("\n");
    const sites = findCallSites(source);
    expect(sites).toHaveLength(1);
    expect(sites[0].firstArg).toBe('"clients.domain"');
  });

  it("accepts only a plain double-quoted span name", () => {
    expect(isLiteralSpanName('"clients.domain"')).toBe(true);
    expect(isLiteralSpanName('"client-profile.identity"')).toBe(true);
    expect(isLiteralSpanName("`clients.domain`")).toBe(false);
    expect(isLiteralSpanName("spanName")).toBe(false);
    expect(isLiteralSpanName('"clients." + phase')).toBe(false);
    expect(isLiteralSpanName("")).toBe(false);
  });
});
