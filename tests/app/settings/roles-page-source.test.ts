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
    expect(page).toMatch(/\.select\("id, display_name, email, role, active"\)/);
    expect(page).toMatch(/\.select\("id, display_name, email, role"\)/);
  });
  it("never mentions a feed token, hash, or Google account field", () => {
    for (const re of [/token/i, /hash/i, /feed/i, /google/i, /ics/i]) expect(page, String(re)).not.toMatch(re);
    expect(editor).not.toMatch(/token|hash/i);
  });
});

describe("the Roles actions", () => {
  const bodies = actions.split(/^export async function /m).slice(1);
  it("re-check the owner on the server before the core is called, in every action", () => {
    expect(actions).toMatch(/practitioner\.role === "owner"/);
    expect(bodies).toHaveLength(8);
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf("("));
      expect(b.indexOf("await assertOwner()"), name).toBeGreaterThan(-1);
      expect(b.indexOf("await assertOwner()"), name).toBeLessThan(b.search(/return core[A-Z]/));
    }
  });
  it("never report success on its own: success only ever comes from the core's answer", () => {
    expect(actions).not.toMatch(/ok: true/);
  });
  it("bind every write to the version a preview returned, and send it to the core (Insurance P-3)", () => {
    for (const fn of ["saveRolePolicyAction", "resetRolePolicyAction", "adoptNewDefaultsAction"]) {
      const b = bodies.find((x) => x.startsWith(fn))!;
      expect(b, fn).toMatch(/isVersion\(expectedVersion\)/);
      expect(b, fn).toMatch(/expectedVersion[,)]/);
    }
  });
  it("only export async functions plus types (a 'use server' module)", () => {
    expect(actions.match(/^export (?!async function|type)/gm)).toBeNull();
  });
});

describe("the policy store", () => {
  it("is writable only when the core answered, and otherwise says why", () => {
    expect(store).toMatch(/coreGetState\(studioId\)/);
    expect(store).toMatch(/writable: true/);
    expect(store).toMatch(/NOT_WRITABLE_REASON/);
  });
});
