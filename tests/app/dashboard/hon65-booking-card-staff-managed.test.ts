import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { NewClientReadiness } from "@/lib/booking/new-client-readiness";

// HON-65: for a staff-managed clinic (both HON-47 self-service settings off) the
// dashboard's booking-setup card must say what it is about: the ONLINE booking
// page. "Before you can take a new client" reads as if staff cannot book. The
// blockers, links and the unknown/ready states are unchanged.

const notReady = {
  status: "not_ready",
  blockers: [{ key: "services", label: "Add an active service", href: "/settings/services" }],
  unavailable: [],
} as unknown as NewClientReadiness;

async function render(staffManaged?: boolean, readiness: NewClientReadiness = notReady) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BookingSetupCard } = await import("@/app/(app)/dashboard/BookingSetupCard");
  return renderToStaticMarkup(BookingSetupCard({ readiness, staffManaged }) as never) ?? "";
}

describe("BookingSetupCard heading by posture", () => {
  it("default keeps the existing heading", async () => {
    expect(await render()).toContain("Before you can take a new client");
    expect(await render(false)).toContain("Before you can take a new client");
  });
  it("staff-managed names the online booking page and keeps every blocker", async () => {
    const html = await render(true);
    expect(html).toContain("Before clients can book online");
    expect(html).not.toContain("Before you can take a new client");
    expect(html).toContain("Add an active service");
    expect(html).toContain("/settings/services");
  });
  it("ready still renders nothing, and unknown keeps its own heading, in both postures", async () => {
    const ready = { status: "ready" } as unknown as NewClientReadiness;
    const unknown = { status: "unknown", unavailable: ["services"] } as unknown as NewClientReadiness;
    expect(await render(true, ready)).toBe("");
    expect(await render(true, unknown)).toContain("We could not check your booking setup");
  });
});

describe("wiring", () => {
  it("the stack passes the posture it already reads to the card", () => {
    const stack = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
    expect(stack).toMatch(/<BookingSetupCard[^>]*staffManaged=\{staffManaged\}/);
  });
});
