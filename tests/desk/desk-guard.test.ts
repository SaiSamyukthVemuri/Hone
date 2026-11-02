import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Privacy R3 (ship dark) and R4 (cross-studio): the desk guard and the practitioner guard each
// accept ONLY the studio the user holds the matching role in, whatever the selected-studio cookie
// says. The cookie is a hint, validated against the table each guard owns.

const A = "11111111-1111-4111-8111-111111111111"; // studio A
const B = "22222222-2222-4222-8222-222222222222"; // studio B
const U = "user-1";

let tables: Record<string, unknown[]> = {};
let user: { id: string } | null = { id: U };
let cookie: string | null = null;
const touched: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/supabase/selected-studio", () => ({ readSelectedStudioId: async () => cookie }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      touched.push(table);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
      return q;
    },
  }),
}));

import { requireReceptionistWithStudio, getReceptionistWithStudio } from "@/lib/desk/guard";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

const rec = (studio_id: string) => ({ id: `r-${studio_id.slice(0, 1)}`, studio_id, display_name: "Desk Person" });
const prac = (studio_id: string) => ({ id: `p-${studio_id.slice(0, 1)}`, studio_id, user_id: U, active: true, role: "owner", studio: { id: studio_id, name: "S" } });

async function outcome<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  tables = {};
  user = { id: U };
  cookie = null;
  touched.length = 0;
  vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("R3: the desk is dark unless the flag is exactly 'true'", () => {
  it.each([undefined, "", "false", "1", "TRUE", "yes", " true"])("flag %j: 404 and not a single read", async (value) => {
    if (value === undefined) vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    else vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", value);
    tables.studio_receptionists = [rec(A)];
    expect(await outcome(requireReceptionistWithStudio)).toBe("NOT_FOUND");
    expect(await outcome(getReceptionistWithStudio)).toBe("Desk unavailable");
    expect(touched).toEqual([]);
  });

  it("control: flag 'true' with an active receptionist row resolves", async () => {
    tables.studio_receptionists = [rec(A)];
    expect(await requireReceptionistWithStudio()).toEqual({ studioId: A, receptionistId: "r-1", displayName: "Desk Person" });
  });
});

describe("desk guard outcomes", () => {
  it("anonymous -> /login; no row -> /no-access; the throwing variant uses fixed messages", async () => {
    user = null;
    expect(await outcome(requireReceptionistWithStudio)).toBe("REDIRECT:/login");
    expect(await outcome(getReceptionistWithStudio)).toBe("Not signed in");
    user = { id: U };
    tables.studio_receptionists = [];
    expect(await outcome(requireReceptionistWithStudio)).toBe("REDIRECT:/no-access");
    expect(await outcome(getReceptionistWithStudio)).toBe("No active receptionist membership");
  });

  it("two studios with no valid selection go to the chooser, never auto-picked", async () => {
    tables.studio_receptionists = [rec(A), rec(B)];
    expect(await outcome(requireReceptionistWithStudio)).toBe("REDIRECT:/no-access?reason=multiple-studios");
    cookie = "33333333-3333-4333-8333-333333333333";
    expect(await outcome(requireReceptionistWithStudio)).toBe("REDIRECT:/no-access?reason=multiple-studios");
    expect(await outcome(getReceptionistWithStudio)).toBe("Studio choice required");
    cookie = B;
    expect(await requireReceptionistWithStudio()).toMatchObject({ studioId: B });
  });
});

describe("R4: cross-studio, both directions", () => {
  it("DESK: a cookie naming a studio the user holds only as a practitioner is never accepted", async () => {
    // Practitioner in A (cookie says A), receptionist in B only.
    tables.practitioners = [prac(A)];
    tables.studio_receptionists = [rec(B)];
    cookie = A;
    const identity = await requireReceptionistWithStudio();
    expect(identity.studioId).toBe(B);
    expect(identity.studioId).not.toBe(A);
    // And with two receptionist studios, the practitioner-only studio in the cookie is not a valid selection.
    tables.studio_receptionists = [rec(B), rec("44444444-4444-4444-8444-444444444444")];
    expect(await outcome(requireReceptionistWithStudio)).toBe("REDIRECT:/no-access?reason=multiple-studios");
    // The desk guard never reads practitioners.
    expect(touched).not.toContain("practitioners");
  });

  it("APP: a receptionist-only user whose selected studio is the receptionist one gets a safe redirect and no data", async () => {
    tables.practitioners = [];
    tables.studio_receptionists = [rec(A)];
    cookie = A;
    expect(await outcome(requirePractitionerWithStudio)).toBe("REDIRECT:/no-access");
    // Only the membership table was asked; no client, appointment or other table was read.
    expect(new Set(touched)).toEqual(new Set(["practitioners"]));
  });

  it("APP: a user with both gets only the practitioner studio from the app guard, and only the receptionist studio from the desk", async () => {
    tables.practitioners = [prac(A)];
    tables.studio_receptionists = [rec(B)];
    cookie = B; // the receptionist-only studio, while visiting an (app) page
    const app = await requirePractitionerWithStudio();
    expect(app.studio.id).toBe(A);
    expect(app.studio.id).not.toBe(B);
    cookie = A; // the practitioner-only studio, while visiting the desk
    expect((await requireReceptionistWithStudio()).studioId).toBe(B);
  });

  it("APP: two practitioner studios and a cookie naming only a receptionist studio is not a valid selection", async () => {
    tables.practitioners = [prac(A), prac("55555555-5555-4555-8555-555555555555")];
    tables.studio_receptionists = [rec(B)];
    cookie = B;
    expect(await outcome(requirePractitionerWithStudio)).toBe("REDIRECT:/no-access?reason=multiple-studios");
  });
});
