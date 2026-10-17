import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// UI-04 — "did this save?" on both consumers of unarchiveClientAction.
//
// Both were raw <button type="submit"> inside a server-component form: no
// in-flight state of any kind, no `active:`, no `focus-visible:`, below the
// 44px floor, each with its own hand-maintained dark: pair. A practitioner
// clicking Unarchive had nothing to tell them Hone had heard the click.
//
// The point of the slice is CONSISTENCY as much as feedback: UI-R02 already
// gave the ARCHIVE half of this pair a PendingButton, the touch floor, press
// and focus. Two halves of one decision should not behave differently, and on
// /clients/[id]/edit they sit on the same page.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const EDIT = code("app/(app)/clients/[id]/edit/page.tsx");
const LIST = code("app/(app)/clients/ArchivedClientsList.tsx");
const ARCHIVE = code("app/(app)/clients/[id]/edit/ArchiveClientControl.tsx");

describe("UI-04: both unarchive controls report their own progress", () => {
  it("each uses PendingButton, and no raw submit survives", () => {
    expect(EDIT).toMatch(/<PendingButton variant="secondary" busyLabel="Unarchiving…">/);
    expect(LIST).toMatch(/<PendingButton variant="primary" size="sm">/);
    expect(EDIT).not.toContain('type="submit"');
    expect(LIST).not.toContain('type="submit"');
  });

  it("only the EDIT control takes a busyLabel — the dense row must not reflow", () => {
    // Not an inconsistency; the two paths through Button differ. With a
    // busyLabel the text is SWAPPED, so "Unarchive" -> "Unarchiving…" would
    // change the control's width and reflow a list row mid-action. Without one,
    // Button holds the label in flow at opacity-0 and overlays the mark, so the
    // box cannot move. aria-busy announces the state on both paths.
    //
    // The edit page is a full-width settings block where a wider control
    // disturbs nothing, so verbal feedback wins there. Treatment follows the
    // density of the surface. The browser proof asserts each guarantee against
    // the control that actually makes it: height-only on the edit page, both
    // axes on the row.
    expect(EDIT).toContain('busyLabel="Unarchiving…"');
    expect(LIST).not.toContain("busyLabel");
  });

  // Scoped to the CONTROL, not the file. The first version of these two
  // assertions searched whole files and failed on unrelated markup: the list
  // file legitimately uses bg-neutral-900 elsewhere, and my region helper
  // sliced from the IMPORT of unarchiveClientAction rather than its <form>, so
  // it swept in surrounding page markup. Both were over-broad assertions, not
  // product defects — a test that fails on code it does not describe is as
  // wrong as one that passes on code it should reject.
  const controlRegion = (src: string) => {
    const i = src.indexOf("<form action={unarchiveClientAction}>");
    if (i < 0) throw new Error("unarchive form not found");
    return src.slice(i, src.indexOf("</form>", i) + 7);
  };

  it("the hand-rolled primary is gone from the list row's control", () => {
    // bg-neutral-900 / hover:bg-neutral-800 + its own dark: pair was a copy of
    // Button variant="primary" — one of the 57 reimplementations Button's
    // docblock counts across 47 files.
    const region = controlRegion(LIST);
    expect(region).not.toContain("bg-neutral-900");
    expect(region).not.toContain("dark:bg-white");
    expect(region).not.toContain("hover:bg-neutral-800");
  });

  it("neither control hand-maintains a dark: pair any more", () => {
    expect(controlRegion(EDIT)).not.toContain("dark:");
    expect(controlRegion(LIST)).not.toContain("dark:");
  });

  it("neither control carries ANY className — the primitive owns the paint", () => {
    // The strongest form of the claim: if a className reappears here, someone
    // has started re-specifying the button's look beside the variant again,
    // which is how the 57 copies accumulated in the first place.
    expect(controlRegion(EDIT)).not.toContain("className");
    expect(controlRegion(LIST)).not.toContain("className");
  });

  it("the PAIR is now consistent: destructive is danger, restorative is not", () => {
    // The distinction is the point. Archiving hides a real client and carries
    // the solid-danger treatment; unarchiving restores one and must not.
    expect(ARCHIVE).toMatch(/<PendingButton variant="danger"/);
    expect(EDIT).not.toMatch(/variant="danger"/);
    expect(LIST).not.toMatch(/variant="danger"/);
  });

  it("the server action and its payload are untouched", () => {
    // This is a presentation slice. The action, the hidden field and the
    // client id it carries are exactly as before.
    expect(EDIT).toMatch(/<form action=\{unarchiveClientAction\}>/);
    expect(LIST).toMatch(/<form action=\{unarchiveClientAction\}>/);
    expect(EDIT).toMatch(/<input type="hidden" name="client_id" value=\{id\} \/>/);
    expect(LIST).toMatch(/<input type="hidden" name="client_id" value=\{client\.id\} \/>/);
  });

  it("both pages stay SERVER components — the island is PendingButton alone", () => {
    // #609: a visual upgrade must not be the reason a clinical page hydrates.
    // PendingButton is the smallest possible client leaf and owns the hook.
    expect(EDIT).not.toMatch(/^\s*["']use client["']/m);
    expect(LIST).not.toMatch(/^\s*["']use client["']/m);
    expect(EDIT).not.toContain("useFormStatus");
    expect(LIST).not.toContain("useFormStatus");
  });

  it("adds no dependency", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).length).toBe(21);
  });
});
