import { describe, expect, it } from "vitest";
import { ARM_FALLBACK_MS, printWithAudit, type ArmDeps } from "@/lib/records/print/arm-print";

/** A fake browser: tracks the armed flag, the afterprint listeners and timers. */
function browser(over: Partial<ArmDeps> & { recordOk?: boolean; printThrows?: boolean } = {}) {
  const log: string[] = [];
  const state = { armed: false, listeners: new Set<() => void>(), timers: new Map<number, () => void>(), nextTimer: 1 };
  const deps: ArmDeps = {
    record: async () => (log.push("record"), { ok: over.recordOk ?? true }),
    arm: () => (log.push("arm"), void (state.armed = true)),
    disarm: () => (log.push("disarm"), void (state.armed = false)),
    print: () => {
      log.push("print");
      if (over.printThrows) throw new Error("blocked");
    },
    onAfterPrint: (cb) => (state.listeners.add(cb), () => void state.listeners.delete(cb)),
    setTimer: (cb, ms) => {
      const id = state.nextTimer++;
      state.timers.set(id, cb);
      log.push(`timer:${ms}`);
      return id;
    },
    clearTimer: (h) => void state.timers.delete(h as number),
    ...over,
  };
  return {
    deps,
    state,
    log,
    afterprint: () => [...state.listeners].forEach((cb) => cb()),
    fireTimers: () => [...state.timers.values()].forEach((cb) => cb()),
    /** What a Ctrl/Cmd+P now would show: the record only while armed. */
    browserPrintShowsRecord: () => state.armed,
  };
}

describe("printWithAudit: one print per audited click", () => {
  it("audits first, arms, prints, and the document is armed only until afterprint", async () => {
    const b = browser();
    expect(await printWithAudit(b.deps)).toEqual({ ok: true });
    expect(b.log).toEqual(["record", "arm", `timer:${ARM_FALLBACK_MS}`, "print"]);
    expect(b.log.indexOf("record")).toBeLessThan(b.log.indexOf("arm"));
    expect(b.log.indexOf("arm")).toBeLessThan(b.log.indexOf("print"));
    expect(b.browserPrintShowsRecord()).toBe(true);
    b.afterprint();
    expect(b.browserPrintShowsRecord()).toBe(false);
  });
  it("B-1: a SECOND Ctrl/Cmd+P after afterprint is not armed, and it takes a new audited click to arm again", async () => {
    const b = browser();
    await printWithAudit(b.deps);
    b.afterprint();
    expect(b.browserPrintShowsRecord()).toBe(false); // second browser print: only the notice
    await printWithAudit(b.deps);
    expect(b.log.filter((x) => x === "record")).toHaveLength(2); // the second print was audited again
    expect(b.browserPrintShowsRecord()).toBe(true);
  });
  it("the timeout fallback disarms when the browser never fires afterprint, once, and drops the listener", async () => {
    const b = browser();
    await printWithAudit(b.deps);
    expect(b.state.listeners.size).toBe(1);
    b.fireTimers();
    expect(b.browserPrintShowsRecord()).toBe(false);
    expect(b.state.listeners.size).toBe(0);
    b.afterprint(); // late afterprint after the fallback must be harmless
    expect(b.log.filter((x) => x === "disarm")).toHaveLength(1);
  });
  it("afterprint cancels the pending fallback timer", async () => {
    const b = browser();
    await printWithAudit(b.deps);
    b.afterprint();
    expect(b.state.timers.size).toBe(0);
  });
});

describe("printWithAudit: every failure path leaves the document unarmed", () => {
  it("a refused audit never arms or prints", async () => {
    const b = browser({ recordOk: false });
    expect(await printWithAudit(b.deps)).toEqual({ ok: false });
    expect(b.log).not.toContain("arm");
    expect(b.log).not.toContain("print");
    expect(b.browserPrintShowsRecord()).toBe(false);
  });
  it("a thrown audit action never arms or prints", async () => {
    const b = browser({ record: () => Promise.reject(new Error("net")) });
    expect(await printWithAudit(b.deps)).toEqual({ ok: false });
    expect(b.log).not.toContain("arm");
    expect(b.log).not.toContain("print");
  });
  it("if window.print throws, the arm is removed at once", async () => {
    const b = browser({ printThrows: true });
    expect(await printWithAudit(b.deps)).toEqual({ ok: false });
    expect(b.browserPrintShowsRecord()).toBe(false);
    expect(b.state.listeners.size).toBe(0);
    expect(b.state.timers.size).toBe(0);
  });
  it("a failure after a previous armed print also clears a stale arm", async () => {
    const b = browser();
    b.state.armed = true; // stale arm left by some earlier path
    await printWithAudit({ ...b.deps, record: async () => ({ ok: false }) });
    expect(b.browserPrintShowsRecord()).toBe(false);
  });
});
