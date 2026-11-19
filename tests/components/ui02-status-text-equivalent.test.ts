import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// The commit this slice is stacked on. Reading the pre-slice file out of git
// keeps the "unchanged visually" claim honest: the comparison uses the real
// previous source, not a copy pasted here that would silently drift.
//
// Overridable ONLY so the control test (ui02-status-proof-truth.test.ts) can
// force the shallow-clone path and observe that it reports SKIPPED rather than
// passing. Nothing else sets it; the default is the real commit.
const BASE_REF =
  process.env.UI02_BASE_REF ?? "cec0234a9dbee31721df8e8978652f8b1b316cef";

// UI-02 — non-colour-only status: every status carried by a decorative mark
// must also exist as TEXT in the accessibility tree.
//
// The roadmap lists "non-color-only status" as an open UI-02 adoption family.
// The defect class is narrow and specific: a status mark marked `aria-hidden`
// with no `sr-only` equivalent anywhere in the row, so the state is present for
// sighted users and absent for assistive technology.
//
// WHAT THESE DO NOT CLAIM. This is a SOURCE-level proof that the text exists and
// is reachable. It is not a screen-reader acceptance result; no automation in
// this repository produces one, and the browser proof beside it asserts the
// computed accessible NAME, which is the closest observable property.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const NOTIF = code("app/(app)/notifications/page.tsx");
const ONBOARD = code("app/(app)/dashboard/onboarding/OnboardingProgressCard.tsx");

describe("UI-02: unread is no longer conveyed by colour alone", () => {
  it("the row carries the word in the accessibility tree", () => {
    expect(NOTIF).toMatch(/<span className="sr-only">Unread\. <\/span>/);
  });

  it("the decorative dot stays decorative — no double announcement", () => {
    // If the dot lost aria-hidden it would be announced too, and the row would
    // read the state twice. The fix adds a name; it does not un-hide the mark.
    expect(NOTIF).toMatch(/aria-hidden\s+className="mr-2 inline-block h-2 w-2 rounded-full bg-rose-600/);
  });

  it("the sr-only text sits INSIDE the row link, so it joins its accessible name", () => {
    // Order matters: the state must precede the title, and both must be within
    // the <p> that the row's <Link> wraps.
    const p = NOTIF.slice(NOTIF.indexOf("isUnread && ("));
    const srIdx = p.indexOf('sr-only">Unread');
    const titleIdx = p.indexOf("{notification.title}");
    expect(srIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(srIdx);
  });
});

describe("UI-02: onboarding step status is no longer mark-only", () => {
  it("every status in the union has a text label", () => {
    expect(ONBOARD).toMatch(/done: "Done"/);
    expect(ONBOARD).toMatch(/skipped: "Skipped"/);
    expect(ONBOARD).toMatch(/todo: "Not started"/);
  });

  it("the label is rendered sr-only and the glyph stays aria-hidden", () => {
    expect(ONBOARD).toMatch(/<span className="sr-only">\{MARK_LABEL\[status\]/);
    expect(ONBOARD).toMatch(/<span aria-hidden className=\{`\$\{MARK_SHAPE\}/);
  });

  it("skipped and not-started are now DISTINGUISHABLE, which they were not", () => {
    // Both rendered byte-identical classes and differed only by glyph (– vs ·).
    // The labels are what actually separate them for a non-visual user.
    expect(ONBOARD).not.toMatch(/skipped: "Not started"/);
    const labels = [...ONBOARD.matchAll(/(done|skipped|todo): "([^"]+)"/g)].map((m) => m[2]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("UI-02: the slice stayed inside its boundary", () => {
  it("adds no dependency", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).length).toBe(21);
    for (const banned of ["lucide-react", "framer-motion", "clsx", "tailwind-merge"]) {
      expect(Object.keys(pkg.dependencies)).not.toContain(banned);
    }
  });

  it("renders the SAME class set as before", () => {
    // The claim is "this change is visually invisible". Asserting a class
    // STRING cannot prove that: refactoring the mark into shape + tone reordered
    // the string while rendering identical classes, so a string assertion would
    // fail on a correct change and pass on an incorrect one that happened to
    // keep the substring. The property is the SET of classes each state emits.
    //
    // The expected sets are PINNED here rather than read from git. The first
    // version read the pre-slice file with `git show <base>:<path>`, which works
    // locally and CANNOT work in CI: ci.yml's validate lane checks out with no
    // fetch-depth, so actions/checkout defaults to depth 1 and the base commit
    // is not in the clone. That lane went red on a test that was green on every
    // full clone — the exact shallow-clone trap this repo has hit before.
    //
    // These two sets were extracted from cec0234a (the commit this slice is
    // stacked on). Re-derive with:
    //   git show cec0234a:'app/(app)/dashboard/onboarding/OnboardingProgressCard.tsx'
    // The cross-check below re-verifies them automatically wherever history is
    // available, so they cannot silently drift.
    const BASE_DONE = new Set(
      "flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[11px] text-white".split(/\s+/),
    );
    const BASE_QUIET = new Set(
      "flex h-5 w-5 items-center justify-center rounded-full border border-neutral-300 text-[11px] text-neutral-400 dark:border-neutral-700".split(/\s+/),
    );

    const shape = ONBOARD.match(/const MARK_SHAPE = "([^"]+)"/)?.[1] ?? "";
    const quiet = ONBOARD.match(/const MARK_QUIET =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
    const doneTone = ONBOARD.match(/"(bg-emerald-600 text-white)"/)?.[1] ?? "";
    expect(shape, "MARK_SHAPE must exist").not.toBe("");
    expect(quiet, "MARK_QUIET must exist").not.toBe("");
    expect(doneTone, "done tone must exist").not.toBe("");

    const set = (...parts: string[]) =>
      new Set(parts.join(" ").split(/\s+/).filter(Boolean));
    const eq = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((x) => b.has(x));

    expect(
      eq(set(shape, doneTone), BASE_DONE),
      `done mark now emits {${[...set(shape, doneTone)].sort().join(" ")}}`,
    ).toBe(true);
    expect(
      eq(set(shape, quiet), BASE_QUIET),
      `quiet mark now emits {${[...set(shape, quiet)].sort().join(" ")}}`,
    ).toBe(true);

    // And the notification dot is genuinely untouched.
    expect(NOTIF).toContain("h-2 w-2 rounded-full bg-rose-600");
  });

  it("the pinned base sets still match real history, where history exists", (ctx) => {
    // Cross-check, so the literals above cannot drift from the commit they
    // claim to describe.
    //
    // THIS MUST NOT RETURN NORMALLY WHEN HISTORY IS MISSING. The first version
    // caught the error, printed a warning and returned — which Vitest reports as
    // PASS. CI's validate lane is a depth-1 checkout, so on every CI run this
    // "historical proof" was recorded as having passed while doing nothing at
    // all. A proof that reports success without executing is worse than no proof:
    // it launders an absence of evidence into a green tick.
    //
    // ctx.skip() marks the test SKIPPED at runtime, so the distinction between
    // "ran and agreed with history" and "could not look at history" survives
    // into the reporter. The pinned-set assertions above are a separate test and
    // still execute in both environments.
    let before: string;
    try {
      before = execFileSync(
        "git",
        ["show", `${BASE_REF}:app/(app)/dashboard/onboarding/OnboardingProgressCard.tsx`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      ctx.skip(
        `base ${BASE_REF.slice(0, 10)} unreachable (shallow clone) — historical cross-check did NOT run`,
      );
      return;
    }

    const historical = [
      ...before.matchAll(/className=\{?[`"]([^`"]*h-5 w-5[^`"]*)[`"]/g),
    ].map((m) => new Set(m[1].split(/\s+/).filter(Boolean)));
    expect(historical.length, "base must contain the three marks").toBe(3);

    const BASE_DONE = new Set(
      "flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[11px] text-white".split(/\s+/),
    );
    const BASE_QUIET = new Set(
      "flex h-5 w-5 items-center justify-center rounded-full border border-neutral-300 text-[11px] text-neutral-400 dark:border-neutral-700".split(/\s+/),
    );
    const eq = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((x) => b.has(x));

    for (const h of historical) {
      expect(
        eq(h, BASE_DONE) || eq(h, BASE_QUIET),
        `history has a mark the pinned sets do not describe: {${[...h].sort().join(" ")}}`,
      ).toBe(true);
    }
  });

  it("components/ui is untouched — no primitive was invented for two call sites", () => {
    // `sr-only` is the convention this repo already uses in 21 places. Two
    // surfaces do not justify a new component, and a new file in components/ui
    // would also have to re-clear the #609 server-compatibility guard.
    expect(NOTIF).not.toMatch(/from "@\/components\/ui\/(status-text|sr-status)/);
    expect(ONBOARD).not.toMatch(/from "@\/components\/ui\/(status-text|sr-status)/);
  });
});
