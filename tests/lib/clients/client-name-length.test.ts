// 0281 / Insurance CB-3: the database refuses a client name that is blank or over 200 characters (clients_identity_guard), and that
// rule reaches every INSERT path, including public booking. Each path refuses it in the application first, with a readable message,
// instead of surfacing a 23514 to a client or a staff member.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_NAME_MAX, CLIENT_NAME_TOO_LONG } from "@/lib/clients/identity";
import { groupRows } from "@/lib/import/quick-import";

const read = (p: string) => readFileSync(p, "utf8");

describe("client name length (database limit 200)", () => {
  it("the shared limit is the database's", () => {
    expect(CLIENT_NAME_MAX).toBe(200);
    expect(CLIENT_NAME_TOO_LONG).toContain("200");
  });

  it.each([
    ["public booking", "app/book/[slug]/actions.ts"],
    ["new client form", "app/(app)/clients/new/actions.ts"],
    ["calendar quick-create", "app/(app)/calendar/actions.ts"],
  ])("%s refuses an over-long name before any write", (_label, file) => {
    const src = read(file);
    expect(src).toMatch(/name\.length > CLIENT_NAME_MAX\) return \{ ok: false, error: CLIENT_NAME_TOO_LONG \}/);
  });

  it("the client profile save refuses an over-long name only when the name CHANGES (a legacy over-length name does not block other edits)", () => {
    const src = read("app/(app)/clients/[id]/actions.ts");
    expect(src).toMatch(/name !== stored\.name && name\.length > CLIENT_NAME_MAX\) return \{ ok: false, error: CLIENT_NAME_TOO_LONG \}/);
    // and no unconditional check remains before the stored name is read
    const before = src.slice(src.indexOf("export async function updateClientAction"), src.indexOf("name !== stored.name"));
    expect(before).not.toMatch(/\n\s*if \(name\.length > CLIENT_NAME_MAX\)/);
  });

  it("quick import turns an over-long name into a row error and never an insert", () => {
    const { groups, errorRows } = groupRows([
      { rowNumber: 1, fields: { client_name: "Valid Synthetic" } },
      { rowNumber: 2, fields: { client_name: "x".repeat(CLIENT_NAME_MAX + 1) } },
      { rowNumber: 3, fields: { client_name: "y".repeat(CLIENT_NAME_MAX) } },
    ]);
    expect(errorRows.map((r) => r.rowNumber)).toEqual([2]);
    expect(groups).toHaveLength(2);
  });

  // Privacy CD2: the public form limits the name BEFORE any database call, so a 23514 never reaches a visitor raw.
  it("the public booking action refuses an over-long name before its first database call and never maps 23514 to the visitor", () => {
    const src = read("app/book/[slug]/actions.ts");
    const limit = src.indexOf("name.length > CLIENT_NAME_MAX");
    expect(limit).toBeGreaterThan(-1);
    // Inside the action that holds the limit: nothing before it may touch the database.
    const action = src.slice(src.lastIndexOf("export async function", limit), limit);
    for (const call of [".rpc(", ".from(", "createAdminClient(", "createClient("]) {
      expect(action, `${call} appears before the name limit`).not.toContain(call);
    }
    expect(src).not.toMatch(/["']23514["']/);
  });
});
