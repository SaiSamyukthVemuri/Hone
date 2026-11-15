import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// HON-58: the owner-only "show receptionists the legal name" switch is HIDDEN until the receptionist
// screen that consumes it exists and has passed Privacy review (Sam's decision, 2 Nov 2026). The 0266
// RPC and table stay in the database untouched; the app must neither render the switch nor call them.

const TEAM = "app/(app)/settings/team";
const PAGE = readFileSync(`${TEAM}/page.tsx`, "utf8");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the legal-name receptionist switch is not in the app", () => {
  it("the Team page renders no switch, section or copy for it", () => {
    expect(PAGE).not.toMatch(/LegalNameAccess/i);
    expect(PAGE).not.toMatch(/legal-name-access/);
    expect(PAGE).not.toMatch(/Client legal names/);
    expect(PAGE).not.toMatch(/studio_legal_name_access/);
  });

  it("the switch component, its action and its read helper are gone", () => {
    expect(existsSync(`${TEAM}/LegalNameAccessSwitch.tsx`)).toBe(false);
    expect(existsSync(`${TEAM}/legal-name-access-actions.ts`)).toBe(false);
    expect(existsSync("lib/clients/legal-name-access.ts")).toBe(false);
  });

  it("no app code calls the 0266 RPC or reads the switch table", () => {
    const offenders = [...sources("app"), ...sources("lib"), ...sources("components")].filter((p) => {
      const t = readFileSync(p, "utf8");
      return /set_receptionist_legal_name_access|\.from\(\s*["']studio_legal_name_access["']/.test(t);
    });
    expect(offenders).toEqual([]);
  });
});
