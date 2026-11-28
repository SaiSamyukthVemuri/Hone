import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { checkActiveConsentTemplatesForPortal, getLatestSignaturesByTemplateForPortal } from "@/lib/consent/queries";
import { readActiveCardForStudioClient, getActiveCardForStudioClient } from "@/lib/payment-methods/queries";
import { getPortalIdentity } from "@/lib/portal/queries";

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
function database(fetch: typeof globalThis.fetch) {
  vi.mocked(createAdminClient).mockReturnValue(createClient("http://test.invalid", "fixture", { global: { fetch } }));
}
afterEach(() => vi.restoreAllMocks());

describe("portal record lookup failures", () => {
  it.each([
    ["rejected", () => Response.json({ code: "42501", message: "permission denied" }, {status: 403})],
    ["missing body", () => new Response(null, {status: 204})],
  ] as const)("keeps unreadable consent out of signed or unsigned totals (%s)", async (_label, reply) => {
    database(async () => reply());
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkActiveConsentTemplatesForPortal("studio")).toEqual({status: "unavailable"});
    expect(await getLatestSignaturesByTemplateForPortal("studio","client")).toBeNull();
  });
  it("returns empty forms and signatures only when both queries return real lists", async () => {
    database(async () => Response.json([]));
    expect(await checkActiveConsentTemplatesForPortal("studio")).toEqual({status:"ok",templates:[]});
    expect(await getLatestSignaturesByTemplateForPortal("studio","client")).toEqual(new Map());
  });
  it("distinguishes unavailable identity from an archived client and withholds the studio query in both cases", async () => {
    const fetch = vi.fn(async () => Response.json({code: "42501"}, { status:403 }));
    database(fetch);
    expect(await getPortalIdentity("studio", "client")).toBeUndefined();
    fetch.mockImplementation(async () => Response.json([{ id:"client", archived_at:"2026-01-01" }]));
    expect(await getPortalIdentity("studio", "client")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps the existing practitioner fallback while giving the portal a distinct failed card result", async () => {
    database(async () => Response.json({code:"42501"}, {status:403}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readActiveCardForStudioClient("studio", "client")).toBeUndefined();
    expect(await getActiveCardForStudioClient("studio", "client")).toBeNull();
    database(async () => Response.json([]));
    expect(await readActiveCardForStudioClient("studio", "client")).toBeNull();
  });
});
