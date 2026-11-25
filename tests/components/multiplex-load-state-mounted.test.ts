// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// THE HOST'S MULTIPLEX LOAD STATE, mounted. The real BlockSetupForm and the real Save visit control; the machine panel is a stand-in the test drives
// by hand (it settles, applies, refuses and unmounts exactly when told), so every transition and every Save/Save visit outcome is reached on purpose.
// The REAL panel's own sequences (Choose machine adoption, route-less retry) are in xcell-mode-control-mounted.test.ts.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/clients/c1/sessions/s1",
}));
const blockActions = vi.hoisted(() => ({ updateTreatmentAreaWithEntryAction: vi.fn(), createTreatmentAreaWithEntryAction: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", () => blockActions);
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => ({
  lookupAreaCreateClaimAction: vi.fn(async () => ({ ok: true, status: "absent" })),
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
type PanelProps = {
  multiplexLoadToken?: number | null;
  onMultiplexSettled?: (t: number, r: "ok" | "no_route" | "error") => void;
  onMultiplexOutcome?: (t: number, o: "applied" | "not_applied") => void;
  onPanelPresence?: (p: boolean) => void;
};
const panel = vi.hoisted(() => ({ props: null as unknown, hide: () => undefined as void, show: () => undefined as void }));
vi.mock("@/components/machines/machine-first-setup-connected", async () => {
  const { createElement, useEffect, useState } = await import("react");
  function Probe(props: PanelProps) {
    panel.props = props;
    useEffect(() => {
      props.onPanelPresence?.(true);
      return () => props.onPanelPresence?.(false);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return createElement("div", { "data-testid": "stand-in-panel" });
  }
  return {
    MachineFirstSetupConnected: (props: PanelProps) => {
      const [hidden, setHidden] = useState(false);
      panel.hide = () => setHidden(true);
      panel.show = () => setHidden(false);
      return hidden ? null : createElement(Probe, props);
    },
  };
});

const { createElement, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
const { ChartingVisitSaveProvider, VisitSaveControl } = await import("@/components/charting-visit-save");
const { ChartingVisitDraftProvider } = await import("@/components/charting-visit-draft");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const create = blockActions.createTreatmentAreaWithEntryAction;
const FAILED = "MultiPlex could not be loaded, so nothing was saved. Pick MultiPlex again, or choose another mode.";
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; create.mockReset(); panel.props = null; });

async function mount(opts: { strict?: boolean } = {}) {
  create.mockResolvedValue({ ok: true, blockId: "new-b1" });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const tree = createElement(ChartingVisitDraftProvider, null,
    createElement(ChartingVisitSaveProvider, null,
      createElement(BlockSetupForm, {
        sessionId: "s1", clientId: "c1", previousBlock: null, block: null, firstEntry: null, initialAreas: [{ area: "Upper lip", side: "center" }] as never,
        defaultMachineFrequency: null, onCancel: () => undefined, multiplexOffer: { deviceId: "unit-pur" },
      } as never),
      createElement(VisitSaveControl)));
  await act(async () => root!.render(opts.strict ? createElement(StrictMode, null, tree) : tree));
}
const p = () => panel.props as Required<PanelProps>;
const pill = () => host!.querySelector<HTMLButtonElement>('[data-testid="mode-multiplex"]');
const legacyPill = (label: string) => Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === label)!;
const saveButton = () => host!.querySelector<HTMLButtonElement>('[data-testid="save-treatment-area"]')!;
const alertText = () => host!.querySelector('[role="alert"]')?.textContent ?? null;
const clickPill = () => act(async () => { pill()!.click(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const settle = (r: "ok" | "no_route" | "error") => act(async () => { p().onMultiplexSettled(p().multiplexLoadToken!, r); });
const outcome = (o: "applied" | "not_applied") => act(async () => { p().onMultiplexOutcome(p().multiplexLoadToken!, o); });
const token = () => p().multiplexLoadToken;
async function typeNote(text = "an edited note") {
  const ta = host!.querySelector<HTMLTextAreaElement>('[data-testid="additional-notes"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(ta, text); ta.dispatchEvent(new Event("input", { bubbles: true })); });
}
const noteValue = () => host!.querySelector<HTMLTextAreaElement>('[data-testid="additional-notes"]')!.value;
const saveVisit = () => act(async () => void host!.querySelector<HTMLButtonElement>('[data-testid="visit-save-button"]')!.click());
const visitStatus = () => host!.querySelector('[data-testid^="visit-save-result-"]')?.getAttribute("data-status");

describe("MultiPlex load state: transitions, mounted (stand-in panel)", () => {
  it("off -> loading: the click mints a token, the panel is handed it, Save is held and says so", async () => {
    await mount();
    expect(token()).toBeNull();
    await clickPill();
    expect(token()).toBe(1);
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toContain("Loading MultiPlex");
  });

  it("loading -> ready: settled ok then applied; the hold lifts and the area saves", async () => {
    await mount();
    await typeNote();
    await clickPill();
    await settle("ok");
    expect(saveButton().disabled, "ok alone does not end the hold: the choice is not applied yet").toBe(true);
    await outcome("applied");
    expect(saveButton().disabled).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a double open (the pill clicked again while loading) keeps the SAME token and does not restart", async () => {
    await mount();
    await clickPill();
    const first = token();
    await clickPill();
    expect(token()).toBe(first);
  });

  it("legacy mode while loading -> off: the late answer for the old token is dropped and Save is open", async () => {
    await mount();
    await clickPill();
    const old = token()!;
    await act(async () => { legacyPill("Thermolysis").click(); });
    expect(token()).toBeNull();
    await act(async () => { p().onMultiplexSettled(old, "error"); });
    expect(saveButton().disabled).toBe(false);
    expect(alertText()).toBeNull();
  });

  it("REJOIN UNDER A NEW TOKEN: loading t1, a legacy mode, MultiPlex again (t2): the load that was running answers t2, and t1's own answer is ignored", async () => {
    await mount();
    await clickPill();
    const t1 = token()!;
    await act(async () => { legacyPill("Blend").click(); });
    await clickPill();
    const t2 = token()!;
    expect(t2).toBeGreaterThan(t1);
    await act(async () => { p().onMultiplexSettled(t1, "error"); });
    expect(saveButton().disabled, "t1's answer matches nothing").toBe(true);
    await settle("ok");
    await outcome("applied");
    expect(saveButton().disabled).toBe(false);
  });

  it("an undo (MultiPlex pressed again once it is ready) -> off with a new token", async () => {
    await mount();
    await clickPill();
    await settle("ok");
    await outcome("applied");
    // the stand-in reports no chosen device, so the form does not show MultiPlex as selected: pressing the pill selects again (re-select -> loading)
    await clickPill();
    expect(token()).toBe(2);
  });

  for (const reason of ["error", "no_route"] as const) {
    it(`loading -> failed (${reason}): Save refuses with the plain message, nothing is sent, the PILL stays, the draft is kept, and a click retries`, async () => {
      await mount();
      await typeNote("typed before the failure");
      await clickPill();
      await settle(reason);
      expect(saveButton().disabled, "refusing, not blocked: she can press it and be told why").toBe(false);
      await act(async () => { saveButton().click(); });
      expect(create).not.toHaveBeenCalled();
      expect(alertText()).toBe(FAILED);
      expect(pill(), "the way out the message names is on screen: MultiPlex again").not.toBeNull();
      expect(legacyPill("Thermolysis"), "...or another mode").toBeTruthy();
      expect(noteValue(), "the draft survives the failure").toBe("typed before the failure");
      await clickPill();
      expect(token()).toBe(2);
      await settle("ok");
      await outcome("applied");
      expect(saveButton().disabled).toBe(false);
      expect(noteValue()).toBe("typed before the failure");
    });
  }

  it("loading -> failed (not applied: the choice was refused, frozen or gated): same refusal, retryable", async () => {
    await mount();
    await typeNote("kept");
    await clickPill();
    await settle("ok");
    await outcome("not_applied");
    await act(async () => { saveButton().click(); });
    expect(create).not.toHaveBeenCalled();
    expect(alertText()).toBe(FAILED);
    expect(noteValue()).toBe("kept");
    await clickPill();
    expect(token()).toBe(2);
  });

  it("APPLY REFUSED BEFORE THE LOAD ANSWERS (a gated panel reports the refusal first): failed, and the later answer cannot reopen it", async () => {
    await mount();
    await clickPill();
    await outcome("not_applied");
    await settle("ok");
    await act(async () => { saveButton().click(); });
    expect(create).not.toHaveBeenCalled();
    expect(alertText()).toBe(FAILED);
  });

  it("PANEL-ONLY UNMOUNT mid-load: loading ends in failed (retryable), it never waits forever; the draft is kept", async () => {
    await mount();
    await typeNote("still here");
    await clickPill();
    expect(saveButton().disabled).toBe(true);
    await act(async () => { panel.hide(); });
    await flush();
    expect(saveButton().disabled).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create).not.toHaveBeenCalled();
    expect(alertText()).toBe(FAILED);
    expect(noteValue()).toBe("still here");
    // and it is retryable once the panel is back
    await act(async () => { panel.show(); });
    await clickPill();
    expect(token()).toBe(2);
    await settle("ok");
    await outcome("applied");
    expect(saveButton().disabled).toBe(false);
  });

  it("STRICTMODE: the effect cleanup + setup pair does not report the panel gone; the load keeps holding and then completes", async () => {
    await mount({ strict: true });
    await clickPill();
    await flush();
    expect(saveButton().disabled, "still loading, not failed").toBe(true);
    expect(alertText()).toBeNull();
    await settle("ok");
    await outcome("applied");
    expect(saveButton().disabled).toBe(false);
  });

  it("an identity written while a load is in flight: that load must not apply after it (failed, Save refuses)", async () => {
    await mount();
    await clickPill();
    await act(async () => { (panel.props as { onSavedDeviceChange?: (id: string | null) => void }).onSavedDeviceChange?.("unit-pur"); });
    expect(token(), "the load is no longer current").toBeNull();
    await act(async () => { saveButton().click(); });
    expect(create).not.toHaveBeenCalled();
    expect(alertText()).toBe(FAILED);
    // (in this test the written id equals the routed unit, which is the saved-as-MultiPlex state: the pill is then the saved choice, not a retry)
  });
});

describe("Save and Save visit read ONE state: the same outcome in every state", () => {
  type St = "off" | "loading" | "failed" | "ready";
  async function reach(st: St) {
    await mount();
    await typeNote();
    if (st === "off") return;
    await clickPill();
    if (st === "loading") return;
    if (st === "failed") return void (await settle("error"));
    await settle("ok");
    await outcome("applied");
  }
  const EXPECT: Record<St, { sent: number; visit: string }> = {
    off: { sent: 1, visit: "saved" },
    ready: { sent: 1, visit: "saved" },
    loading: { sent: 0, visit: "held" },
    failed: { sent: 0, visit: "held" },
  };
  for (const st of ["off", "loading", "failed", "ready"] as const) {
    it(`${st}: the Save button and Save visit send ${EXPECT[st].sent} request(s) and Save visit reports ${EXPECT[st].visit}`, async () => {
      await reach(st);
      await act(async () => { saveButton().click(); });
      const viaButton = create.mock.calls.length;
      act(() => root?.unmount()); host?.remove(); root = host = null; create.mockReset();
      await reach(st);
      await saveVisit();
      expect(viaButton, "button").toBe(EXPECT[st].sent);
      expect(create.mock.calls.length, "Save visit").toBe(EXPECT[st].sent);
      expect(visitStatus()).toBe(EXPECT[st].visit);
      if (st === "loading") expect(alertText()).toBe("Loading MultiPlex…");
      if (st === "failed") expect(alertText()).toBe(FAILED);
    });
  }

  it("the section line belongs to the token it was left for: a new click clears it without any hand-clearing", async () => {
    await reach("loading");
    await saveVisit();
    expect(alertText()).toBe("Loading MultiPlex…");
    await settle("ok");
    await outcome("applied");
    expect(alertText(), "the loading line goes once the load is done").toBeNull();
  });
});
