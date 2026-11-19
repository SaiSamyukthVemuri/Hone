import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

// The charting view is a display preference. It must be read ONLY by the preference modules: never by anything that
// decides who may do what. A new reader has to be added here on purpose, and a reviewer will see it.
const ALLOWED = new Set([
  "lib/charting/view-preference.ts",
  "app/(app)/charting-view-actions.ts",
  "tests/lib/charting/view-preference.test.ts",
  "tests/lib/charting/view-preference-display-only.test.ts",
  "tests/app/charting-view-actions.test.ts",
  "tests/app/sessions/charting-view-page-wiring.test.ts",
  "tests/lib/charting/page-view.test.ts",
  // The xCell registration ROLLOUT gate (Sam's decision) reuses the allowlist parser. It decides what is OFFERED, never who is AUTHORIZED: the
  // owner check stays in the database command. Named here on purpose so a reviewer sees it.
  "lib/machines/xcell-registration-gate.ts",
  "tests/lib/machines/xcell-registration-gate.test.ts",
  "tests/app/machines/machine-setup-actions.test.ts",
]);

// Files that may IMPORT the preference module at all. An authorization, permission, role or policy module is
// deliberately absent; adding one here is a decision a reviewer must see.
const IMPORTERS = new Set([
  "app/(app)/charting-view-actions.ts",
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
  "components/charting-view-context.tsx", // type-only: the view name
  "components/charting-view-shell.tsx",
  "components/use-charting-view-preference.ts",
  "lib/charting/page-view.ts",
  "tests/app/charting-view-actions.test.ts",
  "tests/components/charting-view-preference-hook.test.ts",
  "tests/lib/charting/page-view.test.ts",
  "tests/lib/charting/view-preference-display-only.test.ts",
  "tests/lib/charting/view-preference.test.ts",
]);
// Who may call the READERS. page-view.ts is the one runtime caller.
const READER_USERS = new Set([
  "lib/charting/view-preference.ts",
  "lib/charting/page-view.ts",
  "tests/lib/charting/view-preference.test.ts",
  "tests/lib/charting/view-preference-display-only.test.ts",
  "tests/app/sessions/charting-view-page-wiring.test.ts",
]);

// Tests may name the preference; they cannot authorize anything. These browser specs, Playwright configs and the one config pin are listed by exact path (never
// by directory), so a new file naming the preference still has to be added here on purpose.
const TESTS_MAY_NAME_IT = new Set([
  "e2e/charting-new-view.spec.ts",
  "e2e-payment/charting-new-view-payment.spec.ts",
  "playwright.charting.config.ts",
  "playwright.charting-payment.config.ts",
  "tests/ci/charting-device-config.test.ts",
]);
function namedOutsideTheAllowedFiles(files: string[]): string[] {
  return files.filter((f) => !ALLOWED.has(f) && !TESTS_MAY_NAME_IT.has(f));
}

describe("the charting view preference is display only", () => {
  it("is named in no other source file", () => {
    const out = execFileSync("git", ["grep", "-l", "-E", "charting_view|CHARTING_VIEW_KEY|HONE_CHARTING_NEW_VIEW", "--", "app", "lib", "components", "tests", "middleware.ts", "e2e", "e2e-payment", "playwright.charting.config.ts", "playwright.charting-payment.config.ts"], {
      encoding: "utf8",
    }).trim();
    const files = out.split("\n").filter(Boolean);
    expect(namedOutsideTheAllowedFiles(files)).toEqual([]);
  });
  it("the exemption is narrow: an app, lib or component file naming the preference still fails, and so does any other test file", () => {
    expect(namedOutsideTheAllowedFiles(["lib/billing/permissions.ts", "app/(app)/settings/page.tsx", "components/anything.tsx", "tests/lib/other.test.ts", "e2e/another.spec.ts"])).toEqual([
      "lib/billing/permissions.ts",
      "app/(app)/settings/page.tsx",
      "components/anything.tsx",
      "tests/lib/other.test.ts",
      "e2e/another.spec.ts",
    ]);
    expect(namedOutsideTheAllowedFiles([...TESTS_MAY_NAME_IT])).toEqual([]);
  });
  it("is imported only by the files that display or remember it, never by an authorization or permission module", () => {
    const out = execFileSync(
      "git",
      ["grep", "-l", "-E", "lib/charting/view-preference", "--", "app", "lib", "components", "tests", "middleware.ts"],
      { encoding: "utf8" },
    ).trim();
    const files = out.split("\n").filter(Boolean);
    expect(files.filter((f) => !IMPORTERS.has(f))).toEqual([]);
  });
  it("the page decision itself is imported only by the charting page (never by an authorization or permission module)", () => {
    const out = execFileSync("git", ["grep", "-l", "-E", "chartingViewForPage|lib/charting/page-view", "--", "app", "lib", "components", "tests", "middleware.ts"], { encoding: "utf8" }).trim();
    const allowed = new Set([
      "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
      "lib/charting/page-view.ts",
      "tests/lib/charting/page-view.test.ts",
      "tests/lib/charting/view-preference-display-only.test.ts",
      "tests/app/sessions/charting-view-page-wiring.test.ts",
    ]);
    expect(out.split("\n").filter(Boolean).filter((f) => !allowed.has(f))).toEqual([]);
  });
  it("its readers are called by nothing but the one page decision", () => {
    const out = execFileSync(
      "git",
      ["grep", "-l", "-E", "chartingViewFromMetadata|resolveChartingView|readChartingView", "--", "app", "lib", "components", "tests", "middleware.ts"],
      { encoding: "utf8" },
    ).trim();
    const files = out.split("\n").filter(Boolean);
    expect(files.filter((f) => !READER_USERS.has(f))).toEqual([]);
  });
  it("stores a closed value and no free text", async () => {
    const mod = await import("@/lib/charting/view-preference");
    expect([...mod.CHARTING_VIEWS]).toEqual(["current", "new"]);
  });
});
