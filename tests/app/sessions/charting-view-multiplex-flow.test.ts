import { describe, expect, it } from "vitest";
import { APILUS_3G_NATIVE_FIXTURES } from "@/lib/machines/apilus-3g-fixtures";
import { modeFields } from "@/lib/machines/profile-contract";
import { nativeFieldGroups } from "@/lib/machines/charting";

// Every mode, MultiPlex and Blend included, reaches the screen through the same contract helpers: the fields a mode
// shows are exactly the fields its contract names. So enabling a mode is a contract change (published by Machines),
// never a charting-view change, and both views render it identically.
describe("modes use the shared contract-driven flow", () => {
  const modes = APILUS_3G_NATIVE_FIXTURES.flatMap((p) => p.modes.map((m) => ({ p, m })));
  it("the fixtures include modes to check", () => {
    expect(modes.length).toBeGreaterThan(0);
  });
  it.each(modes.map(({ p, m }) => [`${p.model} ${m.key}`, p, m] as const))("%s: shown fields equal contract fields", (_n, p, m) => {
    const shown = nativeFieldGroups(p, m).flatMap((g) => g.fields.map((f) => f.key)).sort();
    const contract = modeFields(m).map(({ field }) => field.key).sort();
    expect(shown).toEqual(contract);
  });
});
