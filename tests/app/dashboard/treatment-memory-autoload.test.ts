// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTreatmentMemory } from "@/app/(app)/dashboard/dashboard-treatment-memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn();
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (summary: { unavailable: boolean; hasTreatment: boolean; compactSummary: string | null }) =>
  act(() => root.render(createElement(DashboardTreatmentMemory, {
    appointmentId: "appt-1", clientId: "client-1", clientName: "Morgan", timeZone: "UTC", summary,
  })));

describe("the open details load when the row first becomes showable", () => {
  it("reads once when a first unavailable summary is followed by a showable one, and not again on re-render", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "none" }), { status: 200 }));
    // First read of the summary failed: the row says so and asks the server for nothing.
    render({ unavailable: true, hasTreatment: false, compactSummary: null });
    expect(fetchMock).not.toHaveBeenCalled();
    // A later revalidation (for example after adding a pin) makes it showable while the row is open.
    await act(async () => render({ unavailable: false, hasTreatment: true, compactSummary: "electrolysis" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/dashboard/prep-memory?appointment_id=appt-1");
    expect(host.textContent).toContain("No previous treatment to show.");
    expect(host.textContent).not.toContain("Loading previous treatment");
    // Re-rendering with the same summary does not read again.
    await act(async () => render({ unavailable: false, hasTreatment: true, compactSummary: "electrolysis" }));
    await act(async () => render({ unavailable: false, hasTreatment: true, compactSummary: "electrolysis, 20 min" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reads once on mount when the row is showable from the start", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "none" }), { status: 200 }));
    await act(async () => render({ unavailable: false, hasTreatment: true, compactSummary: "electrolysis" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
