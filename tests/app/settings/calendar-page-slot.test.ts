import { beforeEach, describe, expect, it, vi } from "vitest";

// Calendar is a group of focused views (R2): /settings/calendar is only a
// doorway, Display preferences is its own OWNER-ONLY route, and each
// per-practitioner view from the slot (personal-slot.tsx, owned by WS-C) is
// /settings/calendar/<slug>. With no slot there are no placeholder views.

const scenario = { role: "owner" as "owner" | "practitioner" };
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
type View = { slug: string; label: string; Content: () => string };
const slotState: { slot: null | { views: View[] } } = { slot: null };

vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirect(to),
  notFound: () => notFound(),
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({
    practitioner: { role: scenario.role },
    studio: { birthday_reminder_color: "purple", time_format_preference: "12h" },
  }),
}));
vi.mock("@/app/(app)/settings/calendar/StudioDisplayPreferencesForm", () => ({
  StudioDisplayPreferencesForm: () => "DISPLAY_FORM",
}));
vi.mock("@/app/(app)/settings/calendar/personal-slot", () => ({
  get personalCalendarSlot() {
    return slotState.slot;
  },
}));

import CalendarIndex from "@/app/(app)/settings/calendar/page";
import CalendarDisplayPage from "@/app/(app)/settings/calendar/display/page";
import CalendarSlotView from "@/app/(app)/settings/calendar/[view]/page";

const flat = (n: unknown): string =>
  JSON.stringify(n, (_k, v) => (typeof v === "function" ? v.name || "fn" : v));

beforeEach(() => {
  scenario.role = "owner";
  slotState.slot = null;
  redirect.mockClear();
  notFound.mockClear();
});

describe("/settings/calendar doorway", () => {
  it("an owner lands on Display preferences", async () => {
    await expect(CalendarIndex()).rejects.toThrow("REDIRECT:/settings/calendar/display");
  });
  it("with no slot a practitioner is sent to Profile", async () => {
    scenario.role = "practitioner";
    await expect(CalendarIndex()).rejects.toThrow("REDIRECT:/settings/profile");
  });
  it("with a slot a practitioner lands on its first view", async () => {
    scenario.role = "practitioner";
    slotState.slot = { views: [{ slug: "colour", label: "Colour", Content: () => "C" }] };
    await expect(CalendarIndex()).rejects.toThrow("REDIRECT:/settings/calendar/colour");
  });
});

describe("Display preferences view", () => {
  it("an owner sees it labelled for the whole studio", async () => {
    const tree = flat(await CalendarDisplayPage());
    expect(tree).toContain("Applies to the whole studio.");
    expect(tree).toContain("Display preferences");
  });
  it("a practitioner is sent to Profile (the access gate, not the rail)", async () => {
    scenario.role = "practitioner";
    slotState.slot = { views: [{ slug: "colour", label: "Colour", Content: () => "C" }] };
    await expect(CalendarDisplayPage()).rejects.toThrow("REDIRECT:/settings/profile");
  });
});

describe("per-practitioner slot views", () => {
  const params = (view: string) => ({ params: Promise.resolve({ view }) });
  it("an unknown slug, or any slug with no slot, is a 404 (no placeholder)", async () => {
    await expect(CalendarSlotView(params("colour"))).rejects.toThrow("NOT_FOUND");
    slotState.slot = { views: [{ slug: "colour", label: "Colour", Content: () => "C" }] };
    await expect(CalendarSlotView(params("feed"))).rejects.toThrow("NOT_FOUND");
  });
  it("a known slug renders just that view for any role, without Display preferences", async () => {
    scenario.role = "practitioner";
    slotState.slot = { views: [{ slug: "colour", label: "Colour", Content: () => "C" }] };
    const tree = flat(await CalendarSlotView(params("colour")));
    expect(tree).toContain("Colour");
    expect(tree).not.toContain("Applies to the whole studio.");
  });
});
