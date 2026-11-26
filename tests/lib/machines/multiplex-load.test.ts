import { describe, expect, it } from "vitest";
import {
  MULTIPLEX_LOAD_INITIAL,
  multiplexLoadStep,
  multiplexSaveGate,
  type MultiplexFailReason,
  type MultiplexLoadEvent,
  type MultiplexLoadState,
} from "@/lib/machines/multiplex-load";

// THE WHOLE STATE MACHINE, EXHAUSTIVELY: every state x every event. A cell that is not listed in SPECIFIED must leave the state UNCHANGED, so a new
// state or event cannot silently change what an old combination does. Tokens: the current loading token is 4; 3 is a stale one.
const CUR = 4;
const STALE = 3;
const off: MultiplexLoadState = { phase: "off", seq: CUR, want: false, reason: null };
const loading: MultiplexLoadState = { phase: "loading", seq: CUR, want: true, reason: null };
const ready: MultiplexLoadState = { phase: "ready", seq: CUR, want: true, reason: null };
const failed = (reason: MultiplexFailReason): MultiplexLoadState => ({ phase: "failed", seq: CUR, want: true, reason });
const STATES: Record<string, MultiplexLoadState> = {
  off, loading, ready, "failed:error": failed("error"), "failed:no_route": failed("no_route"), "failed:not_applied": failed("not_applied"),
  "failed:panel_gone": failed("panel_gone"), "failed:stale_identity": failed("stale_identity"),
};
const EVENTS: Record<string, MultiplexLoadEvent> = {
  select: { t: "select" }, undo: { t: "undo" }, legacy: { t: "legacy" }, identityWritten: { t: "identityWritten" },
  "settled ok (current)": { t: "settled", token: CUR, result: "ok" },
  "settled no_route (current)": { t: "settled", token: CUR, result: "no_route" },
  "settled error (current)": { t: "settled", token: CUR, result: "error" },
  "settled error (stale)": { t: "settled", token: STALE, result: "error" },
  "applied (current)": { t: "applied", token: CUR }, "applied (stale)": { t: "applied", token: STALE },
  "notApplied (current)": { t: "notApplied", token: CUR }, "notApplied (stale)": { t: "notApplied", token: STALE },
  "panelGone (current)": { t: "panelGone", token: CUR }, "panelGone (stale)": { t: "panelGone", token: STALE },
};
const minted = (want: boolean, phase: "loading" | "off"): MultiplexLoadState => ({ phase, seq: CUR + 1, want, reason: null });

// [state, event] -> expected next state. Everything else is unchanged.
const SPECIFIED = new Map<string, MultiplexLoadState>();
const set = (st: string, ev: string, next: MultiplexLoadState) => SPECIFIED.set(`${st}|${ev}`, next);
for (const st of Object.keys(STATES)) {
  // a select mints a NEW token and loads, from every phase but loading (that is the double open, unchanged)
  if (st !== "loading") set(st, "select", minted(true, "loading"));
  // undo and a legacy mode ALWAYS mint a new token and go off, whatever the phase
  set(st, "undo", minted(false, "off"));
  set(st, "legacy", minted(false, "off"));
}
set("loading", "settled no_route (current)", { ...loading, phase: "failed", reason: "no_route" });
set("loading", "settled error (current)", { ...loading, phase: "failed", reason: "error" });
set("loading", "applied (current)", { ...loading, phase: "ready" });
set("loading", "notApplied (current)", { ...loading, phase: "failed", reason: "not_applied" });
set("loading", "panelGone (current)", { ...loading, phase: "failed", reason: "panel_gone" });
set("loading", "identityWritten", { ...loading, phase: "failed", reason: "stale_identity" });
// "settled ok (current)" leaves loading UNCHANGED on purpose: the apply or refusal that follows is what ends it.

describe("the MultiPlex load state machine: every state x every event", () => {
  for (const [sn, state] of Object.entries(STATES)) {
    for (const [en, event] of Object.entries(EVENTS)) {
      const expected = SPECIFIED.get(`${sn}|${en}`) ?? state;
      it(`${sn} + ${en} -> ${SPECIFIED.has(`${sn}|${en}`) ? `${expected.phase}${expected.reason ? ":" + expected.reason : ""} (seq ${expected.seq})` : "unchanged"}`, () => {
        expect(multiplexLoadStep(state, event)).toEqual(expected);
      });
    }
  }

  it("a click-minted token is the ONLY way out of `off`: nothing but `select` ever produces `loading` from `off`", () => {
    for (const [en, event] of Object.entries(EVENTS)) {
      const next = multiplexLoadStep(off, event);
      if (en === "select") expect(next.phase).toBe("loading");
      else expect(next.phase, en).not.toBe("loading");
    }
    // so a saved MultiPlex area, "Choose machine" and an automatic open (none of which mint a token) can never hold or refuse a Save
    expect(multiplexSaveGate(multiplexLoadStep(MULTIPLEX_LOAD_INITIAL, { t: "settled", token: 1, result: "error" }))).toBe("open");
  });

  it("every token is minted ONCE per click and never reused: the sequence only goes up", () => {
    let s = MULTIPLEX_LOAD_INITIAL;
    const seen: number[] = [];
    for (const ev of ["select", "legacy", "select", "undo", "select", "select"] as const) {
      s = multiplexLoadStep(s, { t: ev });
      seen.push(s.seq);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 5]); // the last select is a double open: the SAME token
  });

  it("the Save gate: held while loading, refused when failed, open otherwise", () => {
    expect(Object.fromEntries(Object.entries(STATES).map(([n, s]) => [n, multiplexSaveGate(s)]))).toEqual({
      off: "open", loading: "held", ready: "open",
      "failed:error": "refused", "failed:no_route": "refused", "failed:not_applied": "refused", "failed:panel_gone": "refused", "failed:stale_identity": "refused",
    });
  });

  it("every failed reason is retryable: select from it starts a fresh load", () => {
    for (const r of ["error", "no_route", "not_applied", "panel_gone", "stale_identity"] as const) {
      expect(multiplexLoadStep(failed(r), { t: "select" })).toEqual({ phase: "loading", seq: CUR + 1, want: true, reason: null });
    }
  });
});
