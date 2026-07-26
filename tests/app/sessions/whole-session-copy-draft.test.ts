import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Whole-session copy draft model (0157) — source guards for the NON-NEGOTIABLE
// safety boundary: the preview is ephemeral (zero clinical writes) and only the
// single explicit commit action writes, via the copy_session_setup RPC.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const PANEL = read(`${BASE}/CopyPreviousAreasPanel.tsx`);
const ACTIONS = read(`${BASE}/whole-session-copy-actions.ts`);
const PAGE = read(`${BASE}/page.tsx`);

describe("preview is EPHEMERAL — building/refreshing/removing/cancelling writes nothing", () => {
  it("build + refresh use the READ-ONLY source action + the pure builder", () => {
    expect(PANEL).toMatch(/getWholeSessionCopySourceAction\(/);
    expect(PANEL).toMatch(/buildCopyDrafts\(res\.source\)/);
    // Both the initial Preview button and Refresh call buildPreview (read-only).
    expect(PANEL).toMatch(/data-testid="copy-previous-preview"/);
    expect(PANEL).toMatch(/data-testid="copy-previous-refresh"/);
  });

  it("removeDraft + cancel are pure client-state changes (no server action)", () => {
    expect(PANEL).toMatch(/function removeDraft\([\s\S]{0,120}setDrafts\(\(d\) => d\.filter/);
    expect(PANEL).toMatch(/function cancel\(\)[\s\S]{0,160}setPhase\("idle"\)/);
    // Neither removeDraft nor cancel calls the commit action.
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

  it("the ONLY caller of the commit action is commit(), behind the explicit CTA", () => {
    expect((PANEL.match(/commitWholeSessionCopyAction\(/g) ?? []).length).toBe(1);
    expect(PANEL).toMatch(/data-testid="copy-previous-commit"/);
    expect(PANEL).toMatch(/Add these areas to today's chart/);
    // The commit sends the reviewed, setup-only specs.
    expect(PANEL).toMatch(/specs: drafts\.map\(draftToCopySpec\)/);
  });
});

describe("server actions — read-only source loader; RPC is the only writer", () => {
  it("getWholeSessionCopySourceAction performs NO writes (select only)", () => {
    const fn = ACTIONS.slice(
      ACTIONS.indexOf("export async function getWholeSessionCopySourceAction"),
      ACTIONS.indexOf("export type WholeSessionCopyCommitResult"),
    );
    expect(fn).toMatch(/\.select\(/);
    expect(fn).not.toMatch(/\.insert\(/);
    expect(fn).not.toMatch(/\.update\(/);
    expect(fn).not.toMatch(/\.delete\(/);
    expect(fn).not.toMatch(/\.rpc\(/);
    // Both source + destination lineage are asserted.
    expect(fn).toMatch(/assertSessionForClient\(studio\.id, input\.clientId, input\.sessionId\)/);
    expect(fn).toMatch(/assertSessionForClient\(studio\.id, input\.clientId, input\.previousSessionId\)/);
  });

  it("commitWholeSessionCopyAction writes ONLY through the copy_session_setup RPC", () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function commitWholeSessionCopyAction"));
    expect(fn).toMatch(/\.rpc\("copy_session_setup"/);
    // No direct table writes from the action — the RPC is the single writer.
    expect(fn).not.toMatch(/\.from\("session_blocks"\)[\s\S]{0,60}\.insert/);
    expect(fn).not.toMatch(/\.from\("electrolysis_entries"\)[\s\S]{0,60}\.insert/);
    expect(fn).toMatch(/assertSessionForClient\(studio\.id, input\.clientId, input\.sessionId\)/);
    expect(fn).toMatch(/if \(!input\.idempotencyKey/);
  });
});

describe("wiring", () => {
  it("the session page renders the draft-model panel (not the paused notice)", () => {
    expect(PAGE).toMatch(/<CopyPreviousAreasPanel/);
    expect(PAGE).toMatch(/import \{ CopyPreviousAreasPanel \}/);
    expect(PAGE).not.toMatch(/<CopyPreviousAreasButton/);
  });
});
