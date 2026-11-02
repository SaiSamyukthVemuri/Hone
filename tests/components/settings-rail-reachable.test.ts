import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeSettingsLocation,
  currentSettingsRailId,
  resolveSettingsNav,
  resolveSettingsNavWithReachable,
  type SettingsNavEntry,
} from "@/lib/settings/nav";

const studio = {} as never;
const entries: SettingsNavEntry[] = [
  { id: "team", group: "studio", label: "Team", href: "/settings/team", roles: ["owner"], order: 30 },
  {
    id: "waitlist",
    group: "studio",
    label: "Waitlist",
    href: "/settings/waitlist",
    roles: ["owner"],
    visibleWhen: () => false,
    order: 50,
  },
  {
    id: "payments",
    group: "studio",
    label: "Payments",
    href: "/settings/payments",
    roles: ["owner"],
    children: [{ id: "payments-setup", label: "Payment setup", href: "/settings/payments/setup" }],
    order: 100,
  },
];

describe("reachable entries (Photos, 0ab9ce743: /settings/waitlist had no current item)", () => {
  it("an owner gets the hidden flat entry as reachable, never in the rail", async () => {
    const { items, reachable } = await resolveSettingsNavWithReachable(entries, { role: "owner", studio });
    expect(items.map((i) => i.id)).toEqual(["team", "payments"]);
    expect(reachable.map((i) => i.id)).toEqual(["waitlist"]);
  });
  it("resolveSettingsNav is unchanged: the hidden entry stays out", async () => {
    const items = await resolveSettingsNav(entries, { role: "owner", studio });
    expect(items.map((i) => i.id)).toEqual(["team", "payments"]);
  });
  it("a practitioner gets nothing reachable: an owner-only entry never reaches their payload", async () => {
    const { items, reachable } = await resolveSettingsNavWithReachable(entries, { role: "practitioner", studio });
    expect(items).toEqual([]);
    expect(reachable).toEqual([]);
  });
  it("a throwing visibleWhen hides the entry but it is still only owner-reachable", async () => {
    const boom: SettingsNavEntry[] = [{ ...entries[1], visibleWhen: () => { throw new Error("x"); } }];
    const { items, reachable } = await resolveSettingsNavWithReachable(boom, { role: "owner", studio });
    expect(items).toEqual([]);
    expect(reachable.map((i) => i.id)).toEqual(["waitlist"]);
  });
  it("with the reachable entry added, /settings/waitlist has exactly one current item", async () => {
    const { items, reachable } = await resolveSettingsNavWithReachable(entries, { role: "owner", studio });
    const all = [...items, ...reachable];
    expect(currentSettingsRailId(all, "/settings/waitlist")).toBe("waitlist");
    expect(activeSettingsLocation(all, "/settings/waitlist")?.item.label).toBe("Waitlist");
    // and without it, nothing is current (the practitioner / owner-only case)
    expect(currentSettingsRailId(items, "/settings/waitlist")).toBeNull();
    expect(currentSettingsRailId(items, "/settings/payments/setup")).toBe("payments-setup");
  });
});

describe("Email notifications toggles are named (Photos, 0ab9ce743: 2 unlabelled)", () => {
  it("every toggle button carries its label as its accessible name", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../..", "app/(app)/settings/studio/EmailSettingsForm.tsx"),
      "utf8",
    );
    expect(src).toMatch(/aria-label=\{t\.label\}\s+aria-pressed=\{displayOn\}/);
  });
});
