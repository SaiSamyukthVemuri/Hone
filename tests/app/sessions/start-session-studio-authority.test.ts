import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// SERVER-ACTION CONTRACT — startSessionAction must name the SELECTED studio.
//
// 0181 moved studio authority into an explicit RPC argument. The value is only
// safe because of WHERE IT COMES FROM: getCurrentPractitionerWithStudio(), the
// server-side resolver that honours the user's validated studio selection.
//
// Two things must stay true, and a behavioural test cannot see either:
//   1. the action passes p_studio_id at all — otherwise the new application
//      silently keeps riding the deprecated compatibility wrapper forever;
//   2. the value is NEVER read from FormData, searchParams or any other
//      browser-supplied channel. The browser does not choose tenant scope.

const FILE = "app/(app)/clients/[id]/sessions/new/actions.ts";
const SRC = readFileSync(join(__dirname, "..", "..", "..", FILE), "utf8");

// Comments describe the removed defect, so contract assertions read executable
// lines only.
const CODE = SRC.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

function startSessionRpcCall(): string {
  const at = CODE.indexOf('supabase.rpc("start_session"');
  expect(at).toBeGreaterThan(-1);
  const open = CODE.indexOf("{", at);
  const close = CODE.indexOf("});", open);
  expect(close).toBeGreaterThan(open);
  return CODE.slice(open, close);
}

describe("startSessionAction — explicit studio authority", () => {
  it("passes p_studio_id to the start_session RPC", () => {
    expect(startSessionRpcCall()).toMatch(/p_studio_id\s*:/);
  });

  it("sources the studio from the server-resolved practitioner context", () => {
    expect(startSessionRpcCall()).toMatch(/p_studio_id\s*:\s*studio\.id/);
    // …and that binding exists because the action resolved it server-side.
    expect(CODE).toMatch(
      /const\s*\{[^}]*studio[^}]*\}\s*=\s*await\s+getCurrentPractitionerWithStudio\(\)/,
    );
  });

  it("still sends the other four command arguments", () => {
    const call = startSessionRpcCall();
    for (const arg of [
      "p_client_id",
      "p_modality",
      "p_appointment_id",
      "p_coalesce_minutes",
    ]) {
      expect(call).toContain(arg);
    }
  });
});

describe("startSessionAction — the browser never chooses tenant scope", () => {
  it("never reads a studio id from FormData", () => {
    expect(CODE).not.toMatch(/formData\.get\(\s*["'`][^"'`]*studio/i);
  });

  it("never reads a studio id from search params or any client input", () => {
    expect(CODE).not.toMatch(/searchParams[\s\S]{0,40}studio/i);
    expect(CODE).not.toMatch(/p_studio_id\s*:\s*(formData|sp|searchParams|params)\b/i);
  });

  it("only ever reads client_id, modality and appointment_id from the form", () => {
    const reads = [...CODE.matchAll(/formData\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(reads)).toEqual(
      new Set(["client_id", "modality", "appointment_id"]),
    );
  });
});
