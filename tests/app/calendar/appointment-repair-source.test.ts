import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_ROLE_ALLOWLIST } from "../../security/service-role-allowlist";

// ===========================================================================
// APPOINTMENT BOUNDARY B4 — application wiring contract.
//
// The DB suites prove the commands behave. This file proves the APPLICATION
// actually goes through them: that the actions call the right RPCs, that the
// actor and studio are resolved server-side, that the repair UI is owner-gated,
// and — the one that matters most — that no direct appointment UPDATE has been
// reintroduced alongside the governed path.
// ===========================================================================

const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const ACTIONS_PATH = "app/(app)/calendar/appointment-repair-actions.ts";
const ACTIONS = read(ACTIONS_PATH);
const PAGE = read("app/(app)/calendar/[id]/page.tsx");
const REPAIR_UI = read("app/(app)/calendar/AppointmentOutcomeRepair.tsx");
const NOTES_UI = read("app/(app)/calendar/AppointmentNotesEditor.tsx");
const CONTRACT = read("app/(app)/calendar/appointment-repair-contract.ts");
const MIGRATION = read("supabase/migrations/0173_appointment_repair_commands.sql");

/** Source with `//` line comments stripped, so prose cannot satisfy a guard. */
const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");

const ACTIONS_CODE = strip(ACTIONS);

// ---------------------------------------------------------------------------

describe("B4 actions — the governed RPCs are the only write path", () => {
  it("calls revert_appointment_outcome and set_appointment_notes", () => {
    expect(ACTIONS_CODE).toContain('admin.rpc("revert_appointment_outcome"');
    expect(ACTIONS_CODE).toContain('admin.rpc("set_appointment_notes"');
  });

  it("performs NO direct appointments DML of its own", () => {
    // The whole boundary rests on this. A `.from("appointments").update(...)`
    // here would route around every gate 0173 enforces. Reads are permitted —
    // the repair-state loader needs one — so this forbids the WRITE verbs
    // outright rather than forbidding the table.
    expect(ACTIONS_CODE).not.toMatch(/\.update\(/);
    expect(ACTIONS_CODE).not.toMatch(/\.insert\(/);
    expect(ACTIONS_CODE).not.toMatch(/\.upsert\(/);
    expect(ACTIONS_CODE).not.toMatch(/\.delete\(/);
  });

  it("touches exactly two tables, both read-only, both via .select()", () => {
    const froms = (ACTIONS_CODE.match(/\.from\(\s*["'](\w+)["']\s*\)/g) ?? []).sort();
    expect(froms).toEqual(['.from("appointment_audit")', '.from("appointments")']);
    expect(ACTIONS_CODE).toContain('.select("created_at")');
    expect(ACTIONS_CODE).toContain('.select("status")');
  });

  it("the repair-state loader is STUDIO-SCOPED before it reads the audit baseline", () => {
    // `appointment_audit` has no studio_id, so its lookup cannot scope itself.
    // Every export of a "use server" module is browser-callable, so without a
    // scoped appointment read first this loader would answer for ANOTHER
    // studio's appointment — a cross-studio state oracle, and a surface that
    // claims `repairable: true` for a row the command would refuse.
    const fn = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function loadAppointmentRepairStateAction"),
    );
    const body = fn.slice(0, fn.indexOf("\nexport "));

    const apptRead = body.indexOf('.from("appointments")');
    const auditRead = body.indexOf('.from("appointment_audit")');
    expect(apptRead, "the appointment read must exist").toBeGreaterThan(-1);
    expect(auditRead, "the audit read must exist").toBeGreaterThan(-1);
    expect(apptRead, "the scoped appointment read must come FIRST").toBeLessThan(
      auditRead,
    );

    // Scoped by BOTH keys, exactly like the SQL command's lookup.
    const scoped = body.slice(apptRead, auditRead);
    expect(scoped).toMatch(/\.eq\("id",\s*appointmentId\)/);
    expect(scoped).toMatch(/\.eq\("studio_id",\s*studioId\)/);
  });

  it("the loader derives the status from the DATABASE, never from its caller", () => {
    // A status argument would let a caller steer the baseline lookup at the
    // wrong audit action for a row that does not have that status.
    const sig = ACTIONS_CODE.slice(
      ACTIONS_CODE.indexOf("export async function loadAppointmentRepairStateAction"),
    );
    const params = sig.slice(sig.indexOf("("), sig.indexOf(")"));
    expect(params).toContain("appointmentId");
    expect(params, "the loader must take no status argument").not.toContain(
      "status",
    );
    expect(ACTIONS_CODE).toMatch(/const status = appt\.status as RevertibleStatus/);
  });
});

describe("B4 actions — actor and studio are resolved server-side", () => {
  it("resolves both through getCurrentPractitionerWithStudio", () => {
    expect(ACTIONS_CODE).toContain("getCurrentPractitionerWithStudio");
    const calls =
      ACTIONS_CODE.match(/await getCurrentPractitionerWithStudio\(\)/g) ?? [];
    // Both commands plus the read-only loader.
    expect(calls.length).toBe(3);
  });

  it("passes the SERVER-derived studio id and user id to every RPC", () => {
    for (const rpc of ["revert_appointment_outcome", "set_appointment_notes"]) {
      const at = ACTIONS_CODE.indexOf(`admin.rpc("${rpc}"`);
      expect(at).toBeGreaterThan(-1);
      const call = ACTIONS_CODE.slice(at, ACTIONS_CODE.indexOf("});", at));
      expect(call).toMatch(/p_studio_id:\s*studioId/);
      expect(call).toMatch(/p_actor_user_id:\s*actorUserId/);
    }
  });

  it("never accepts a studio id, practitioner id, user id or role from the browser", () => {
    const inputTypes = ACTIONS_CODE.match(/export type \w+Input = \{[^}]*\}/g) ?? [];
    expect(inputTypes.length).toBeGreaterThan(0);
    for (const t of inputTypes) {
      expect(t).not.toMatch(/studioId|practitionerId|userId|role/);
    }
  });

  it("sends the reason and notes RAW — SQL owns the trim", () => {
    // Trimming in JS would let the browser satisfy the SQL floor with
    // whitespace only if the two ever disagreed. There is one authority.
    expect(ACTIONS_CODE).toMatch(/p_reason:\s*reason\b/);
    expect(ACTIONS_CODE).toMatch(/p_notes:\s*notes\b/);
    expect(ACTIONS_CODE).not.toMatch(/p_reason:\s*[\w.]*\.trim\(\)/);
    expect(ACTIONS_CODE).not.toMatch(/p_notes:\s*[\w.]*\.trim\(\)/);
  });
});

describe("B4 actions — sentinels are propagated truthfully", () => {
  it("an unrecognised code is a failure, never a silent success", () => {
    const fn = ACTIONS_CODE.slice(ACTIONS_CODE.indexOf("function mapSentinel"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/code === "ok"/);
    // The fallthrough must return ok:false.
    expect(body.trimEnd().endsWith("return { ok: false, error: GENERIC_FAILURE };"))
      .toBe(true);
  });

  it("every sentinel the migration can return has practitioner-facing copy", () => {
    // Extract the result codes 0173 actually returns, and require a message for
    // each. This is what stops a new SQL sentinel from surfacing as the generic
    // failure without anyone noticing.
    const fnStart = MIGRATION.indexOf("function public.revert_appointment_outcome");
    const fnEnd = MIGRATION.indexOf(
      "comment on function public.revert_appointment_outcome",
    );
    const body = MIGRATION.slice(fnStart, fnEnd);
    const codes = new Set(
      [...body.matchAll(/return\s+'([a-z_]+)'\s*;/g)].map((m) => m[1]),
    );
    // The blocking classes are returned as `'blocked_' || v_blocking`.
    const helperStart = MIGRATION.indexOf(
      "function public.appointment_has_blocking_dependents",
    );
    const helperEnd = MIGRATION.indexOf(
      "comment on function public.appointment_has_blocking_dependents",
    );
    for (const m of MIGRATION.slice(helperStart, helperEnd).matchAll(
      /return\s+'([a-z_]+)'\s*;/g,
    )) {
      codes.add(`blocked_${m[1]}`);
    }
    codes.delete("ok");

    for (const code of codes) {
      expect(
        ACTIONS_CODE,
        `sentinel ${code} has no practitioner-facing message`,
      ).toContain(`${code}:`);
    }
  });

  it("the notes sentinels are covered too", () => {
    const fnStart = MIGRATION.indexOf("function public.set_appointment_notes");
    const fnEnd = MIGRATION.indexOf("comment on function public.set_appointment_notes");
    const codes = new Set(
      [...MIGRATION.slice(fnStart, fnEnd).matchAll(/return\s+'([a-z_]+)'\s*;/g)].map(
        (m) => m[1],
      ),
    );
    codes.delete("ok");
    for (const code of codes) {
      expect(ACTIONS_CODE, `notes sentinel ${code} has no message`).toContain(
        `${code}:`,
      );
    }
  });
});

describe("B4 actions — constants agree with the migration", () => {
  it("the reason floor matches the SQL constant", () => {
    const sqlMin = MIGRATION.match(
      /c_min_reason\s+constant\s+integer\s*:=\s*(\d+)/,
    )?.[1];
    const tsMin = CONTRACT.match(
      /MIN_REPAIR_REASON_LENGTH\s*=\s*(\d+)/,
    )?.[1];
    expect(sqlMin).toBeDefined();
    expect(tsMin).toBe(sqlMin);
  });

  it("the notes ceiling matches the SQL constant", () => {
    const sqlMax = MIGRATION.match(
      /c_max_notes\s+constant\s+integer\s*:=\s*(\d+)/,
    )?.[1];
    const tsMax = CONTRACT.match(
      /MAX_APPOINTMENT_NOTES_LENGTH\s*=\s*(\d+)/,
    )?.[1];
    expect(sqlMax).toBeDefined();
    expect(tsMax).toBe(sqlMax);
  });

  it("the baseline action map matches the SQL CASE", () => {
    // A drift here would make the UI compute the repair window from the wrong
    // audit event, so the surface would offer a repair the command refuses.
    for (const [status, action] of [
      ["completed", "marked_complete"],
      ["no_show", "marked_no_show"],
      ["cancelled", "cancelled"],
    ] as const) {
      expect(MIGRATION).toMatch(
        new RegExp(`when '${status}'\\s+then '${action}'`),
      );
      expect(CONTRACT).toMatch(
        new RegExp(`${status}:\\s*"${action}"`),
      );
    }
  });

  it("the repair window matches 72 hours", () => {
    expect(MIGRATION).toMatch(/interval\s*'72 hours'/);
    expect(CONTRACT).toMatch(/REPAIR_WINDOW_MS\s*=\s*72\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

describe("B4 UI — mounting and gating", () => {
  it("the detail page mounts both repair surfaces", () => {
    expect(PAGE).toContain("<AppointmentOutcomeRepair");
    expect(PAGE).toContain("<AppointmentNotesEditor");
  });

  it("outcome repair is OWNER-gated and TERMINAL-gated on the page", () => {
    expect(PAGE).toMatch(/isOwner\s*&&\s*isTerminalOutcome/);
    expect(PAGE).toMatch(
      /repairState\s*&&\s*isTerminalOutcome\s*&&\s*\(\s*\n?\s*<AppointmentOutcomeRepair/,
    );
  });

  it("the repair state is resolved on the SERVER, not in the client component", () => {
    expect(PAGE).toContain("await loadAppointmentRepairStateAction(");
    // Comments stripped: the component's header legitimately EXPLAINS that the
    // page does this, and prose must not satisfy or defeat a guard.
    expect(strip(REPAIR_UI)).not.toContain("loadAppointmentRepairStateAction");
  });

  it("a blocked repair explains itself instead of offering a doomed button", () => {
    const ui = strip(REPAIR_UI);
    // The not-repairable branch renders the reason and no submit control.
    expect(ui).toMatch(/!repairState\.repairable\s*\?/);
    expect(ui).toContain("{repairState.reason}");
  });

  it("the repair copy is practitioner wording, not developer wording", () => {
    const ui = REPAIR_UI;
    expect(ui).toContain("Correct appointment outcome");
    expect(ui).toContain("Current status:");
    expect(ui).toContain("Restore to:");
    expect(ui).toContain("Restore appointment");
    expect(ui).toContain("This repair is recorded in the appointment audit history.");

    // Only what the practitioner actually SEES. Scanning the whole file would
    // trip on identifiers like `revertAppointmentOutcomeAction`, which is code,
    // not copy — so this extracts JSX text nodes and the ternary string
    // literals rendered inside them.
    const jsxText = [...strip(ui).matchAll(/>\s*([^<>{}]+?)\s*</g)].map((m) => m[1]);
    const rendered = [...strip(ui).matchAll(/\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap(
      (m) => [m[1], m[2]],
    );
    const visible = [...jsxText, ...rendered].join(" | ").toLowerCase();
    expect(visible.length, "no visible copy extracted").toBeGreaterThan(40);

    for (const forbidden of ["revert", "sentinel", "dml", "rpc", "42501", "23p01"]) {
      expect(visible, `visible copy must not say "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  it("the notes editor is not owner-gated (any active member may correct)", () => {
    // The page mounts it unconditionally; authority is the command's.
    const at = PAGE.indexOf("<AppointmentNotesEditor");
    const preceding = PAGE.slice(Math.max(0, at - 400), at);
    expect(preceding).not.toMatch(/isOwner\s*&&\s*$/);
  });

  it("neither UI component writes to the database directly", () => {
    for (const [name, src] of [
      ["AppointmentOutcomeRepair", REPAIR_UI],
      ["AppointmentNotesEditor", NOTES_UI],
    ] as const) {
      expect(src, `${name} must not import a supabase client`).not.toMatch(
        /createClient|createAdminClient/,
      );
    }
  });
});

describe("B4 — service-role allowlist", () => {
  it("the repair actions file is registered with a precise scope guard", () => {
    const entry = SERVICE_ROLE_ALLOWLIST.find((e) => e.path === ACTIONS_PATH);
    expect(entry, "the file must be on the allowlist").toBeDefined();
    expect(entry!.purpose.length).toBeGreaterThan(0);
    expect(entry!.why.length).toBeGreaterThan(0);
    // The guard names the RPC rather than the generic resolver, so the entry
    // cannot keep vouching for a file that stopped using the governed command.
    expect(entry!.scopeGuard).toBe("revert_appointment_outcome");
    expect(ACTIONS).toContain(entry!.scopeGuard);
  });
});
