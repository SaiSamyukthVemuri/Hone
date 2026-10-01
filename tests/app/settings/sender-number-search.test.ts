import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// SMS-NUMBER-SEARCH-01 — the owner's number lookup, wired
// ===========================================================================
//
// THESE PROVE THE SEAM, NOT THE RULE. That the search writes nothing, clamps
// its own page size and validates its own inputs is `searchAvailableSenderNumbers`'
// business and is proved in tests/lib/sms/provisioning.test.ts. That the fake is
// the default provider is proved in tests/source-guards/sms-provider-guards.test.ts.
//
// What can go wrong HERE is the wiring: skipping the owner check, trusting a
// browser-supplied studio, handing a raw provider error code to a practitioner,
// forwarding the provider's object (and one day a SID with it), or reaching for
// an admin client a read-only lookup has no use for.

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));

// A read-only candidate search needs no elevated privilege. If one is ever
// constructed here, that is a design change and this throws rather than letting
// the test pass quietly.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error("number lookup must not construct a service-role client");
  }),
}));

// The action resolves its provider through the fence. The fence's own behaviour
// is pinned elsewhere; here the fake is injected so the seam can be exercised
// without an environment variable deciding the outcome.
vi.mock("@/lib/sms/provider", () => ({
  resolveProvisioningProvider: () => provider,
}));

import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { searchSenderNumbersAction } from "@/app/(app)/settings/integrations/actions";
import type { ProviderErrorCode } from "@/lib/sms/provider/types";

const STUDIO = "11111111-1111-1111-1111-111111111111";

let provider: FakeSmsProvisioningProvider;

function arrangeProvider(script: { searchFails?: ProviderErrorCode } = {}) {
  provider = new FakeSmsProvisioningProvider(script);
}

function arrangeRole(role: "owner" | "practitioner") {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { id: "actor", role },
    studio: { id: STUDIO, name: "Willow" },
  } as unknown as Awaited<ReturnType<typeof getCurrentPractitionerWithStudio>>);
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  arrangeProvider();
  arrangeRole("owner");
});

describe("authorization", () => {
  it("refuses a non-owner", async () => {
    arrangeRole("practitioner");
    const out = await searchSenderNumbersAction(null, form({ country: "CA" }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.message).toMatch(/only the studio owner/i);
  });

  it("refuses a non-owner BEFORE touching the provider", async () => {
    // The ordering is the point. A refusal that still enumerates has already
    // asked the provider a question on behalf of someone not entitled to ask.
    arrangeRole("practitioner");
    await searchSenderNumbersAction(null, form({ country: "CA" }));
    expect(provider.calls.search).toBe(0);
  });

  it("never takes a studio id from the form", async () => {
    // Identity is re-derived from the session, so a forged studio id changes
    // nothing. If this ever starts reading the form, the action would be
    // enumerating for whatever studio the browser named.
    await searchSenderNumbersAction(
      null,
      form({ country: "CA", studioId: "99999999-9999-9999-9999-999999999999" }),
    );
    expect(getCurrentPractitionerWithStudio).toHaveBeenCalled();
  });
});

describe("input refusals carry practitioner copy, not provider codes", () => {
  it("refuses a missing country", async () => {
    const out = await searchSenderNumbersAction(null, form({}));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.message).toMatch(/two-letter country code/i);
    expect(provider.calls.search).toBe(0);
  });

  it("refuses a malformed area code", async () => {
    const out = await searchSenderNumbersAction(
      null,
      form({ country: "CA", areaCode: "41x" }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.message).toMatch(/2 to 5 digits/i);
    expect(provider.calls.search).toBe(0);
  });

  it("treats a blank area code as absent rather than invalid", async () => {
    // The field is optional, and an empty string is what an untouched input
    // actually submits — not something to refuse.
    const out = await searchSenderNumbersAction(
      null,
      form({ country: "CA", areaCode: "   " }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.searchedAreaCode).toBeNull();
  });
});

describe("a successful lookup", () => {
  it("returns candidates", async () => {
    const out = await searchSenderNumbersAction(
      null,
      form({ country: "CA", areaCode: "416" }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.candidates[0].phoneNumber).toMatch(/^\+1416\d{7}$/);
  });

  it("states the scope it actually searched", async () => {
    // The result must not read as "these are all the numbers available".
    const out = await searchSenderNumbersAction(
      null,
      form({ country: "ca", areaCode: "604" }),
    );
    if (!out.ok) throw new Error("unreachable");
    expect(out.searchedCountry).toBe("CA");
    expect(out.searchedAreaCode).toBe("604");
  });

  it("carries no provider SID on any candidate", async () => {
    // 0191 excludes phone_number_sid and messaging_service_sid from the
    // browser's column grant precisely so a SID can never become something the
    // browser knows. Nothing has been bought at search time, so no SID exists
    // yet — this pins the shape so a later field cannot arrive by a spread.
    const out = await searchSenderNumbersAction(null, form({ country: "CA" }));
    if (!out.ok) throw new Error("unreachable");
    for (const candidate of out.candidates) {
      expect(Object.keys(candidate).sort()).toEqual([
        "country",
        "formatted",
        "locality",
        "phoneNumber",
        "region",
        "smsCapable",
      ]);
    }
    expect(JSON.stringify(out)).not.toMatch(/sid/i);
  });

  it("constructs no service-role client", async () => {
    await searchSenderNumbersAction(null, form({ country: "CA" }));
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("writes nothing — the lookup is repeatable with no accumulated effect", async () => {
    // "An owner may browse as often as they like and it costs nothing and
    // commits to nothing." Three searches, and the fake still owns nothing.
    await searchSenderNumbersAction(null, form({ country: "CA" }));
    await searchSenderNumbersAction(null, form({ country: "CA" }));
    await searchSenderNumbersAction(null, form({ country: "CA" }));
    expect(provider.calls.search).toBe(3);
    expect(provider.ownedNumbers()).toEqual([]);
  });
});

describe("provider failures are translated, never echoed", () => {
  const CASES: ReadonlyArray<{ code: ProviderErrorCode; expect: RegExp }> = [
    { code: "no_numbers_available", expect: /no numbers are available/i },
    { code: "provider_rate_limited", expect: /too many lookups/i },
    { code: "provider_timeout", expect: /timed out/i },
    { code: "provider_not_configured", expect: /not switched on/i },
  ];

  for (const c of CASES) {
    it(`${c.code} becomes a sentence a practitioner can act on`, async () => {
      arrangeProvider({ searchFails: c.code });
      const out = await searchSenderNumbersAction(null, form({ country: "CA" }));
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.message).toMatch(c.expect);
      // The raw code is support vocabulary, not an explanation.
      expect(out.message).not.toContain(c.code);
    });
  }

  it("never names the provider to the practitioner", async () => {
    // The owner is choosing a phone number, not operating a provider account.
    arrangeProvider({ searchFails: "provider_unauthorized" });
    const out = await searchSenderNumbersAction(null, form({ country: "CA" }));
    if (out.ok) throw new Error("unreachable");
    expect(out.message).not.toMatch(/twilio/i);
  });

  it("does not invite a retry for a condition the owner cannot clear", async () => {
    // An unarmed deployment is not a transient failure. Telling an owner to
    // "try again" when nothing they do can change the answer is the overclaim.
    arrangeProvider({ searchFails: "provider_not_configured" });
    const out = await searchSenderNumbersAction(null, form({ country: "CA" }));
    if (out.ok) throw new Error("unreachable");
    expect(out.message).not.toMatch(/try again/i);
  });
});
