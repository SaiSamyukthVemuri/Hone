import { describe, expect, it } from "vitest";
import { MENU_PRINT_POLICY, MENU_PRINT_UNRECORDED_MESSAGE, newMenuPrintState, onBeforePrint, type MenuPrintDeps } from "@/lib/records/print/menu-print";

function harness(over: Partial<MenuPrintDeps> = {}) {
  const log: string[] = [];
  let armed = false;
  let after: (() => void) | null = null;
  const reports: boolean[] = [];
  const deps: MenuPrintDeps = {
    policy: "record_after",
    isArmed: () => armed,
    arm: () => { armed = true; log.push("arm"); },
    disarm: () => { armed = false; log.push("disarm"); },
    record: async () => { log.push("record"); return { ok: true }; },
    onAfterPrint: (cb) => { after = cb; return () => { after = null; }; },
    report: (r) => { reports.push(r); },
    ...over,
  };
  return { deps, log, afterprint: () => after?.(), setArmed: (v: boolean) => { armed = v; }, reports: () => reports };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the default policy is the product's chosen one, in one named constant", () => {
  it("is record_after", () => expect(MENU_PRINT_POLICY).toBe("record_after"));
  it("tells the person what to do when a menu print was not recorded", () => {
    expect(MENU_PRINT_UNRECORDED_MESSAGE).toBe("This print wasn't recorded. Press Print on the page to record it.");
  });
});

describe("Ctrl/Cmd+P (beforeprint)", () => {
  it("record_after: arms at once (synchronously), records once, and disarms after the print", async () => {
    const h = harness(); const st = newMenuPrintState();
    onBeforePrint(h.deps, st);
    expect(h.log).toEqual(["arm", "record"]); // armed before anything async
    await flush();
    expect(h.reports()).toEqual([true]);
    h.afterprint();
    expect(h.log).toEqual(["arm", "record", "disarm"]);
  });
  it("is idempotent per open: a second menu print prints but adds no second record", async () => {
    const h = harness(); const st = newMenuPrintState();
    onBeforePrint(h.deps, st); await flush(); h.afterprint();
    onBeforePrint(h.deps, st); await flush();
    expect(h.log.filter((x) => x === "record")).toHaveLength(1);
    expect(h.log.filter((x) => x === "arm")).toHaveLength(2);
  });
  it("two beforeprints before the first save finishes record once", async () => {
    const h = harness(); const st = newMenuPrintState();
    onBeforePrint(h.deps, st); onBeforePrint(h.deps, st); await flush();
    expect(h.log.filter((x) => x === "record")).toHaveLength(1);
  });
  it("a failed save is reported, and the NEXT menu print tries again", async () => {
    let ok = false;
    const h = harness({ record: async () => ({ ok }) }); const st = newMenuPrintState();
    onBeforePrint(h.deps, st); await flush();
    expect(h.reports()).toEqual([false]);
    ok = true; h.afterprint();
    onBeforePrint(h.deps, st); await flush();
    expect(h.reports()).toEqual([false, true]);
  });
  it("a save that throws is a failed save, not an unhandled error", async () => {
    const h = harness({ record: async () => { throw new Error("down"); } });
    onBeforePrint(h.deps, newMenuPrintState()); await flush();
    expect(h.reports()).toEqual([false]);
  });
  it("the page's Print button (already armed and recorded) records nothing more", async () => {
    const h = harness(); h.setArmed(true);
    onBeforePrint(h.deps, newMenuPrintState()); await flush();
    expect(h.log).toEqual([]);
  });
  it("notice_only: the browser's own print arms nothing and records nothing", async () => {
    const h = harness({ policy: "notice_only" });
    onBeforePrint(h.deps, newMenuPrintState()); await flush();
    expect(h.log).toEqual([]);
  });
});
