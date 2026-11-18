import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import {
  NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV,
  NEW_CLIENT_WAITLIST_SLUGS_ENV,
} from "@/lib/booking/new-client-waitlist";
import { isCurrentSection } from "@/app/(app)/PrimaryNavLink";

// "Waitlist" in the main navigation.
//
// The rule is the Settings tab's rule, REUSED: the same function decides both, so these tests compare the two decisions across the
// whole matrix instead of restating the rule. Admission being Closed never hides it; a practitioner never sees it; another
// studio's queue never lights it; a failed read hides it. Synthetic studios and ids only.

const SLUG_A = "studio-a";
const SLUG_B = "studio-b";
const scenario = {
  studio: "A" as "A" | "B",
  role: "owner" as "owner" | "member",
  rows: [] as Array<{ studio_id: string; status: string }>,
  error: null as null | { code: string },
};
const idOf = () => (scenario.studio === "A" ? "studio-id-a" : "studio-id-b");
const slugOf = () => (scenario.studio === "A" ? SLUG_A : SLUG_B);
const admission: { value: { ok: boolean; mode?: string; source?: string } } = { value: { ok: true, mode: "open", source: "persisted" } };

vi.mock("@/lib/booking/new-client-admission", async (orig) => ({
  ...(await orig<typeof import("@/lib/booking/new-client-admission")>()),
  getNewClientAdmissionMode: vi.fn(async () => admission.value),
}));
vi.mock("@/lib/booking/new-client-readiness", () => ({ getNewClientReadiness: async () => ({ status: "unknown", unavailable: [] }) }));
vi.mock("@/lib/supabase/queries", () => {
  const identity = async () => ({
    practitioner: { id: "prac-1", role: scenario.role, user_id: "user-1" },
    studio: { id: idOf(), slug: slugOf(), name: "Synthetic Studio" },
  });
  return { getCurrentPractitionerWithStudio: identity, requirePractitionerWithStudio: identity };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      const filters: Array<[string, string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), builder),
        in: (c: string, v: unknown[]) => (filters.push(["in", c, v]), builder),
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          if (scenario.error) return Promise.resolve({ data: null, count: null, error: scenario.error }).then(resolve, reject);
          const n = scenario.rows.filter((r) => filters.every(([op, c, v]) => (op === "eq" ? (r as Record<string, unknown>)[c] === v : (v as unknown[]).includes((r as Record<string, unknown>)[c])))).length;
          return Promise.resolve({ data: null, count: n, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("service-role client used by the shell"); } }));

const envKeys = [NEW_CLIENT_WAITLIST_SLUGS_ENV, NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV];
let saved: Array<readonly [string, string | undefined]> = [];
const setFlags = (on: boolean) => { for (const k of envKeys) { if (on) process.env[k] = `${SLUG_A},${SLUG_B}`; else delete process.env[k]; } };

function findItems(node: ReactNode): Array<{ href: string; label: string }> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const c of node) { const f = findItems(c); if (f) return f; } return null; }
  const el = node as ReactElement<{ items?: unknown; children?: ReactNode }>;
  if (Array.isArray(el.props?.items)) return el.props.items as Array<{ href: string; label: string }>;
  return findItems(el.props?.children);
}
async function settingsTabShown() {
  const { default: SettingsLayout } = await import("@/app/(app)/settings/layout");
  return (findItems(await SettingsLayout({ children: null })) ?? []).some((i) => i.href === "/settings/waitlist" && i.label === "Waitlist");
}
async function navShown() {
  const { showWaitlistInPrimaryNav } = await import("@/lib/settings/nav-registry");
  return showWaitlistInPrimaryNav({ role: scenario.role === "owner" ? "owner" : "practitioner", studio: { id: idOf(), slug: slugOf(), name: "Synthetic Studio" } as never });
}

beforeEach(() => {
  saved = envKeys.map((k) => [k, process.env[k]] as const);
  Object.assign(scenario, { studio: "A", role: "owner", rows: [], error: null });
  admission.value = { ok: true, mode: "open", source: "persisted" };
  setFlags(false);
});
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } vi.restoreAllMocks(); });

describe("the main navigation entry follows the Settings tab's rule, exactly", () => {
  const modes = [
    { mode: "open" }, { mode: "waitlist" }, { mode: "closed" },
  ];
  const rowSets: Array<[string, Array<{ studio_id: string; status: string }>]> = [
    ["no entries", []],
    ["an active entry in this studio", [{ studio_id: "studio-id-a", status: "waiting" }]],
    ["only removed/converted history", [{ studio_id: "studio-id-a", status: "removed" }, { studio_id: "studio-id-a", status: "converted" }]],
    ["an active entry in ANOTHER studio", [{ studio_id: "studio-id-b", status: "waiting" }]],
  ];
  for (const role of ["owner", "member"] as const) for (const flags of [true, false]) for (const m of modes) for (const [label, rows] of rowSets) {
    it(`role ${role}, flags ${flags ? "on" : "off"}, admission ${m.mode}, ${label}: nav == settings tab`, async () => {
      scenario.role = role; scenario.rows = rows; setFlags(flags);
      admission.value = { ok: true, mode: m.mode, source: "persisted" };
      expect(await navShown()).toBe(await settingsTabShown());
    });
  }

  it("anti-vacuity: the matrix includes both a shown and a hidden answer", async () => {
    scenario.rows = [{ studio_id: "studio-id-a", status: "waiting" }];
    expect(await navShown()).toBe(true);
    scenario.rows = [];
    expect(await navShown()).toBe(false);
  });
});

describe("enabled, disabled, Closed, roles, studio switching, failure", () => {
  it("enabled (waitlist mode, durable): shown for an owner", async () => {
    admission.value = { ok: true, mode: "waitlist", source: "persisted" };
    expect(await navShown()).toBe(true);
  });
  it("admission CLOSED does not hide it while the studio has a queue", async () => {
    admission.value = { ok: true, mode: "closed", source: "persisted" };
    scenario.rows = [{ studio_id: "studio-id-a", status: "invited" }];
    expect(await navShown()).toBe(true);
  });
  it("disabled and no queue: hidden", async () => {
    expect(await navShown()).toBe(false);
  });
  it("a practitioner never sees it, even with a queue and the feature on", async () => {
    scenario.role = "member"; scenario.rows = [{ studio_id: "studio-id-a", status: "waiting" }];
    admission.value = { ok: true, mode: "waitlist", source: "persisted" };
    expect(await navShown()).toBe(false);
  });
  it("studio switching: the answer is for the CURRENT studio only", async () => {
    scenario.rows = [{ studio_id: "studio-id-a", status: "waiting" }];
    scenario.studio = "A"; expect(await navShown()).toBe(true);
    scenario.studio = "B"; expect(await navShown()).toBe(false);
    scenario.studio = "A"; expect(await navShown()).toBe(true);
  });
  it("a failed read hides it and does not throw", async () => {
    scenario.rows = [{ studio_id: "studio-id-a", status: "waiting" }]; scenario.error = { code: "42501" };
    await expect(navShown()).resolves.toBe(false);
  });
  it("an admission lookup that throws hides it and does not throw", async () => {
    const mod = await import("@/lib/booking/new-client-admission");
    vi.mocked(mod.getNewClientAdmissionMode).mockRejectedValueOnce(new Error("boom"));
    await expect(navShown()).resolves.toBe(false);
  });
});

describe("placement and target (read from the real shell source)", () => {
  const layout = readFileSync("app/(app)/layout.tsx", "utf8");
  const mobile = readFileSync("app/(app)/MobileMenu.tsx", "utf8");
  it("desktop: Waitlist sits between Calendar and Records, links to the existing page, and is conditional", () => {
    const cal = layout.indexOf('testId="nav-calendar"');
    const wl = layout.indexOf('testId="nav-waitlist"');
    const rec = layout.indexOf('testId="nav-records"');
    expect(cal).toBeGreaterThan(-1);
    expect(wl).toBeGreaterThan(cal);
    expect(rec).toBeGreaterThan(wl);
    expect(layout).toMatch(/\{showWaitlist && \(\s*<PrimaryNavLink\s+href="\/settings\/waitlist"/);
  });
  it("mobile: Waitlist sits between Calendar and Records, only when shown, and defaults to hidden", () => {
    expect(mobile).toMatch(/\{ href: "\/calendar", label: "Calendar" \},\s*\.\.\.\(showWaitlist \? \[\{ href: "\/settings\/waitlist", label: "Waitlist" \}\] : \[\]\),\s*\{ href: "\/records", label: "Records" \}/);
    expect(mobile).toMatch(/showWaitlist = false/);
    expect(layout).toMatch(/<MobileMenu[\s\S]*?showWaitlist=\{showWaitlist\}/);
  });
  it("one decision feeds both menus, from the Settings tab's own function, with no second rule", () => {
    expect(layout.match(/showWaitlistInPrimaryNav\(/g) ?? []).toHaveLength(1);
    expect(layout).not.toMatch(/hasActiveWaitlistEntries|newClientWaitlistCommitIsDurable|getNewClientAdmissionMode/);
    const registry = readFileSync("lib/settings/nav-registry.ts", "utf8");
    expect(registry).toMatch(/visibleWhen: waitlistVisible/);
    expect(registry).toMatch(/showWaitlistInPrimaryNav[\s\S]*?waitlistVisible\(ctx\)/);
  });
  it("no new page and no migration: the target route is the existing one", () => {
    expect(readFileSync("app/(app)/settings/waitlist/page.tsx", "utf8")).toContain("requirePractitionerWithStudio");
  });
});

describe("active styling: the section stays lit on every waitlist subpage", () => {
  const href = "/settings/waitlist";
  it.each(["/settings/waitlist", "/settings/waitlist/", "/settings/waitlist/search", "/settings/waitlist/released", "/settings/waitlist/replies"])(
    "%s is current", (p) => expect(isCurrentSection(p, href, "section")).toBe(true),
  );
  it.each(["/settings/booking", "/settings/waitlisted", "/settings", "/calendar", "/records", null])(
    "%s is not current", (p) => expect(isCurrentSection(p as string | null, href, "section")).toBe(false),
  );
});
