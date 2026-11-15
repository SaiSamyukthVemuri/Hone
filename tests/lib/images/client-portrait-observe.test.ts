import { beforeEach, describe, expect, it, vi } from "vitest";

// DN-24 / Privacy X2: the ID-portrait signer is OBSERVE-ONLY. A non-owner is logged as a would-deny and still served; an owner is not logged.
vi.mock("server-only", () => ({}));

const role = { current: "practitioner" as "owner" | "practitioner" };
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: role.current, id: "p" }, studio: { id: "S" } })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: { studio_id: "S", client_id: "C", storage_bucket: "treatment-images", storage_path: "S/C/x.jpg" }, error: null });
    return { from: () => chain };
  },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" } }) }) } }),
}));
vi.mock("@/lib/images/treatment-images", () => ({
  TREATMENT_IMAGES_BUCKET: "treatment-images",
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS: 60,
  buildTreatmentImageThumbPath: () => null,
  validateTreatmentImagePath: () => ({ ok: true }),
}));

import { signedClientPortraitUrl } from "@/lib/images/client-portrait";

const input = { studioId: "S", clientId: "C", portraitImageId: "I" };
const wouldDeny = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === "permission_observe_would_deny" && l.key === "id_portraits_owner_only");

describe("signedClientPortraitUrl is observe-only for DN-24", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("a non-owner is logged as a would-deny (role and ids only) and is still served", async () => {
    role.current = "practitioner";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await signedClientPortraitUrl(input)).toEqual({ url: "https://signed.example/x", thumbUrl: null });
    const logs = wouldDeny(warn);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ role: "practitioner", studioId: "S" });
    expect(JSON.stringify(logs[0])).not.toMatch(/signed\.example|"C"|email|name/);
  });

  it("an owner is served and not logged; no portrait selected means no signing and no log", async () => {
    role.current = "owner";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await signedClientPortraitUrl(input))?.url).toBe("https://signed.example/x");
    expect(await signedClientPortraitUrl({ ...input, portraitImageId: null })).toBeNull();
    expect(wouldDeny(warn)).toHaveLength(0);
  });
});
