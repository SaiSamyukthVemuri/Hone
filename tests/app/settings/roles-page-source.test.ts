import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source guards for Settings -> Roles (R2). DN-21: the page reads only the columns it shows, so a calendar-feed token (or its
// hash) or any other private field can never reach a render or a prop. The actions re-check the owner and never fake a save.
const page = readFileSync("app/(app)/settings/roles/page.tsx", "utf8");
const actions = readFileSync("app/(app)/settings/roles/actions.ts", "utf8");
const editor = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
const store = readFileSync("lib/settings/roles/policy-store.ts", "utf8");

describe("the Roles page shows only names and addresses, never tokens or hashes (DN-21)", () => {
  it("selects explicit columns, never *", () => {
    expect(page).not.toMatch(/\.select\(\s*["'`]\*/);
    expect(page).toMatch(/\.select\("id, display_name, email, role"\)/);
  });
  it("never mentions a feed token, hash, or Google account field", () => {
    for (const re of [/token/i, /hash/i, /feed/i, /google/i, /ics/i]) expect(page, String(re)).not.toMatch(re);
    expect(editor).not.toMatch(/token|hash/i);
  });
});

describe("the Roles actions", () => {
  it("re-check the owner on the server before anything else", () => {
    expect(actions).toMatch(/practitioner\.role === "owner"/);
    expect(actions.indexOf("await assertOwner()")).toBeGreaterThan(0);
    expect(actions.indexOf("await assertOwner()")).toBeLessThan(actions.indexOf("await loadStudioPolicyState"));
  });
  it("never report success while the policy store cannot write", () => {
    expect(store).toMatch(/writable: false/);
    expect(actions).not.toMatch(/return \{ ok: true \}/);
  });
  it("only export async functions plus types (a 'use server' module)", () => {
    expect(actions.match(/^export (?!async function|type)/gm)).toBeNull();
  });
});
