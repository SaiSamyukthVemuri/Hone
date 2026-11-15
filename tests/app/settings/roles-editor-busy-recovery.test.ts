// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioPolicy } from "@/lib/permissions/catalog";

// Insurance/Privacy B-1 and B-2 on #1335 (Codex P2 4477378035): editing is disabled while a save is in flight, so a rejected promise or a
// refresh that is still applying must never leave the editor stuck read-only. Mounted in jsdom (this file only). Synthetic data.

const refresh = vi.fn();
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn(), refresh }) }));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const policy: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
const people = [{ id: "p2", name: "Alex Practitioner", email: "alex@example.test", role: "practitioner" as const, state: "active" as const }];
const failing = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const previewOk = async () => ({ ok: true as const, preview: { version: 3, roles: [] } });

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  refresh.mockReset();
});

async function mount(over: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(RolesEditor, {
        policies: { practitioner: policy, receptionist: policy },
        reviewed: false,
        writable: true,
        notWritableReason: null,
        staffRoleChange: false,
        initialView: "permissions",
        people,
        timezone: "America/Toronto",
        previewSave: failing,
        previewReset: previewOk,
        previewAdopt: previewOk,
        save: failing,
        reset: failing,
        adopt: failing,
        previewActivation: failing,
        activate: failing,
        loadHistory: failing,
        loadAccess: failing,
        changeRole: failing,
        reload: failing,
        ...over,
      }),
    );
  });
}

async function openAdoptAndConfirm() {
  const banner = host!.querySelector('[data-testid="roles-review-banner"] button') as HTMLButtonElement;
  await act(async () => banner.click());
  const textarea = host!.querySelector('[data-testid="roles-preview"] [data-testid="reason-input"]') as HTMLTextAreaElement | null;
  if (textarea) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!;
    await act(async () => {
      setter.call(textarea, "Reviewing the new defaults today");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const confirm = [...host!.querySelectorAll('[data-testid="roles-preview"] button')].find((b) => /adopt these|confirm/i.test(b.textContent ?? "")) as HTMLButtonElement;
  await act(async () => confirm.click());
}

const fieldsets = () => [...host!.querySelectorAll("fieldset")] as HTMLFieldSetElement[];

describe("B-2: a rejected promise ends 'saving' with a visible error", () => {
  it("adopt rejects: the page shows an alert and the rows are not locked read-only", async () => {
    await mount({ adopt: () => Promise.reject(new Error("network down")), reload: () => Promise.reject(new Error("network down")) });
    await openAdoptAndConfirm();
    const alert = host!.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toMatch(/could not confirm|Reload the page/i);
    // not stuck: the status line is not "Saving…" and a normal row is editable again
    expect(host!.querySelector('[role="status"]')?.textContent ?? "").not.toMatch(/Saving/);
    const live = fieldsets().filter((f) => !f.disabled);
    expect(live.length).toBeGreaterThan(0);
  });
});

describe("B-1: the editor stays busy until the refresh has been applied", () => {
  it("adopt succeeds: router.refresh is called through a transition (the source pin follows)", async () => {
    await mount({ adopt: async () => ({ ok: true as const, newVersion: 4 }) });
    await openAdoptAndConfirm();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
