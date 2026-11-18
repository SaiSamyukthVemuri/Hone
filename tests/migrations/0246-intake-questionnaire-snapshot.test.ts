import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("0246 prospective-only snapshot boundary", () => {
  it("uses row-catalogue step limits on save, submit and assisted handoff", () => {
    const client = readFileSync("app/intake/[token]/actions.ts", "utf8");
    const assisted = readFileSync("app/(app)/clients/[id]/intake/actions.ts", "utf8");
    expect(client).toContain("catalogue.steps.some(s => s.id === step)");
    expect(client).toContain('step: catalogue.steps[catalogue.steps.length - 1].id, operation: "submit"');
    expect(assisted).toContain("const lastStep = loaded.catalogue.steps[loaded.catalogue.steps.length - 1].id");
    expect(assisted).toContain('step: lastStep, operation: "handoff"');
  });
  it("both trusted creators explicitly issue NULL until reader rollout; export remains pending", () => {
    const creators = readFileSync("lib/intake/queries.ts", "utf8");
    expect([...creators.matchAll(/questionnaire_snapshot:\s*null/g)]).toHaveLength(2);
    expect(creators).not.toContain("ISSUED_QUESTIONNAIRE");
    const ensure = creators.slice(creators.indexOf("export async function ensureIntakeForClient("),
      creators.indexOf("export async function createIntakeRequestForClient("));
    const reissue = creators.slice(creators.indexOf("export async function createIntakeRequestForClient("),
      creators.indexOf("export async function getIntakeHistoryForClient("));
    for (const body of [ensure, reissue]) {
      expect(body).toMatch(/\.insert\(\{[\s\S]*?questionnaire_snapshot:\s*null,/);
    }
    const registry = readFileSync("lib/export/resource-registry.ts", "utf8");
    expect(registry).toMatch(/client_intake_forms:\s*\{\s*kind: "pending",\s*ticket: "TRUTH-01B"/);
  });
});
