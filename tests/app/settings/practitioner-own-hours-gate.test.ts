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

  it("nav and search list availability for practitioners", () => {
    expect(read("lib/settings/nav-registry.ts")).toMatch(
      /id: "availability"[^\n]*roles: BOTH/,
    );
    const nav = read("lib/search/navigation-registry.ts");
    const i = nav.indexOf('id: "settings-availability"');
    expect(nav.slice(i, i + 500)).toContain('visibility: "practitioner"');
  });
});
