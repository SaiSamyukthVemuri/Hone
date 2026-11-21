// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// MOUNTED (jsdom). After a role change on the open person, "View access" must not keep showing the OLD role's rows as the access in force now:
// it goes back to loading and then shows the answer for the new role. The server is a mock; no database.

vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn() }) }));
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AccessSummary } = await import("@/app/(app)/settings/roles/roles-editor");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { key: string; scope: "own" | "studio"; source: "stored"; cappedBy: null };
const answer = (role: string, key: string) => ({ ok: true as const, state: "active" as const, role, rows: [{ key, scope: "studio", source: "stored", cappedBy: null } as Row] });
const person = (role: "practitioner" | "receptionist") => ({ id: "p1", name: "Dana", email: "d@example.test", role, state: "active" as const });

describe("View access reloads when the open person's role changes", () => {
  it("old role's rows are gone, the panel shows loading, then the new role's rows", async () => {
    const calls: Array<(v: unknown) => void> = [];
    const load = vi.fn(() => new Promise((res) => calls.push(res)));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (role: "practitioner" | "receptionist") =>
      act(async () => {
        root.render(createElement(AccessSummary, { person: person(role), load: load as never }));
      });

    await render("practitioner");
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => calls[0](answer("practitioner", "appt.book")));
    expect(host.querySelector('[data-access-row="appt.book"]')).not.toBeNull();

    // the owner changes the role; the parent refreshes the same open person with a new role
    await render("receptionist");
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-access-row="appt.book"]')).toBeNull();
    expect(host.querySelector('[data-access-state="loading"]')).not.toBeNull();

    await act(async () => calls[1](answer("receptionist", "calendar.view")));
    expect(host.querySelector('[data-access-row="calendar.view"]')).not.toBeNull();
    expect(host.querySelector('[data-access-row="appt.book"]')).toBeNull();
    expect(host.querySelector('[data-access-state="loading"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
