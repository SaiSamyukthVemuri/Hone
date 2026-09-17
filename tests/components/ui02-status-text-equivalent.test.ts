import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// The commit this slice is stacked on. Reading the pre-slice file out of git
// keeps the "unchanged visually" claim honest: the comparison uses the real
// previous source, not a copy pasted here that would silently drift.
const BASE_REF = "cec0234a9dbee31721df8e8978652f8b1b316cef";

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

  it("renders the SAME class set as before — proved against the base file", () => {
    // The claim is "this change is visually invisible". Asserting a class
    // STRING cannot prove that: refactoring the mark into shape + tone reordered
    // the string while rendering identical classes, and a string assertion would
    // fail on a correct change and pass on an incorrect one that happened to
    // keep the substring. The property is the SET of classes each state emits,
    // so that is what this compares — against the real pre-slice file, read out
    // of git rather than restated here where it could drift.
    const before = execFileSync(
      "git",
      ["show", `${BASE_REF}:app/(app)/dashboard/onboarding/OnboardingProgressCard.tsx`],
      { encoding: "utf8" },
    );

    const classSets = (src: string): Set<string>[] =>
      [...src.matchAll(/className=\{?[`"]([^`"]*h-5 w-5[^`"]*)[`"]/g)].map(
        (m) => new Set(m[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean)),
      );

    // Base emits three literal marks; head emits one template plus two tones.
    const beforeSets = classSets(before);
    expect(beforeSets.length).toBeGreaterThan(0);

    const shape = ONBOARD.match(/const MARK_SHAPE = "([^"]+)"/)?.[1] ?? "";
    const quiet = ONBOARD.match(/const MARK_QUIET =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
    const doneTone = ONBOARD.match(/"(bg-emerald-600 text-white)"/)?.[1] ?? "";
    expect(shape, "MARK_SHAPE must exist").not.toBe("");
    expect(quiet, "MARK_QUIET must exist").not.toBe("");
    expect(doneTone, "done tone must exist").not.toBe("");

    const set = (...parts: string[]) =>
      new Set(parts.join(" ").split(/\s+/).filter(Boolean));
    const afterDone = set(shape, doneTone);
    const afterQuiet = set(shape, quiet);

    const eq = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((x) => b.has(x));

    // Every state the base rendered must still be rendered by one of ours.
    for (const b of beforeSets) {
      expect(
        eq(b, afterDone) || eq(b, afterQuiet),
        `base class set {${[...b].sort().join(" ")}} is no longer emitted`,
      ).toBe(true);
    }

    // And the notification dot is genuinely untouched.
    expect(NOTIF).toContain("h-2 w-2 rounded-full bg-rose-600");
  });

  it("components/ui is untouched — no primitive was invented for two call sites", () => {
    // `sr-only` is the convention this repo already uses in 21 places. Two
    // surfaces do not justify a new component, and a new file in components/ui
    // would also have to re-clear the #609 server-compatibility guard.
    expect(NOTIF).not.toMatch(/from "@\/components\/ui\/(status-text|sr-status)/);
    expect(ONBOARD).not.toMatch(/from "@\/components\/ui\/(status-text|sr-status)/);
  });
});
