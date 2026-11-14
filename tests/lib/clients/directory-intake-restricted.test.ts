import { readFileSync } from "node:fs";
import ts from "typescript";
import { intakeReadAllowed } from "@/lib/clients/intake-read-gate";
import { describe, expect, it } from "vitest";
import { buildDirectoryRows, parseDirectoryParams, queryDirectory, type DirectoryAggregates } from "@/lib/clients/directory-query";
import { projectStaffRow } from "@/lib/clients/directory-rules";

// F-I5-1 (Team review of #1429): readCurrentIntake was ungated. A viewer without clin.view_intake_status / clin.view_intake must see the directory's
// intake column and intake filter as RESTRICTED, never "Not submitted" and never an empty "nothing needs review" (the #1341 P2 class).
const row = (id: string) => projectStaffRow({ id, name: `C ${id}`, preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null });
const rows = [row("1"), row("2")];
const P = (over: Partial<ReturnType<typeof parseDirectoryParams>> = {}) => ({ ...parseDirectoryParams({}), ...over });
const restricted: DirectoryAggregates = { nextAppointments: new Map(), intake: null, intakeRestricted: true };
const keyed: DirectoryAggregates = { nextAppointments: new Map(), intake: new Map([["1", "submitted"]]) };
const unavailable: DirectoryAggregates = { nextAppointments: new Map(), intake: null };

describe("directory intake: restricted is its own state", () => {
  it("every row is restricted, not not_submitted and not unavailable", () => {
    expect(buildDirectoryRows(rows, restricted).map((r) => r.intake)).toEqual(["restricted", "restricted"]);
    expect(queryDirectory(rows, restricted, P()).intakeRestricted).toBe(true);
    expect(queryDirectory(rows, restricted, P()).intakeUnavailable).toBe(false);
  });
  it("the intake_review filter returns no rows and is flagged restricted, not blocked as a failed read", () => {
    const page = queryDirectory(rows, restricted, P({ filters: ["intake_review"] }));
    expect(page.rows).toEqual([]);
    expect(page.intakeRestricted).toBe(true);
    expect(page.blockedFilters).toEqual([]);
  });
  it("controls: a keyed viewer sees real states; a failed read stays unavailable", () => {
    expect(buildDirectoryRows(rows, keyed).map((r) => r.intake)).toEqual(["awaiting_review", "not_submitted"]);
    expect(queryDirectory(rows, keyed, P({ filters: ["intake_review"] })).rows.map((r) => r.id)).toEqual(["1"]);
    expect(buildDirectoryRows(rows, unavailable).map((r) => r.intake)).toEqual(["unavailable", "unavailable"]);
  });
});

describe("intakeReadAllowed truth table (R-1)", () => {
  const f = (isOwner: boolean, statusAllowed: boolean, answersAllowed: boolean) => intakeReadAllowed({ isOwner, statusAllowed, answersAllowed });
  it("owner → true; status only → true; answers only → true; neither → false", () => {
    expect(f(true, false, false)).toBe(true);
    expect(f(false, true, false)).toBe(true);
    expect(f(false, false, true)).toBe(true);
    expect(f(false, false, false)).toBe(false);
  });
});

// Resolve the REAL calls from the page AST (comments cannot match): which keys are asked, and what feeds the owner argument.
function pageFacts() {
  const text = readFileSync("app/(app)/clients/page.tsx", "utf8");
  const sf = ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const keys: string[] = [];
  const gateCalls: ts.CallExpression[] = [];
  const readCalls: ts.CallExpression[] = [];
  let isOwnerInit = "";
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === "requirePermission" && n.arguments[2] && ts.isStringLiteralLike(n.arguments[2])) keys.push(n.arguments[2].text);
      if (n.expression.text === "intakeReadAllowed") gateCalls.push(n);
      if (n.expression.text === "readCurrentIntake") readCalls.push(n);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "isOwner" && n.initializer) isOwnerInit = n.initializer.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sf, keys, gateCalls, readCalls, isOwnerInit };
}

describe("the directory page reads intake only behind the gate (AST, comments ignored)", () => {
  it("asks exactly clin.view_intake_status and clin.view_intake (MF: a swapped key fails)", () => {
    const { keys } = pageFacts();
    expect(keys.filter((k) => k.startsWith("clin.view_intake")).sort()).toEqual(["clin.view_intake", "clin.view_intake_status"]);
    expect(keys).not.toContain("clin.view_aftercare");
  });
  it("the owner argument is derived from the practitioner role (MD: an owner shortcut that is always true fails)", () => {
    const { isOwnerInit, gateCalls } = pageFacts();
    expect(isOwnerInit.replace(/\s+/g, " ")).toBe('practitioner.role === "owner"');
    for (const c of gateCalls) expect(c.arguments[0].getText()).toMatch(/isOwner/);
    // the owner branch must not pass true for the key results
    expect(gateCalls.some((c) => /statusAllowed:\s*status\.allowed/.test(c.getText()) && /answersAllowed:\s*answers\.allowed/.test(c.getText()))).toBe(true);
  });
  it("MJ: intakeRestricted derives from intakeAllowed (a constant false would show Unavailable instead of the restricted copy)", () => {
    const { sf } = pageFacts();
    let init = "";
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "intakeRestricted" && n.initializer) init = n.initializer.getText(sf);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(init.replace(/\s+/g, " ")).toMatch(/!intakeAllowed/);
  });
  it("both readCurrentIntake calls sit inside a branch that waits on the gate result (MC: allow → true is caught by the truth table above)", () => {
    const { readCalls, sf } = pageFacts();
    expect(readCalls.length).toBe(2);
    for (const c of readCalls) {
      let guarded = false;
      for (let a: ts.Node | undefined = c.parent; a && !ts.isSourceFile(a); a = a.parent) {
        const cond = ts.isConditionalExpression(a) ? a.condition.getText(sf) : ts.isArrowFunction(a) ? a.parameters.map((p) => p.getText(sf)).join() : "";
        if (/\bok\b|intakeAllowed/.test(cond) && (ts.isConditionalExpression(a) || /\bok\b/.test(cond))) { guarded = true; break; }
      }
      expect(guarded, c.getText(sf)).toBe(true);
    }
  });
  it("the view says so", () => {
    const ui = readFileSync("app/(app)/clients/ClientsDirectory.tsx", "utf8");
    expect(ui).toContain('restricted: "Not available to your role"');
    expect(ui).toContain("directory-intake-filter-restricted");
  });
});

// R-3 (Team, recorded on I2 / 0334): once client_intake_forms has a clin.view_intake SELECT policy, a member holding ONLY clin.view_intake_status reads
// zero rows there, and the directory would say "Not submitted". In the SAME change as that migration readCurrentIntake must read the definer enum projection.
// This is a tripwire that arms itself: it passes while no such policy exists, and fails the moment one does without the reader switching.
import { readdirSync } from "node:fs";
export function intakePolicyRequiresViewIntake(files: Array<{ name: string; text: string }>): string[] {
  const BENIGN = new Set(["is_studio_member", "session_is_visible", "auth.uid", "current_setting", "coalesce", "exists", "in", "any", "select", "lower", "now"]);
  return files
    .filter((f) => {
      const text = f.text.replace(/--[^\n]*/g, "");
      const mentionsKey = /clin\.view_intake\b/.test(text);
      // every create/alter policy statement that targets client_intake_forms
      for (const stmt of text.split(";")) {
        if (!/\b(create|alter)\s+policy\b[\s\S]*\bon\s+(public\.)?client_intake_forms\b/i.test(stmt)) continue;
        if (/has_studio_permission|clin\.view_intake|clin_view_intake/i.test(stmt)) return true;
        // a helper that checks the key: any function call other than the membership-only ones, in a file that names the key
        const calls = [...stmt.matchAll(/([a-z_][\w.]*)\s*\(/gi)].map((m) => m[1].replace(/^public\./, "").toLowerCase());
        if (mentionsKey && calls.some((c) => !BENIGN.has(c) && !/^(create|alter)$/.test(c) && c !== "policy")) return true;
      }
      return false;
    })
    .map((f) => f.name);
}
describe("R-3: the directory reader follows the I2 policy", () => {
  const migrations = readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql")).map((name) => ({ name, text: readFileSync(`supabase/migrations/${name}`, "utf8") }));
  const reader = readFileSync("lib/clients/directory-read.ts", "utf8");
  it("detector fixtures: a clin.view_intake SELECT policy on client_intake_forms is recognised; an unrelated one is not", () => {
    const yes = `create policy cif_select on public.client_intake_forms for select to authenticated using (public.has_studio_permission(studio_id, 'clin.view_intake'));`;
    expect(intakePolicyRequiresViewIntake([{ name: "x.sql", text: yes }])).toEqual(["x.sql"]);
    expect(intakePolicyRequiresViewIntake([{ name: "y.sql", text: `create policy p on public.sessions for select using (true);` }])).toEqual([]);
    // R-3 hardening: alter policy, and a policy that calls a helper which checks the key
    const alter = `alter policy cif_select on public.client_intake_forms using (public.has_studio_permission(studio_id, 'clin.view_intake'));`;
    expect(intakePolicyRequiresViewIntake([{ name: "a.sql", text: alter }])).toEqual(["a.sql"]);
    const helper = `-- clin.view_intake\ncreate function public.can_read_intake(s uuid) returns boolean language sql as $$ select public.has_studio_permission(s,'clin.view_intake') $$;\ncreate policy cif_select on public.client_intake_forms for select to authenticated using (public.can_read_intake(studio_id));`;
    expect(intakePolicyRequiresViewIntake([{ name: "h.sql", text: helper }])).toEqual(["h.sql"]);
    // controls: a membership-only policy on the same table, and a comment that merely names the key, do not arm it
    const member = `create policy cif_select on public.client_intake_forms for select to authenticated using (public.is_studio_member(studio_id));`;
    expect(intakePolicyRequiresViewIntake([{ name: "m.sql", text: member }])).toEqual([]);
    expect(intakePolicyRequiresViewIntake([{ name: "c.sql", text: "-- clin.view_intake later\n" + member }])).toEqual([]);
  });
  it("while such a policy exists, readCurrentIntake does not read client_intake_forms directly (it uses the enum projection)", () => {
    const armed = intakePolicyRequiresViewIntake(migrations);
    if (armed.length === 0) return; // not yet: I2 has not landed
    const body = reader.slice(reader.indexOf("export async function readCurrentIntake"));
    expect(body, `I2 policy present in ${armed.join(", ")}: switch readCurrentIntake to the clin.view_intake_status projection`).not.toMatch(/\.from\("client_intake_forms"\)/);
  });
});
