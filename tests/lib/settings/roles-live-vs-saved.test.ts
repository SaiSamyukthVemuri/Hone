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

describe("Roles copy does not imply a setting is enforced (Team matrix, 14 Nov)", () => {
  it("the scope line does not claim the app reads or is wired to these settings", async () => {
    const { ENFORCEMENT_SCOPE_LINE } = await import("@/lib/settings/roles/model");
    expect(ENFORCEMENT_SCOPE_LINE).not.toMatch(/\bwired\b|\breads\b|\bis reading\b/i);
    expect(ENFORCEMENT_SCOPE_LINE).toMatch(/does not read them yet/);
  });

  it("source: while require-permission is absent AND no key is released, the scope line cannot say the app is wired or reads them; releasing any key means revisiting this wording", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    if (existsSync("lib/permissions/require-permission.ts")) return; // enforcement shipped: the wording is decided in that change
    // The other condition behind "not in force yet": 0287 seeds every release row PENDING (released_at null). If a key is ever released (a seeded
    // row with a time), the "not in force yet" wording has to be revisited with it, so this test fails until someone does.
    const mig = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
    const seed = mig.slice(mig.indexOf("insert into public.permission_key_release"));
    const rows = [...seed.slice(0, seed.indexOf(";")).matchAll(/\('([a-z_.]+)',\s*([^,]+),/g)];
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r[2].trim() !== "null").map((r) => r[1])).toEqual([]);
    const src = readFileSync("lib/settings/roles/model.ts", "utf8");
    const at = src.indexOf("export const ENFORCEMENT_SCOPE_LINE");
    expect(at).toBeGreaterThan(-1);
    const literal = src.slice(at, src.indexOf(";", at));
    expect(literal).not.toMatch(/wired|\bwill read\b|\breads\b|app (reads|checks|enforces)/i);
  });

  it("the page-level scope line says not in force yet and that the database does not check", async () => {
    const { ENFORCEMENT_SCOPE_LINE } = await import("@/lib/settings/roles/model");
    expect(ENFORCEMENT_SCOPE_LINE).toContain("not in force yet");
    expect(ENFORCEMENT_SCOPE_LINE).toContain("database does not check");
    expect(ENFORCEMENT_SCOPE_LINE).not.toMatch(/^Enforced/);
  });
  it("the deny-only note no longer promises an immediate effect", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
    expect(src).not.toContain("takes effect now");
    expect(src).toContain("It is in force only when the line above says so.");
  });

  it("timing is worded ONLY from the database's `timing` (TIMING_TEXT) and notActiveYetKeeps: no static timing prose anywhere else on the page", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const m = await import("@/lib/settings/roles/model");
    expect("RELEASE_RULE_SENTENCE" in m).toBe(false);
    const files = [
      ...readdirSync("lib/settings/roles").filter((f) => f.endsWith(".ts")).map((f) => `lib/settings/roles/${f}`),
      "app/(app)/settings/roles/roles-editor.tsx",
      "app/(app)/settings/roles/page.tsx",
      "app/(app)/settings/roles/actions.ts",
    ];
    const timingProse = /(lowers|raises) access|waits? for (your|you|a later)|activate it|applies at once|takes effect (as soon|when|at)|released and you activate/i;
    for (const f of files) {
      let src = readFileSync(f, "utf8");
      // The two sanctioned homes, and comments (which explain the rule but are not shown).
      src = src.replace(/export const TIMING_TEXT[\s\S]*?\n};/, "").replace(/export const notActiveYetKeeps[\s\S]*?;\n/, "");
      const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, f).not.toMatch(timingProse);
    }
    // exact strings (sent to Privacy)
    expect(m.EACH_CHOICE_LINE).toBe("Each saved choice below says when it takes effect.");
    expect(m.TIMING_TEXT.applies_on_save).toBe("Takes effect as soon as you save it.");
    expect(m.TIMING_TEXT.waits_for_activation).toContain("Saving it again takes effect at once");
    expect(m.TIMING_TEXT.waits_for_full_release).toContain("Activating does not change that");
    expect(m.NOT_ACTIVE_YET_LINE).toBe("Saved, but not in force yet.");
    expect(m.ENFORCEMENT_SCOPE_LINE).toContain(m.EACH_CHOICE_LINE);
    expect(m.ENFORCEMENT_SCOPE_LINE).not.toMatch(/Nothing is released/);
    expect(m.notActiveYetKeeps("practitioner", "Whole studio")).toContain("lowers access applies at once");
  });
});
