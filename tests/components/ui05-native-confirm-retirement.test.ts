import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// UI-05 — the last two native confirm() dialogs, retired.
//
// WHY THIS IS NOT A STYLING SLICE. confirm-dialog.tsx's own docblock records
// that iOS Safari can SUPPRESS a native confirm silently. When it does, the
// guard returns false and the mutation never runs: a practitioner taps Remove
// or Archive, sees nothing happen, and cannot tell refusal from being ignored.
// Two other surfaces in this repo had already migrated for that reason and said
// so in their comments; these two were the stragglers.
//
// What the shipped dialog adds that a native one cannot: role="alertdialog",
// a focus trap, focus restored to the opener, Escape that closes ONLY while
// idle so an in-flight mutation is never abandoned, and an error region that
// keeps the dialog open so the message can be read.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SCHEDULE = code("components/treatment-schedule-editor.tsx");
const PORTAL = code("components/portal-messages-card.tsx");

describe("UI-05: no native confirm survives anywhere in the app", () => {
  it("app/ and components/ contain ZERO live window.confirm calls", () => {
    // Repo-wide, not just the two files touched — otherwise a third could
    // appear tomorrow and this slice would still read as complete. Comments
    // mentioning the old API are allowed; a call is not.
    const hits = execSync(
      "git ls-files 'app/**/*.tsx' 'components/**/*.tsx'",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .flatMap((f) => {
        const stripped = code(f);
        return stripped.includes("window.confirm(") ? [f] : [];
      });
    expect(hits, `native confirm still called in: ${hits.join(", ")}`).toEqual([]);
  });
});

describe("UI-05: both surfaces use the shipped dialog with its real contract", () => {
  it("each mounts ConfirmDialog with danger tone and a busy label", () => {
    for (const [name, src] of [
      ["schedule", SCHEDULE],
      ["portal", PORTAL],
    ] as const) {
      expect(src, `${name} imports the dialog`).toContain(
        'from "@/components/confirm-dialog"',
      );
      expect(src, `${name} mounts it`).toMatch(/<ConfirmDialog/);
      expect(src, `${name} is destructive`).toMatch(/tone="danger"/);
      expect(src, `${name} names the in-flight state`).toMatch(/busyLabel="/);
    }
  });

  it("the caller still owns the mutation — pending is passed, not invented", () => {
    // The dialog is presentation. Each caller keeps its own transition and
    // passes `pending` in, which is what locks the dialog against Escape and
    // double-submit.
    expect(SCHEDULE).toMatch(/pending=\{pending\}/);
    expect(PORTAL).toMatch(/pending=\{archivePending\}/);
  });

  it("failure keeps the dialog OPEN and does not render the error twice", () => {
    // On failure each handler sets the error and leaves the dialog open, per
    // the dialog's error contract; the surface's own error paragraph is then
    // suppressed so the message is not shown in two places at once.
    expect(SCHEDULE).toMatch(/error=\{confirming \? error : null\}/);
    expect(SCHEDULE).toMatch(/\{error && !confirming && \(/);
    expect(PORTAL).toMatch(/error=\{archiveTarget \? archiveError : null\}/);
    expect(PORTAL).toMatch(/\{archiveError && !archiveTarget && \(/);
  });

  it("success closes the dialog; failure does not", () => {
    expect(SCHEDULE).toMatch(/if \(r\.ok\) \{\s*setConfirming\(false\);/);
    expect(PORTAL).toMatch(/if \(r\.ok\) \{\s*setArchiveTarget\(null\);/);
  });

  it("the portal card tracks WHICH message, which confirm() carried implicitly", () => {
    // A native confirm knew its target from the call stack. A mounted dialog
    // must be told, and `runArchive` must refuse to fire without one — losing
    // that would archive whatever the last-known id happened to be.
    expect(PORTAL).toMatch(/const \[archiveTarget, setArchiveTarget\]/);
    expect(PORTAL).toMatch(/open=\{archiveTarget !== null\}/);
    expect(PORTAL).toMatch(/if \(!archiveTarget\) return;/);
    expect(PORTAL).toMatch(/fd\.set\("message_id", archiveTarget\)/);
  });

  it("no mutation contract changed — same actions, same FormData fields", () => {
    expect(SCHEDULE).toMatch(/fd\.set\("stage_id", stage\.id\)/);
    expect(SCHEDULE).toMatch(/fd\.set\("plan_id", planId\)/);
    expect(SCHEDULE).toMatch(/fd\.set\("client_id", clientId\)/);
    expect(SCHEDULE).toMatch(/await deleteAction\(fd\)/);
    expect(PORTAL).toMatch(/fd\.set\("client_id", clientId\)/);
    expect(PORTAL).toMatch(/await archiveAction\(fd\)/);
  });

  it("invents no dialog of its own, and adds no dependency", () => {
    // The point is adoption. A second modal implementation here would be the
    // opposite of the slice.
    for (const src of [SCHEDULE, PORTAL]) {
      expect(src).not.toMatch(/role="alertdialog"/);
      expect(src).not.toMatch(/aria-modal/);
    }
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).length).toBe(21);
  });
});
