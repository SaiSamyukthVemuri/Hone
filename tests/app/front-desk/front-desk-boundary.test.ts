import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// STUDIO-READY-02d (#824): what the front desk may touch. A source contract.
// The database already refuses a receptionist everywhere but the three 0216
// projections (tests/db/receptionist-foundation.db.test.ts). This pins the
// server side of the same boundary, so a later edit cannot quietly widen it:
//   * every front-desk page and layout runs the receptionist guard itself;
//   * front-desk code reads data ONLY through lib/receptionist/projections.ts,
//     never through the practitioner helpers, a table read or the admin client;
//   * the projections module calls exactly the three 0216 RPCs and no table;
//   * the identity module's one service-role read is the studio's name and
//     timezone, after membership is verified.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : [rel];
  });
}

const ALL_DESK = files("app/front-desk").filter((f) => /\.(ts|tsx)$/.test(f));
// The guarded group, and the chooser that sits outside it.
const DESK = ALL_DESK.filter((f) => f.startsWith("app/front-desk/(desk)/"));
const SELECT = ALL_DESK.filter((f) => f.startsWith("app/front-desk/select/"));

describe("front-desk routes", () => {
  it("exist, and include the layout and both pages", () => {
    expect(ALL_DESK.sort()).toEqual(
      [
        "app/front-desk/(desk)/book/page.tsx",
        "app/front-desk/(desk)/contacts/page.tsx",
        "app/front-desk/(desk)/layout.tsx",
        "app/front-desk/(desk)/page.tsx",
        "app/front-desk/select/actions.ts",
        "app/front-desk/select/page.tsx",
      ].sort(),
    );
  });

  it("every page and layout runs requireReceptionistWithStudio itself", () => {
    for (const f of DESK) expect(code(read(f)), f).toMatch(/await requireReceptionistWithStudio\(\)/);
  });

  it("never import the practitioner guards, query helpers, the admin client or a raw Supabase client", () => {
    for (const f of ALL_DESK) {
      const c = code(read(f));
      expect(c, f).not.toMatch(/@\/lib\/supabase\/(queries|admin-server|server)"/);
      expect(c, f).not.toMatch(/requirePractitionerWithStudio|getCurrentPractitionerWithStudio/);
      expect(c, f).not.toMatch(/\.from\(|\.rpc\(/);
    }
  });

  it("read data only through lib/receptionist/projections", () => {
    const imports = DESK.flatMap((f) => [...code(read(f)).matchAll(/from "(@\/lib\/[^"]+)"/g)].map((m) => m[1]));
    expect([...new Set(imports)].sort()).toEqual([
      "@/lib/receptionist/calendar-days",
      "@/lib/receptionist/identity",
      "@/lib/receptionist/projections",
    ]);
  });

  it("the chooser lists and sets ONLY the caller's own memberships, and reads no studio data", () => {
    const page = code(read("app/front-desk/select/page.tsx"));
    const action = code(read("app/front-desk/select/actions.ts"));
    expect(page).toMatch(/await listOwnFrontDeskStudios\(\)/);
    // The cookie is set only after the studio is verified as the caller's own.
    expect(action.indexOf("await isOwnFrontDeskStudio(studioId)")).toBeGreaterThan(-1);
    expect(action.indexOf("await setSelectedStudioId(studioId)")).toBeGreaterThan(
      action.indexOf("await isOwnFrontDeskStudio(studioId)"),
    );
    const imports = SELECT.flatMap((f) => [...code(read(f)).matchAll(/from "(@\/lib\/[^"]+)"/g)].map((m) => m[1]));
    expect([...new Set(imports)].sort()).toEqual(["@/lib/receptionist/identity", "@/lib/supabase/selected-studio"]);
  });
});

describe("lib/receptionist/projections.ts", () => {
  const c = code(read("lib/receptionist/projections.ts"));

  it("calls exactly the three 0216 projections and the 0220 booking options, with the caller's own session", () => {
    const rpcs = [...c.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual([
      "receptionist_booking_options",
      "receptionist_calendar",
      "receptionist_calendar_closures",
      "receptionist_client_contacts",
    ]);
    expect(c).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(c).not.toMatch(/admin-server|createAdminClient/);
  });

  it("reads no table and passes no actor id", () => {
    expect(c).not.toMatch(/\.from\(/);
    expect(c).not.toMatch(/p_actor|p_receptionist_id|p_practitioner_id/);
  });
});

describe("lib/receptionist/scheduling-actions.ts (STUDIO-READY-02c)", () => {
  const c = code(read("lib/receptionist/scheduling-actions.ts"));

  it("writes ONLY through the three 0220 receptionist commands, with the caller's own session", () => {
    const rpcs = [...c.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["receptionist_cancel_appointment", "receptionist_create_appointment", "receptionist_move_appointment"]);
    for (const m of c.matchAll(/(\w+)\.rpc\("receptionist_/g)) expect(m[1]).toBe("supabase");
    expect(c).toMatch(/const supabase = await createClient\(\);/);
  });

  it("never sends an actor, override, duration or note", () => {
    expect(c).not.toMatch(/p_actor|p_receptionist_id|p_practitioner_id|p_allow_outside|p_duration|p_notes/);
  });

  it("resolves the studio server-side in every action, before any command", () => {
    for (const fn of ["bookFrontDeskAppointmentAction", "moveFrontDeskAppointmentAction", "cancelFrontDeskAppointmentAction"]) {
      const body = c.slice(c.indexOf(`export async function ${fn}`));
      const guard = body.indexOf("await requireReceptionistWithStudio()");
      expect(guard, fn).toBeGreaterThan(-1);
      expect(guard, fn).toBeLessThan(body.indexOf(".rpc("));
    }
  });

  it("the service role is used only AFTER a committed result, and every read is scoped to the studio", () => {
    expect(c.indexOf("createAdminClient()")).toBeGreaterThan(c.indexOf('row?.result !== "created"'));
    const reads = [...c.matchAll(/\.from\("([a-z_]+)"\)/g)].length;
    const scoped = [...c.matchAll(/\.eq\("studio_id", studioId\)|\.eq\("id", studioId\)/g)].length;
    expect(reads).toBeGreaterThan(0);
    expect(scoped).toBe(reads);
    expect(c).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it("exports only the three actions (every export of a server module is an endpoint)", () => {
    const exported = [...c.matchAll(/export (?:async function|function|const) (\w+)/g)].map((m) => m[1]).sort();
    expect(exported).toEqual(["bookFrontDeskAppointmentAction", "cancelFrontDeskAppointmentAction", "moveFrontDeskAppointmentAction"]);
  });
});

describe("components/front-desk", () => {
  it("call only the front-desk actions, and read nothing", () => {
    for (const f of files("components/front-desk")) {
      const c = code(read(f));
      const imports = [...c.matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]);
      expect(imports, f).toEqual(["@/lib/receptionist/scheduling-actions"]);
      expect(c, f).not.toMatch(/\.from\(|\.rpc\(/);
    }
  });
});

describe("lib/receptionist/identity.ts", () => {
  const c = code(read("lib/receptionist/identity.ts"));

  it("reads only the caller's own receptionist rows, and the studio's name and timezone", () => {
    const tables = [...new Set([...c.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
    expect(tables).toEqual(["studio_receptionists", "studios"]);
    expect(c).toMatch(/\.from\("studios"\)\s*\.select\("id, name, timezone"\)/);
    expect(c).toMatch(/\.eq\("user_id", user\.id\)\s*\.eq\("active", true\)/);
  });

  it("verifies membership BEFORE the one service-role read", () => {
    expect(c.indexOf("resolveReceptionistMembership(")).toBeGreaterThan(-1);
    expect(c.indexOf("createAdminClient()")).toBeGreaterThan(c.indexOf("redirect(FRONT_DESK_SELECT_PATH)"));
    // The chooser's name read covers only the caller's own studio ids.
    expect(c).toMatch(/const ids = \[\.\.\.new Set\(loaded\.rows\.map\(\(r\) => r\.studio_id\)\)\]/);
    expect(c).toMatch(/\.from\("studios"\)\.select\("id, name"\)\.in\("id", ids\)/);
  });

  it("redirects exactly as the practitioner guard does", () => {
    expect(c).toMatch(/redirect\("\/login"\)/);
    expect(c).toMatch(/redirect\("\/no-access"\)/);
    // 2+ studios choose at the receptionist's own chooser, not the practitioner one.
    expect(c).toMatch(/redirect\(FRONT_DESK_SELECT_PATH\)/);
    expect(c).toMatch(/FRONT_DESK_SELECT_PATH = "\/front-desk\/select"/);
    expect(c).not.toMatch(/reason=multiple-studios/);
  });
});

describe("the middleware carve-out", () => {
  const c = code(read("lib/supabase/middleware.ts"));
  const start = c.indexOf('.from("studio_receptionists")');

  it("reads receptionist rows only inside the zero-practitioner branch", () => {
    expect(start).toBeGreaterThan(-1);
    const before = c.slice(0, start);
    expect(before.lastIndexOf("if (activeStudioIds.length === 0) {")).toBeGreaterThan(before.lastIndexOf('.from("practitioners")'));
  });

  it("admits only front-desk paths and otherwise redirects to /front-desk", () => {
    const branch = c.slice(start, c.indexOf("if (!usable)", start));
    expect(branch).toMatch(/if \(isFrontDeskPath\(pathname\)\) return supabaseResponse;/);
    expect(branch).toMatch(/deskUrl\.pathname = FRONT_DESK_PATH;/);
  });
});
