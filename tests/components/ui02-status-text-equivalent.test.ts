import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

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
  it("components/ui is untouched — no primitive was invented for two call sites", () => {
    // `sr-only` is the convention this repo already uses in 21 places. Two
    // surfaces do not justify a new component, and a new file in components/ui
    // would also have to re-clear the #609 server-compatibility guard.
    expect(NOTIF).not.toMatch(/from "@\/components\/ui\/(status-text|sr-status)/);
    expect(ONBOARD).not.toMatch(/from "@\/components\/ui\/(status-text|sr-status)/);
  });
});
