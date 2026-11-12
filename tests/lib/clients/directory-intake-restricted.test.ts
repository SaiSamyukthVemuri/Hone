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
