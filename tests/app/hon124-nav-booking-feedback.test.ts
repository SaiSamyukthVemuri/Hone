import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isCurrentSection } from "@/app/(app)/PrimaryNavLink";

// HON-124 PR 1 (mobile navigation + booking feedback). Source contracts for the
// parts a node-environment suite can see; the behaviour itself (focus after
// Escape, one booking row after a double press) is proved in the browser by
// e2e/hon124-nav-booking-mobile.spec.ts.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const APP_MENU = codeOnly(read("app/(app)/MobileMenu.tsx"));
const SITE_MENU = codeOnly(read("app/_components/marketing/MobileNav.tsx"));
const BOOK_FORM = codeOnly(read("app/book/[slug]/PublicBookForm.tsx"));

describe("item 10: the app phone menu", () => {
  it("marks the current destination with the desktop row's own rule", () => {
    expect(APP_MENU).toContain('from "./PrimaryNavLink"');
    expect(APP_MENU).toContain("isCurrentSection(pathname, href, match)");
    // Both link renderers (working surfaces and account actions) carry it.
    expect(APP_MENU.match(/aria-current=\{currentFor\(/g) ?? []).toHaveLength(2);
    // Dashboard is EXACT, or every /dashboard/... page (Capacity) would mark it.
    expect(APP_MENU).toMatch(/href: "\/dashboard", label: "Dashboard", match: "exact"/);
  });

  it("the shared rule: exact vs section, and a prefix sibling is not a section", () => {
    expect(isCurrentSection("/dashboard/capacity", "/dashboard", "exact")).toBe(false);
    expect(isCurrentSection("/dashboard/capacity", "/dashboard/capacity", "section")).toBe(true);
    expect(isCurrentSection("/clients/abc", "/clients", "section")).toBe(true);
    expect(isCurrentSection("/records-archive", "/records", "section")).toBe(false);
  });

  it("Escape returns focus to the trigger before the panel unmounts", () => {
    expect(APP_MENU).toMatch(
      /e\.key === "Escape" && rootRef\.current\?\.contains\(document\.activeElement\)\)\s*\{\s*triggerRef\.current\?\.focus\(\);/,
    );
    // Focus first, THEN the one dismissal rule.
    const focusAt = APP_MENU.indexOf("triggerRef.current?.focus();\n      }\n      if (e.key === \"Escape\") close();");
    expect(focusAt).toBeGreaterThan(-1);
  });

  it("the trigger names the panel it controls", () => {
    expect(APP_MENU).toContain('aria-controls="mobile-navigation-panel"');
    expect(APP_MENU).toContain('id="mobile-navigation-panel"');
  });
});

describe("item 10: the marketing phone menu", () => {
  it("marks the current page and names its nav", () => {
    expect(SITE_MENU).toContain("usePathname()");
    expect(SITE_MENU.match(/aria-current=\{isCurrent\(item\.href\) \? "page" : undefined\}/g) ?? []).toHaveLength(2);
    expect(SITE_MENU).toMatch(/<nav aria-label="Site"/);
  });

  it("its fade stops under reduced motion", () => {
    // Opens on the first frame: the fade exists only in the CLOSED branch.
    expect(SITE_MENU).toContain('${open ? "" : "transition-opacity duration-200 motion-reduce:transition-none"}');
  });
});

describe("items 4 + 19: the public booking submit", () => {
  it("refuses a second submit synchronously, before React re-renders", () => {
    expect(BOOK_FORM).toContain("const submitLockRef = useRef(false);");
    const guard = BOOK_FORM.indexOf("if (submitLockRef.current) return;");
    const take = BOOK_FORM.indexOf("submitLockRef.current = true;");
    const post = BOOK_FORM.indexOf("await publicBookAppointmentAction(fd)");
    expect(guard).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(guard);
    expect(post).toBeGreaterThan(take);
    // Released in finally, so a refused booking can be corrected and resent.
    expect(BOOK_FORM).toMatch(/finally \{\s*submitLockRef\.current = false;\s*\}/);
  });

  it("a taken time clears the stale choice and re-reads the day", () => {
    expect(BOOK_FORM).toMatch(
      /if \(r\.code === "slot_taken"\) \{\s*setPicked\(null\);\s*keepErrorOnRefetchRef\.current = true;\s*setSlotsRetry\(\(n\) => n \+ 1\);\s*\}/,
    );
    // ...and that refetch does not wipe the refusal it was asked for.
    expect(BOOK_FORM).toMatch(
      /if \(keepErrorOnRefetchRef\.current\) keepErrorOnRefetchRef\.current = false;\s*else setError\(null\);/,
    );
  });

  it("the refusal is in a live region that is mounted before it speaks", () => {
    expect(BOOK_FORM).toMatch(/<span role="alert" data-testid="booking-error"[^>]*>\s*\{error \?\? ""\}/);
    expect(BOOK_FORM).not.toMatch(/\{error && \(\s*<span className="text-\[13px\] text-red-600">/);
  });

  it("success is set only after the action answered ok (item 20)", () => {
    const refusal = BOOK_FORM.indexOf("if (!r.ok) {");
    const done = BOOK_FORM.indexOf("setDone({");
    expect(refusal).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(refusal);
    expect(BOOK_FORM.match(/setDone\(/g) ?? []).toHaveLength(1);
  });
});
