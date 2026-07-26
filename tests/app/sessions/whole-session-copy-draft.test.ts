import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Whole-session copy draft model (0157) — source guards for the amended safety
// boundary: the preview is ephemeral (zero clinical writes); the SOURCE is
// server-derived; the commit validates canonically, writes ONLY via the
// service-role copy_session_setup RPC, passes a SERVER-derived practitioner id,
// and returns fixed non-leaky errors; and minutes are never copied.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const PANEL = read(`${BASE}/CopyPreviousAreasPanel.tsx`);
const ACTIONS = read(`${BASE}/whole-session-copy-actions.ts`);
const PAGE = read(`${BASE}/page.tsx`);

describe("preview is EPHEMERAL — building/refreshing/removing/cancelling writes nothing", () => {
  it("build uses the READ-ONLY source action + the pure builder; source is not browser-chosen", () => {
    expect(PANEL).toMatch(/getWholeSessionCopySourceAction\(\{ clientId, sessionId \}\)/);
    expect(PANEL).toMatch(/buildCopyDrafts\(res\.source\)/);
    // The panel takes ONLY clientId + sessionId — no browser-supplied source id.
    expect(PANEL).not.toMatch(/previousSessionId/);
    expect(PANEL).toMatch(/data-testid="copy-previous-preview"/);
    expect(PANEL).toMatch(/data-testid="copy-previous-refresh"/);
  });

  it("removeDraft + cancel are pure client-state changes (no server action)", () => {
    expect(PANEL).toMatch(/function removeDraft\([\s\S]{0,120}setDrafts\(\(d\) => d\.filter/);
    expect(PANEL).toMatch(/function cancel\(\)[\s\S]{0,220}setPhase\("idle"\)/);
    const removeAndCancel = PANEL.slice(
      PANEL.indexOf("function removeDraft"),
      PANEL.indexOf("function commit"),
    );
    expect(removeAndCancel).not.toMatch(/commitWholeSessionCopyAction/);
    expect(removeAndCancel).not.toMatch(/getWholeSessionCopySourceAction/);
  });

  it("a fresh idempotency key is minted per preview build (at-most-once commit)", () => {
    expect(PANEL).toMatch(/setIdempotencyKey\(crypto\.randomUUID\(\)\)/);
  });

  it("the ONLY caller of the commit action is commit(), behind the explicit CTA, sending the narrow input + server fingerprint", () => {
    expect((PANEL.match(/commitWholeSessionCopyAction\(/g) ?? []).length).toBe(1);
    expect(PANEL).toMatch(/data-testid="copy-previous-commit"/);
    expect(PANEL).toMatch(/Add these areas to today's chart/);
    expect(PANEL).toMatch(/drafts: drafts\.map\(draftToCopyInput\)/);
    expect(PANEL).toMatch(/sourceSessionId,\s*\n?\s*sourceFingerprint,/);
  });

  it("the card shows machine setup but NOT minutes (minutes are never copied)", () => {
    // The card's setup line must not surface a minutes value.
    expect(PANEL).not.toMatch(/d\.setup\.minutes/);
  });
});

describe("server actions — read-only descriptor source; service-role RPC is the only writer; safe errors", () => {
  it("getWholeSessionCopySourceAction performs NO writes and derives the source server-side", () => {
    const fn = ACTIONS.slice(
      ACTIONS.indexOf("export async function getWholeSessionCopySourceAction"),
      ACTIONS.indexOf("export type WholeSessionCopyCommitResult"),
    );
    // Reads only: the descriptor RPC + selects; no insert/update/delete.
    expect(fn).toMatch(/whole_session_copy_source_descriptor/);
    expect(fn).not.toMatch(/\.insert\(/);
    expect(fn).not.toMatch(/\.update\(/);
    expect(fn).not.toMatch(/\.delete\(/);
    expect(fn).not.toMatch(/copy_session_setup/);
    // Destination lineage asserted; no browser previousSessionId param.
    expect(fn).toMatch(/assertSessionForClient\(studio\.id, input\.clientId, input\.sessionId\)/);
    expect(ACTIONS).not.toMatch(/previousSessionId/);
  });

  it("commitWholeSessionCopyAction validates canonically, then writes ONLY via the service-role RPC", () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function commitWholeSessionCopyAction"));
    // Canonical server-side normalization BEFORE any DB call.
    expect(fn).toMatch(/normalizeWholeSessionCopy\(input\.drafts\)/);
    // The single writer is the RPC, called through the service-role client.
    expect(fn).toMatch(/createAdminClient\(\)/);
    expect(fn).toMatch(/\.rpc\("copy_session_setup"/);
    // Server-derived practitioner id + source fingerprint are passed (not trusted from the browser).
    expect(fn).toMatch(/p_practitioner_id: practitioner\.id/);
    expect(fn).toMatch(/p_expected_source_fingerprint: input\.sourceFingerprint/);
    // No direct table writes.
    expect(fn).not.toMatch(/\.from\("session_blocks"\)[\s\S]{0,60}\.insert/);
    expect(fn).toMatch(/assertSessionForClient\(studio\.id, input\.clientId, input\.sessionId\)/);
  });

  it("NEVER returns raw DB/driver text — errors are mapped to fixed safe messages (P2)", () => {
    // No raw error message interpolation anywhere in the actions.
    expect(ACTIONS).not.toMatch(/error\.message/);
    expect(ACTIONS).not.toMatch(/Copy failed: \$\{/);
    // A stable code→message map exists and is used for the commit RPC error.
    expect(ACTIONS).toMatch(/function safeCommitError\(/);
    expect(ACTIONS).toMatch(/safeCommitError\(\(error as \{ code\?: string \}\)\.code\)/);
    for (const code of ["HN001", "HN002", "HN003", "HN004", "HN005", "HN006", "HN007"]) {
      expect(ACTIONS).toMatch(new RegExp(`case "${code}":`));
    }
  });

  it("the commit action is registered in the service-role allowlist", () => {
    const allow = read("tests/security/service-role-allowlist.ts");
    expect(allow).toMatch(/whole-session-copy-actions\.ts/);
  });
});

describe("wiring", () => {
  it("the session page renders the draft-model panel with only clientId + sessionId", () => {
    expect(PAGE).toMatch(/<CopyPreviousAreasPanel clientId=\{id\} sessionId=\{session\.id\} \/>/);
    expect(PAGE).toMatch(/import \{ CopyPreviousAreasPanel \}/);
    expect(PAGE).not.toMatch(/<CopyPreviousAreasButton/);
  });
});
