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

/** Remove every selfServiceLinksFor( ... ) call, balanced: its argument object is the ONLY place raw URLs may be built. */
function withoutGateCalls(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const at = source.indexOf("selfServiceLinksFor(", i);
    if (at === -1) { out += source.slice(i); break; }
    out += source.slice(i, at);
    let depth = 0; let j = at + "selfServiceLinksFor".length;
    do { const c = source[j++]; if (c === "(") depth++; else if (c === ")") depth--; } while (depth > 0 && j < source.length);
    out += "selfServiceLinksFor(GATED)";
    i = j;
  }
  return out;
}

function assignments(source: string, prop: string): string[] {
  const re = new RegExp(`\\b${prop}:\\s*([^\\n]*)`, "g");
  return [...source.matchAll(re)].map((m) => m[1]);
}

/** Every way a template argument can reach a client CTA other than through its gate. */
export function ctaGateViolations(source: string): string[] {
  const out: string[] = [];
  const outside = withoutGateCalls(source);
  for (const u of assignments(source, "portalLoginUrl")) if (!u.includes("portalLoginUrlForStudio(")) out.push(`portalLoginUrl: ${u}`);
  for (const u of assignments(source, "rebookUrl")) {
    if (/^(string|undefined)/.test(u)) continue; // type declarations
    if (!u.includes("rebookUrlFor(")) out.push(`rebookUrl: ${u}`);
  }
  // Outside a gate call, a Cancel/Reschedule value may only be the gate's own output.
  for (const prop of ["cancellationUrl", "rescheduleUrl"]) {
    for (const u of assignments(outside, prop)) {
      if (/^(string|null)/.test(u)) continue; // type declarations
      if (!/^links\.(cancellationUrl|rescheduleUrl),?$/.test(u.trim())) out.push(`${prop}: ${u}`);
    }
  }
  if (/\/(cancel|reschedule)\/\$\{|\/(cancel|reschedule)\/`/.test(outside)) out.push("raw cancel/reschedule path outside a gate call");
  return out;
}

describe("client email CTA routing", () => {
  it("the real source has no ungated CTA", () => {
    expect(ctaGateViolations(BODY)).toEqual([]);
    expect(assignments(BODY, "portalLoginUrl").length).toBeGreaterThanOrEqual(4);
    expect((BODY.match(/\.\.\.selfServiceLinksFor\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  // Negative controls: the guard must see each bypass, including the one that
  // overrides the policy-filtered values AFTER the spread (Codex P2 on #1238).
  const mutate = (from: string, to: string) => { expect(BODY).toContain(from); return BODY.replace(from, to); };
  it("catches raw Cancel/Reschedule URLs placed after the spread (override)", () => {
    const spread = "...selfServiceLinksFor(p.studio, p),";
    const mutated = mutate(spread, `${spread}\n    cancellationUrl: \`\${origin}/cancel/\${token}\`,\n    rescheduleUrl: \`\${origin}/reschedule/\${token}\`,`);
    expect(ctaGateViolations(mutated).join("\n")).toMatch(/cancellationUrl/);
    expect(ctaGateViolations(mutated).join("\n")).toMatch(/rescheduleUrl/);
  });
  it("catches a template argument passed straight through", () => {
    expect(ctaGateViolations(mutate("...selfServiceLinksFor(p.studio, p),", "cancellationUrl: p.cancellationUrl,")).length).toBeGreaterThan(0);
  });
  it("catches an ungated portal link and an ungated rebook link", () => {
    expect(ctaGateViolations(mutate("portalLoginUrl: portalLoginUrlForStudio(p.studio),", "portalLoginUrl: `${origin}/portal/login`,")).join()).toMatch(/portalLoginUrl/);
    expect(ctaGateViolations(mutate("rebookUrl: rebookUrlFor(params.studio, params.rebookUrl),", "rebookUrl: params.rebookUrl,")).join()).toMatch(/rebookUrl/);
  });
  // Codex P2 (4407749090): the raw-URL exception is the gate call's OWN argument
  // object, nothing broader. Raw URLs handed straight to the template, to any
  // other call, or in place of the spread must all be seen.
  it("catches raw URLs passed directly to the template in place of the gate", () => {
    const raw = "cancellationUrl: `${origin}/cancel/${token}`,\n    rescheduleUrl: `${origin}/reschedule/${token}`,";
    const v = ctaGateViolations(mutate("...selfServiceLinksFor(p.studio, p),", raw)).join("\n");
    expect(v).toMatch(/cancellationUrl/);
    expect(v).toMatch(/rescheduleUrl/);
  });
  it("catches a raw cancel path inside some OTHER call's argument", () => {
    const mutated = mutate("...selfServiceLinksFor(p.studio, p),", "...selfServiceLinksFor(p.studio, p),\n    extra: String(`${origin}/reschedule/${token}`),");
    expect(ctaGateViolations(mutated).join("\n")).toMatch(/raw cancel\/reschedule path/);
  });
  it("still allows raw URLs inside the gate call's own argument", () => {
    expect(ctaGateViolations(BODY)).toEqual([]);
  });
});
