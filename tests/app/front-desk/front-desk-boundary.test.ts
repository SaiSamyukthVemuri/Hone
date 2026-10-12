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

const DESK = files("app/front-desk").filter((f) => /\.(ts|tsx)$/.test(f));

describe("front-desk routes", () => {
  it("exist, and include the layout and both pages", () => {
    expect(DESK.sort()).toEqual(
      ["app/front-desk/contacts/page.tsx", "app/front-desk/layout.tsx", "app/front-desk/page.tsx"].sort(),
    );
  });

  it("every page and layout runs requireReceptionistWithStudio itself", () => {
    for (const f of DESK) expect(code(read(f)), f).toMatch(/await requireReceptionistWithStudio\(\)/);
  });

  it("never import the practitioner guards, query helpers, the admin client or a raw Supabase client", () => {
    for (const f of DESK) {
      const c = code(read(f));
      expect(c, f).not.toMatch(/@\/lib\/supabase\/(queries|admin-server|server)"/);
      expect(c, f).not.toMatch(/requirePractitionerWithStudio|getCurrentPractitionerWithStudio/);
      expect(c, f).not.toMatch(/\.from\(|\.rpc\(/);
    }
  });

  it("read data only through lib/receptionist/projections", () => {
    const imports = DESK.flatMap((f) => [...code(read(f)).matchAll(/from "(@\/lib\/[^"]+)"/g)].map((m) => m[1]));
    expect([...new Set(imports)].sort()).toEqual(["@/lib/receptionist/identity", "@/lib/receptionist/projections"]);
  });
});

describe("lib/receptionist/projections.ts", () => {
  const c = code(read("lib/receptionist/projections.ts"));

  it("calls exactly the three 0216 projections, with the caller's own session", () => {
    const rpcs = [...c.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["receptionist_calendar", "receptionist_calendar_closures", "receptionist_client_contacts"]);
    expect(c).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(c).not.toMatch(/admin-server|createAdminClient/);
  });

  it("reads no table and passes no actor id", () => {
    expect(c).not.toMatch(/\.from\(/);
    expect(c).not.toMatch(/p_actor|p_receptionist_id|p_practitioner_id/);
  });
});

describe("lib/receptionist/identity.ts", () => {
  const c = code(read("lib/receptionist/identity.ts"));

  it("reads only the caller's own receptionist rows, and the studio's name and timezone", () => {
    const tables = [...c.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(["studio_receptionists", "studios"]);
    expect(c).toMatch(/\.from\("studios"\)\s*\.select\("id, name, timezone"\)/);
    expect(c).toMatch(/\.eq\("user_id", user\.id\)\s*\.eq\("active", true\)/);
  });

  it("verifies membership BEFORE the one service-role read", () => {
    expect(c.indexOf("resolveReceptionistMembership(")).toBeGreaterThan(-1);
    expect(c.indexOf("createAdminClient()")).toBeGreaterThan(c.indexOf('redirect("/no-access?reason=multiple-studios")'));
  });

  it("redirects exactly as the practitioner guard does", () => {
    expect(c).toMatch(/redirect\("\/login"\)/);
    expect(c).toMatch(/redirect\("\/no-access"\)/);
    expect(c).toMatch(/redirect\("\/no-access\?reason=multiple-studios"\)/);
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
