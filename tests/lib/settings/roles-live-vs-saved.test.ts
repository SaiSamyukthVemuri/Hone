import { describe, expect, it } from "vitest";
import { CATALOG, type PermissionDef, type StudioPolicy } from "@/lib/permissions/catalog";
import { buildRoleModel, liveStatusLine, liveStatusOf, LIVE_UNKNOWN_LINE } from "@/lib/settings/roles/model";
import type { PolicyWithServer } from "@/lib/settings/roles/server-effective";

const key = (CATALOG as readonly PermissionDef[])[0].key;
const base: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
const text = (s: string) => s;
const withServer = (effective: string, source: string): PolicyWithServer => ({
  ...base,
  server: { stored: { [key]: "studio" }, effective: { [key]: effective }, source: { [key]: source } },
} as PolicyWithServer);

describe("S3 live vs saved", () => {
  it("no core answer: unknown, and the line never claims an in-force value", () => {
    const st = liveStatusOf("studio", key, base);
    expect(st).toEqual({ state: "unknown", saved: "studio", inForce: null });
    expect(liveStatusLine(st, text)).toContain(LIVE_UNKNOWN_LINE);
    expect(liveStatusLine(st, text)).not.toMatch(/In force now: (off|own|studio)/);
  });
  it("stored value in force: live", () => {
    expect(liveStatusOf("studio", key, withServer("studio", "stored")).state).toBe("live");
  });
  it("an inert key is not live even when the values match", () => {
    for (const source of ["inactive_until_activated", "unreleased"]) {
      const st = liveStatusOf("studio", key, withServer("studio", source));
      expect(st.state, source).toBe("not_live");
      expect(liveStatusLine(st, text)).toContain("not in force yet");
    }
  });
  it("a lower in-force value is not live and the line names both values", () => {
    const st = liveStatusOf("studio", key, withServer("off", "stored"));
    expect(st.state).toBe("not_live");
    expect(liveStatusLine(st, text)).toBe("Saved: studio. In force now: off. The saved setting is not in force yet.");
  });
  it("every model row carries a status; without the core every row is unknown", () => {
    const rows = buildRoleModel("practitioner", base).flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.live.state, r.key).toBe("unknown");
  });
});
