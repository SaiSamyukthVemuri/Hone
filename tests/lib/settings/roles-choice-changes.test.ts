import { describe, expect, it } from "vitest";
import { adoptTarget, chosenChanges, resetTarget, savedChoicesFor } from "@/lib/settings/roles/diff";
import type { Role, StudioPolicy } from "@/lib/permissions/catalog";

// Codex P2 4584672884: adopting defaults while nothing is released leaves the effective-access diff EMPTY, yet it changes the owner's fallback
// choices (appt.cancel for a receptionist: Off on an existing studio, Whole studio on a new one). Those must be listed.

const existing = (values: Record<string, string> = {}) => ({ basis: "existing_snapshot", values, gates: {} }) as unknown as StudioPolicy;
const policies = (p = existing(), r = existing()) => ({ practitioner: p, receptionist: r }) as Record<Role, StudioPolicy>;
const adopted = (p: Record<Role, StudioPolicy>) => ({ practitioner: adoptTarget(p.practitioner), receptionist: adoptTarget(p.receptionist) });
const resetOf = (p: Record<Role, StudioPolicy>, role: Role) => ({ ...p, [role]: resetTarget(p[role]) });

describe("adopt lists the choices it changes (basis moves to new_studio, stored overrides are KEPT)", () => {
  it("an existing studio with no overrides: the receptionist's appt.cancel moves Off to Whole studio, and the practitioner's does not move", () => {
    const p = policies();
    const out = chosenChanges(["practitioner", "receptionist"], p, adopted(p));
    expect(out.filter((c) => c.key === "appt.cancel")).toEqual([{ role: "receptionist", key: "appt.cancel", label: "Cancel appointments", from: "off", to: "studio" }]);
    expect(out.length).toBeGreaterThan(0);
  });
  it("Codex 4623900551: a stored practitioner appt.cancel = off STAYS Off on adoption, so it is not previewed as a move to Whole studio", () => {
    const p = policies(existing({ "appt.cancel": "off" }));
    expect(chosenChanges(["practitioner"], p, adopted(p)).filter((c) => c.key === "appt.cancel")).toEqual([]);
  });
  it("a stored override that equals the new default is not a change", () => {
    const p = policies(existing(), existing({ "appt.cancel": "studio" }));
    expect(chosenChanges(["receptionist"], p, adopted(p)).filter((c) => c.key === "appt.cancel")).toEqual([]);
  });
  it("a studio already on new_studio with no overrides has nothing to list (control: the list is not always non-empty)", () => {
    const fresh = { basis: "new_studio", values: {}, gates: {} } as unknown as StudioPolicy;
    const p = policies(fresh, fresh);
    expect(chosenChanges(["practitioner", "receptionist"], p, adopted(p))).toEqual([]);
  });
});

describe("reset lists the choices it changes (stored overrides of ONE role are deleted, the basis is KEPT)", () => {
  it("Codex 4623900551: resetting an existing_snapshot studio with no overrides previews nothing (the new-studio defaults are not applied by a reset)", () => {
    const p = policies();
    expect(chosenChanges(["receptionist"], p, resetOf(p, "receptionist"))).toEqual([]);
  });
  it("a stored override is reverted to the studio's own basis value, for that role only", () => {
    const p = policies(existing({ "appt.cancel": "off" }), existing({ "appt.cancel": "studio" }));
    const out = chosenChanges(["practitioner"], p, resetOf(p, "practitioner"));
    expect(out).toEqual([{ role: "practitioner", key: "appt.cancel", label: "Cancel appointments", from: "off", to: "studio" }]);
  });
  it("on a new_studio studio the basis value is the new-studio default", () => {
    const ns = (values: Record<string, string>) => ({ basis: "new_studio", values, gates: {} }) as unknown as StudioPolicy;
    const p = policies(ns({ "appt.cancel": "off" }), ns({}));
    expect(chosenChanges(["practitioner"], p, resetOf(p, "practitioner"))).toEqual([{ role: "practitioner", key: "appt.cancel", label: "Cancel appointments", from: "off", to: "studio" }]);
  });
});

describe("a save's summary uses the values held at the previewed version", () => {
  it("before-values come from the policy passed in (not from anything the page holds), null when none is stored", () => {
    const fresh = policies(existing({ "appt.cancel": "off" }));
    const out = savedChoicesFor(fresh, { practitioner: { "appt.cancel": "own", "appt.move": "off" } });
    expect(out).toEqual([
      { role: "practitioner", key: "appt.cancel", label: "Cancel appointments", from: "off", to: "own" },
      { role: "practitioner", key: "appt.move", label: expect.any(String), from: null, to: "off" },
    ]);
  });
});
