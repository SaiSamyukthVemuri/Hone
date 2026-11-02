import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Insurance N-3: the legal-name form is separate from the client form, so typed-but-unsaved text must not be
// lost silently. Source pins: the component is a client component with hooks.
const src = readFileSync("components/legal-identity-form.tsx", "utf8");

describe("LegalIdentityForm unsaved-change guard", () => {
  it("tracks the stored value and compares every field against it", () => {
    expect(src).toMatch(/const \[saved, setSaved\] = useState\(initial\)/);
    expect(src).toMatch(/values\.given !== saved\.given \|\| values\.middle !== saved\.middle \|\| values\.family !== saved\.family/);
  });
  it("asks the browser to confirm closing or reloading only while dirty, and removes the listener", () => {
    expect(src).toMatch(/if \(!dirty\) return;/);
    expect(src).toMatch(/addEventListener\("beforeunload", warn\)/);
    expect(src).toMatch(/removeEventListener\("beforeunload", warn\)/);
    expect(src).toMatch(/\}, \[dirty\]\)/);
  });
  it("a successful save clears the dirty state; a failed one does not", () => {
    expect(src).toMatch(/if \(result\.ok\) setSaved\(values\)/);
  });
  it("shows a visible notice while dirty and not saving", () => {
    expect(src).toMatch(/\{dirty && !pending && \(\s*<span data-testid="legal-name-unsaved"/);
    expect(src).toMatch(/Unsaved legal name\. Press Save legal name before leaving this page\./);
  });
  it("adds no write: still only the one save action", () => {
    expect((src.match(/saveLegalIdentityAction\(/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(/localStorage|sessionStorage|fetch\(/);
  });
});
