import { beforeEach, describe, expect, it, vi } from "vitest";

// Privacy EO-1 (#1328): a refused save echoes the CURRENT stored values, so the two identity saves state "owner or
// practitioner" themselves instead of leaning on the membership-wide policies. A caller with any other role is
// refused with the generic message BEFORE any database client is created, whatever the form carries.

const h = vi.hoisted(() => ({
  role: "owner" as string,
  dbCreated: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    throw new Error("identity saves must never use the service role");
  },
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: h.role },
    studio: { id: "studio-A" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    h.dbCreated += 1;
    throw new Error("no database client may be created for this form");
  },
}));

import { updateClientAction } from "@/app/(app)/clients/[id]/actions";
import { saveLegalIdentityAction } from "@/app/(app)/clients/[id]/legal-identity-actions";

const GENERIC_CLIENT = "Couldn't save the client. Please try again.";
const GENERIC_LEGAL = "Couldn't save the legal name. Please try again.";

function clientForm(): FormData {
  const f = new FormData();
  f.set("client_id", "11111111-1111-4111-8111-111111111111");
  f.set("baseline", JSON.stringify({ name: "Synthetic Client" }));
  f.set("name", "Synthetic Renamed");
  return f;
}

function legalForm(): FormData {
  const f = new FormData();
  f.set("client_id", "11111111-1111-4111-8111-111111111111");
  f.set("legal_given_name", "Dana");
  f.set("legal_family_name", "Okafor");
  f.set("legal_baseline", JSON.stringify({ legal_given_name: "Dana", legal_middle_name: null, legal_family_name: "Okafor" }));
  return f;
}

describe("the identity saves are staff-only (owner or practitioner)", () => {
  beforeEach(() => {
    h.role = "owner";
    h.dbCreated = 0;
  });

  it.each(["receptionist", "viewer", "", undefined, null])("updateClientAction refuses role %s before any database client", async (role) => {
    h.role = role as string;
    expect(await updateClientAction(clientForm())).toEqual({ ok: false, error: GENERIC_CLIENT });
    expect(h.dbCreated).toBe(0);
  });

  it.each(["receptionist", "viewer", "", undefined, null])("saveLegalIdentityAction refuses role %s before any database client", async (role) => {
    h.role = role as string;
    expect(await saveLegalIdentityAction(legalForm())).toEqual({ ok: false, error: GENERIC_LEGAL });
    expect(h.dbCreated).toBe(0);
  });

  // NEGATIVE CONTROL: the same calls with an owner or practitioner are NOT stopped by the role guard. A form with no
  // client id answers "Missing client id." (past the guard, still before any database client), which a guard that
  // refused everyone could not produce.
  it.each(["owner", "practitioner"])("control: role %s passes the guard in both actions", async (role) => {
    h.role = role;
    const noId = new FormData();
    expect(await updateClientAction(noId)).toEqual({ ok: false, error: "Missing client id." });
    expect(await saveLegalIdentityAction(noId)).toEqual({ ok: false, error: "Missing client id." });
    expect(h.dbCreated).toBe(0);
  });
});
