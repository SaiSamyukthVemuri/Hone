import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXED_OWNER_ONLY } from "@/lib/permissions/catalog";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0287_roles_permission_engine.sql"), "utf8");
const start = sql.indexOf("insert into public.permission_narrowings");
const seed = sql.slice(start, sql.indexOf(";\n", start));
const rows = [...seed.matchAll(/^ {2}\('([a-z_]+)', '[^']*', '(?:[^']|'')*', 'R\d', (true|false), '(narrows|safeguard)'/gm)].map((m) => ({ id: m[1]!, narrowsExisting: m[2] === "true", access: m[3]! }));

describe("permission_narrowings seed (0287)", () => {
  it("every row carries a practitioner_access of narrows or safeguard", () => {
    expect(rows.length).toBe((seed.match(/^ {2}\('/gm) ?? []).length);
    expect(sql).toMatch(/practitioner_access text not null check \(practitioner_access in \('narrows', 'safeguard'\)\)/);
  });

  it("every fixed owner-only item that narrows today's access is previewed as a narrows row (DN-25 advance notice)", () => {
    for (const f of FIXED_OWNER_ONLY.filter((x) => x.existingEffect === "narrows")) {
      const row = rows.find((r) => r.id === f.id);
      expect(row, `${f.id} missing from permission_narrowings`).toBeDefined();
      expect(row).toMatchObject({ narrowsExisting: true, access: "narrows" });
    }
  });

  it("the adopt preview emits practitioner_access for EVERY row, so safeguards that narrow nothing are not dropped", () => {
    expect(sql).toMatch(/'practitioner_access', n\.practitioner_access/);
    expect(sql).toMatch(/from public\.permission_narrowings n\)\);/);
    expect(sql).not.toMatch(/from public\.permission_narrowings n where n\.narrows_existing/);
  });
});
