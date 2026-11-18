import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ARM_FALLBACK_MS, printWithAudit, type ArmDeps } from "@/lib/records/print/arm-print";

// HON-46 (Sam's decision, 18 Nov 2026): the day packet prints on Letter AND A4, and a failed, cancelled or restored print leaves the
// treatment workflow usable. Paper is the printer's choice, so these tests pin that the layout names NO paper and holds no fixed
// width, and that every way a print can end leaves the page disarmed and the next Print working.

const VIEW = readFileSync("app/(app)/records/print/_packet/day-packet-view.tsx", "utf8");
const css = VIEW.slice(VIEW.indexOf("const PRINT_CSS = `"), VIEW.indexOf("`;", VIEW.indexOf("const PRINT_CSS = `")));

describe("paper: Letter and A4 from one layout", () => {
  it("the print CSS names no paper size and no fixed page width or height", () => {
    expect(css).not.toMatch(/\bsize\s*:/);
    expect(css).not.toMatch(/\b(letter|a4)\b/i);
    expect(css).not.toMatch(/(?:width|height)\s*:\s*\d+(?:\.\d+)?(?:px|in|cm|pt)/i);
  });
  it("every page margin and padding is in millimetres, so it holds on 210 mm and 215.9 mm paper", () => {
    const lengths = [...css.matchAll(/(?:padding|margin|height)\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(lengths.length).toBeGreaterThan(0);
    for (const l of lengths) expect(l, l).toMatch(/^(0|(\d+(?:\.\d+)? ?mm)(\s+\d+(?:\.\d+)?mm)*|0 \d+mm)$/);
  });
  it("the browser's own header and footer (which print the address) stay off the paper on either size", () => {
    expect(css).toMatch(/@page\s*\{\s*margin:\s*0;\s*\}/);
  });
  it("a visit never splits across pages", () => {
    expect(VIEW).toMatch(/break-inside-avoid py-3" data-testid="day-packet-visit"/);
  });
});

function fake(over: Partial<ArmDeps> = {}) {
  const log: string[] = [];
  let armed = false;
  let after: (() => void) | null = null;
  let timer: (() => void) | null = null;
  const deps: ArmDeps = {
    record: async () => (log.push("record"), { ok: true }),
    arm: () => { armed = true; log.push("arm"); },
    disarm: () => { armed = false; log.push("disarm"); },
    print: () => { log.push("print"); },
    onAfterPrint: (cb) => { after = cb; return () => { after = null; }; },
    setTimer: (cb) => { timer = cb; return 1; },
    clearTimer: () => { timer = null; },
    ...over,
  };
  return { deps, log, armed: () => armed, fireAfter: () => after?.(), fireTimer: () => timer?.() };
}

describe("a failed, cancelled or restored print leaves the page usable", () => {
  it("a CANCELLED print (the dialog closes, afterprint fires) disarms, and Print works again", async () => {
    const b = fake();
    expect(await printWithAudit(b.deps)).toEqual({ ok: true });
    expect(b.armed()).toBe(true);
    b.fireAfter();
    expect(b.armed()).toBe(false);
    expect(await printWithAudit(b.deps)).toEqual({ ok: true });
    expect(b.log.filter((x) => x === "record")).toHaveLength(2);
  });
  it("a browser that never reports the end of a print still disarms after the fallback, and Print works again", async () => {
    const b = fake();
    await printWithAudit(b.deps);
    b.fireTimer();
    expect(b.armed()).toBe(false);
    expect(await printWithAudit(b.deps)).toEqual({ ok: true });
    expect(ARM_FALLBACK_MS).toBe(60_000);
  });
  it("a save that fails prints nothing, leaves nothing armed, and the next Print works", async () => {
    const b = fake({ record: async () => ({ ok: false }) });
    expect(await printWithAudit(b.deps)).toEqual({ ok: false, reason: "audit_failed" });
    expect(b.armed()).toBe(false);
    expect(b.log).not.toContain("print");
    expect(await printWithAudit({ ...b.deps, record: async () => ({ ok: true }) })).toEqual({ ok: true });
  });
  it("a print dialog that cannot open leaves nothing armed and is told apart from a failed save", async () => {
    const b = fake({ print: () => { throw new Error("no dialog"); } });
    expect(await printWithAudit(b.deps)).toEqual({ ok: false, reason: "print_failed" });
    expect(b.armed()).toBe(false);
  });
  it("the controls that carry the workflow are outside the printed document and hidden in print", () => {
    const doc = VIEW.slice(VIEW.indexOf("<div data-packet-document>"));
    expect(doc).not.toContain("AuditedPrintButton");
    expect(VIEW).toMatch(/Back to Record Keeping/);
    expect(VIEW.match(/print:hidden/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("a restored or reused print link says what to do", () => {
  const page = readFileSync("app/(app)/records/print/ticket/[token]/page.tsx", "utf8");
  it("names a reload, Back and a restored tab, and says to start a fresh print from the session", () => {
    expect(page).toContain("restored this tab");
    expect(page).toContain("went Back to it");
    expect(page).toMatch(/Start a fresh print from the client&rsquo;s session/);
    expect(page).toContain("Print this day&rsquo;s record");
  });
  it("it states no reason that tells a prober which check failed", () => {
    expect(page).not.toMatch(/expired|forged|malformed|other studio|wrong studio/i);
  });
  it("the label it names is the real button on the session page", () => {
    const session = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
    expect(session).toContain("Print this day&rsquo;s record");
  });
});
