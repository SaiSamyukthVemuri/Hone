import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion } from "./helpers/migration-state";
import { CLIENT_BUDGET_LEVELS } from "@/lib/budget/levels";

// 0183 — client_budget_context (applied, frozen). This pins the live
// CLIENT_BUDGET_LEVELS constant to the CHECK the database enforces.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0183";
const SQL = readFileSync(
  path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)),
  "utf8",
);
// Executable SQL only.
const CODE = SQL.split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

describe("0183: the level vocabulary matches the application exactly", () => {
  it("constrains budget_level to the same three values as lib/budget/levels.ts", () => {
    const check = CODE.slice(
      CODE.indexOf("client_budget_context_level_check"),
    );
    for (const level of CLIENT_BUDGET_LEVELS) {
      expect(check).toContain(`'${level}'`);
    }
    // And nothing else: extract the quoted values from the IN list.
    const inList = /budget_level in \(([^)]*)\)/.exec(check);
    expect(inList).not.toBeNull();
    const values = [...(inList?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(values.sort()).toEqual([...CLIENT_BUDGET_LEVELS].sort());
  });
});
