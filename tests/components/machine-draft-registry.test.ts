// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => actions);

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

const PROFILE: MachineProfile = {
  profileId: "fixture:mounted",
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Mounted",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [{ id: "p", kind: "studio-device-photo", consultedOn: "2026-10-12", establishes: "A synthetic unit." }],
  openQuestions: [],
  channels: { count: 1, nativeLabel: "Channel", associationRequired: false, supportsDistinctSettingGroups: false, verification: "device-confirmed", evidence: ["p"] },
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["p"],
      stages: [],
      fields: [
        { key: "current", nativeLabel: "Current", quantity: "current", unit: "µA", decimals: 0, optional: false, expectedSource: "practitioner-entered", editable: true, verification: "device-confirmed", evidence: ["p"] },
        { key: "duration", nativeLabel: "Time", quantity: "duration", unit: "s", decimals: 1, optional: false, expectedSource: "practitioner-entered", editable: true, verification: "device-confirmed", evidence: ["p"] },
      ],
    },
    {
      key: "second",
      nativeLabel: "Second",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["p"],
      stages: [],
      fields: [
        { key: "current", nativeLabel: "Current", quantity: "current", unit: "µA", decimals: 0, optional: false, expectedSource: "practitioner-entered", editable: true, verification: "device-confirmed", evidence: ["p"] },
        { key: "duration", nativeLabel: "Time", quantity: "duration", unit: "s", decimals: 1, optional: false, expectedSource: "practitioner-entered", editable: true, verification: "device-confirmed", evidence: ["p"] },
      ],
    },
  ],
};

const DEVICE: StudioDevice = {
  deviceId: "room-9",
  studioId: "studio-synthetic",
  profileId: "fixture:mounted",
  profileVersion: 1,
  displayName: "Room 9 unit",
  installedOptions: [],
  retiredAt: null,
};
const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };

// THE LEVEL-BASED DRAFT REGISTRY, MOUNTED (#1369, Codex 4505408578, Insurance final423). The sibling suites render with react-dom/server,
// which never runs effects; this mounts the real components in jsdom under a host stand-in that owns a registry the way block-setup-form
// does (draft-registry.tsx) and reads what the HOST derives: `anyDraft` (the leave guard / "Unsaved" label) and `anyUnresolved` (the
// host's Cancel and the identity controls). (a)-(e) are the regression tests, red on the edge-triggered model; T1-T6 follow.
// Synthetic records.

const { createElement, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupConnected } = await import("@/components/machines/machine-first-setup-connected");
const { MachineSettingDraft } = await import("@/components/machines/machine-setting-draft");
const { DraftRegistryProvider, useDraftRegistryState, useReportDraft } = await import("@/components/machines/draft-registry");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CTX = {
  scope: SCOPE,
  devices: [DEVICE],
  inventoryReason: null,
  remembered: null,
  rememberedUnavailable: null,
  persistence: { kind: "database", persisted: true },
  catalogue: [PROFILE],
  canManageMachines: false,
  priorSetup: [],
  recordedSetup: [],
  priorSetupUnavailable: false,
  recordedSetupUnavailable: false,
  unitNames: {},
  suggestedMachine: null,
  restoredSelection: null,
  legacyMachine: { profileId: "dectro-apilus:xcell", label: "Dectro xCell" },
};
const SAVED = { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" };

type View = { anyDraft: boolean; anyUnresolved: boolean };
const NONE: View = { anyDraft: false, anyUnresolved: false };
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let view: View = NONE;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = root = null;
  view = NONE;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** The host stand-in: its registry, a Cancel gated on any(unresolved) as block-setup-form's is, and the children inside the provider. */
function Host({ children }: { children?: unknown }) {
  const reg = useDraftRegistryState();
  view = reg.view;
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "host-cancel", disabled: reg.view.anyUnresolved }, "Cancel"),
    createElement(DraftRegistryProvider, { api: reg.api, view: reg.view }, children as never),
  );
}
const hostCancelDisabled = () => host!.querySelector<HTMLButtonElement>('[data-testid="host-cancel"]')!.disabled;
const pickerDisabled = () => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.disabled;

function create(strict: boolean) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return (node: unknown) =>
    act(async () => {
      root!.render(strict ? createElement(StrictMode, null, node as never) : (node as never));
    });
}
const pick = async (value: string) => {
  const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
function fill(testId: string, value: string) {
  const input = host!.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input, `input ${testId} is mounted`).not.toBeNull();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const typeReadings = () => {
  fill("reading-current", "120");
  fill("reading-duration", "1.5");
};
const press = (testId: string) => act(async () => host!.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());

type Opts = { strict?: boolean; record?: unknown; deferWrite?: boolean; remembered?: boolean };
/** Mount Host > Connected, open the panel and (unless `remembered`) pick the unit. Returns a re-render with a new savedIdentity. */
async function setup(o: Opts = {}) {
  let release: (v: { ok: boolean }) => void = () => {};
  if (o.deferWrite) actions.recordBlockMachineIdentityAction.mockImplementationOnce(() => new Promise<{ ok: boolean }>((r) => { release = r; }) as never);
  const load = vi.fn(async () => ({ ...CTX, remembered: o.remembered ? { deviceId: "room-9", modeKey: "galvanic" } : null }));
  const render = create(o.strict ?? false);
  const tree = (savedIdentity: typeof SAVED | null, mountConnected = true) =>
    createElement(Host, {
      children: mountConnected
        ? createElement(MachineFirstSetupConnected, { clientId: "c", sessionId: "s", blockId: "b1", load, record: o.record, savedIdentity } as never)
        : null,
    });
  await render(tree(null));
  await press("machine-first-open");
  if (!o.remembered) await pick("room-9");
  return { rerender: (s: typeof SAVED | null, mountConnected = true) => render(tree(s, mountConnected)), release: () => act(async () => release({ ok: true })) };
}
const inFlight = () => vi.fn(() => new Promise<never>(() => {}));

for (const strict of [false, true]) {
  const tag = strict ? "StrictMode" : "plain";
  describe(`the saved-identity flip while the reading entry is mounted [${tag}] (regression (a)-(e), T1, T4)`, () => {
    it("(a) typed readings stay a draft after savedIdentity flips false -> true", async () => {
      const { rerender } = await setup({ strict });
      expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "the entry is mounted after the pick").not.toBeNull();
      typeReadings();
      expect(view.anyDraft, "control: the draft is registered while typing").toBe(true);
      await rerender(SAVED);
      expect(host!.querySelector<HTMLInputElement>('[data-testid="reading-current"]')!.value, "the entry survived the flip with its value").toBe("120");
      expect(view.anyDraft, "the host still derives an unsaved draft (leave guard stays armed)").toBe(true);
    });

    it("(b) + T4: a save in flight stays unresolved after the flip, the picker stays frozen AND the HOST Cancel stays disabled", async () => {
      const record = inFlight();
      const { rerender } = await setup({ strict, record });
      typeReadings();
      await press("machine-reading-save");
      expect(record).toHaveBeenCalledTimes(1);
      expect(view.anyUnresolved, "control: the hold is registered").toBe(true);
      expect(pickerDisabled(), "control: the picker is frozen").toBe(true);
      expect(hostCancelDisabled(), "control: the HOST Cancel is disabled").toBe(true);
      await rerender(SAVED);
      expect(view.anyUnresolved, "still unresolved after the flip").toBe(true);
      expect(pickerDisabled(), "the picker stays frozen").toBe(true);
      expect(hostCancelDisabled(), "the HOST Cancel stays disabled: one click would unmount the entry and drop the retry key").toBe(true);
    });

    it("(c) the area's own identity write: the entry mounts only once it confirms, and its draft survives the host's flip", async () => {
      const { rerender, release } = await setup({ strict, deferWrite: true });
      expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "no entry while the write is pending").toBeNull();
      await release();
      expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "the entry mounts after the write confirms").not.toBeNull();
      typeReadings();
      expect(view.anyDraft).toBe(true);
      await rerender(SAVED);
      expect(host!.querySelector<HTMLInputElement>('[data-testid="reading-current"]')!.value).toBe("120");
      expect(view.anyDraft, "still a draft after the host supplies the written identity").toBe(true);
    });

    it("(d) an entry auto-selected from a remembered unit (NO identity write) keeps its draft across the later flip", async () => {
      const { rerender } = await setup({ strict, remembered: true });
      expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "mounted with no identity saved").not.toBeNull();
      expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
      typeReadings();
      expect(view.anyDraft).toBe(true);
      await rerender(SAVED);
      expect(view.anyDraft, "draft survives the host supplying the saved identity").toBe(true);
    });

    it("(e) + T4: a save in flight on an auto-selected entry: the hold, the frozen picker and the HOST Cancel survive the flip", async () => {
      const { rerender } = await setup({ strict, remembered: true, record: inFlight() });
      typeReadings();
      await press("machine-reading-save");
      expect(hostCancelDisabled(), "control").toBe(true);
      await rerender(SAVED);
      expect(view.anyUnresolved).toBe(true);
      expect(pickerDisabled(), "the picker stays frozen").toBe(true);
      expect(hostCancelDisabled(), "the HOST Cancel stays disabled").toBe(true);
    });
  });
}

// T2: a same-key remount of an OWNER. Each instance has its own useId, so the departing instance removes only ITS key and the arriving one
// writes its own - whether both land in one commit or across two.
function Owner({ draft, unresolved }: { draft: boolean; unresolved: boolean }) {
  useReportDraft({ draft, unresolved });
  return null;
}
describe("T2 a same-key remount of an owner", () => {
  const run = async (strict: boolean, mode: "one-commit" | "two-commits") => {
    const render = create(strict);
    const at = (k: string | null) => createElement(Host, { children: k ? createElement(Owner, { key: k, draft: true, unresolved: true }) : null });
    await render(at("same"));
    expect(view, "control").toEqual({ anyDraft: true, anyUnresolved: true });
    if (mode === "one-commit") {
      await render(at("other")); // old instance unmounts and a new one mounts in the same commit
    } else {
      await render(at(null));
      expect(view, "after the unmount alone, nothing is held").toEqual(NONE);
      await render(at("same"));
    }
    expect(view, "the arriving instance's flags are registered").toEqual({ anyDraft: true, anyUnresolved: true });
  };
  for (const strict of [false, true])
    for (const mode of ["one-commit", "two-commits"] as const) it(`${mode}${strict ? " (StrictMode)" : ""}`, () => run(strict, mode));
});

// T3: a save that answers AFTER its entry unmounted must not re-register, warn, or reach the host.
describe("T3 a late save answer after the entry unmounted", () => {
  it("registers nothing, warns nothing, calls nothing", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let answer: (v: { ok: boolean }) => void = () => {};
    const record = vi.fn(() => new Promise<{ ok: boolean }>((r) => { answer = r; }));
    const { rerender } = await setup({ record });
    typeReadings();
    await press("machine-reading-save");
    expect(view.anyUnresolved, "control: in flight").toBe(true);
    await rerender(null, false); // the whole connected tree goes away mid-save
    expect(view, "the departed entry removed its own keys").toEqual(NONE);
    await act(async () => answer({ ok: true }));
    await act(async () => {});
    expect(view, "a late answer does not re-register").toEqual(NONE);
    expect(warn, "no React warning").not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
  });
});

// T5: the create form's setting draft is an owner too.
describe("T5 the setting draft is a registry owner", () => {
  it("typing registers a draft; unmounting removes exactly it", async () => {
    const render = create(false);
    const at = (on: boolean) =>
      createElement(Host, { children: on ? createElement(MachineSettingDraft, { profile: PROFILE, mode: PROFILE.modes[0], onDraftChange: () => {} } as never) : null });
    await render(at(true));
    expect(view.anyDraft, "an empty mount is not a draft").toBe(false);
    const input = host!.querySelector<HTMLInputElement>('[data-testid="machine-setting-draft"] input:not([type=checkbox])');
    expect(input, "a setting input exists").not.toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(input, "120");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(view.anyDraft, "typed settings are a draft").toBe(true);
    await render(at(false));
    expect(view.anyDraft, "unmounting the draft removes its entry").toBe(false);
  });

  it("block-setup-form: identityDirty is a registry owner, and the early return precedes BOTH writes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
    expect(src).toMatch(/useReportDraft\(\{ draft: identityDirty, unresolved: false \}, draftRegistry\.api\)/);
    const body = src.slice(src.indexOf("const onIdentityDraft"));
    const early = body.indexOf("if (createAttemptRef.current !== null) return;");
    expect(early, "the unresolved-create early return exists").toBeGreaterThan(0);
    expect(early).toBeLessThan(body.indexOf("identityDraftRef.current = choice"));
    expect(early).toBeLessThan(body.indexOf("setIdentityDirty(choice !== null)"));
    expect((src.match(/setIdentityDirty\(/g) ?? []).length, "one writer of the flag").toBe(1);
  });
});

// T6: a randomized oracle. The expected view is computed from the test's OWN action log (which owners are mounted and what they last
// wrote), never from the registry, across StrictMode and parent re-render churn (fresh props and element identities every step).
describe("T6 randomized oracle", () => {
  type Slot = { mounted: boolean; draft: boolean; unresolved: boolean };
  function Slotted({ slot }: { slot: Slot; churn: number }) {
    useReportDraft({ draft: slot.draft, unresolved: slot.unresolved });
    return null;
  }
  function Driver({ slots, churn }: { slots: Slot[]; churn: number }) {
    return createElement(Host, { children: slots.map((s, i) => (s.mounted ? createElement(Slotted, { key: `${i}`, slot: { ...s }, churn }) : null)) });
  }
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const strict of [false, true])
    for (let seed = 1; seed <= 12; seed++)
      it(`seed ${seed}${strict ? " (StrictMode)" : ""}`, async () => {
        const r = rng(seed * 7919);
        const slots: Slot[] = [0, 1, 2].map(() => ({ mounted: false, draft: false, unresolved: false }));
        const render = create(strict);
        const log: string[] = [];
        for (let step = 0; step < 40; step++) {
          const i = Math.floor(r() * slots.length);
          const kind = Math.floor(r() * 4);
          if (kind === 0) slots[i].mounted = !slots[i].mounted;
          else if (kind === 1) slots[i].draft = !slots[i].draft;
          else if (kind === 2) slots[i].unresolved = !slots[i].unresolved;
          log.push(`${step}:${i}:${kind}`);
          await render(createElement(Driver, { slots: slots.map((s) => ({ ...s })), churn: step }));
          const expected = {
            anyDraft: slots.some((s) => s.mounted && s.draft),
            anyUnresolved: slots.some((s) => s.mounted && s.unresolved),
          };
          expect(view, `after ${log.join(" ")}`).toEqual(expected);
        }
      });
});

// SPELLING TRIPWIRE: nothing outside the hook may write the host's draft or hold. The only writers are `useReportDraft` and the registry's
// own api; a component that takes or calls a draft/hold setter again reintroduces the edge-triggered model.
describe("no writer outside useReportDraft", () => {
  it("no component takes or calls a host draft/hold callback", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dirs = ["components/machines", "app/(app)/clients/[id]/sessions/[sessionId]"];
    const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`));
    expect(files.length, "the sweep must cover its subjects").toBeGreaterThan(20);
    const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const offenders = files.filter((f) => /\bon(Revision(Draft|Unresolved)|UnresolvedChange)\b|\bset(RevisionUnresolved|RevisionDraft)\b/.test(code(f)));
    expect(offenders, "a draft/hold callback came back").toEqual([]);
    const writers = files.filter((f) => /\bapi\??\.(report|remove)\(/.test(code(f)));
    expect(writers, "only the hook's module touches the registry api").toEqual(["components/machines/draft-registry.tsx"]);
    expect(code("components/machines/draft-registry.tsx"), "the removal effect keeps [] deps").toMatch(/return \(\) => api\?\.remove\(id\);[\s\S]*?\}, \[\]\);/);
  });
});
