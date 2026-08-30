import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../scripts/classify-changes.mjs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// SEC-ADAPTER-01 — the security-guidance adapter is DERIVED, never authoritative
// ---------------------------------------------------------------------------
// `.claude/claude-security-guidance.md` is read by the Anthropic
// `security-guidance` plugin and becomes part of a security reviewer's prompt.
// That makes it the one file in this repository that can quietly acquire
// authority it was never granted: nothing executes it, no lane exercises it, and
// a rule that has drifted from the canonical document produces no runtime
// symptom at all — it just makes the reviewer look for the wrong thing.
//
// So every rule line must name the canonical source it was derived from, and
// that source must still say it. If the two disagree, the source wins and this
// test goes red rather than the adapter going stale in silence.
//
// The adapter is also a PROMPT, concatenated into a bounded budget. A file that
// grew past the budget would be tail-truncated, and Hone's rules would vanish
// from the reviewer's context with nothing anywhere reporting it.

const ADAPTER = ".claude/claude-security-guidance.md";

/**
 * The canonical documents an adapter rule may cite. Deliberately a closed list:
 * a rule sourced from anywhere else is a rule this repository has not agreed to.
 */
const CANONICAL = [
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "ENGINEERING_STANDARDS.md",
  "docs/03_SECURITY_AND_PRIVACY.md",
] as const;

/**
 * The prompt budget the plugin concatenates into, in bytes. Carried from the
 * plugin's documented behaviour (v2.0.7) rather than measured here — the plugin
 * is an out-of-repo, operator-installed tool. Re-verify it if the plugin major
 * changes; the number being a little conservative costs nothing, and the guard
 * is here so a silent tail-truncation cannot happen either way.
 */
const PROMPT_BUDGET_BYTES = 8192;

/** GitHub's heading-slug rule, which is what a `#anchor` in a citation means. */
const slug = (heading: string): string =>
  heading
    .replace(/^#+\s+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");

/** Every heading in a markdown document, mapped to the body beneath it. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s+/.test(line)) {
      if (current !== null) out.set(current, buffer.join("\n"));
      current = slug(line);
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  if (current !== null) out.set(current, buffer.join("\n"));
  return out;
}

type Citation = { line: number; rule: string; file: string; anchor: string; token: string };
type Adapter = { rules: number; cited: Citation[]; unanchored: number[] };

/**
 * Read the adapter into its rule lines and their citations.
 *
 * A rule is a top-level list item. Its citation sits at the END OF ITS OWN LINE,
 * not on a neighbouring one: this repository has already been bitten by a marker
 * that was supposed to own the thing next to it and did not, so the binding is
 * made positional-free — one line, one rule, one citation.
 */
function readAdapter(body: string): Adapter {
  const cited: Citation[] = [];
  const unanchored: number[] = [];
  let rules = 0;
  body.split("\n").forEach((raw, i) => {
    if (!raw.startsWith("- ")) return;
    rules++;
    const m = /^(.*?)\s*<!-- source: ([^#\s]+)#([^\s|]+) \| token: (.+?) -->$/.exec(raw.trim());
    if (!m) {
      unanchored.push(i + 1);
      return;
    }
    cited.push({ line: i + 1, rule: m[1], file: m[2], anchor: m[3], token: m[4] });
  });
  return { rules, cited, unanchored };
}

/**
 * Every way the adapter departs from its sources.
 *
 * `read` is injected so the negative controls can run the REAL checker against a
 * mutated scratch copy of the real documents, rather than against a hand-built
 * imitation of them.
 */
function parityViolations(adapterBody: string, read: (file: string) => string | null): string[] {
  const bad: string[] = [];
  const { rules, cited, unanchored } = readAdapter(adapterBody);

  if (rules === 0) bad.push("the adapter states no rules at all");
  for (const line of unanchored) bad.push(`${ADAPTER}:${line}: rule line carries no source citation`);

  const cache = new Map<string, Map<string, string> | null>();
  const sectionsOf = (file: string) => {
    if (!cache.has(file)) {
      const body = read(file);
      cache.set(file, body === null ? null : sections(body));
    }
    return cache.get(file) ?? null;
  };

  for (const c of cited) {
    if (!(CANONICAL as readonly string[]).includes(c.file)) {
      bad.push(`${ADAPTER}:${c.line}: cites ${c.file}, which is not a canonical source`);
      continue;
    }
    const secs = sectionsOf(c.file);
    if (secs === null) {
      bad.push(`${ADAPTER}:${c.line}: cites ${c.file}, which does not exist`);
      continue;
    }
    if (!secs.has(c.anchor)) {
      bad.push(`${ADAPTER}:${c.line}: ${c.file} has no heading "#${c.anchor}"`);
      continue;
    }
    if (!secs.get(c.anchor)!.includes(c.token)) {
      bad.push(
        `${ADAPTER}:${c.line}: ${c.file}#${c.anchor} no longer contains ${JSON.stringify(c.token)} — ` +
          `the adapter asserts a rule its source has dropped`,
      );
    }
  }
  return bad;
}

const readRepo = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

describe("SEC-ADAPTER-01 — security-guidance adapter parity", () => {
  const BODY = readFileSync(ADAPTER, "utf8");

  // T1 + T2 + T3 + T4 — every rule is traceable, and its source still says it.
  it("every rule line cites a canonical source that still contains its token", () => {
    expect(readAdapter(BODY).rules, "the adapter states no rules").toBeGreaterThan(0);
    expect(parityViolations(BODY, readRepo)).toEqual([]);
  });

  it("every citation names one of the four canonical documents", () => {
    const files = [...new Set(readAdapter(BODY).cited.map((c) => c.file))].sort();
    for (const f of files) expect(CANONICAL as readonly string[], `${f} is not canonical`).toContain(f);
    expect(files.length, "no citations at all").toBeGreaterThan(0);
  });

  // T5 — the prompt budget cannot silently truncate Hone's rules.
  it("the adapter fits the prompt budget", () => {
    const size = statSync(ADAPTER).size;
    expect(size, `${size} bytes exceeds the ${PROMPT_BUDGET_BYTES}-byte prompt budget`).toBeLessThan(
      PROMPT_BUDGET_BYTES,
    );
  });

  // T6 — the adapter states its own limits, so no reader infers authority.
  it("the adapter states that its findings are leads, not review completion", () => {
    expect(BODY, "must say findings are leads").toMatch(/\*\*leads\*\*, not review completion/);
    expect(BODY, "must name the Codex actor id that DOES gate completion").toContain("199175422");
    expect(BODY, "must name the evidence module").toContain("scripts/eng/evidence.mjs");
    expect(BODY, "must disclaim tier and lane authority").toMatch(
      /never sets a risk tier, never selects a\s+CI lane/,
    );
  });

  // -------------------------------------------------------------------------
  // What kind of file this actually is
  // -------------------------------------------------------------------------
  // The adapter sits in an awkward place: it is markdown, it is not
  // documentation, and it changes no runtime behaviour. Getting that three-way
  // answer wrong in either direction is a real defect — call it docs and a
  // security control ships under the docs lane; call it runtime and every
  // production baseline guard demands a fresh runtime pin for a file Vercel
  // never serves. Both were live possibilities, so the answer is pinned here.
  describe("the adapter's authority is governance, not runtime and not docs", () => {
    it("is NOT runtime-bearing: no shipped code reads it", () => {
      // The deployed application never touches `.claude/`. Asserted over the
      // runtime roots rather than by trusting the build output, so this stays
      // true for a reader who never runs `next build`.
      // Derived from what the repository actually has, not a hard-coded list:
      // `hooks/` and `types/` do not exist here, and a pathspec git cannot
      // resolve makes the probe exit 128 — a broken probe that proves nothing.
      const runtimeRoots = ["app", "lib", "components", "hooks", "types", "middleware.ts", "next.config.ts"]
        .filter((r) => existsSync(r));
      expect(runtimeRoots.length, "no runtime root exists — the probe would be vacuous").toBeGreaterThan(2);
      // Scope, stated rather than implied: `git grep` reads TRACKED content, so
      // an unstaged working-tree file is invisible to this probe. That is the
      // right scope for a repository guard — CI only ever sees tracked files —
      // but it means a local "it passed" before `git add` proves nothing.
      //
      // `git grep -l` exits 1 when it matches nothing, which is the PASSING
      // case here, so the exit status is read rather than thrown on. status 1
      // with empty output is "no runtime module reads it"; anything else is a
      // real result or a broken probe, and both must be visible.
      const probe = spawnSync(
        "git",
        ["grep", "-l", "--", ".claude/", ...runtimeRoots],
        { encoding: "utf8" },
      );
      expect(probe.status, "the probe itself must run (0 = matched, 1 = no match)").toBeLessThanOrEqual(1);
      expect(
        (probe.stdout ?? "").trim(),
        "a runtime module reads .claude/ — the adapter would then be runtime-bearing",
      ).toBe("");
    });

    it("is NOT runtime-bearing: the production build never runs it", () => {
      const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts?: Record<string, string>;
      };
      expect(pkg.scripts?.build ?? "", "the build command must not reach .claude/").not.toMatch(/\.claude/);
    });

    it("IS security-governance-bearing: it routes to the security lane at T3", () => {
      const r = classify([ADAPTER]) as { security: boolean; docs_only: boolean; baselineRiskTier: string };
      expect(r.security, "the adapter must reach the security lane").toBe(true);
      expect(r.baselineRiskTier).toBe("T3");
      expect(r.docs_only, "it is not documentation").toBe(false);
    });

    it("the three answers are mutually consistent — governance, not runtime, not docs", () => {
      const r = classify([ADAPTER]) as { security: boolean; docs_only: boolean };
      // Not docs AND not runtime is only coherent because a third category
      // exists: files that govern how the repository is built and reviewed.
      // If a future change makes it runtime-bearing, the first test above fails
      // and this classification has to be revisited rather than assumed.
      expect([r.security, r.docs_only]).toEqual([true, false]);
    });
  });

  // -------------------------------------------------------------------------
  // Negative controls — a parity guard that cannot fail is a decoration
  // -------------------------------------------------------------------------
  // Each mutates a scratch copy of the REAL documents, in the language the
  // matcher parses, and requires the specific failure. Nothing is written into
  // the repository.

  /** Run the real checker with one canonical document rewritten. */
  const withMutatedSource = (file: string, from: string, to: string) => {
    const original = readRepo(file);
    expect(original, `${file} must exist`).not.toBeNull();
    expect(original!, `control needs ${JSON.stringify(from)} in ${file}`).toContain(from);
    expect(to, `a replacement containing ${JSON.stringify(from)} proves nothing`).not.toContain(from);
    const mutated = original!.replace(from, to);
    expect(mutated, "the control's substitution must land").not.toEqual(original);
    expect(mutated, "the token must actually be gone").not.toContain(from);
    return (f: string) => (f === file ? mutated : readRepo(f));
  };

  it("N1 RED: a cited token dropped from its source is reported", () => {
    // The replacement must not CONTAIN the token: `paymentIntents.createX` still
    // contains `paymentIntents.create`, so a substring matcher would pass and the
    // control would prove nothing. Mutate in the language the matcher parses.
    const read = withMutatedSource("CONTRIBUTING.md", "paymentIntents.create", "paymentIntents.forge");
    const violations = parityViolations(BODY, read);
    expect(violations.join("\n")).toMatch(/no longer contains "paymentIntents\.create"/);
  });

  it("N2 RED: a cited heading removed from its source is reported", () => {
    const read = withMutatedSource(
      "CONTRIBUTING.md",
      "## How to treat public / token routes",
      "## How to treat public token routes",
    );
    const violations = parityViolations(BODY, read);
    expect(violations.join("\n")).toMatch(/has no heading "#how-to-treat-public--token-routes"/);
  });

  it("N3 RED: a rule line with its citation stripped is reported", () => {
    const stripped = BODY.split("\n")
      .map((l) => (l.startsWith("- ") ? l.replace(/\s*<!-- source: .*? -->$/, "") : l))
      .join("\n");
    expect(stripped, "the control's substitution must land").not.toEqual(BODY);
    const violations = parityViolations(stripped, readRepo);
    expect(violations.length, "every rule should now be unanchored").toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(/rule line carries no source citation/);
  });

  it("N4 RED: an adapter grown past the prompt budget is refused", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-guidance-budget-"));
    try {
      const oversized = path.join(dir, "adapter.md");
      writeFileSync(oversized, BODY + "\n" + "x".repeat(PROMPT_BUDGET_BYTES), "utf8");
      expect(statSync(oversized).size).toBeGreaterThanOrEqual(PROMPT_BUDGET_BYTES);
      // ...while the real one still fits, so the control is discriminating.
      expect(statSync(ADAPTER).size).toBeLessThan(PROMPT_BUDGET_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("N5 RED: an adapter citing a non-canonical source is reported", () => {
    const smuggled = BODY.replace("<!-- source: CONTRIBUTING.md#", "<!-- source: NOTES.md#");
    expect(smuggled, "the control's substitution must land").not.toEqual(BODY);
    expect(parityViolations(smuggled, readRepo).join("\n")).toMatch(
      /cites NOTES\.md, which is not a canonical source/,
    );
  });

  it("N6 RED: the leads-not-completion header cannot be removed silently", () => {
    // The header is asserted by T6 over the real file; this proves T6's matcher
    // discriminates rather than matching anything.
    const gutted = BODY.replace("**leads**, not review completion", "the authoritative verdict");
    expect(gutted).not.toEqual(BODY);
    expect(/\*\*leads\*\*, not review completion/.test(gutted)).toBe(false);
    expect(/\*\*leads\*\*, not review completion/.test(BODY)).toBe(true);
  });
});
