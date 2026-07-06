import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0107_studio_tracking_encrypted_token.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0107 — number (repo-max tripwire)", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_/.exec(f)?.[1])
        .filter(Boolean)
        .map((n) => Number(n)),
    );
    expect(maxNum).toBe(107);
    expect(FILE).toMatch(/^0107_/);
  });
});

describe("0107 — encrypted self-serve token columns", () => {
  it("adds encrypted_server_token + last4 + timestamps + token_status", () => {
    for (const col of [
      "encrypted_server_token text",
      "server_token_last4      text",
      "server_token_added_at    timestamptz",
      "server_token_rotated_at  timestamptz",
      "token_status             text not null default 'absent'",
    ]) {
      expect(SQL).toContain(col);
    }
    expect(SQL).toMatch(/token_status in \('absent', 'active'\)/);
  });

  it("deprecates (keeps) server_token_secret_ref rather than storing a raw token", () => {
    expect(SQL).toMatch(/DEPRECATED \(0107\)/);
    // No raw-token value column is introduced.
    const codeOnly = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const raw of ["access_token", "api_token", "token_value", "auth_token", "raw_token"]) {
      expect(codeOnly.toLowerCase()).not.toContain(raw);
    }
  });

  it("makes token management OWNER-only (replaces member insert/update)", () => {
    expect(SQL).toMatch(/drop policy if exists "studio_tracking_providers_studio_member_insert"/);
    expect(SQL).toMatch(/drop policy if exists "studio_tracking_providers_studio_member_update"/);
    expect(SQL).toMatch(/create policy "studio_tracking_providers_owner_insert"[\s\S]*is_studio_owner\(studio_id\)/);
    expect(SQL).toMatch(/create policy "studio_tracking_providers_owner_update"[\s\S]*is_studio_owner\(studio_id\)/);
  });
});
