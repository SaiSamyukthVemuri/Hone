// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddToWaitlistPanel } from "@/components/waitlist/add-to-waitlist-panel";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useInviteOutcomePending } from "@/components/waitlist/invite-outcome-boundary";
import { OverInviteLink } from "@/components/waitlist/over-invite-link";

vi.mock("@/components/waitlist/invite-outcome-boundary", () => ({ useInviteOutcomePending: vi.fn(() => false) }));
import { WaitlistWorkspaceHeader } from "@/components/waitlist/workspace-header";

it("opens one header panel at a time and preserves an unfinished add form", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(WaitlistWorkspaceHeader, {
      settings: createElement("p", null, "Waitlist texts"),
      addPerson: createElement("input", { "aria-label": "New person" }),
    })));
    const buttonFor = (label: string) => Array.from(host.querySelectorAll("button")).find(button => button.textContent === label)!;
    const add = buttonFor("+ Add person");
    const settings = buttonFor("Settings");
    const addPanel = document.getElementById(add.getAttribute("aria-controls")!)!;
    const settingsPanel = document.getElementById(settings.getAttribute("aria-controls")!)!;
    expect(addPanel.hidden).toBe(true);
    expect(settingsPanel.hidden).toBe(true);
    await act(async () => add.click());
    expect(add.getAttribute("aria-expanded")).toBe("true");
    expect(addPanel.hidden).toBe(false);
    addPanel.querySelector("input")!.value = "Fictional person";
    await act(async () => settings.click());
    expect(settingsPanel.hidden).toBe(false);
    expect(addPanel.hidden).toBe(true);
    await act(async () => add.click());
    expect(settingsPanel.hidden).toBe(true);
    expect(addPanel.querySelector("input")!.value).toBe("Fictional person");
    await act(async () => add.click());
    expect(add.getAttribute("aria-expanded")).toBe("false");
    expect(addPanel.hidden).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("acknowledges only a confirmed add or import on the corresponding tab", () => {
  const action = async () => ({ ok: true as const });
  const render = (props: Partial<ComponentProps<typeof AddToWaitlistPanel>>) =>
    renderToStaticMarkup(createElement(AddToWaitlistPanel, { addAction: action, importAction: action, ...props }));
  expect(render({})).not.toContain("Added to the waitlist.");
  expect(render({ initialAddState: { ok: false, message: "Please try again." } })).not.toContain("Added to the waitlist.");
  expect(render({ initialAddState: { ok: true } })).toContain("Added to the waitlist.");
  expect(render({ initialImportState: { ok: true } })).not.toContain("Added to the waitlist.");
  expect(render({ initialTab: "import", initialImportState: { ok: true } })).toContain("Added to the waitlist.");
});


it("protects header actions and removes the over-invite link until a send settles", () => {
  vi.mocked(useInviteOutcomePending).mockReturnValue(true);
  try {
    const header = renderToStaticMarkup(createElement(WaitlistWorkspaceHeader, { settings: "Settings form", addPerson: "Add form" }));
    expect(header.match(/<button[^>]* disabled=""/g)).toHaveLength(2);
    expect(header.match(/<fieldset[^>]* disabled=""/g)).toHaveLength(2);
    const overInvite = renderToStaticMarkup(createElement(OverInviteLink, { isOwner: true }));
    expect(overInvite).toContain('aria-disabled="true"');
    expect(overInvite).not.toContain("href=");
  } finally {
    vi.mocked(useInviteOutcomePending).mockReturnValue(false);
  }
});
