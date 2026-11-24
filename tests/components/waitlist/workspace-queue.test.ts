// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceQueue } from "@/components/waitlist/workspace-queue";
import { workspaceView } from "@/lib/waitlist/workspace-view";

const pending = vi.hoisted(() => ({ value: false }));
vi.mock("@/components/waitlist/invite-outcome-boundary", () => ({
  useInviteOutcomePending: () => pending.value,
}));

describe("workspace addresses", () => {
  it("opens the matching workspace view for each queue section, response action and historical link", () => {
    expect(workspaceView({})).toBe("waiting");
    for (const section of ["waiting", "claimed"]) expect(workspaceView({ section })).toBe("waiting");
    expect(workspaceView({ section: "invited" })).toBe("invited");
    for (const section of ["released", "expired"]) expect(workspaceView({ section })).toBe("history");
    for (const params of [{ view: "declined" }, { fu: "refused" }, { followup: "1" }, { tab: "responses" }]) {
      expect(workspaceView(params)).toBe("responses");
    }
    expect(workspaceView({ tab: "history" })).toBe("history");
    expect(workspaceView({ tab: "bogus", section: "bogus", fu: "bogus" })).toBe("waiting");
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  window.history.replaceState(null, "", "/waitlist");
  pending.value = false;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderQueue() {
  act(() => {
    root.render(createElement(WorkspaceQueue, {
      initialView: "waiting", waiting: 110, invited: 2, responses: null, responseLabel: "open follow-ups",
      searchMin: 2, searchMax: 60,
      children: [
        createElement("section", { "data-workspace-section": "expired", key: "history" }, createElement("span", { id: "entry-abc" })),
        createElement("section", { "data-workspace-section": "responses", key: "responses" }, createElement("span", { id: "follow-up" })),
      ],
    }));
  });
}

it("preserves old notification anchors and a subsequent entry link, including the active navigation label", () => {
  window.history.replaceState(null, "", "/waitlist#follow-up");
  renderQueue();
  const current = () => host.querySelector('[aria-current="page"]');
  expect(current()?.textContent).toBe("Responses");
  act(() => {
    window.history.replaceState(null, "", "/waitlist#entry-abc");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(current()?.textContent).toBe("History");
  expect(host.querySelector("[data-view]")?.getAttribute("data-view")).toBe("history");
});

it("submits the existing owner name search and withholds navigation while an invite is in flight", () => {
  renderQueue();
  const search = host.querySelector('form[role="search"]');
  const input = host.querySelector<HTMLInputElement>('input[name="q"]');
  expect(search?.getAttribute("action")).toBe("/waitlist/search");
  expect(input?.minLength).toBe(2);
  expect(host.querySelectorAll("nav a")).toHaveLength(4);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Waiting110");
  pending.value = true;
  renderQueue();
  expect(host.querySelectorAll("nav a")).toHaveLength(0);
  expect(input?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
});
