import { describe, expect, it, vi } from "vitest";

// Sam decision 2 (1 Nov): a practitioner MAY see the studio's PUBLISHED service-list price when
// booking. The client-finance absences are pinned in profile-pricing.test.ts and stay unchanged.
// Positive control: the services read the profile page makes (no price option) carries the price.
const SERVICE_PRICE_CENTS = 4242;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const self: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => void) =>
            res({ data: [{ id: "svc1", studio_id: "s1", name: "Synthetic service", price_cents: SERVICE_PRICE_CENTS }], error: null });
        }
        return () => self;
      },
    });
    return { from: () => self };
  },
}));

describe("practitioner booking card keeps the published service price", () => {
  it("the profile's services read (no includePrices option) returns the price", async () => {
    const { getActiveServices } = await import("@/lib/booking/queries");
    const rows = await getActiveServices("s1");
    expect(rows[0]?.price_cents).toBe(SERVICE_PRICE_CENTS);
  });

  it("the negative control still strips: an explicit includePrices:false returns null", async () => {
    const { getActiveServices } = await import("@/lib/booking/queries");
    const rows = await getActiveServices("s1", { includePrices: false });
    expect(rows[0]?.price_cents).toBeNull();
  });
});
