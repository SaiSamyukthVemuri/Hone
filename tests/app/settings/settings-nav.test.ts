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
// Every route the rail would offer: a flat entry's own route and each child view.
const hrefs = async (role: "owner" | "practitioner") =>
  (await resolveSettingsNav(SETTINGS_NAV, { role, studio })).flatMap((i) =>
    i.children.length ? i.children.map((c) => c.href) : [i.href],
  );

describe("settings nav registry", () => {
  it("an owner sees every studio view, including Marketing & analytics", async () => {
    const owner = await hrefs("owner");
    for (const h of [
      "/settings/profile",
      "/settings/calendar/display",
      "/settings/studio/details",
      "/settings/studio/email",
      "/settings/studio/text-messages",
      "/settings/studio/client-self-service",
      "/settings/forms/postcare",
      "/settings/forms/intake-preview",
      "/settings/forms/cancellation-policy",
      "/settings/team",
      "/settings/booking/link",
      "/settings/booking/window",
      "/settings/availability",
      "/settings/services",
      "/settings/machines",
      "/settings/consent",
      "/settings/payments/setup",
      "/settings/payments/card-on-file",
      "/settings/payments/fees",
      "/settings/integrations/google-calendar",
      "/settings/integrations/text-messaging",
      "/settings/integrations/marketing",
      "/settings/import",
      "/settings/data",
    ]) {
      expect(owner).toContain(h);
    }
  });

  it("a practitioner is never handed an owner-only view", async () => {
    const practitioner = await hrefs("practitioner");
    for (const h of [
      "/settings/calendar/display",
      "/settings/studio/details",
      "/settings/team",
      "/settings/booking/link",
      "/settings/waitlist",
      "/settings/availability",
      "/settings/services",
      "/settings/machines",
      "/settings/consent",
      "/settings/payments/setup",
      "/settings/integrations/google-calendar",
      "/settings/integrations/marketing",
      "/settings/forms/postcare",
      "/settings/forms/cancellation-policy",
      "/settings/import",
      "/settings/data",
    ]) {
      expect(practitioner).not.toContain(h);
    }
    expect(practitioner).toContain("/settings/profile");
    expect(practitioner).toContain("/settings/forms/intake-preview");
  });

  it("owner-only views of a shared group are filtered out for a practitioner", async () => {
    const items = await resolveSettingsNav(SETTINGS_NAV, { role: "practitioner", studio });
    const forms = items.find((i) => i.id === "forms");
    expect(forms?.children.map((c) => c.id)).toEqual(["forms-intake-preview"]);
    const owner = await resolveSettingsNav(SETTINGS_NAV, { role: "owner", studio });
    expect(owner.find((i) => i.id === "forms")?.children.map((c) => c.id)).toEqual([
      "forms-postcare",
      "forms-intake-preview",
      "forms-cancellation-policy",
    ]);
  });

  it("a group opens at its first visible view", async () => {
    const owner = await resolveSettingsNav(SETTINGS_NAV, { role: "owner", studio });
    const forms = owner.find((i) => i.id === "forms");
    expect(forms?.href).toBe("/settings/forms/postcare");
    const practitioner = await resolveSettingsNav(SETTINGS_NAV, { role: "practitioner", studio });
    expect(practitioner.find((i) => i.id === "forms")?.href).toBe("/settings/forms/intake-preview");
  });

  it("with no Calendar slot, a practitioner has no Calendar group (no placeholder)", async () => {
    const practitioner = await resolveSettingsNav(SETTINGS_NAV, { role: "practitioner", studio });
    expect(practitioner.find((i) => i.id === "calendar")).toBeUndefined();
  });

  it("flat pages have no dropdown", async () => {
    const owner = await resolveSettingsNav(SETTINGS_NAV, { role: "owner", studio });
    for (const id of ["team", "availability", "services", "machines", "consent", "import", "data"]) {
      expect(owner.find((i) => i.id === id)?.children).toEqual([]);
    }
  });

  it("every view route sits under its group's base, and routes are unique", async () => {
    const owner = await resolveSettingsNav(SETTINGS_NAV, { role: "owner", studio });
    const seen: string[] = [];
    for (const g of owner.filter((i) => i.children.length)) {
      for (const c of g.children) {
        if (g.id !== "profile") expect(c.href.startsWith(`${g.base}/`)).toBe(true);
        seen.push(c.href);
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("every old-hash redirect lands on a real rail route", async () => {
    const { SETTINGS_HASH_REDIRECTS } = await import("@/lib/settings/redirects");
    const owner = new Set(await hrefs("owner"));
    for (const [hash, target] of Object.entries(SETTINGS_HASH_REDIRECTS)) {
      expect(owner.has(target), `#${hash} -> ${target}`).toBe(true);
    }
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
