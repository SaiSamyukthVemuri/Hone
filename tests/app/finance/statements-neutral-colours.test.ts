import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PILL_TONE } from "@/app/(app)/financials/statements/statements-chrome";
import { documentVisitTone, studioVisitStatus } from "@/lib/finance/statement-methods";

// Direction from the product owner: no decorative sage across Hone, including Statements; meaningful status colours stay. These tests pin the PROPERTY
// (no tint anywhere in the Statements screens; status colour carries the status), not the spelling of a class.

const ROOTS = ["app/(app)/financials/statement", "app/(app)/financials/statements"];
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}
const FILES = ROOTS.flatMap(sources);

describe("no decorative sage in the Statements screens", () => {
  it("the folders are scanned (so the guard cannot pass on an empty list)", () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(FILES.some((f) => f.endsWith("client-statement-view.tsx"))).toBe(true);
    expect(FILES.some((f) => f.endsWith("statement-print-view.tsx"))).toBe(true);
    expect(FILES.some((f) => f.endsWith("statement-view.tsx"))).toBe(true);
  });
  it("no source carries a literal hex colour (a sage or any other), so every colour is an app token", () => {
    for (const f of FILES) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        const code = l.replace(/\/\/.*$/, ""); // a comment may name a value; code may not
        // the one allowed literal is the neutral black alpha of the active segment's shadow
        expect(code.replace(/shadow-\[0_1px_4px_#0002\]/g, ""), `${f}:${i + 1}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      });
    }
  });
  it("no source uses a green or teal palette class directly (status green comes only through the success tokens)", () => {
    for (const f of FILES) expect(readFileSync(f, "utf8"), f).not.toMatch(/\b(?:bg|text|border|ring|fill|stroke)-(?:emerald|green|teal|lime|sage|mineral|wash|band)/);
  });
  it("the summary card is white with the static edge, and the shared chrome has no tint", () => {
    const chrome = readFileSync("app/(app)/financials/statements/statements-chrome.tsx", "utf8");
    expect(chrome).toContain('SUMMARY_TONE = "border border-line bg-surface"');
    expect(chrome).toContain("bg-surface-sunken");
  });
  it("the page ground is white", () => {
    for (const f of ["statement/page.tsx", "statements/page.tsx"]) expect(readFileSync(`app/(app)/financials/${f}`, "utf8"), f).toContain('className="bg-surface min-[1140px]:-mx-[45px]"');
  });
  it("Print / Save as PDF is the app's solid action (charcoal), not a brand colour", () => {
    const src = readFileSync("app/(app)/financials/statements/client-statement-view.tsx", "utf8");
    expect(src).toMatch(/const PRIMARY = cx\([^\n]*border-accent bg-accent[^\n]*text-on-accent/);
  });
  it("the print paper carries no colour of its own (ink on white only)", () => {
    const src = readFileSync("app/(app)/financials/statements/statement-print-view.tsx", "utf8");
    expect(src).not.toMatch(/\b(?:bg|border)-(?![btlrxy]\b|line\b)[a-z]+/); // edge directions (border-t) and the neutral rule colour are the only forms
  });
});

describe("the status pill keeps its meaning in colour, and the words stay", () => {
  const cash = (cents: number) => ({ kind: "collected_cash" as const, cents });
  it("Paid is the success green; it is the ONLY state drawn that way", () => {
    expect(studioVisitStatus([cash(10000)], 10000)).toEqual({ label: "Paid", tone: "success" });
    expect(PILL_TONE.success).toBe("bg-success-surface text-success-fg");
    for (const s of [
      studioVisitStatus([cash(5000)], 10000), // Payment not confirmed
      studioVisitStatus([cash(5000)], null), // Payment recorded
      studioVisitStatus([{ kind: "unresolved", cents: null }]),
      studioVisitStatus([{ kind: "still_owes_note", cents: null }]),
      studioVisitStatus([{ kind: "refunded_card_session", cents: 100 }]),
      studioVisitStatus([{ kind: "waived", cents: 100 }]),
      studioVisitStatus([cash(0)], 0),
    ]) expect(s.tone, s.label).not.toBe("success");
  });
  it("Payment not confirmed, Unresolved and Marked still owing are the warning amber", () => {
    for (const s of [studioVisitStatus([cash(5000)], 10000), studioVisitStatus([cash(0)], 5000), studioVisitStatus([{ kind: "unresolved", cents: null }]), studioVisitStatus([{ kind: "still_owes_note", cents: null }])]) expect(s.tone, s.label).toBe("warning");
    expect(studioVisitStatus([cash(5000)], 10000).label).toBe("Payment not confirmed");
    expect(studioVisitStatus([{ kind: "unresolved", cents: null }]).label).toBe("Unresolved");
    expect(studioVisitStatus([{ kind: "still_owes_note", cents: null }]).label).toBe("Marked still owing");
    expect(PILL_TONE.warning).toBe("bg-warning-surface text-warning-fg");
  });
  it("Payment recorded, Refunded in full, Waived and No charge are the neutral grey", () => {
    const rows = [studioVisitStatus([cash(5000)], null), studioVisitStatus([{ kind: "refunded_card_session", cents: 100 }]), studioVisitStatus([{ kind: "waived", cents: 100 }]), studioVisitStatus([cash(0)], 0)];
    expect(rows.map((r) => r.label)).toEqual(["Payment recorded", "Refunded in full", "Waived", "No charge"]);
    for (const r of rows) expect(r.tone, r.label).toBe("neutral");
    expect(PILL_TONE.neutral).toBe("bg-status-neutral-surface text-status-neutral-fg");
  });
  it("a unresolved line wins over a payment: never green, always the amber Unresolved", () => {
    expect(studioVisitStatus([cash(10000), { kind: "unresolved", cents: null }], 10000)).toMatchObject({ label: "Unresolved", tone: "warning" });
  });
  it("the client statement's states map the same way: paid is green; unknown and not paid are amber; adjusted and no charge are grey", () => {
    expect(documentVisitTone("paid")).toBe("success");
    expect(documentVisitTone("unknown")).toBe("warning");
    expect(documentVisitTone("confirmed_unpaid")).toBe("warning");
    expect(documentVisitTone("adjusted")).toBe("neutral");
    expect(documentVisitTone("no_charge")).toBe("neutral");
  });
  it("the three tones are three different colours", () => {
    expect(new Set(Object.values(PILL_TONE)).size).toBe(3);
  });
});
