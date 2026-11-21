// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioPolicy } from "@/lib/permissions/catalog";

// Codex P2 4584672884 / 4584603808 on the page: the adoption preview lists the saved choices it changes (so it never says "Nothing would
// change" while fallback choices move), and a preview the server refused as stale keeps the draft and takes the fresh saved state.
// Mounted in jsdom (this file only). Synthetic data.

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


const emptyRole = (role: "practitioner" | "receptionist") => ({ role, diff: { changes: [], fixedNarrowings: [], widened: 0, narrowed: 0, newlyEnabledSensitive: 0 }, people: [], count: 0, storedRemoved: [] });
const adoptPreview = (choices: unknown[]) => async () => ({ ok: true as const, preview: { version: 3, roles: [emptyRole("practitioner"), emptyRole("receptionist")], choices } });
const choice = { role: "receptionist" as const, key: "appt.cancel", label: "Cancel appointments", from: "off" as const, to: "studio" as const };

async function openAdopt() {
  const banner = host!.querySelector('[data-testid="roles-review-banner"] button') as HTMLButtonElement;
  await act(async () => banner.click());
}

describe("the adoption preview lists the saved choices adoption changes", () => {
  it("effective access unchanged but a fallback choice moves: the choice is listed and the page does not say nothing would change", async () => {
    await mount({ previewAdopt: adoptPreview([choice]) });
    await openAdopt();
    const panel = host!.querySelector('[data-testid="roles-preview"]');
    expect(panel?.textContent ?? "").not.toMatch(/Nothing would change/);
    expect(host!.querySelector('[data-choice-change="receptionist:appt.cancel"]')?.textContent ?? "").toMatch(/Cancel appointments: Off to Whole studio/);
  });
  it("control: with no choice change and no access change it still says nothing would change", async () => {
    await mount({ previewAdopt: adoptPreview([]) });
    await openAdopt();
    expect(host!.querySelector('[data-testid="roles-preview"]')?.textContent ?? "").toMatch(/Nothing would change/);
  });
});
