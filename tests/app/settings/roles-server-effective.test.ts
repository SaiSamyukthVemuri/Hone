import { describe, expect, it } from "vitest";
import { parseState } from "@/lib/settings/roles/core-parse";
import { buildRoleModel, applyEdit, NOT_ACTIVE_YET_LINE, notActiveYetKeeps } from "@/lib/settings/roles/model";
import { shownEffectiveScope, type PolicyWithServer } from "@/lib/settings/roles/server-effective";
import { effectiveScope } from "@/lib/permissions/catalog";

// The mirror (catalog effectiveScope) cannot know the release rules (0287 activation rule: pending, narrow, activated). Where the core
// answered, the Roles page must show the core's answer.

const KEY = "appt.cancel";
const policy = (over: Partial<PolicyWithServer["server"] & object>, values: Record<string, "off" | "own" | "studio"> = {}): PolicyWithServer => ({
  basis: "new_studio",
  values,
  gates: {},
  server: { stored: { ...values }, effective: {}, source: {}, ...over },
});
const rowOf = (p: PolicyWithServer, key = KEY) =>
  buildRoleModel("practitioner", p).flatMap((g) => g.rows).find((r) => r.key === key)!;

describe("page shows the core's effective value", () => {
  it("a saved choice that is pending activation is shown as NOT in force, with the core's value", () => {
    // The mirror would release it as FULL and say "studio".
    const p = policy({ effective: { [KEY]: "own" }, source: { [KEY]: "inactive_until_activated" } }, { [KEY]: "studio" });
    expect(effectiveScope("practitioner", KEY, p)).toBe("studio");
    const r = rowOf(p);
    expect(r.chosen).toBe("studio");
    expect(r.effective).toBe("own");
    expect(r.inactiveBecause).toBe(NOT_ACTIVE_YET_LINE);
  });
  it("an unreleased key also stays at the core's value", () => {
    const p = policy({ effective: { [KEY]: "off" }, source: { [KEY]: "unreleased" } }, { [KEY]: "studio" });
    expect(rowOf(p).effective).toBe("off");
  });
  it("Codex P1: a saved Off on a key that is not released yet says what is STILL in force, never just Off", () => {
    const p = policy({ effective: { [KEY]: "studio" }, source: { [KEY]: "unreleased" } }, { [KEY]: "off" });
    const r = rowOf(p);
    expect(r.chosen).toBe("off");
    expect(r.effective).toBe("studio");
    expect(r.inactiveBecause).toBe(notActiveYetKeeps("practitioner", "Whole studio"));
    expect(r.inactiveBecause).toMatch(/practitioners keep: Whole studio/);
  });
  it("the same for a released key awaiting activation, and for a draft that tightens it", () => {
    const p = policy({ effective: { [KEY]: "studio" }, source: { [KEY]: "inactive_until_activated" } }, { [KEY]: "studio" });
    expect(rowOf(p).inactiveBecause).toBeNull(); // nothing differs, nothing to say
    const edited = applyEdit("practitioner", p, KEY, "off");
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(rowOf(edited.policy as PolicyWithServer).inactiveBecause).toMatch(/keep: Whole studio/);
  });
  it("a live (stored) lower value is NOT flagged: it is in force", () => {
    const p = policy({ effective: { [KEY]: "off" }, source: { [KEY]: "stored" } }, { [KEY]: "off" });
    expect(rowOf(p).inactiveBecause).toBeNull();
  });
  it("a draft change cannot lift an inert key above the core's value", () => {
    const p = policy({ effective: { [KEY]: "own" }, source: { [KEY]: "inactive_until_activated" } }, { [KEY]: "studio" });
    const edited = applyEdit("practitioner", p, KEY, "off");
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(shownEffectiveScope("practitioner", KEY, edited.policy as PolicyWithServer)).toBe("own");
  });
  it("an unchanged, released key shows the core's value even where the mirror differs (narrow release)", () => {
    const p = policy({ effective: { [KEY]: "own" }, source: { [KEY]: "stored" } }, { [KEY]: "studio" });
    expect(shownEffectiveScope("practitioner", KEY, p)).toBe("own");
  });
  it("without a core answer the mirror is used (the page is read-only then)", () => {
    const p: PolicyWithServer = { basis: "existing_snapshot", values: {}, gates: {} };
    expect(shownEffectiveScope("practitioner", KEY, p)).toBe(effectiveScope("practitioner", KEY, p));
  });
  it("applyEdit keeps the core's answer on the draft", () => {
    const p = policy({ effective: { [KEY]: "own" }, source: { [KEY]: "stored" } }, { [KEY]: "own" });
    const edited = applyEdit("practitioner", p, KEY, "off");
    if (edited.ok) expect((edited.policy as PolicyWithServer).server).toBe(p.server);
  });
});

describe("parseState carries the core's effective and source", () => {
  const raw = {
    ok: true, version: 3, basis: "new_studio", gates: {},
    roles: {
      practitioner: { [KEY]: { stored: "studio", effective: "own", source: "inactive_until_activated" } },
      receptionist: { [KEY]: { stored: null, effective: "off", source: "snapshot" } },
    },
  };
  it("keeps stored, effective and source per role", () => {
    const s = parseState(raw)!;
    expect(s.policies.practitioner.values[KEY]).toBe("studio");
    const srv = (s.policies.practitioner as PolicyWithServer).server!;
    expect(srv.effective[KEY]).toBe("own");
    expect(srv.source[KEY]).toBe("inactive_until_activated");
    expect(srv.stored[KEY]).toBe("studio");
    expect((s.policies.receptionist as PolicyWithServer).server!.stored[KEY]).toBeUndefined();
  });
});

describe("NQ-10: a pending choice also says what it is waiting on", () => {
  const EDIT = "clin.edit_records";
  const VIEW = "clin.view_records";
  it("names View clinical records when viewing is off, and says the choice is kept", () => {
    const p = policy(
      { effective: { [EDIT]: "off", [VIEW]: "off" }, source: { [EDIT]: "inactive_until_activated", [VIEW]: "stored" } },
      { [EDIT]: "own", [VIEW]: "off" },
    );
    const r = rowOf(p, EDIT);
    expect(r.inactiveBecause).toBe(NOT_ACTIVE_YET_LINE);
    expect(r.inactiveUntil).toBe("Inactive until View clinical records is on. Your choice is kept.");
  });
  it("shows no such line when viewing is on, or when the row is not pending", () => {
    const on = policy(
      { effective: { [EDIT]: "off", [VIEW]: "own" }, source: { [EDIT]: "inactive_until_activated", [VIEW]: "stored" } },
      { [EDIT]: "own", [VIEW]: "own" },
    );
    expect(rowOf(on, EDIT).inactiveUntil).toBeNull();
    const notPending = policy({ effective: { [EDIT]: "off", [VIEW]: "off" }, source: { [EDIT]: "stored", [VIEW]: "stored" } }, { [EDIT]: "own", [VIEW]: "off" });
    expect(rowOf(notPending, EDIT).inactiveUntil).toBeNull();
    expect(rowOf(notPending, EDIT).inactiveBecause).toMatch(/^Inactive: needs/);
  });
});
