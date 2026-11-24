import { describe, expect, it, vi } from "vitest";
import { resolveSettingsNav } from "@/lib/settings/nav";
import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import { buildSettingsOverview } from "@/lib/settings/overview";
import type { Studio } from "@/lib/types/database";
import type { OverviewSection } from "@/lib/settings/overview";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/booking/new-client-admission", () => ({
  getNewClientAdmissionMode: async () => ({ ok: true, mode: "closed", source: "persisted" }),
}));
vi.mock("@/lib/booking/new-client-waitlist-durability-bridge", () => ({ newClientWaitlistCommitIsDurable: () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/waitlist/operator-queue-presence", () => ({ hasActiveWaitlistEntries: async () => false }));

const studio = { id: "studio-1", slug: "synthetic" } as Studio;
const links = (sections: OverviewSection[]) => sections.flatMap((section) => section.links);

describe("Settings overview", () => {
  it("offers the exact visible owner paths and their search vocabulary", async () => {
    const items = await resolveSettingsNav(SETTINGS_NAV, { role: "owner", studio });
    const sections = buildSettingsOverview(items, { isOwner: true, googleCalendarEnabled: false });
    const results = links(sections);
    const urls = results.map((l) => l.href);
    for (const item of items) {
      for (const leaf of item.children.length ? item.children : [item]) expect(urls).toContain(leaf.href);
    }
    expect(results.find((l) => l.href === "/settings/services")?.keywords).toContain("colour picker");
    expect(results.find((l) => l.href === "/settings/booking/window")?.keywords).toContain("buffer");
    expect(urls).not.toContain("/waitlist");
    expect(urls).not.toContain("/settings/profile#google-calendar");
    expect(new Set(urls).size).toBe(urls.length);
    expect(sections.map(({ name }) => name)).not.toContain("Other settings");
  });

  it("only ships role-visible pages and search vocabulary, including flag-gated personal integrations", async () => {
    const items = await resolveSettingsNav(SETTINGS_NAV, { role: "practitioner", studio });
    const sections = buildSettingsOverview(items, { isOwner: false, googleCalendarEnabled: false });
    const urls = links(sections).map((l) => l.href);
    expect(urls.sort()).toEqual(["/settings/forms/intake-preview", "/settings/profile", "/settings/profile#calendar-feed"]);
    expect(JSON.stringify(sections)).not.toMatch(/Stripe setup|Payments & fees|settings\/team|colour picker|google-calendar/);
    expect(links(buildSettingsOverview(items, { isOwner: false, googleCalendarEnabled: true })).map((l) => l.href))
      .toContain("/settings/profile#google-calendar");
  });
});
