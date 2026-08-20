import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  TODO_COMPACT_COUNT,
  TODO_DISCLOSURE_LIMIT,
} from "@/lib/dashboard/todo-model";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const PAGE = codeOnly(read("app/(app)/dashboard/page.tsx"));
const LIST = read("app/(app)/dashboard/todo-list.tsx");
const LIST_CODE = codeOnly(LIST);
const SNAPSHOT = codeOnly(read("app/(app)/dashboard/practice-snapshot.tsx"));

// DASH-TRUTH-02 — hidden work is expandable in place, never dead text.
describe("DASH-TRUTH-02 disclosure", () => {
  it("M5 the dead '+ N more not shown' text is gone", () => {
    // codeOnly: the comment above the new control deliberately quotes the old
    // string to explain what was removed and why.
    expect(LIST_CODE).not.toMatch(/more not shown/);
  });

  it("M1 there is a real, accessible toggle", () => {
    expect(LIST_CODE).toMatch(/<button/);
    expect(LIST_CODE).toMatch(/aria-expanded=\{expanded\}/);
    expect(LIST_CODE).toMatch(/aria-controls="dashboard-todo-list"/);
    expect(LIST_CODE).toMatch(/Show \$\{hiddenCount\} more/);
    expect(LIST_CODE).toMatch(/Show less/);
  });

  it("M2/M3 expansion slices the SAME ordered list, so order and links survive", () => {
    // One source of rows; expansion only changes how many of them render.
    expect(LIST_CODE).toMatch(/expanded \? todo\.items : todo\.items\.slice\(0, TODO_COMPACT_COUNT\)/);
    expect(LIST_CODE).toMatch(/visible\.map\(\(item\)/);
    expect(LIST_CODE).toMatch(/href=\{item\.action\.href\}/);
  });

  it("M4 collapse is the same control, toggled", () => {
    expect(LIST_CODE).toMatch(/setExpanded\(\(v\) => !v\)/);
  });

  it("the count can only ever name rows that are actually loaded", () => {
    expect(LIST_CODE).toMatch(/todo\.items\.length - TODO_COMPACT_COUNT/);
    expect(TODO_COMPACT_COUNT).toBeLessThan(TODO_DISCLOSURE_LIMIT);
  });

  it("a genuine scan-cap truncation is still stated, but never as a control", () => {
    expect(LIST).toMatch(/Older items beyond this list are not included/);
    const tail = LIST.slice(LIST.indexOf("todo.moreCount > 0"));
    expect(tail).not.toMatch(/<button/);
  });

  it("no page navigation is introduced by the disclosure", () => {
    const tail = LIST_CODE.slice(LIST_CODE.indexOf("hiddenCount > 0"));
    expect(tail).not.toMatch(/<Link|router\.|href=/);
  });
});

// DASH-TRUTH-03 — plumbing is not a KPI.
describe("DASH-TRUTH-03 practice snapshot", () => {
  it("S1/S2 neither prepared label renders", () => {
    expect(SNAPSHOT).not.toMatch(/Payments prepared/);
    expect(SNAPSHOT).not.toMatch(/Test payments prepared/);
    expect(SNAPSHOT).not.toMatch(/testPayments\.prepared/);
  });

  it("S3 Payments charged remains", () => {
    expect(SNAPSHOT).toMatch(/Payments charged/);
    expect(SNAPSHOT).toMatch(/testPayments\.charged/);
  });

  it("S4 Refunds remains", () => {
    expect(SNAPSHOT).toMatch(/Refunds/);
    expect(SNAPSHOT).toMatch(/testPayments\.refunds/);
  });
});

// DASH-TRUTH-04 — the daily product does not email the founder.
describe("DASH-TRUTH-04 pilot feedback is off the Dashboard", () => {
  it("B1/B2 no PilotFeedbackPrompt renders anywhere on the Dashboard", () => {
    expect(PAGE).not.toMatch(/<PilotFeedbackPrompt/);
    expect(PAGE).not.toMatch(/from "\.\/pilot-feedback-prompt"/);
  });

  it("B3 the old Pilot learning card has not returned", () => {
    for (const s of [/Pilot learning/i, /Send it to Sam/i, /Know another electrologist/i, /Send feedback/i]) {
      expect(PAGE).not.toMatch(s);
    }
  });
});

// Preservation of already-shipped Chloe fixes.
describe("previously shipped Dashboard fixes are preserved", () => {
  it("R2 completed booking setup stays off the Dashboard", () => {
    for (const s of [/Booking page ready/i, /Your public booking page is live/i]) {
      expect(PAGE).not.toMatch(s);
    }
  });

  it("R3 completed Getting Started stays off the Dashboard", () => {
    expect(PAGE).not.toMatch(/Setup complete\./i);
    expect(PAGE).not.toMatch(/Getting started checklist/i);
  });

  it("R1 the inline full-treatment disclosure is untouched by this tranche", () => {
    // The e2e spec (dashboard-treatment-memory-inline) is the browser
    // authority. This pins that the component still owns the inline
    // disclosure and this tranche did not reintroduce calendar navigation.
    const MEM = read("app/(app)/dashboard/dashboard-treatment-memory.tsx");
    expect(MEM).toMatch(/View full last treatment/i);
    expect(codeOnly(MEM)).not.toMatch(/href=\{?["\`]\/calendar/);
  });
});
