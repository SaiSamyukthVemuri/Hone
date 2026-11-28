import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-109 (client-form Save): the browser behaviour is proved in e2e/client-form-saved-inline.spec.ts. This pins, at the source, the properties a browser
// run localises poorly: "Saved." is set in exactly one place and only for a server ok, the no-double-submit guard, and that only the edit page opts in.
const form = readFileSync("components/client-form.tsx", "utf8");
const edit = readFileSync("app/(app)/clients/[id]/edit/page.tsx", "utf8");
const create = readFileSync("app/(app)/clients/new/page.tsx", "utf8");

describe("the client form's soft save", () => {
  it('sets "Saved." in exactly one place: after runClientSave returned a saved outcome carrying an in-app profile address', () => {
    expect((form.match(/setSaved\(true\)/g) ?? []).length).toBe(1);
    expect(form).toContain("flushSync(() => setSaved(true))");
    const i = form.indexOf("setSaved(true)");
    const before = form.slice(Math.max(0, i - 900), i);
    expect(before).toContain("await runClientSave(action, fd)");
    expect(before).toContain('outcome.kind === "saved"');
    expect(before).toContain("SAVED_REDIRECT.test(outcome.redirectTo)");
  });
  it("navigates inside the same transition, so the button stays pending until the profile is applied", () => {
    const i = form.indexOf("setSaved(true)");
    const next = form.slice(i, i + 300);
    expect(next).toContain("router.push(outcome.redirectTo)");
    expect(form.slice(0, i)).toContain("startTransition(async () => {");
  });
  it("refuses a second submit while one is in flight or after it saved (guard set synchronously)", () => {
    expect(form).toMatch(/if \(inFlight\.current \|\| saved\) return;/);
    expect(form).toMatch(/inFlight\.current = true;\s*\n\s*startTransition/);
  });
  it("only an in-app client profile address is ever navigated to", () => {
    expect(form).toContain("const SAVED_REDIRECT = /^\\/clients\\/[0-9a-f-]{36}$/i;");
  });
  it("only the edit page opts in; the create page keeps its redirect()", () => {
    expect(edit).toMatch(/\bsoftSave\b/);
    expect(create).not.toMatch(/softSave/);
  });
  it("a refusal never shows Saved: the refused branch does not call setSaved", () => {
    const refused = form.slice(form.indexOf('outcome.kind === "refused"'), form.indexOf('outcome.kind === "failed"'));
    expect(refused).not.toContain("setSaved");
  });
});
