import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPortalPresentation, formatPortalCopy, parsePortalPresentation } from "@/lib/portal/presentation";
import { getPublishedPortalPresentation, portalRedesignEnrolled } from "@/lib/portal/presentation-server";

vi.mock("server-only", () => ({}));
const { admin } = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: admin }));

const first = "d6d5e7a0-7ad0-43ca-a19f-27a230fff58d";
const second = "031fa3b3-4b10-4337-850a-53cdf4f65623";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); admin.mockReset(); });

describe("portal presentation", () => {
  it("resolves only declared placeholders using the correct studio and public contact name", () => {
    expect(formatPortalCopy("{studio} · {owner} · {client}", { studioName: "Studio $&", ownerName: "", clientName: "Lee" }))
      .toBe("Studio $& · Studio $& · Lee");
    expect(formatPortalCopy("Ask {owner}", { studioName: "Second", ownerName: "Dr. Kim", clientName: "Lee" })).toBe("Ask Dr. Kim");
  });
  it("requires the complete, unique overview sections with bounded text and boolean visibility", () => {
    const orig = defaultPortalPresentation();
    const swapped = { ...orig, sections: orig.sections.slice().reverse() };
    expect(parsePortalPresentation(swapped)).toEqual(swapped);
    expect(parsePortalPresentation({ ...orig, sections: [...orig.sections.slice(0, -1), orig.sections[0]] })).toBeNull();
    expect(parsePortalPresentation({ ...orig, sections: orig.sections.slice(1) })).toBeNull();
    expect(parsePortalPresentation({ ...orig, sections: orig.sections.map(s => ({ ...s, visible: "true" })) })).toBeNull();
    expect(parsePortalPresentation({ ...orig, welcomeHeading: " " })).toBeNull();
    expect(parsePortalPresentation({ ...orig, welcomeMessage: "a".repeat(601) })).toBeNull();
  });
  it("defaults to classic, ignores wildcards and avoids any database access for unenrolled studios", async () => {
    vi.stubEnv("HONE_PORTAL_REDESIGN_STUDIO_IDS", "*," + first);
    expect(portalRedesignEnrolled(first)).toBe(true);
    expect(portalRedesignEnrolled(second)).toBe(false);
    expect(await getPublishedPortalPresentation(second)).toBeNull();
    vi.stubEnv("HONE_PORTAL_REDESIGN_STUDIO_IDS", "");
    expect(await getPublishedPortalPresentation(first)).toBeNull();
    expect(admin).not.toHaveBeenCalled();
  });
  it("reads only published content for the exact enrolled studio and rechecks each request", async () => {
    vi.stubEnv("HONE_PORTAL_REDESIGN_STUDIO_IDS", first);
    const result = vi.fn().mockResolvedValueOnce({ data: { published: defaultPortalPresentation() }, error: null })
      .mockResolvedValueOnce({ data: { published: null }, error: null }).mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { published: { bad: true } }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "42P01" } }).mockRejectedValueOnce(new Error("offline"));
    const query = { from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: result };
    admin.mockReturnValue(query);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getPublishedPortalPresentation(first)).toEqual(defaultPortalPresentation());
    for (let i = 0; i < 5; i++) expect(await getPublishedPortalPresentation(first)).toBeNull();
    expect(result).toHaveBeenCalledTimes(6);
    expect(query.from).toHaveBeenCalledWith("studio_portal_presentations");
    expect(query.select).toHaveBeenCalledWith("published");
    expect(query.eq).toHaveBeenCalledWith("studio_id", first);
  });
});
