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
    expect(bodies).toHaveLength(9);
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf("("));
      expect(b.indexOf("await assertOwner()"), name).toBeGreaterThan(-1);
      // reloadPolicyAction reads the stored policy through the policy store, which reads get_role_permissions.
      expect(b.indexOf("await assertOwner()"), name).toBeLessThan(b.search(/\bcore[A-Z][A-Za-z]*\(|await loadStudioPolicyState|await wiringRefusal/));
    }
  });
  it("never report success on its own: success only ever comes from the core's answer", () => {
    // The one `ok: true` is reloadPolicyAction handing back what get_role_permissions holds; it asserts no write happened.
    expect(actions.match(/ok: true/g)).toHaveLength(2); // the return type and the value, both in reloadPolicyAction
    expect(actions).toMatch(/\{ ok: true; state: StudioPolicyState \}/);
  });
  it("bind every write to the version a preview returned, and send it to the core (Insurance P-3)", () => {
    for (const fn of ["saveRolePolicyAction", "resetRolePolicyAction", "adoptNewDefaultsAction"]) {
      const b = bodies.find((x) => x.startsWith(fn))!;
      expect(b, fn).toMatch(/isVersion\(expectedVersion\)/);
      expect(b, fn).toMatch(/expectedVersion[,)]/);
    }
  });
  it("run the wiring guard before the core on every free-form change, from the catalog and not the core", () => {
    for (const fn of ["previewRoleChangesAction", "saveRolePolicyAction"]) {
      const b = bodies.find((x) => x.startsWith(fn))!;
      expect(b.indexOf("await wiringRefusal("), fn).toBeGreaterThan(-1);
      expect(b.indexOf("await wiringRefusal("), fn).toBeLessThan(b.search(/\bcore(PreviewChanges|Save)\(/));
    }
    expect(actions).toMatch(/enforcementRefusal\(/);
    expect(actions).not.toMatch(/\.enforcement\b/); // never read from the core's state
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

describe("Codex 3 Nov on #1335: a reset is confirmed for the role that was previewed, and a save is read back", () => {
  const confirm = editor.slice(editor.indexOf("async function confirmPreview"), editor.indexOf("const tabs"));
  const open = editor.slice(editor.indexOf("async function openPreview"), editor.indexOf("async function confirmPreview"));
  const save = editor.slice(editor.indexOf("async function onSave"), editor.indexOf("function discard"));
  it("the preview carries the role it was computed for and confirm sends that role, never the current tab", () => {
    expect(editor).toMatch(/type Preview = \{ kind: "reset" \| "adopt"; role: Role; data: ServerPreview \}/);
    expect(confirm).toMatch(/props\.reset\(preview\.role,/);
    expect(confirm).not.toMatch(/props\.reset\(role,/);
    expect(editor).toMatch(/<PreviewPanel[^>]*\n?\s*kind=\{preview\.kind\}\s*\n?\s*role=\{preview\.role\}/);
  });
  it("a response that arrives after a tab switch or cancel is dropped", () => {
    expect(open).toMatch(/const seq = \+\+previewSeq\.current/);
    expect(open).toMatch(/if \(seq !== previewSeq\.current\) return;/);
    expect(editor).toMatch(/previewSeq\.current \+= 1;\s*\n\s*setRole\(r\)/);
    expect(editor).toMatch(/onCancel=\{\(\) => \{\s*\n\s*previewSeq\.current \+= 1;/);
  });
  it("after a successful save the saved and draft policies come from the core, not from the draft", () => {
    expect(save).toMatch(/await props\.reload\(\)/);
    expect(save).not.toMatch(/setSaved\(drafts\)/);
    expect(save).toMatch(/setSaved\(fresh\.state\.policies\)/);
    expect(save).toMatch(/setDrafts\(fresh\.state\.policies\)/);
    // If the read-back fails nothing is claimed: the page is refreshed from the server.
    expect(save).toMatch(/router\.refresh\(\)/);
  });
  it("reloadPolicyAction is owner-only and refuses to hand back the read-only snapshot as if it were authoritative", () => {
    const b = actions.slice(actions.indexOf("export async function reloadPolicyAction"), actions.indexOf("export async function previewRoleChangesAction"));
    expect(b).toMatch(/await assertOwner\(\)/);
    expect(b).toMatch(/state\.writable \? \{ ok: true, state \} : refuse\(\{ code: "unavailable" \}\)/);
  });
});
