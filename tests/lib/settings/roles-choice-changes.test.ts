import { describe, expect, it } from "vitest";
import { chosenChanges, defaultsPolicy, savedChoicesFor } from "@/lib/settings/roles/diff";
import type { Role, StudioPolicy } from "@/lib/permissions/catalog";

// Codex P2 4584672884: adopting defaults while nothing is released leaves the effective-access diff EMPTY, yet it changes the owner's fallback
// choices (appt.cancel for a receptionist: Off on an existing studio, Whole studio on a new one). Those must be listed.

const existing = (values: Record<string, string> = {}) => ({ basis: "existing_snapshot", values, gates: {} }) as unknown as StudioPolicy;
const policies = (p = existing(), r = existing()) => ({ practitioner: p, receptionist: r }) as Record<Role, StudioPolicy>;
const toDefaults = (p: Record<Role, StudioPolicy>) => ({ practitioner: defaultsPolicy(p.practitioner), receptionist: defaultsPolicy(p.receptionist) });

describe("adopt lists the choices it changes", () => {
  it("an existing studio with no overrides: the receptionist's appt.cancel moves Off to Whole studio, and the practitioner's does not move", () => {
    const p = policies();
    const out = chosenChanges(["practitioner", "receptionist"], p, toDefaults(p));
    const cancel = out.filter((c) => c.key === "appt.cancel");
    expect(cancel).toEqual([{ role: "receptionist", key: "appt.cancel", label: "Cancel appointments", from: "off", to: "studio" }]);
    expect(out.length).toBeGreaterThan(0);
  });
  it("a reset for ONE role lists only that role", () => {
    const p = policies();
    const out = chosenChanges(["receptionist"], p, toDefaults(p));
    expect(out.every((c) => c.role === "receptionist")).toBe(true);
  });
  it("a studio already on the defaults has nothing to list (control: the list is not always non-empty)", () => {
    const p = { practitioner: defaultsPolicy(existing()), receptionist: defaultsPolicy(existing()) } as Record<Role, StudioPolicy>;
    expect(chosenChanges(["practitioner", "receptionist"], p, toDefaults(p))).toEqual([]);
  });
  it("a stored override that equals the new default is not a change", () => {
    const p = policies(existing(), existing({ "appt.cancel": "studio" }));
    expect(chosenChanges(["receptionist"], p, toDefaults(p)).filter((c) => c.key === "appt.cancel")).toEqual([]);
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
