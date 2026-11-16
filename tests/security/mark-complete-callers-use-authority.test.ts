import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SPELLING-BASED TRIPWIRE (not a proof). Before migration 0277 the application is the ONLY gate on who may complete an
// appointment: every call of rpc("mark_appointment_complete") must be preceded, in the same file, by a call of
// canCompleteAppointment(...). A third caller without the helper must fail this test. It reads the text of app/, lib/ and
// components/; it cannot see a call built from a variable name, an alias, or a string assembled at run time, and a comment
// is stripped before matching. 0277 adds the database half; this stays as the app half.

const ROOT = path.resolve(__dirname, "../..");
const DIRS = ["app", "lib", "components"];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const CALL = /\.rpc\(\s*["']mark_appointment_complete["']/;

// Returns the files that call the RPC without a canCompleteAppointment( call BEFORE the first rpc call.
export function ungatedCallers(files: Array<{ file: string; text: string }>): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const s = strip(f.text);
    const m = CALL.exec(s);
    if (!m) continue;
    const gate = s.indexOf("canCompleteAppointment(");
    if (gate === -1 || gate > m.index) bad.push(f.file);
  }
  return bad.sort();
}

const real = DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((p) => ({ file: path.relative(ROOT, p), text: readFileSync(p, "utf8") }));

describe("every rpc('mark_appointment_complete') call is gated by canCompleteAppointment (spelling-based tripwire)", () => {
  it("no caller in app/, lib/ or components/ is ungated", () => {
    expect(ungatedCallers(real)).toEqual([]);
  });

  it("the known callers are exactly the two server paths (a new caller must be reviewed, not just gated)", () => {
    const callers = real.filter((f) => CALL.test(strip(f.text))).map((f) => f.file).sort();
    expect(callers).toEqual(["app/(app)/calendar/actions.ts", "app/(app)/clients/[id]/sessions/new/actions.ts"]);
  });

  it("NEGATIVE CONTROL: a synthetic third caller without the helper is named; with the helper first it passes; a call only in a comment is ignored", () => {
    const rpc = `await admin.rpc("mark_appointment_complete", { p_appointment_id: id });`;
    expect(ungatedCallers([{ file: "x.ts", text: rpc }])).toEqual(["x.ts"]);
    expect(ungatedCallers([{ file: "y.ts", text: `if (!canCompleteAppointment(a, b)) return;\n${rpc}` }])).toEqual([]);
    expect(ungatedCallers([{ file: "z.ts", text: `${rpc}\nif (canCompleteAppointment(a, b)) {}` }])).toEqual(["z.ts"]);
    expect(ungatedCallers([{ file: "c.ts", text: `// admin.rpc("mark_appointment_complete", {})` }])).toEqual([]);
  });
});

describe("the session page does not state an assignment rule it cannot back (C3)", () => {
  const page = strip(readFileSync(path.join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"), "utf8"));
  it("the 'only the assigned practitioner or the studio owner' sentence is rendered only when apptContext exists; otherwise the neutral line", () => {
    expect(page).toContain("Completion unavailable right now.");
    expect(page).toMatch(/apptContext \? \(\s*<span[^>]*data-testid="completion-not-assigned">\s*Only the assigned practitioner or the studio owner can mark this appointment completed\.\s*<\/span>\s*\) : \(\s*<span[^>]*data-testid="completion-unavailable">\s*Completion unavailable right now\.\s*<\/span>/);
    expect(page.match(/Only the assigned practitioner or the studio owner/g)?.length).toBe(1);
  });
});
