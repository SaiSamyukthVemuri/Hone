import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Decision 6 (Sam, 1 Nov): a practitioner changes ONLY their own working hours; the owner any.
// Behavioural: the scoped writers refuse before any database call when the target is not the
// session's own practitioner. Source pins: the page, nav and search expose it to practitioners.

const OWN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

const session = vi.hoisted(() => ({
  role: "practitioner" as string,
  active: true,
}));
const reached = vi.hoisted(() => ({ client: 0, admin: 0 }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    reached.client += 1;
    throw new Error("REACHED_DB");
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => {
    reached.admin += 1;
    throw new Error("REACHED_ADMIN");
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: OWN, role: session.role, active: session.active },
    studio: { id: "studio-1", timezone: "UTC", practitioner_capacity_enabled: true },
  })),
}));

import {
  customizePractitionerWeekAction,
  resetPractitionerDayAction,
  resetPractitionerOverrideAction,
  resetPractitionerWeekAction,
  upsertScopedDayDefaultAction,
  upsertScopedOverrideAction,
} from "@/app/(app)/settings/availability/actions";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const WRITERS = [
  ["upsertScopedDayDefaultAction", upsertScopedDayDefaultAction],
  ["resetPractitionerDayAction", resetPractitionerDayAction],
  ["customizePractitionerWeekAction", customizePractitionerWeekAction],
  ["resetPractitionerWeekAction", resetPractitionerWeekAction],
  ["upsertScopedOverrideAction", upsertScopedOverrideAction],
  ["resetPractitionerOverrideAction", resetPractitionerOverrideAction],
] as const;

beforeEach(() => {
  vi.stubEnv("HONE_PRACTITIONER_OWN_HOURS_ENABLED", "true");
  session.role = "practitioner";
  session.active = true;
  reached.client = 0;
  reached.admin = 0;
});

describe("decision 6: scoped hours writers", () => {
  for (const [name, action] of WRITERS) {
    it(`${name}: a practitioner targeting a colleague is refused before any database call`, async () => {
      const res = await action(form({ practitioner_id: OTHER }));
      expect(res).toEqual({ ok: false, error: "You can only change your own working hours." });
      expect(reached).toEqual({ client: 0, admin: 0 });
    });

    it(`${name}: a studio-wide (empty) target is refused for a practitioner`, async () => {
      const res = await action(form({ practitioner_id: "" }));
      expect(res).toEqual({ ok: false, error: "You can only change your own working hours." });
      expect(reached).toEqual({ client: 0, admin: 0 });
    });

    it(`${name}: a practitioner targeting themselves proceeds to the database`, async () => {
      await expect(action(form({ practitioner_id: OWN }))).rejects.toThrow("REACHED_DB");
    });

    it(`${name}: the owner may target a colleague`, async () => {
      session.role = "owner";
      await expect(action(form({ practitioner_id: OTHER }))).rejects.toThrow("REACHED_DB");
    });

    it(`${name}: an inactive practitioner is refused`, async () => {
      session.active = false;
      const res = await action(form({ practitioner_id: OWN }));
      expect(res.ok).toBe(false);
      expect(reached).toEqual({ client: 0, admin: 0 });
    });
  }
});

describe("decision 6: exposure", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("owner role in the scoped-writer session reaches the database (control)", async () => {
    session.role = "owner";
    await expect(upsertScopedDayDefaultAction(form({ practitioner_id: OTHER }))).rejects.toThrow(
      "REACHED_DB",
    );
  });

  it("studio-wide writers stay owner-only", () => {
    const src = read("app/(app)/settings/availability/actions.ts");
    expect(src).toMatch(/export async function upsertDayDefaultAction[\s\S]*?assertOwner\(\)/);
    expect(src).toMatch(/export async function saveWeeklyDefaultsAction[\s\S]*?assertOwner\(\)/);
  });

  it("a non-owner weekly save uses the actor-aware RPC; the owner keeps the original", () => {
    const src = read("app/(app)/settings/availability/actions.ts");
    expect(src).toContain("save_weekly_availability_as");
    expect(src).toContain("p_actor_practitioner_id");
  });

  it("the page gives a practitioner only their own editor, gated on capacity", () => {
    const src = read("app/(app)/settings/availability/page.tsx");
    expect(src).toContain("practitioner_capacity_enabled !== true");
    expect(src).toContain("practitionerId={mine.id}");
  });

  it("nav lists availability for a practitioner only behind the default-off flag; search stays owner-only", () => {
    const nav = read("lib/settings/nav-registry.ts");
    expect(nav).toMatch(/id: "availability"[\s\S]*?roles: BOTH[\s\S]*?visibleWhen: \(ctx\) => ctx\.role === "owner" \|\| practitionerOwnHoursEnabled\(\)/);
    const search = read("lib/search/navigation-registry.ts");
    const at = search.indexOf('id: "settings-availability"');
    expect(search.slice(at, at + 500)).toContain('visibility: "owner"');
  });

  it("the flag is default-off and exactly 'true' turns it on", async () => {
    const { practitionerOwnHoursEnabled } = await import("@/lib/settings/practitioner-own-hours");
    vi.unstubAllEnvs();
    expect(practitionerOwnHoursEnabled()).toBe(false);
    vi.stubEnv("HONE_PRACTITIONER_OWN_HOURS_ENABLED", "1");
    expect(practitionerOwnHoursEnabled()).toBe(false);
    vi.stubEnv("HONE_PRACTITIONER_OWN_HOURS_ENABLED", "true");
    expect(practitionerOwnHoursEnabled()).toBe(true);
  });

  it("the page replaces the editor with a plain sentence while the flag is off", () => {
    const src = read("app/(app)/settings/availability/page.tsx");
    expect(src.indexOf("practitionerOwnHoursEnabled()")).toBeGreaterThan(0);
    expect(src.indexOf("practitionerOwnHoursEnabled()")).toBeLessThan(src.indexOf("practitionerId={mine.id}"));
  });
});

// Insurance W-4 / Privacy C3 / Privacy C1(0278): the actor is the session's, a practitioner can
// never reach the actor-less weekly command, and an override note never reaches a public response.
describe("decision 6: source contracts for the database half's conditions", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const ACTIONS = read("app/(app)/settings/availability/actions.ts");

  it("W-4: the actor-less save_weekly_availability is reachable only from the owner branch or assertOwner paths", () => {
    const customize = ACTIONS.slice(ACTIONS.indexOf("export async function customizePractitionerWeekAction"));
    const end = customize.indexOf("\n}\n");
    const body = customize.slice(0, end);
    expect(body).toMatch(/practitioner\.role === "owner"\s*\?\s*await admin\.rpc\("save_weekly_availability", \{/);
    expect(body).toMatch(/:\s*await admin\.rpc\("save_weekly_availability_as", \{[\s\S]*?p_actor_practitioner_id: practitioner\.id/);
    // the only other caller is the studio-wide save, which is owner-only
    const wide = ACTIONS.slice(ACTIONS.indexOf("export async function saveWeeklyDefaultsAction"));
    expect(wide.slice(0, wide.indexOf('rpc("save_weekly_availability"'))).toContain("assertOwner()");
  });

  it("C3: every scoped writer passes the SESSION's practitioner as the actor, never a form value", () => {
    const actors = ACTIONS.match(/p_actor_practitioner_id: ([^,\n]+)/g) ?? [];
    expect(actors.length).toBeGreaterThanOrEqual(6);
    for (const a of actors) expect(a).toMatch(/p_actor_practitioner_id: (practitioner|ctx)\.id|practitionerId/);
    expect(ACTIONS).not.toMatch(/p_actor_practitioner_id: (trimmed|formData|nullable)/);
  });

  it("C1: public slot generation never selects or forwards an override note", () => {
    const slots = read("lib/booking/slots.ts");
    const range = read("lib/booking/public-slot-range.ts");
    const selects = slots.match(/from\("studio_availability_overrides"\)\s*\.select\(([^)]*)\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toMatch(/note|\*/);
    expect(range).not.toMatch(/\bnote\b/);
  });

  it("C1: no public or desk surface imports the note-carrying override readers (SOURCE ONLY; a runtime sentinel case is not written)", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const readers = /getOverridesForRange|studioWideOverrides|loadScopedAvailability/;
    const allowed = new Set([
      "app/(app)/calendar/page.tsx",
      "app/(app)/settings/availability/page.tsx",
      "lib/booking/public-slot-range.ts", // reads rows server-side; asserted above to forward no note
      "lib/booking/queries.ts",
      "lib/booking/studio-wide-availability.ts",
      "lib/booking/practitioner-availability.ts",
    ]);
    const hits: string[] = [];
    for (const root of ["app", "lib"]) {
      for (const f of walk(join(process.cwd(), root))) {
        const rel = f.slice(process.cwd().length + 1);
        if (readers.test(readFileSync(f, "utf8")) && !allowed.has(rel)) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("decision 6: flag OFF (default) refuses gracefully and never reaches the database", () => {
  for (const [name, action] of WRITERS) {
    it(`${name}: a practitioner targeting themselves gets the plain not-available sentence`, async () => {
      vi.unstubAllEnvs();
      const res = await action(form({ practitioner_id: OWN }));
      expect(res).toEqual({ ok: false, error: "Changing your own working hours is not available yet. Ask the studio owner." });
      expect(reached).toEqual({ client: 0, admin: 0 });
    });
    it(`${name}: the owner is unaffected by the flag`, async () => {
      vi.unstubAllEnvs();
      session.role = "owner";
      await expect(action(form({ practitioner_id: OTHER }))).rejects.toThrow("REACHED_DB");
    });
  }
});
