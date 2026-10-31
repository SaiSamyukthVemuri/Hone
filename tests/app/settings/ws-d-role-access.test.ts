import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

// WS-D (settings redesign): role-aware access, enforced on the server. Synthetic ids only.
const ensure = vi.fn(async () => ({ deduped: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({ ensurePractitionerNotification: (...a: unknown[]) => ensure(...(a as [])) }));

import { OWNER_ONLY_NOTIFICATION_EVENT_TYPES, scopeNotificationsToViewer } from "@/lib/notifications/owner-only-events";
import { ensureCardChangeNotification } from "@/lib/billing/card-change-notification";

const read = (p: string) => readFileSync(p, "utf8");

describe("owner-only notification scope", () => {
  const spy = () => { const calls: unknown[][] = []; const q = { not: (...a: unknown[]) => { calls.push(a); return q; } }; return { q, calls }; };

  it("lists exactly the two card-on-file event types", () => {
    expect([...OWNER_ONLY_NOTIFICATION_EVENT_TYPES]).toEqual(["card_added", "card_replaced"]);
  });
  it("leaves the owner's query unchanged", () => {
    const { q, calls } = spy();
    expect(scopeNotificationsToViewer(q, true)).toBe(q);
    expect(calls).toEqual([]);
  });
  it("excludes the card types for every other role", () => {
    const { q, calls } = spy();
    scopeNotificationsToViewer(q, false);
    expect(calls).toEqual([["event_type", "in", "(card_added,card_replaced)"]]);
  });
  it("every retrieval path uses the scope: page, header badge, mark-all-read", () => {
    for (const f of ["app/(app)/notifications/page.tsx", "app/(app)/notifications/actions.ts", "app/(app)/layout.tsx"]) {
      expect(read(f), f).toMatch(/scopeNotificationsToViewer\(/);
      expect(read(f), f).toMatch(/role === "owner"|viewerIsOwner/);
    }
  });
});

describe("card-change notification DELIVERY is owner-only", () => {
  const OWNER = "00000000-0000-4000-8000-0000000000a1";
  function fakeAdmin(owner: { id: string } | null) {
    const chain = (data: unknown, count?: number) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "limit"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data, error: null });
      c.then = (res: (v: unknown) => unknown) => res({ data: null, error: null, count });
      return c;
    };
    return {
      from: (table: string) => table === "client_payment_methods" ? chain({ brand: "visa", last4: "4242" }, 1)
        : table === "clients" ? chain({ name: "Synthetic Client" }) : chain(owner),
    };
  }
  const params = { studioId: "s", clientId: "c", livemode: false, setupIntentId: "seti_1" };
  beforeEach(() => ensure.mockClear());

  it("targets the owner's practitioner row, never studio-wide", async () => {
    await ensureCardChangeNotification(fakeAdmin({ id: OWNER }) as never, params as never);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect((ensure.mock.calls[0] as unknown[])[1]).toMatchObject({ practitionerId: OWNER });
  });
  it("throws (so Stripe retries) when the studio has no active owner, and writes nothing", async () => {
    await expect(ensureCardChangeNotification(fakeAdmin(null) as never, params as never)).rejects.toThrow("card_change_owner_missing");
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("owner-only pages and surfaces refuse before any read", () => {
  it("Practice Snapshot renders for the owner only", () => {
    const s = read("app/(app)/dashboard/secondary-stack.tsx");
    expect(s).toMatch(/\{isOwner && \(\s*<PracticeSnapshot/);
  });
  it("Practice Capacity keeps its owner check before the capacity read", () => {
    const s = read("app/(app)/dashboard/capacity/page.tsx");
    expect(s.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(-1);
    expect(s.indexOf('practitioner.role !== "owner"')).toBeLessThan(s.indexOf("getOwnerCapacityBriefing("));
  });
  for (const [page, readMarker] of [
    ["app/(app)/settings/launch/page.tsx", "getNewClientReadiness("],
    ["app/(app)/settings/data/page.tsx", "loadCounts("],
  ] as const) {
    it(`${page} refuses a non-owner before ${readMarker}`, () => {
      const s = read(page);
      const guard = s.indexOf('practitioner.role !== "owner"');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(s.indexOf(readMarker, s.indexOf("export default")));
    });
  }
  it("the Launch tab sits in the owner-gated block of the settings nav", () => {
    const s = read("app/(app)/settings/layout.tsx");
    expect(s.indexOf('href: "/settings/launch"')).toBeGreaterThan(s.indexOf("...(isOwner"));
  });
  it("studio-wide calendar preferences (time format, birthday colour) are saved only by an owner, at the action", () => {
    const s = read("app/(app)/settings/studio/actions.ts");
    const fn = s.slice(s.indexOf("export async function updateStudioAction"));
    const guard = fn.indexOf('practitioner.role !== "owner"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf("time_format_preference"));
    expect(guard).toBeLessThan(fn.indexOf("birthday_reminder_color"));
  });
});

import { isLaunchComplete, launchDestinationVisible } from "@/lib/settings/launch-completion";

describe("launch completion predicate (decision D4): derived, owner-only 'Setup' while incomplete", () => {
  const done = { send_confirmation_emails: true, postcare_aftercare_text: "Keep it dry.", cancellation_policy_text: "24h", no_show_policy_text: "Fee" };
  const ready = { status: "ready" } as const;
  it("is complete only when the booking authority is ready and the page's own must-haves are set", () => {
    expect(isLaunchComplete(ready, done)).toBe(true);
    expect(isLaunchComplete(ready, { ...done, send_confirmation_emails: false })).toBe(false);
    expect(isLaunchComplete(ready, { ...done, postcare_aftercare_text: "  " })).toBe(false);
    expect(isLaunchComplete(ready, { ...done, postcare_aftercare_text: null })).toBe(false);
    expect(isLaunchComplete(ready, { ...done, cancellation_policy_text: "" })).toBe(false);
    expect(isLaunchComplete(ready, { ...done, no_show_policy_text: null })).toBe(false);
  });
  it("an authority that is not ready, or could not answer, is never complete", () => {
    expect(isLaunchComplete({ status: "not_ready", blockers: [], nextStep: null, unavailable: [] } as never, done)).toBe(false);
    expect(isLaunchComplete({ status: "unknown", unavailable: [] } as never, done)).toBe(false);
  });
  it("visible to the owner only, and only while incomplete", () => {
    expect(launchDestinationVisible("owner", false)).toBe(true);
    expect(launchDestinationVisible("owner", true)).toBe(false);
    for (const role of ["practitioner", "receptionist", "", "admin"]) expect(launchDestinationVisible(role, false)).toBe(false);
  });
  it("the page redirects a complete studio away and shares the predicate's facts; the nav label is Setup", () => {
    const page = readFileSync("app/(app)/settings/launch/page.tsx", "utf8");
    expect(page).toMatch(/isLaunchComplete\(readiness, studio\)\) redirect\("\/settings\/profile"\)/);
    expect(page).toMatch(/studioHasAftercare\(studio\)/);
    expect(readFileSync("app/(app)/settings/layout.tsx", "utf8")).toMatch(/launchVisible \? \[\{ href: "\/settings\/launch", label: "Setup" \}\]/);
  });
});
