import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R-3 (second tripwire, I2-1): getLatestIntakeForClient reads client_intake_forms with the signed-in client, so after 0334 a viewer who holds only
// clin.view_intake_status gets ZERO rows from it and a page would say "no intake". Every caller must therefore stand behind the clin.view_intake gate
// (the answers key) or be the one shared loader that picks the projection for status-only viewers. A NEW caller fails here until it is classified.
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const CALLEES = ["getLatestIntakeForClient", "getLatestSubmittedOrReviewedIntakeForClient"];
// file -> a pattern that must appear BEFORE the first call, proving the clin.view_intake gate
const GATES: Record<string, RegExp> = {
  "lib/intake/viewer-intake.ts": /if \(access\.canViewIntake\)/,
  "app/(app)/clients/[id]/intake/assist/page.tsx": /requirePermission\([^)]*"clin\.view_intake"[^)]*\)\)\.allowed\) notFound\(\)/,
  "app/(app)/clients/[id]/page.tsx": /canViewIntakePromise\.then\(\(ok\) => \(ok \?/,
};

export function callersOf(sources: Array<{ file: string; text: string }>): string[] {
  return sources.filter((s) => CALLEES.some((c) => new RegExp(`\\b${c}\\(`).test(strip(s.text)))).map((s) => s.file).sort();
}
export function ungated(sources: Array<{ file: string; text: string }>): string[] {
  return callersOf(sources).filter((file) => {
    const gate = GATES[file];
    if (!gate) return true;
    const code = strip(sources.find((s) => s.file === file)!.text);
    const call = code.search(new RegExp(`\\b(${CALLEES.join("|")})\\(`));
    const g = code.search(gate);
    return g < 0 || g > call;
  });
}

describe("every reader of the intake ROW stands behind clin.view_intake", () => {
  const sources = ["app", "lib", "components"].flatMap((d) => files(d)).filter((f) => f !== "lib/intake/queries.ts").map((file) => ({ file, text: readFileSync(file, "utf8") }));
  it("the real callers are exactly the classified ones (not vacuous)", () => {
    expect(callersOf(sources)).toEqual(Object.keys(GATES).sort());
  });
  it("each real caller has its gate before the call", () => {
    expect(ungated(sources)).toEqual([]);
  });
  it("fixtures: a new caller, and a caller whose gate comes AFTER the read, are refused", () => {
    expect(callersOf([{ file: "app/new/page.tsx", text: "await getLatestIntakeForClient(s, c);" }])).toEqual(["app/new/page.tsx"]);
    expect(ungated([{ file: "app/new/page.tsx", text: "await getLatestIntakeForClient(s, c);" }])).toEqual(["app/new/page.tsx"]);
    expect(ungated([{ file: "lib/intake/viewer-intake.ts", text: "x = await getLatestIntakeForClient(s,c); if (access.canViewIntake) {}" }])).toEqual(["lib/intake/viewer-intake.ts"]);
    // control: gate first
    expect(ungated([{ file: "lib/intake/viewer-intake.ts", text: "if (access.canViewIntake) { x = await getLatestIntakeForClient(s,c); }" }])).toEqual([]);
    // a mention in a comment is not a call
    expect(callersOf([{ file: "a.ts", text: "// getLatestIntakeForClient(" }])).toEqual([]);
  });
});
