import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// UI-R02 slice 2 — press/pending adoption on two high-frequency practitioner
// controls: the charting done-boundary and the destructive client archive.
//
// SCOPE NOTE. These assert that each control routes through a UI-R01 primitive
// and that the hand-rolled shapes are gone. They do NOT claim the press paints
// on a real device — `REAL_DEVICE_TOUCH_ACTIVE` is still UNVERIFIED, and no
// automation closes it. The browser-observable half lives in
// e2e/ui-r01-interaction-foundations.spec.ts.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DONE = code("app/(app)/clients/[id]/sessions/[sessionId]/DoneChartingButton.tsx");
const ARCHIVE = code("app/(app)/clients/[id]/edit/ArchiveClientControl.tsx");

describe("UI-R02: the charting done-boundary uses the primitives", () => {
  it("every styled control is a Button; only the invisible backdrop stays raw", () => {
    // Four raw <button>s became three Buttons. The backdrop is an inset-0
    // overlay with aria-label="Close", not a styled control, so it is
    // deliberately exempt rather than accidentally missed.
    expect((DONE.match(/<Button\b/g) ?? []).length).toBe(3);
    expect((DONE.match(/<button\b/g) ?? []).length).toBe(1);
    expect(DONE).toMatch(/<button[\s\S]{0,120}aria-label="Close"/);
  });

  it("the hand-rolled primary is gone, dark: pairs and all", () => {
    expect(DONE).not.toContain("DONE_CLASS");
    expect(DONE).not.toContain("bg-neutral-900");
    expect(DONE).not.toContain("dark:bg-white");
    expect(DONE).not.toContain("disabled:opacity-50");
  });

  it("the CLINICAL stamp now has a real in-flight state, not just opacity", () => {
    // This is the defect that mattered: markThenProceed writes an aftercare
    // stamp through a server action and the only signal was a faded button.
    expect(DONE).toMatch(/pending=\{pending\}/);
    expect(DONE).toMatch(/busyLabel="Marking…"/);
  });

  it("BEHAVIOUR IS UNCHANGED — the never-blocking contract survives", () => {
    // Escape must still close while the write is in flight. Both dialog
    // buttons are disabled during pending, so Escape and the backdrop are the
    // only two exits; adopting confirm-dialog's idle-only rule here would
    // remove one of them from a control documented as emergency-safe.
    expect(DONE).toMatch(/e\.key === "Escape"/);
    expect(DONE).not.toMatch(/Escape"\s*&&\s*!pending/);
    expect(DONE).toMatch(/onClick=\{proceed\}/);
    expect(DONE).toMatch(/role="dialog"/);
  });
});

describe("UI-R02: the destructive archive control", () => {
  it("the hand-rolled PendingButton is replaced by the real one", () => {
    // useFormStatus + {pending ? "Archiving..." : ...} + disabled:opacity-60
    // was one of the 57 ternaries Button's docblock counts across 47 files.
    expect(ARCHIVE).not.toContain("useFormStatus");
    expect(ARCHIVE).not.toContain("ArchiveSubmit");
    expect(ARCHIVE).not.toContain("disabled:opacity-60");
    expect(ARCHIVE).not.toMatch(/pending \? "Archiving/);
    expect(ARCHIVE).toMatch(/<PendingButton variant="danger" busyLabel="Archiving…">/);
  });

  it("the disarmed trigger composes the shared layers rather than hand-rolling", () => {
    // Button has no outlined-danger variant and Hone ships no tailwind-merge,
    // so this control supplies its own colour on top of LEAF_CONTROL_PRESS —
    // that layer's documented contract, not a workaround.
    expect(ARCHIVE).toContain("CONTROL_MIN_TOUCH");
    expect(ARCHIVE).toContain("FOCUS_RING");
    expect(ARCHIVE).toContain("LEAF_CONTROL_PRESS");
  });

  it("LEAF_CONTROL_PRESS is never used without a colour of its own", () => {
    // The layer collapses to a no-op under prefers-reduced-motion, so a caller
    // that supplies no active: colour ships NO acknowledgement to a
    // reduced-motion user. This is the exact contract UI-R01 paid four review
    // rounds to establish.
    expect(ARCHIVE).toMatch(/active:bg-red-100/);
    expect(ARCHIVE).toMatch(/dark:active:bg-red-900\/40/);
  });

  it("only the committed step is solid danger", () => {
    // Outlined while disarmed, solid once armed. Arming only reveals copy, so
    // flattening both to variant="danger" would destroy a real escalation.
    expect((ARCHIVE.match(/variant="danger"/g) ?? []).length).toBe(1);
    expect(ARCHIVE).toMatch(/<Button type="button" variant="secondary"/);
  });
});

describe("UI-R02: what this slice did NOT do", () => {
  it("adds no dependency and no animation library", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    for (const banned of ["framer-motion", "lucide-react", "clsx", "tailwind-merge", "@astryxdesign/core"]) {
      expect(Object.keys(pkg.dependencies)).not.toContain(banned);
    }
  });

  it("fabricates no optimistic clinical state — the stamp is still server-confirmed", () => {
    // proceed() must stay behind `res.ok`. An optimistic navigate would show a
    // charting exit as complete when the aftercare write had failed.
    expect(DONE).toMatch(/const res = await markAction\(fd\)/);
    expect(DONE).toMatch(/if \(res\.ok\) \{\s*proceed\(\)/);
    expect(DONE).not.toMatch(/proceed\(\);\s*await markAction/);
  });
});
