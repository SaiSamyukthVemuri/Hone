import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-50 / HON-47 guard: every client email in lib/email/send-appointment.ts
// reaches the template through the ONE policy gate for each self-service CTA.
// selfServiceLinksFor decides Cancel/Reschedule, rebookUrlFor decides "book
// another", portalLoginUrlForStudio decides the portal link. A new sender that
// hands a raw URL to a template would link a client into a path the studio
// switched off, and nothing else would notice. Source contract; the behaviour
// of each gate is covered by client-self-service-ctas.test.ts.

const SOURCE = readFileSync("lib/email/send-appointment.ts", "utf8");
// The gates' own definitions are the only place raw values may appear.
const BODY = SOURCE.slice(SOURCE.indexOf("// Typed delivery result"));

function assignments(prop: string): string[] {
  const re = new RegExp(`\\b${prop}:\\s*([^\\n]*)`, "g");
  return [...BODY.matchAll(re)].map((m) => m[1]);
}

describe("client email CTA routing", () => {
  it("every portal link goes through portalLoginUrlForStudio", () => {
    const uses = assignments("portalLoginUrl");
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const u of uses) expect(u).toContain("portalLoginUrlForStudio(");
  });

  it("every 'book another' link goes through rebookUrlFor", () => {
    const uses = assignments("rebookUrl").filter((u) => !/^(string|undefined)/.test(u) && !u.startsWith("string"));
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const u of uses) expect(u).toContain("rebookUrlFor(");
  });

  it("Cancel and Reschedule reach a template only as selfServiceLinksFor output", () => {
    for (const prop of ["cancellationUrl", "rescheduleUrl"]) {
      const uses = assignments(prop).filter((u) => !/^(string|null)/.test(u));
      // type declarations are filtered; what remains are call-site values
      for (const u of uses) {
        const ok = /^links\.(cancellationUrl|rescheduleUrl),?$/.test(u.trim()) || /^`\$\{origin\}\/(cancel|reschedule)\//.test(u.trim());
        expect(ok, `${prop}: ${u}`).toBe(true);
      }
    }
    // The template-facing spreads all name the gate; none passes params/p straight through.
    expect(BODY).not.toMatch(/cancellationUrl:\s*(params|p)\.cancellationUrl/);
    expect(BODY).not.toMatch(/rescheduleUrl:\s*(params|p)\.rescheduleUrl/);
    expect((BODY.match(/\.\.\.selfServiceLinksFor\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
