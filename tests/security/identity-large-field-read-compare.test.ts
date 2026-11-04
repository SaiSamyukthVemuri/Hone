import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Privacy R1 (#1328), closed by 0281: a long field has no URL condition, so the compare happens INSIDE the database in one
// statement (update_client_profile_if_unchanged). The action must not read-then-write and must not build a conditional
// UPDATE chain any more. Source pin.
const src = readFileSync(join(process.cwd(), "app/(app)/clients/[id]/actions.ts"), "utf8");
const fn = src.slice(src.indexOf("export async function updateClientAction"), src.indexOf("export async function archiveClientAction"));

describe("updateClientAction saves through the atomic database function", () => {
  it("sends the patch and the loaded values to update_client_profile_if_unchanged in one call", () => {
    expect(fn).toContain('supabase.rpc("update_client_profile_if_unchanged"');
    expect(fn).toContain("p_expected: expected");
    expect(fn).toContain("for (const { key, value } of plan.conditions) expected[key] = value");
  });
  it("no longer reads long fields before the write and no longer builds a URL-conditioned UPDATE", () => {
    expect(fn).not.toContain("splitConditions");
    expect(fn).not.toContain("unconditioned");
    expect(fn).not.toMatch(/\.from\("clients"\)\s*\.update\(/);
  });
  it("a NULL answer is read back for the conflict review, never reported as success", () => {
    expect(fn).toContain("if (!changedId) {");
    expect(fn.indexOf("if (!changedId) {")).toBeLessThan(fn.lastIndexOf("redirect(`/clients/${clientId}`)"));
  });
});
