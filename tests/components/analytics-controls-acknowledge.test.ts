import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// HON-109: every server-backed Analytics control must acknowledge a press inside the 100 ms budget.
// Measured before the fix: a plain <a> or a native GET form is a full document navigation, so the old page stayed frozen for 0.8-1.3 s with no
// signal (20/20 runs over budget). The contract: a navigating control is a PendingLink, a navigating form is a PendingGetForm with a pending-aware
// submit. Downloads (export.csv) are not navigations and stay plain links.

const DIR = path.join(process.cwd(), "app/(app)/financials/analytics");
const read = (f: string) => readFileSync(path.join(DIR, f), "utf8");
const SCREENS = ["overview-screen.tsx", "clients-screen.tsx", "waitlist-screen.tsx"];

describe("HON-109 analytics controls acknowledge a press", () => {
  for (const file of SCREENS) {
    it(`${file}: no plain navigating anchor and no native GET form`, () => {
      const src = read(file);
      const anchors = [...src.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
      // The only plain anchors allowed are file downloads.
      const offenders = anchors.filter((a) => !/export\.csv/.test(a));
      expect(offenders).toEqual([]);
      expect(src).not.toMatch(/<form\b/);
    });
  }

  it("the period form and the capacity form are PendingGetForm with a pending-aware submit", () => {
    expect(read("overview-screen.tsx")).toMatch(/<PendingGetForm[\s\S]*<PendingSubmit[\s\S]*<\/PendingGetForm>/);
    const w = read("waitlist-screen.tsx");
    expect(w).toMatch(/<PendingGetForm[\s\S]*<PendingButton[\s\S]*<\/PendingGetForm>/);
  });

  it("PendingGetForm keeps a real GET form and navigates inside a transition (no artificial delay)", () => {
    const src = readFileSync(path.join(process.cwd(), "components/pending-get-form.tsx"), "utf8");
    expect(src).toMatch(/method="get"/);
    expect(src).toMatch(/useTransition/);
    expect(src).not.toMatch(/setTimeout/);
  });

  it("the Statements month picker acknowledges a press but keeps the browser's own GET submission (HON-100 Back/Forward restore)", () => {
    const chrome = readFileSync(path.join(process.cwd(), "app/(app)/financials/statements/statements-chrome.tsx"), "utf8");
    expect(chrome).toMatch(/<PendingGetForm native /);
    expect(chrome).not.toMatch(/<form\b/);
    const gf = readFileSync(path.join(process.cwd(), "components/pending-get-form.tsx"), "utf8");
    // native mode never prevents the browser's submit unless a press is already in flight
    expect(gf).toMatch(/if \(native\) \{[\s\S]*?if \(pending\) event\.preventDefault\(\);[\s\S]*?return;/);
    expect(gf).toMatch(/pageshow/);
  });

  it("PendingButton also reflects a GET form's pending state", () => {
    expect(readFileSync(path.join(process.cwd(), "components/pending-button.tsx"), "utf8")).toMatch(/usePendingGetForm\(\)/);
  });

  it("the uncontrolled filter forms are keyed on the applied params, so an unapplied choice cannot outlive a navigation (Codex P2)", () => {
    expect(read("overview-screen.tsx")).toMatch(/<PendingGetForm key=\{\[params\.periodKind, selected, params\.from, params\.to, params\.compare, params\.series\]\.join\("\|"\)\}/);
    expect(read("waitlist-screen.tsx")).toMatch(/<PendingGetForm key=\{`\$\{params\.serviceId \?\? ""\}\|\$\{params\.days\}`\}/);
  });

  it("the feedback e2e selects a Period option that exists and does not swallow the rejection (Codex P1)", () => {
    const spec = readFileSync(path.join(process.cwd(), "e2e/hon109-analytics-feedback.spec.ts"), "utf8");
    const m = spec.match(/getByLabel\("Period"\)\.selectOption\("([a-z_]+)"\)(\.catch)?/);
    expect(m, "a Period selectOption call").not.toBeNull();
    expect(m![2], "no .catch swallowing the failure").toBeUndefined();
    const offered = [...read("overview-screen.tsx").matchAll(/PERIOD_LABELS[^=]*= \{([^}]*)\}/g)][0][1];
    expect(offered).toContain(`${m![1]}:`);
  });
});
