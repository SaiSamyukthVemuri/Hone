import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_COLOR_KEYS, SERVICE_COLOR_KEYS_0153 } from "@/lib/calendar/service-colors";

// Migration 0161 (applied, frozen) widened the service colour CHECK. This pins
// the live app allowlist in lib/calendar/service-colors to that CHECK.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0161_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const FLAT = SQL.replace(/\s+/g, " ");
// CODE view: comments removed entirely, so a rationale that NAMES a forbidden
// construct cannot be mistaken for the construct itself.
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const CODE_FLAT = CODE.replace(/\s+/g, " ");

describe("0161: the colour CHECK and the app allowlist agree", () => {
  it("keeps every 0153 key legal", () => {
    for (const key of SERVICE_COLOR_KEYS_0153) {
      expect(FLAT, `${key} must remain allowed`).toContain(`'${key}'`);
    }
  });

  it("the DB allowlist and the app allowlist are the same ten keys", () => {
    const start = CODE_FLAT.indexOf("check (calendar_color in (");
    const check = CODE_FLAT.slice(start, CODE_FLAT.indexOf("))", start));
    const inSql = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(inSql)).toEqual(new Set(SERVICE_COLOR_KEYS));
    expect(inSql).toHaveLength(SERVICE_COLOR_KEYS.length);
  });
});
