import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OBSERVED_KEY_CONTEXT } from "@/lib/permissions/observe-permission";
import { NOT_STAFF_CLASSES, censusPaths, censusRpcs, decisionOf, notStaffClass, type PathEntry } from "./permission-census";
import { DYNAMIC_RPC_FILES, FINDINGS, PATH_DECISIONS, RPC_NAMES } from "./permission-coverage.registry";

// Every path that can write or release protected data has an explicit decision, and each decision equals what the
// code does. See permission-coverage.registry.ts for how to read it and what it does not claim. The census parses
// the real tree (about 4 seconds), so it is computed once and given a generous timeout.

const ROOT = process.cwd();
let entries: PathEntry[] = [];
let rpcs: Array<{ name: string; file: string }> = [];
beforeAll(() => {
  entries = censusPaths(ROOT);
  rpcs = censusRpcs(ROOT);
}, 120_000);

const registered = (): Map<string, string> => {
  const m = new Map<string, string>();
  for (const [file, byName] of Object.entries(PATH_DECISIONS)) for (const [name, d] of Object.entries(byName)) m.set(`${file}#${name}`, d);
  return m;
};

describe("the census finds the real tree (it is not vacuous)", () => {
  it("sees the known counts and entries", () => {
    expect(entries.filter((e) => e.kind === "action").length).toBeGreaterThanOrEqual(250);
    expect(entries.filter((e) => e.kind === "route").length).toBeGreaterThanOrEqual(20);
    const ids = new Set(entries.map((e) => e.id));
    for (const known of [
      "app/(app)/calendar/actions.ts#bookAppointmentForClientAction",
      "app/(app)/calendar/move-appointment-actions.ts#moveAppointmentAction",
      "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts#refundPaymentChargeAttemptAction",
      "app/(app)/settings/team/actions.ts#invitePractitionerAction",
      "app/api/cron/no-show-check/route.ts#GET",
      "app/api/stripe/webhook/route.ts#POST",
      "app/(app)/financials/statements/[clientId]/export.csv/route.ts#GET",
      "app/api/clients/[clientId]/images/[imageId]/signed-url/route.ts#GET",
    ]) expect(ids.has(known), known).toBe(true);
  });

  it("sees the known gates on known entries", () => {
    const d = (id: string) => decisionOf(entries.find((e) => e.id === id)!);
    expect(d("app/(app)/calendar/actions.ts#bookAppointmentForClientAction")).toContain("observed(appt.book)");
    expect(d("app/(app)/calendar/move-appointment-actions.ts#moveAppointmentAction")).toContain("observed(appt.move,appt.reassign)");
    expect(d("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts#refundPaymentChargeAttemptAction")).toMatch(/^owner\(/);
    expect(d("app/(app)/settings/team/actions.ts#invitePractitionerAction")).toBe("owner(assertOwner)");
    expect(d("app/(app)/financials/statements/[clientId]/export.csv/route.ts#GET")).toMatch(/^owner\(/);
    expect(d("app/api/cron/no-show-check/route.ts#GET")).toMatch(/^not_staff\(cron\)/);
    expect(d("app/api/stripe/webhook/route.ts#POST")).toMatch(/^not_staff\(webhook\)/);
    expect(d("app/api/clients/[clientId]/images/[imageId]/signed-url/route.ts#GET")).toBe("staff");
  });

  it("finds database commands, including a literal-only set and the files with a computed name", () => {
    expect(new Set(rpcs.map((r) => r.name)).size).toBeGreaterThanOrEqual(150);
    expect(rpcs.some((r) => r.name === "update_own_practitioner_profile")).toBe(true);
  });
});

describe("every path has an explicit decision, and it equals what the code does", () => {
  it("has no undecided path", () => {
    const reg = registered();
    expect(entries.map((e) => e.id).filter((id) => !reg.has(id)).sort(), "add each to permission-coverage.registry.ts with the gate it really has").toEqual([]);
  });

  it("has no stale decision", () => {
    const live = new Set(entries.map((e) => e.id));
    expect([...registered().keys()].filter((id) => !live.has(id)).sort(), "remove the entry, the path is gone").toEqual([]);
  });

  it("matches the gate each entry has today", () => {
    const reg = registered();
    const drift = entries.filter((e) => reg.has(e.id) && reg.get(e.id) !== decisionOf(e)).map((e) => `${e.id}: recorded ${reg.get(e.id)}, code now ${decisionOf(e)}`);
    expect(drift, "a gate changed. If that is intended, record the new decision and say why in the PR").toEqual([]);
  });

  it("leaves nothing unresolved", () => {
    expect([...registered().entries()].filter(([, d]) => d.startsWith("unresolved")).map(([id]) => id)).toEqual([]);
  });

  it("uses only known classes for by-design non-staff paths, each matching its path", () => {
    for (const e of entries) {
      const d = registered().get(e.id) ?? "";
      const m = /^not_staff\(([a-z_]+)\)/.exec(d);
      if (!m) continue;
      expect(NOT_STAFF_CLASSES[m[1]], `${e.id}: unknown class ${m[1]}`).toBeDefined();
      expect(notStaffClass(e.file), e.id).toBe(m[1]);
    }
  });

  it("names, for an observed entry, only keys the observer can ask", () => {
    for (const [id, d] of registered()) {
      const m = /^observed\(([^)]*)\)/.exec(d);
      if (!m) continue;
      for (const key of m[1].split(",")) expect(Object.keys(OBSERVED_KEY_CONTEXT), `${id}: ${key}`).toContain(key);
    }
  });
});

describe("database commands the app calls by name", () => {
  it("lists every one, and none that is gone", () => {
    const live = [...new Set(rpcs.filter((r) => r.name !== "<dynamic>").map((r) => r.name))].sort();
    expect(live.filter((n) => !RPC_NAMES.includes(n)), "add each new command to RPC_NAMES").toEqual([]);
    expect(RPC_NAMES.filter((n) => !live.includes(n)), "remove a command the app no longer calls").toEqual([]);
  });

  it("knows every call site whose command name is computed", () => {
    const live = [...new Set(rpcs.filter((r) => r.name === "<dynamic>").map((r) => r.file))].sort();
    expect(live).toEqual([...DYNAMIC_RPC_FILES].sort());
  });
});

describe("the findings name entries that exist", () => {
  it("every entry a finding cites is in the registry", () => {
    const reg = registered();
    for (const f of FINDINGS) for (const id of f.entries) expect(reg.has(id), `${f.id}: ${id}`).toBe(true);
    expect(FINDINGS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a receptionist cannot pass the staff helper (what 'staff' rests on)", () => {
  it("resolves identity from practitioner rows only, and no app code reads receptionist rows", () => {
    const q = readFileSync(join(ROOT, "lib/supabase/queries.ts"), "utf8");
    expect(q).toMatch(/async function loadActiveMembershipRows[\s\S]{0,400}\.from\("practitioners"\)/);
    expect(q).not.toContain("studio_receptionists");
    // The only app or lib file that names the receptionist table is the export registry. When the receptionist desk
    // lands this must change on purpose: the 'staff' decisions above stop meaning "no receptionist".
    const out = execSync(`grep -rl "studio_receptionists" app lib components --include=*.ts --include=*.tsx || true`, { cwd: ROOT }).toString().trim().split("\n").filter(Boolean);
    // The front desk (lib/desk) reads the caller's OWN receptionist rows, on purpose and only there (its guard and its entry); it is the receptionist
    // surface, not a staff path, so it does not weaken what "staff" means. A new file naming the table must be added here deliberately.
    // The owner's Team settings also name the table, on purpose: the page LISTS the studio's own front-desk rows and the invite action checks for a
    // duplicate, both under the OWNER's session and the owner-only read policy (a receptionist reads only their own row). Neither feeds the staff helper,
    // so a receptionist still cannot pass it. This is a reviewed extension of the invariant, not a loosening of the helper checks above.
    expect([...out].sort()).toEqual([
      "app/(app)/settings/team/actions.ts",
      "app/(app)/settings/team/page.tsx",
      "lib/desk/entry.ts",
      "lib/desk/guard.ts",
      "lib/export/resource-registry.ts",
    ]);
    // Both Team files read the table on the user-session client, never the admin client: the page file has no admin client at all, and in the action
    // file every read of the table hangs off `supabase` (the user-session client), none off an admin client.
    const team = (f: string) => readFileSync(join(ROOT, f), "utf8");
    expect(team("app/(app)/settings/team/page.tsx")).not.toContain("createAdminClient");
    const actions = team("app/(app)/settings/team/actions.ts");
    expect(actions.match(/\.from\("studio_receptionists"\)/g)?.length ?? 0).toBeGreaterThan(0);
    expect(actions).not.toMatch(/\badmin\w*\s*\.from\("studio_receptionists"\)/);
    expect(actions).toMatch(/await supabase\s*\.from\("studio_receptionists"\)/);
  });
});

describe("the `desk` not-staff class names ONE file, so a new desk action is undecided until someone decides it", () => {
  it("matches the reviewed desk action and nothing else under lib/desk", () => {
    expect(notStaffClass("lib/desk/choose-actions.ts")).toBe("desk");
    for (const f of ["lib/desk/other-actions.ts", "lib/desk/guard.ts", "lib/desk/choose-actions.ts.bak", "lib/desk/sub/choose-actions.ts", "lib/deskx/choose-actions.ts"]) {
      expect(notStaffClass(f), f).toBeNull();
    }
  });

  it("NEGATIVE CONTROL: a new server action under lib/desk is reported as unresolved, never as a decided desk path", () => {
    const dir = mkdtempSync(join(tmpdir(), "permission-census-desk-"));
    try {
      for (const f of ["choose-actions.ts", "new-actions.ts"]) {
        mkdirSync(join(dir, "lib/desk"), { recursive: true });
        writeFileSync(join(dir, "lib/desk", f), `"use server";\nexport async function act() { return 1; }\n`);
      }
      const found = new Map(censusPaths(dir).map((e) => [e.id, decisionOf(e)]));
      expect(found.get("lib/desk/choose-actions.ts#act")).toBe("not_staff(desk)");
      expect(found.get("lib/desk/new-actions.ts#act")).toMatch(/^unresolved/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------------------------------------------
// The census itself, on fixtures: it must claim a gate only where there is one.
// --------------------------------------------------------------------------------------------------------------
describe("the census claims only what is there (fixtures)", () => {
  const dir = mkdtempSync(join(tmpdir(), "permission-census-"));
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  let byName: Map<string, PathEntry>;
  beforeAll(() => {
    put("lib/supabase/queries.ts", `export async function getCurrentPractitionerWithStudio() { return { practitioner: { role: "x" }, studio: {} }; }\n`);
    put("lib/desk/guard.ts", `export async function requireReceptionistWithStudio() { return {}; }`);
    put("app/(desk)/desk/actions.ts", [
      `"use server";`,
      `import { requireReceptionistWithStudio } from "@/lib/desk/guard";`,
      `export async function deskGuarded() { const actor = await requireReceptionistWithStudio(); return actor; }`,
      `export async function deskNotAwaited() { requireReceptionistWithStudio(); return 1; }`,
      `export async function deskConditional(flag: boolean) { if (flag) await requireReceptionistWithStudio(); return 1; }`,
    ].join("\n"));
    put("lib/helpers.ts", [
      `import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";`,
      `export async function assertOwner() { const { practitioner } = await getCurrentPractitionerWithStudio(); if (practitioner.role !== "owner") { throw new Error("no"); } return practitioner; }`,
      `export async function ownerOrNull() { const { practitioner } = await getCurrentPractitionerWithStudio(); if (practitioner.role !== "owner") { return null; } return practitioner; }`,
    ].join("\n"));
    put("app/(app)/x/actions.ts", [
      `"use server";`,
      `import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";`,
      `import { assertOwner, ownerOrNull } from "@/lib/helpers";`,
      `export async function ownGuard() { const { practitioner } = await getCurrentPractitionerWithStudio(); if (practitioner.role !== "owner") return { ok: false }; return { ok: true }; }`,
      `export async function viaThrowingHelper() { await assertOwner(); return 1; }`,
      `export async function viaReturningHelper() { const o = await ownerOrNull(); return o; }`,
      `export async function viaTryReturning() { try { await assertOwner(); } catch { return { ok: false }; } return 1; }`,
      `export async function viaTryContinuing() { let f = 0; try { await assertOwner(); } catch { f = 1; } return f; }`,
      `export async function nestedOnly(flag: boolean) { const { practitioner } = await getCurrentPractitionerWithStudio(); if (flag) { if (practitioner.role !== "owner") return 0; } return 1; }`,
      `export async function andNotOr(flag: boolean) { const { practitioner } = await getCurrentPractitionerWithStudio(); if (flag && practitioner.role !== "owner") return 0; return 1; }`,
      `export async function orGuard(flag: boolean) { const { practitioner } = await getCurrentPractitionerWithStudio(); if (flag || practitioner.role !== "owner") return 0; return 1; }`,
      `export async function ownerBranchOnly() { const { practitioner } = await getCurrentPractitionerWithStudio(); if (practitioner.role === "owner") { return 2; } return 1; }`,
      `export async function noGate() { return 1; }`,
      `const local = async () => 1;`,
      `export { local as renamedAction };`,
      `export const arrowAction = async () => { return 1; };`,
      `export type NotAnAction = { a: 1 };`,
      `export const NOT_A_FUNCTION = 5;`,
    ].join("\n"));
    put("app/api/y/route.ts", [
      `import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";`,
      `export const dynamic = "force-dynamic";`,
      `export async function GET() { await getCurrentPractitionerWithStudio(); return new Response("x"); }`,
      `export async function helperNotMethod() { return 1; }`,
    ].join("\n"));
    put("lib/not-an-action.ts", `export async function looksLikeAnAction() { return 1; }\n`);
    put("app/(app)/x/helpers-no-directive.ts", `export async function alsoNotAnAction() { return 1; }\n`);
    byName = new Map(censusPaths(dir).map((e) => [e.id.replace(/^app\//, "").replace(/^\(app\)\/x\//, ""), e]));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const d = (n: string) => decisionOf(byName.get(n)!);
  it("finds exports of every form, and only server-action and route-method exports", () => {
    expect([...byName.keys()].sort()).toEqual(
      ["(desk)/desk/actions.ts#deskGuarded", "(desk)/desk/actions.ts#deskNotAwaited", "(desk)/desk/actions.ts#deskConditional", "actions.ts#arrowAction", "actions.ts#andNotOr", "actions.ts#nestedOnly", "actions.ts#noGate", "actions.ts#orGuard", "actions.ts#ownGuard", "actions.ts#ownerBranchOnly", "actions.ts#renamedAction", "actions.ts#viaReturningHelper", "actions.ts#viaThrowingHelper", "actions.ts#viaTryContinuing", "actions.ts#viaTryReturning", "api/y/route.ts#GET"].sort(),
    );
  });
  it("claims an owner guard at the top of the body, or from a helper that throws", () => {
    expect(d("actions.ts#ownGuard")).toBe("owner(self)");
    expect(d("actions.ts#orGuard")).toBe("owner(self)");
    expect(d("actions.ts#viaThrowingHelper")).toBe("owner(assertOwner)");
    expect(d("actions.ts#viaTryReturning")).toBe("owner(assertOwner)");
  });
  it("recognises the selected-studio receptionist guard only when awaited before work", () => {
    expect(d("(desk)/desk/actions.ts#deskGuarded")).toBe("receptionist(selected_studio)");
    expect(d("(desk)/desk/actions.ts#deskNotAwaited")).toBe("unresolved(no gate found)");
    expect(d("(desk)/desk/actions.ts#deskConditional")).toBe("unresolved(no gate found)");
  });
  it("marks a helper that only returns a refusal as unverified", () => {
    expect(d("actions.ts#viaReturningHelper")).toBe("owner?(ownerOrNull)");
  });
  it("does not claim a guard that is conditional, a branch, or swallowed", () => {
    for (const n of ["actions.ts#nestedOnly", "actions.ts#andNotOr", "actions.ts#ownerBranchOnly", "actions.ts#viaTryContinuing"]) expect(d(n), n).toBe("staff");
  });
  it("reports an entry with no gate at all as unresolved, never as safe", () => {
    expect(d("actions.ts#noGate")).toMatch(/^unresolved/);
    expect(d("actions.ts#arrowAction")).toMatch(/^unresolved/);
  });
  it("follows a renamed export to its body", () => {
    expect(byName.get("actions.ts#renamedAction")!.evidence).not.toBeNull();
  });
});
