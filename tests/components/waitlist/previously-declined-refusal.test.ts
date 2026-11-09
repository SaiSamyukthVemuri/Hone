// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { InviteOutcomeBoundary, type InviteOutcomeResult } from "@/components/waitlist/invite-outcome-boundary";
import { InviteComposer } from "@/components/waitlist/invite-composer";
import { emptyDraft } from "@/lib/waitlist/b4-invitation-draft";
import {
  ADMIT_REFUSAL_PRESENTATION,
  PREVIOUSLY_DECLINED_COPY,
  invitationNoticeFor,
  invitationRefusalCopy,
  type AdapterCapabilities,
} from "@/lib/waitlist/invite-to-book-contract";

// A person who declined THIS window (same service, dates and days) is refused at issue (0192, `already_declined_offer`, which the contract
// normalises to `previously_declined`). The refusal used to fall through to "Please try again", which is untrue (retrying the identical window can
// never succeed) and, because the only notice sat above the whole queue, was not even in view of the Send button that was pressed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COPY =
  "No invitation was created: they already said this window didn't work. Change the dates or days and send a different window.";

describe("previously_declined copy", () => {
  it("is the approved sentence, exactly", () => {
    expect(PREVIOUSLY_DECLINED_COPY).toBe(COPY);
    expect(invitationRefusalCopy("previously_declined")).toBe(COPY);
  });
  it("is not the generic try-again fallback, and never says to retry", () => {
    expect(invitationRefusalCopy("previously_declined")).not.toBe(invitationRefusalCopy("unavailable" as never));
    expect(COPY.toLowerCase()).not.toContain("try again");
  });
  it("the server's already_declined_offer reaches it", () => {
    expect(ADMIT_REFUSAL_PRESENTATION.already_declined_offer).toBe("previously_declined");
    const n = invitationNoticeFor({ state: "refused", code: ADMIT_REFUSAL_PRESENTATION.already_declined_offer });
    expect(n.tone).toBe("error");
    expect(n.invitationExists).toBe(false);
    expect(n.message).toBe(COPY);
  });
});

const CONNECTED: AdapterCapabilities = { enforcesScope: true, canResend: true, canCancel: true, canReturnToWaitlist: true, canRemove: true };
const SERVICES = [{ id: "svc-1", name: "Electrolysis consultation", modality: "consultation" }];
const REFUSED: InviteOutcomeResult = { outcome: { state: "refused", code: "previously_declined" } };

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const action = vi.fn<(f: FormData) => Promise<InviteOutcomeResult>>();

beforeEach(() => {
  action.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async () => {
  await act(async () => {
    root.render(
      createElement(InviteOutcomeBoundary, {
        action,
        entryNames: { "e-1": "Sam", "e-2": "Amara" },
        children: [
          createElement("div", { key: "above", "data-testid": "queue-above" }),
          createElement(InviteComposer, { key: "e-1", entryId: "e-1", entryName: "Sam", draft: { ...emptyDraft(), serviceId: "svc-1" }, services: SERVICES, capabilities: CONNECTED, cancelAction: async () => {} }),
          createElement(InviteComposer, { key: "e-2", entryId: "e-2", entryName: "Amara", draft: { ...emptyDraft(), serviceId: "svc-1" }, services: SERVICES, capabilities: CONNECTED }),
        ],
      }),
    );
  });
};
const send = (n = 0) => host.querySelectorAll<HTMLButtonElement>('[data-testid="composer-send"]')[n];
const press = async (n = 0) => {
  await act(async () => {
    send(n).form!.requestSubmit(send(n));
  });
};
// jsdom's form reset after an action leaves the select on its placeholder; a browser keeps the controlled value. Put it back before pressing again.
const reselectService = () => host.querySelectorAll<HTMLSelectElement>('select[name="service_id"]').forEach((el) => (el.value = "svc-1"));
const inline = (n = 0) => host.querySelectorAll<HTMLElement>('[data-testid="composer-outcome"]')[n] ?? null;

describe("the refusal is announced beside Send", () => {
  it("shows the exact copy as an alert in the pressed composer, and keeps the form open", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    expect(inline()).toBeNull();
    await press(0);
    expect(action).toHaveBeenCalledTimes(1);
    const el = inline(0)!;
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.textContent).toBe(COPY);
    expect(el.closest("form")).toBe(send(0).form);
    // The composer is still mounted and Send is usable again.
    expect(send(0).disabled).toBe(false);
  });
  it("precedes the Send button, so it is read before the next press", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    await press(0);
    expect(inline(0)!.compareDocumentPosition(send(0)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("appears only in the composer that was pressed", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    await press(0);
    expect(host.querySelectorAll('[data-testid="composer-outcome"]').length).toBe(1);
  });
  it("the boundary's own notice still carries the answer, named", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    await press(0);
    expect(host.querySelector('[data-testid="invite-outcome"]')!.textContent).toContain(COPY);
    expect(host.querySelector('[data-testid="invite-outcome"]')!.textContent).toContain("Sam");
  });
  it("is withheld while the next send is in flight", async () => {
    action.mockResolvedValueOnce(REFUSED);
    await mount();
    await press(0);
    expect(inline(0)).not.toBeNull();
    let release!: (r: InviteOutcomeResult) => void;
    action.mockReturnValueOnce(new Promise((r) => (release = r)));
    reselectService();
    await act(async () => {
      send(0).form!.requestSubmit(send(0));
    });
    expect(inline(0)).toBeNull();
    await act(async () => release(REFUSED));
    expect(inline(0)!.textContent).toBe(COPY);
  });
  it("a refusal that arrives after the window was edited mid-send is NOT shown beside the new window", async () => {
    await mount();
    let release!: (r: InviteOutcomeResult) => void;
    action.mockReturnValueOnce(new Promise((r) => (release = r)));
    await act(async () => {
      send(0).form!.requestSubmit(send(0));
    });
    const other = [...host.querySelectorAll<HTMLInputElement>('form input[name="window_days"]')].find((r) => !r.checked)!;
    await act(async () => {
      other.click();
    });
    await act(async () => release(REFUSED));
    expect(inline(0)).toBeNull();
    // The boundary's own notice still reports the answer to the window that was sent.
    expect(host.querySelector('[data-testid="invite-outcome"]')!.textContent).toContain(COPY);
  });
  it("Cancel does not capture a window: pressing it after an edit does not bring the answer back", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    await press(0);
    const other = [...host.querySelectorAll<HTMLInputElement>('form input[name="window_days"]')].find((r) => !r.checked)!;
    await act(async () => other.click());
    expect(inline(0)).toBeNull();
    const cancel = host.querySelector<HTMLButtonElement>('[data-testid="composer-cancel"]')!;
    await act(async () => {
      cancel.form!.requestSubmit(cancel);
    });
    expect(inline(0)).toBeNull();
  });
  it("still shows when the draft is edited and put back to what was sent", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    await press(0);
    const radios = [...host.querySelectorAll<HTMLInputElement>('form input[name="window_days"]')];
    const sent = radios.find((r) => r.checked)!;
    const other = radios.find((r) => !r.checked)!;
    await act(async () => other.click());
    expect(inline(0)).toBeNull();
    await act(async () => sent.click());
    expect(inline(0)!.textContent).toBe(COPY);
  });
  it("goes away when the dates or days change, because it answered the window that was sent", async () => {
    action.mockResolvedValue(REFUSED);
    await mount();
    await press(0);
    expect(inline(0)).not.toBeNull();
    const other = [...host.querySelectorAll<HTMLInputElement>('form input[name="window_days"]')].find((r) => !r.checked)!;
    await act(async () => {
      other.click();
    });
    expect(inline(0)).toBeNull();
  });
});
