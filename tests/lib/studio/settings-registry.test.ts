import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOT_A_SETTING,
  STUDIO_SETTINGS,
  isStudioSettingKey,
  readStudioSettings,
  resolveStudioSetting,
} from "@/lib/studio/settings";

const ROOT = path.resolve(__dirname, "../../..");

function studioBooleanColumns(): string[] {
  const src = readFileSync(path.join(ROOT, "lib/types/database.ts"), "utf8");
  const m = src.match(/export (?:type|interface) Studio\b[^{]*\{([\s\S]*?)\n\}/);
  expect(m, "Studio type found").not.toBeNull();
  return [...m![1].matchAll(/^\s+([a-z0-9_]+)\??: boolean;/gm)].map((x) => x[1]);
}

function migrationDefault(column: string): boolean | null {
  const dir = path.join(ROOT, "supabase/migrations");
  for (const f of readdirSync(dir).sort()) {
    const text = readFileSync(path.join(dir, f), "utf8").replace(/\s+/g, " ");
    const m = text.match(new RegExp(`add column(?: if not exists)? ${column} boolean not null default (true|false)`, "i"));
    if (m) return m[1].toLowerCase() === "true";
  }
  return null;
}

describe("registry completeness", () => {
  it("every boolean column on Studio is registered or explicitly not a setting", () => {
    const missing = studioBooleanColumns().filter((c) => !isStudioSettingKey(c) && !NOT_A_SETTING.includes(c));
    expect(missing, `register these in lib/studio/settings.ts: ${missing.join(", ")}`).toEqual([]);
  });
  it("every registered key is a real Studio column", () => {
    const cols = new Set(studioBooleanColumns());
    expect(Object.keys(STUDIO_SETTINGS).filter((k) => !cols.has(k))).toEqual([]);
  });
});

describe("defaults are the columns' existing defaults", () => {
  it.each(Object.entries(STUDIO_SETTINGS))("%s", (key, def) => {
    const fromMigration = migrationDefault(key);
    // show_treatment_time_to_clients is declared across a line break; it normalises the same way.
    expect(fromMigration, `${key} default found in a migration`).not.toBeNull();
    expect(def.default).toBe(fromMigration);
  });
  it("retired settings default false (the 0159 CHECK forces false)", () => {
    for (const d of Object.values(STUDIO_SETTINGS)) if (d.kind === "retired") expect(d.default).toBe(false);
  });
});

describe("resolveStudioSetting", () => {
  it("returns the stored value, and the default only when absent or null", () => {
    expect(resolveStudioSetting({ send_confirmation_emails: false }, "send_confirmation_emails")).toBe(false);
    expect(resolveStudioSetting({}, "send_confirmation_emails")).toBe(true);
    expect(resolveStudioSetting({ send_confirmation_emails: null }, "send_confirmation_emails")).toBe(true);
    expect(resolveStudioSetting({}, "send_confirmation_sms")).toBe(false);
  });
});

describe("readStudioSettings", () => {
  function fake(result: { data: unknown; error: unknown }, seen: string[]) {
    return {
      from: (t: string) => ({
        select: (cols: string) => ({
          eq: (c: string, id: string) => ({
            maybeSingle: async () => {
              seen.push(`${t}|${cols}|${c}=${id}`);
              return result;
            },
          }),
        }),
      }),
    } as never;
  }
  it("is scoped to one studio and fills defaults for absent columns", async () => {
    const seen: string[] = [];
    const out = await readStudioSettings(fake({ data: { client_cancellation_enabled: false }, error: null }, seen), "studio-a", [
      "client_cancellation_enabled",
      "client_reschedule_enabled",
    ]);
    expect(out).toEqual({ client_cancellation_enabled: false, client_reschedule_enabled: true });
    expect(seen).toEqual(["studios|client_cancellation_enabled,client_reschedule_enabled|id=studio-a"]);
  });
  it("returns null on a failed read rather than inventing defaults", async () => {
    expect(await readStudioSettings(fake({ data: null, error: { message: "x" } }, []), "studio-a", ["send_confirmation_emails"])).toBeNull();
    expect(await readStudioSettings(fake({ data: null, error: null }, []), "studio-a", ["send_confirmation_emails"])).toBeNull();
  });
});
