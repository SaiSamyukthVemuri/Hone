import { describe, expect, it, vi } from "vitest";

// The Settings rail is a server-evaluated registry (lib/settings/nav-registry.ts).
// These resolve the REAL registry for each role. The waitlist entry's own
// visibility rule is proved separately in waitlist-nav-visibility.test.ts, so
// its dependencies are stubbed to "not visible" here.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/booking/new-client-admission", () => ({
  getNewClientAdmissionMode: async () => ({ ok: true, mode: "open", source: "persisted" }),
}));
vi.mock("@/lib/booking/new-client-waitlist-durability-bridge", () => ({
  newClientWaitlistCommitIsDurable: () => false,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/waitlist/operator-queue-presence", () => ({
  hasActiveWaitlistEntries: async () => false,
}));

import { resolveSettingsNav, type SettingsNavEntry } from "@/lib/settings/nav";
import { SETTINGS_NAV } from "@/lib/settings/nav-registry";
import type { Studio } from "@/lib/types/database";

const studio = { id: "s", slug: "x" } as unknown as Studio;
const hrefs = async (role: "owner" | "practitioner") =>
  (await resolveSettingsNav(SETTINGS_NAV, { role, studio })).map((i) => i.href);

describe("settings nav registry", () => {
  it("an owner sees every studio page, including Marketing & analytics", async () => {
    const owner = await hrefs("owner");
    for (const h of [
      "/settings/profile",
      "/settings/intake",
      "/settings/studio",
      "/settings/team",
      "/settings/booking",
      "/settings/availability",
      "/settings/services",
      "/settings/machines",
      "/settings/consent",
      "/settings/payments",
      "/settings/integrations",
      "/settings/tracking",
      "/settings/import",
      "/settings/data",
    ]) {
      expect(owner).toContain(h);
    }
  });

  it("a practitioner is never handed an owner-only entry", async () => {
    const practitioner = await hrefs("practitioner");
    for (const h of [
      "/settings/studio",
      "/settings/team",
      "/settings/booking",
      "/settings/waitlist",
      "/settings/availability",
      "/settings/services",
      "/settings/machines",
      "/settings/consent",
      "/settings/payments",
      "/settings/integrations",
      "/settings/tracking",
      "/settings/import",
      "/settings/data",
    ]) {
      expect(practitioner).not.toContain(h);
    }
    expect(practitioner).toContain("/settings/profile");
    expect(practitioner).toContain("/settings/intake");
  });

  it("owner-only sections of a shared page are filtered out for a practitioner", async () => {
    const items = await resolveSettingsNav(SETTINGS_NAV, { role: "practitioner", studio });
    const forms = items.find((i) => i.id === "forms");
    expect(forms?.sections.map((s) => s.id)).toEqual(["intake-preview"]);
    const owner = await resolveSettingsNav(SETTINGS_NAV, { role: "owner", studio });
    expect(owner.find((i) => i.id === "forms")?.sections.map((s) => s.id)).toEqual([
      "postcare",
      "intake-preview",
      "policies",
    ]);
  });

  it("entry ids and hrefs are unique", () => {
    const ids = SETTINGS_NAV.map((e) => e.id);
    const paths = SETTINGS_NAV.map((e) => e.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("resolveSettingsNav", () => {
  const entry = (over: Partial<SettingsNavEntry>): SettingsNavEntry => ({
    id: "e",
    group: "studio",
    label: "E",
    href: "/settings/e",
    roles: ["owner", "practitioner"],
    order: 1,
    ...over,
  });

  it("a visibleWhen that throws hides the entry (fails closed)", async () => {
    const out = await resolveSettingsNav(
      [
        entry({
          visibleWhen: () => {
            throw new Error("flag read failed");
          },
        }),
      ],
      { role: "owner", studio },
    );
    expect(out).toEqual([]);
  });

  it("visibleWhen is not consulted for a role the static list excludes", async () => {
    const visibleWhen = vi.fn(async () => true);
    const out = await resolveSettingsNav([entry({ roles: ["owner"], visibleWhen })], {
      role: "practitioner",
      studio,
    });
    expect(out).toEqual([]);
    expect(visibleWhen).not.toHaveBeenCalled();
  });

  it("orders by group, then order, then registry position", async () => {
    const out = await resolveSettingsNav(
      [
        entry({ id: "b", href: "/b", group: "studio", order: 2 }),
        entry({ id: "a", href: "/a", group: "studio", order: 1 }),
        entry({ id: "p", href: "/p", group: "personal", order: 9 }),
        entry({ id: "s", href: "/s", group: "setup", order: 9 }),
      ],
      { role: "owner", studio },
    );
    expect(out.map((i) => i.id)).toEqual(["s", "p", "a", "b"]);
  });
});
