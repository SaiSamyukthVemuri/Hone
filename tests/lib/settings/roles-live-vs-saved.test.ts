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
    expect(liveStatusLine(st, text)).toBe("Saved: studio. In force now: off. The saved setting is not in force yet. Once it is released, a choice that lowers access applies at once, and one that raises access waits for your activation.");
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

  it("the release rule is stated true to 0287: lowering applies at once on release, raising waits for activation (pinned in every page string)", async () => {
    const { readFileSync } = await import("node:fs");
    const m = await import("@/lib/settings/roles/model");
    const rule = "a choice that lowers access applies at once, and one that raises access waits for you to activate it";
    expect(m.RELEASE_RULE_SENTENCE).toContain(rule);
    expect(m.ENFORCEMENT_SCOPE_LINE).toContain(rule);
    expect(readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8")).toContain(rule);
    // the old claim, that EVERY saved choice waits for release AND activation, is false for a lowering
    const model = readFileSync("lib/settings/roles/model.ts", "utf8");
    const roles = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
    for (const s of [model, roles]) {
      expect(s).not.toMatch(/take effect only after they are released and you activate/);
      expect(s).not.toMatch(/do not change anyone.{1,12}s access until they are released and you activate/);
      expect(s).not.toContain("Until this setting is released and you activate it");
      expect(s).not.toContain("Once activated, a saved change applies");
    }
    expect(m.NOT_ACTIVE_YET_LINE).toContain("raises access");
    expect(m.notActiveYetKeeps("practitioner", "Whole studio")).toContain("lowers access applies at once");
  });
});
