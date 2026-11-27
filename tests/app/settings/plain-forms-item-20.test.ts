// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-124 item 20 follow-up: the remaining plain forms show a refusal and confirm only after ok.
async function mount(el: (c: typeof import("react").createElement) => unknown, click: (h: HTMLElement) => HTMLElement) {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.appendChild(host);
  await act(async () => { createRoot(host).render(el(createElement) as never); });
  await act(async () => { click(host).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return host;
}
const form = (h: HTMLElement) => h.querySelector("form") as HTMLElement;

describe("ReceptionistActiveForm", () => {
  it("a refusal shows its sentence and NO confirmation; a throw shows the fixed sentence; ok names the person", async () => {
    const { ReceptionistActiveForm } = await import("@/app/(app)/settings/team/ReceptionistActiveForm");
    const run = (action: () => Promise<unknown>, active = true) => mount((c) => c(ReceptionistActiveForm, { action: action as never, receptionistId: "r1", name: "Ada", active }), form);
    let host = await run(async () => ({ ok: false, error: "Another active front-desk member already uses this email." }), false);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/already uses this email/);
    expect(host.textContent).not.toMatch(/Reactivated/);
    host = await run(async () => { throw new Error("An error occurred in the Server Components render"); });
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Could not update this front-desk member/);
    expect(host.textContent).not.toContain("Server Components");
    host = await run(async () => ({ ok: true }));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Deactivated Ada.");
  });
});

describe("MarkAllReadForm", () => {
  it("failure is said; ok names the count and stays visible after the unread count reaches zero", async () => {
    const { MarkAllReadForm } = await import("@/app/(app)/notifications/MarkAllReadForm");
    let host = await mount((c) => c(MarkAllReadForm, { action: async () => ({ ok: false as const, error: "Couldn't mark notifications read. Please refresh and try again." }), unreadCount: 3 }), form);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Couldn't mark notifications read/);
    host = await mount((c) => c(MarkAllReadForm, { action: async () => ({ ok: true as const, updated: 3 }), unreadCount: 3 }), form);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Marked 3 notifications read.");
  });
});

describe("PortalReviewedForm", () => {
  it("a refusal is shown to the visitor; success shows nothing extra (the page re-renders with its Reviewed badge)", async () => {
    const { PortalReviewedForm } = await import("@/app/portal/PortalReviewedForm");
    let host = await mount((c) => c(PortalReviewedForm, { action: async () => ({ ok: false as const, error: "Could not mark this message as reviewed. Try again." }), messageId: "m1" }), form);
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Could not mark this message as reviewed/);
    host = await mount((c) => c(PortalReviewedForm, { action: async () => ({ ok: true as const }), messageId: "m1" }), form);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("source pins", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../../..", p), "utf8");
  it("the three actions return results and never throw a message", () => {
    const rec = read("app/(app)/settings/team/receptionist-actions.ts");
    expect(rec).toContain("Promise<ActionResult>");
    expect(rec).not.toContain("throw new Error");
    const portal = read("app/portal/portal-message-actions.ts");
    expect(portal).toMatch(/markPortalMessageReviewedAction\(\s*formData: FormData,\s*\): Promise<ActionResult>/);
  });
  it("the pages render the client forms, not a bare form action", () => {
    expect(read("app/(app)/notifications/page.tsx")).toContain("<MarkAllReadForm");
    expect(read("app/portal/page.tsx")).toContain("<PortalReviewedForm");
    expect(read("app/(app)/settings/team/page.tsx")).toContain("<ReceptionistActiveForm");
  });
});
