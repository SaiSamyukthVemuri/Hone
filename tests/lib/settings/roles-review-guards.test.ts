import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 0361 source guards (Insurance G1/C4/F6, Privacy L1-L3/H4). Reading source is the point: these pin WHO may call what and WHERE the review table and its
// consistency stamp may travel. A stamp is not a permission; it never reaches a URL, a log, an error report or an analytics event.

const dirs = ["lib/settings/roles", "app/(app)/settings/roles"];
const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`));
const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
// The word as an identifier or key of the review table, not the substring of preview*.
const REVIEW_WORD = /\breview(Hash|_hash|_version)?\b|\.review\b/;
const body = (src: string, name: string) => {
  const at = src.indexOf(`export async function ${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", at + 10);
  return src.slice(at, next < 0 ? undefined : next);
};

describe("the audit's `_review` bookkeeping key is never shown", () => {
  it("History skips keys that begin with an underscore: no row, no version, no stamp", async () => {
    const { parseHistory } = await import("@/lib/settings/roles/core-parse");
    const HASH = "cd".repeat(32);
    const raw = {
      ok: true,
      rows: [{ id: 5, at: "2026-11-16T10:00:00Z", kind: "role_permissions_saved", role: "practitioner", actor_name: "Owner", reason: null, before: { "appt.cancel": "studio" }, after: { "appt.cancel": "off", _review: { version: 3, hash: HASH } } }],
    };
    const r = parseHistory(raw, 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.rows[0].after)).toEqual(["Cancel appointments"]);
    expect(JSON.stringify(r)).not.toContain(HASH);
    expect(JSON.stringify(r)).not.toMatch(/_review/);
  });
});

describe("Privacy: an unexpected database outcome shows the page's generic copy and never a raw message", () => {
  it("a raw SQL error, a malformed refusal, or text in place of JSON all map to `unexpected` with the fixed message", async () => {
    const { parseError, parseCommand, parsePreview } = await import("@/lib/settings/roles/core-parse");
    const { roleErrorMessage } = await import("@/lib/settings/roles/api");
    type RoleError = Parameters<typeof roleErrorMessage>[0];
    const raw = "perm_review_timing: P0001 something with private detail";
    for (const r of [parseError(raw), parseError({ ok: false, code: raw }), parseError({ ok: false, message: raw }), parseCommand({ ok: false, code: "P0001", message: raw }), parsePreview(raw)]) {
      const err = ("error" in r ? r.error : r) as RoleError;
      expect(err).toEqual({ code: "unexpected" });
      expect(roleErrorMessage(err)).toBe("Something went wrong and we could not confirm the result. Reload the page to see what is saved.");
      expect(roleErrorMessage(err)).not.toContain("P0001");
    }
  });
  it("core.ts never forwards an error object's message or details to the caller", () => {
    expect(code("lib/settings/roles/core.ts")).not.toMatch(/error\.(message|details|hint)/);
  });
});

describe("G1/F6: the page saves and previews ONLY through the reviewed pair", () => {
  const core = code("lib/settings/roles/core.ts");
  it("core.ts calls preview_role_changes_at and save_role_permissions_reviewed, and never the old non-versioned pair", () => {
    expect(core).toMatch(/"preview_role_changes_at"/);
    expect(core).toMatch(/"save_role_permissions_reviewed"/);
    expect(core).not.toMatch(/"preview_role_changes"/);
    expect(core).not.toMatch(/"save_role_permissions"/);
    expect(core).not.toMatch(/perm_run_changes/);
  });
  it("no other file in the Roles paths names the old commands or the internals", () => {
    for (const f of files.filter((x) => !x.endsWith("core.ts"))) expect(code(f), f).not.toMatch(/preview_role_changes\b|save_role_permissions\b|perm_run_changes|perm_review_/);
  });
  it("a missing reviewed command fails closed (the page's own refusal, never a fall back to the old save)", () => {
    expect(core).toMatch(/REVIEW_MISSING/);
    expect(core).not.toMatch(/preview_role_changes"|save_role_permissions"/);
  });
});

describe("C4: reset, adopt and activation are outside the review table and always send an expected version", () => {
  const core = code("lib/settings/roles/core.ts");
  const actions = code("app/(app)/settings/roles/actions.ts");
  it("their core functions never read or send the review table or its stamp", () => {
    for (const name of ["coreReset", "coreAdopt", "corePreviewReset", "corePreviewAdopt", "coreActivate", "corePreviewActivation"]) expect(body(core, name), name).not.toMatch(REVIEW_WORD);
  });
  it("their actions refuse without a version, and never take a review stamp", () => {
    for (const name of ["resetRolePolicyAction", "adoptNewDefaultsAction"]) {
      const b = body(actions, name);
      expect(b, name).toMatch(/isVersion\(expectedVersion\)/);
      expect(b, name).not.toMatch(REVIEW_WORD);
    }
    expect(body(actions, "activatePermissionsAction")).toMatch(/isVersion\(/);
    expect(body(actions, "activatePermissionsAction")).not.toMatch(REVIEW_WORD);
  });
  it("the reviewed actions refuse without a version, and Save without a stamp", () => {
    expect(body(actions, "previewRoleChangesAction")).toMatch(/isVersion\(expectedVersion\)/);
    expect(body(actions, "saveRolePolicyAction")).toMatch(/isVersion\(expectedVersion\)/);
    expect(body(actions, "saveRolePolicyAction")).toMatch(/review_hash_required/);
  });
});

describe("Privacy L1-L3/H4: the review table, the draft and the stamp go nowhere but the Server Action body and response", () => {
  it("no console output, error reporter, analytics event, breadcrumb or context in the Roles paths", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/\bconsole\.|Sentry|captureException|captureMessage|addBreadcrumb|setContext|setExtra|analytics|\btrack\(|posthog|gtag/i);
  });
  it("no thrown Error, URL, query string, cookie or storage carries the review, the draft or the stamp", () => {
    for (const f of files) {
      const c = code(f);
      expect(c, f).not.toMatch(/new Error\([^)]*(review|hash|edits|draft|changes)/i);
      expect(c, f).not.toMatch(/(searchParams|URLSearchParams|cookies\(|localStorage|sessionStorage|document\.cookie|router\.(push|replace)\([^)]*(review|hash))/i);
    }
  });
  it("the stamp is never rendered: no JSX expression prints it", () => {
    const editor = code("app/(app)/settings/roles/roles-editor.tsx");
    expect(editor).not.toMatch(/\{[^{}]*\b(reviewHash|review\??\.hash)\b[^{}]*\}\s*<\//);
    expect(editor).not.toMatch(/data-[a-z-]+=\{[^}]*hash/i);
  });
  it("the stamp is bound only on the server (the page has no SQL text, and RAISE never carries the table: pinned in the migration test)", () => {
    expect(code("lib/settings/roles/core-parse.ts")).not.toMatch(/console\./);
  });
});
