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
const CARD = read("components/copy-draft-card.tsx");

describe("preview is EPHEMERAL — building/refreshing/removing/cancelling writes nothing", () => {
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

  it("there is exactly ONE commit call site — submitCommit() — sending the narrow input + server fingerprint", () => {
    // Repeat-client fast charting added a SECOND route to the copy, not a second
    // copy implementation: both routes funnel through the single submitCommit()
    // helper, so this count staying at 1 is what proves they cannot drift.
    expect((PANEL.match(/commitWholeSessionCopyAction\(/g) ?? []).length).toBe(1);
    expect(PANEL).toMatch(/async function submitCommit\(env: RetryEnvelope\)/);
    expect(PANEL).toMatch(/data-testid="copy-previous-commit"/);
    expect(PANEL).toMatch(/Add these areas to today's chart/);
    expect(PANEL).toMatch(/drafts: env\.drafts\.map\(draftToCopyInput\)/);
    expect(PANEL).toMatch(/sourceSessionId: env\.sourceSessionId,/);
    expect(PANEL).toMatch(/sourceFingerprint: env\.sourceFingerprint,/);
    // Both routes submit through it, each passing the SERVER-derived source
    // identity — neither can commit without it.
    expect((PANEL.match(/await submitCommit\(/g) ?? []).length).toBe(2);
  });

  it("the editable card reuses SHARED widgets and never edits minutes", () => {
    // Reuses the shared area editor + probe picker + shared constants/gating.
    expect(CARD).toMatch(/from "@\/components\/multi-area-editor"/);
    expect(CARD).toMatch(/from "@\/components\/probe-picker"/);
    expect(CARD).toMatch(/from "@\/lib\/sessions\/mode-sections"/);
    expect(CARD).toMatch(/from "@\/lib\/constants"/);
    // No minutes editor anywhere in the card (a comment may mention the policy,
    // but there is no minutes field, testid, or setup key).
    expect(CARD).not.toMatch(/\.minutes\b/);
    expect(CARD).not.toMatch(/data-testid=[^>]*minute/i);
    expect(CARD).not.toMatch(/minutes_performed/);
    // All edits go through onChange (component state) — the card imports no server action.
    expect(CARD).not.toMatch(/whole-session-copy-actions|use server|\.rpc\(/);
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
    // Consistency: the descriptor is re-checked after loading source rows so the
    // preview never returns rows from a different revision than the fingerprint.
    expect((fn.match(/whole_session_copy_source_descriptor/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(fn).toMatch(/being updated. Please try again/i);
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
    // Source identity is REQUIRED before any write.
    expect(fn).toMatch(/if \(!input\.sourceSessionId \|\| !input\.sourceFingerprint\)/);
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
});

describe("wiring", () => {
  it("the page gates the panel on the CANONICAL descriptor — not a separate previous-session query", () => {
    expect(PAGE).toMatch(/whole_session_copy_source_descriptor/);
    expect(PAGE).toMatch(/canCopyFromPrevious/);
    // The old independent "latest previous session" gate is gone.
    expect(PAGE).not.toMatch(/previousSessionAny|previousSessionHasAreas/);
  });
});

// Phase B reconciliation with the Phase A clinical contract. The editable copy
// card must match production charting: no galvanic-intensity control, the
// OmniBlend rule, and no minutes/outcome input.
describe("copy card matches the Phase A charting contract", () => {
  it("(2) has NO galvanic intensity field/label/testid", () => {
    expect(CARD).not.toMatch(/Galvanic intensity/);
    expect(CARD).not.toMatch(/galvanicIntensityPercent/);
    expect(CARD).not.toMatch(/galv-intensity/);
  });

  it("(3C) ports the charting form's OmniBlend rule: no thermolysis duration for OmniBlend", () => {
    // block-setup-form hides thermolysis duration + clears it for OmniBlend; the
    // card must mirror this so a reviewed copy can't persist a duration on an
    // OmniBlend entry (a state the corrected charting new-entry flow prevents).
    expect(CARD).toMatch(/const isOmniblend = s\.apilusModality === "Omniblend"/);
    // The duration input is gated on !isOmniblend.
    expect(CARD).toMatch(/\{!isOmniblend && \(\s*<label[\s\S]{0,200}?Thermolysis duration/);
    // Switching modality to OmniBlend clears any typed thermolysis duration.
    expect(CARD).toMatch(
      /next === "Omniblend"\s*\?\s*\{ thermolysisDurationSeconds: "" \}/,
    );
  });

  it("(4/11/12) the card renders NO input bound to minutes or any outcome field", () => {
    // Precise: the card only binds inputs to reusable setup fields (value={s.<x>})
    // and only mutates via patchSetup. It renders no input for minutes or any
    // outcome (comments/observations/reaction/tolerance/caution/hairs/numbing).
    expect(CARD).not.toMatch(
      /value=\{s\.(minutes|minutesPerformed|comments|observationChips|toleranceRating|reactionType|reactionNotes|cautionNote|cautionForNextSession|hairsTreated|numbingStatus|numbingNotes)\b/,
    );
    expect(CARD).not.toMatch(
      /patchSetup\(\{\s*(minutes|comments|observationChips|toleranceRating|reactionType|cautionNote|hairsTreated|numbingStatus)\b/,
    );
  });
});
