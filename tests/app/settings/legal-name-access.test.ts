import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseLegalNameAccessForm, readLegalNameAccessSetting } from "@/lib/clients/legal-name-access";

// HON-58 Q1: the owner's switch. Synthetic data only.

vi.mock("server-only", () => ({}));

const st = vi.hoisted(() => ({
  role: "owner" as string,
  studioId: "studio-A",
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  error: null as { code?: string; message: string } | null,
  revalidated: [] as string[],
  admin: 0,
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => st.revalidated.push(p) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: st.role }, studio: { id: st.studioId } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      st.rpcs.push({ name, args });
      return { error: st.error };
    },
  }),
}));

const form = (v: string | null) => {
  const fd = new FormData();
  if (v !== null) fd.set("receptionist_legal_name_access", v);
  return fd;
};

beforeEach(() => {
  st.role = "owner";
  st.studioId = "studio-A";
  st.rpcs = [];
  st.error = null;
  st.revalidated = [];
});

describe("setReceptionistLegalNameAccessAction", () => {
  it("an owner changes only their own studio, through the audited command", async () => {
    const { setReceptionistLegalNameAccessAction } = await import("@/app/(app)/settings/studio/actions");
    expect(await setReceptionistLegalNameAccessAction(form("true"))).toEqual({ ok: true });
    expect(st.rpcs).toEqual([{ name: "set_receptionist_legal_name_access", args: { p_studio_id: "studio-A", p_enabled: true } }]);
    expect(st.revalidated).toContain("/settings/studio");
  });

  it("a non-owner is refused before any call", async () => {
    const { setReceptionistLegalNameAccessAction } = await import("@/app/(app)/settings/studio/actions");
    for (const role of ["practitioner", "receptionist"]) {
      st.role = role;
      expect(await setReceptionistLegalNameAccessAction(form("true"))).toMatchObject({ ok: false });
    }
    expect(st.rpcs).toEqual([]);
  });

  it("anything but the literal true/false is refused, never coerced; a form studio id is ignored", async () => {
    const { setReceptionistLegalNameAccessAction } = await import("@/app/(app)/settings/studio/actions");
    for (const v of [null, "", "on", "1", "TRUE", "yes"]) expect(await setReceptionistLegalNameAccessAction(form(v))).toMatchObject({ ok: false });
    const fd = form("false");
    fd.set("studio_id", "studio-B");
    await setReceptionistLegalNameAccessAction(fd);
    expect(st.rpcs.map((r) => r.args.p_studio_id)).toEqual(["studio-A"]);
  });

  it("a database refusal is reported generically and nothing is revalidated", async () => {
    const { setReceptionistLegalNameAccessAction } = await import("@/app/(app)/settings/studio/actions");
    st.error = { code: "42501", message: "only an owner of the studio may change this setting" };
    const res = await setReceptionistLegalNameAccessAction(form("true"));
    expect(res).toEqual({ ok: false, error: "Could not save settings. Please try again." });
    expect(st.revalidated).toEqual([]);
  });
});

describe("reading the setting fails closed", () => {
  const reader = (result: { data: unknown; error: { code?: string; message?: string } | null }) => ({
    from: (table: string) => {
      expect(table).toBe("studio_legal_name_access");
      return { select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) };
    },
  });
  it("no row is OFF; only a literal true is ON", async () => {
    expect(await readLegalNameAccessSetting(reader({ data: null, error: null }), "s")).toEqual({ available: true, receptionistAccess: false });
    expect(await readLegalNameAccessSetting(reader({ data: { receptionist_access: false }, error: null }), "s")).toEqual({ available: true, receptionistAccess: false });
    expect(await readLegalNameAccessSetting(reader({ data: { receptionist_access: "true" }, error: null }), "s")).toEqual({ available: true, receptionistAccess: false });
    expect(await readLegalNameAccessSetting(reader({ data: { receptionist_access: true }, error: null }), "s")).toEqual({ available: true, receptionistAccess: true });
  });
  it("a missing table (before 0266) or any read error is unavailable, never ON", async () => {
    expect(await readLegalNameAccessSetting(reader({ data: null, error: { code: "42P01", message: 'relation "studio_legal_name_access" does not exist' } }), "s")).toEqual({ available: false });
    expect(await readLegalNameAccessSetting(reader({ data: null, error: { code: "57014" } }), "s")).toEqual({ available: false });
  });
  it("parses strictly", () => {
    expect(parseLegalNameAccessForm(form("true"))).toBe(true);
    expect(parseLegalNameAccessForm(form("false"))).toBe(false);
    expect(parseLegalNameAccessForm(form("TRUE"))).toBeNull();
  });
});

describe("the card", () => {
  const page = readFileSync("app/(app)/settings/studio/page.tsx", "utf8");
  const card = readFileSync("app/(app)/settings/studio/LegalNameAccessForm.tsx", "utf8");
  it("is owner-page only, shown only where the table exists, and starts from the stored value", () => {
    expect(page).toMatch(/practitioner\.role !== "owner"[\s\S]*?return \(/);
    expect(page).toContain("legalNameAccess.available && <LegalNameAccessForm initial={legalNameAccess.receptionistAccess} />");
  });
  it("says it is off by default, takes effect on the next load, and is recorded", () => {
    expect(card).toMatch(/off by default/);
    expect(card).toMatch(/next page\s+load/);
    expect(card).toMatch(/recorded/);
  });
});
