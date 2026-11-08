import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuickBlockDrawer } from "@/app/(app)/calendar/QuickBlockDrawer";
import { quickBlockScopeFor } from "@/lib/calendar/block-scope";

// HON-48 F1 (held for Sam's rule): the quick block drawer says whom a new block
// applies to under practitioner capacity. Synthetic names.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}));
vi.mock("@/app/(app)/calendar/calendar-block-actions", () => ({ createCalendarTimedBlockAction: vi.fn() }));

const NAMES = { "p-ana": "Synthetic Ana", "p-bo": "Synthetic Bo" };
const DRAFT = { localDate: "2031-05-12", startLocal: "12:00", endLocal: "13:00" };

function render(scope: ReturnType<typeof quickBlockScopeFor>): string {
  return renderToStaticMarkup(
    createElement(QuickBlockDrawer, { open: true, draft: DRAFT, studioTimezone: "America/Los_Angeles", onClose: () => {}, scope }),
  );
}

describe("quickBlockScopeFor", () => {
  it("capacity off gives no scope", () => {
    expect(quickBlockScopeFor({ names: undefined, isOwner: true, currentPractitionerId: "p-ana", currentPractitionerName: "Synthetic Ana" })).toBeUndefined();
    expect(quickBlockScopeFor({ names: undefined, isOwner: false, currentPractitionerId: "p-bo", currentPractitionerName: "Synthetic Bo" })).toBeUndefined();
  });

  it("a non-owner gets their own time only", () => {
    expect(quickBlockScopeFor({ names: NAMES, isOwner: false, currentPractitionerId: "p-bo", currentPractitionerName: "Bo fallback" })).toEqual({ kind: "self", name: "Synthetic Bo" });
  });

  it("the owner chooses from the active roster with nothing preselected", () => {
    expect(quickBlockScopeFor({ names: NAMES, isOwner: true, currentPractitionerId: "p-ana", currentPractitionerName: "Synthetic Ana" })).toEqual({
      kind: "choose",
      options: [{ id: "p-ana", name: "Synthetic Ana" }, { id: "p-bo", name: "Synthetic Bo" }],
      defaultValue: "",
    });
  });
});

describe("QuickBlockDrawer scope control", () => {
  it("capacity off renders no scope control", () => {
    const html = render(undefined);
    expect(html).not.toContain("data-quick-block-scope");
    expect(html).not.toContain("All practitioners");
  });

  it("a non-owner sees that only their time is blocked", () => {
    const html = render(quickBlockScopeFor({ names: NAMES, isOwner: false, currentPractitionerId: "p-bo", currentPractitionerName: "Synthetic Bo" }));
    expect(html).toContain('data-quick-block-scope="self"');
    expect(html).toContain("Blocks only your time (Synthetic Bo). Other practitioners stay bookable.");
    expect(html).not.toContain("<select");
  });

  it("the owner gets All practitioners / Only <name>, with a disabled placeholder selected", () => {
    const html = render(quickBlockScopeFor({ names: NAMES, isOwner: true, currentPractitionerId: "p-ana", currentPractitionerName: "Synthetic Ana" }));
    expect(html).toContain('data-quick-block-scope="choose"');
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose who this blocks<\/option>/);
    expect(html).toContain('<option value="all">All practitioners</option>');
    expect(html).toContain('<option value="p-ana">Only Synthetic Ana</option>');
    expect(html).toContain('<option value="p-bo">Only Synthetic Bo</option>');
  });
});
