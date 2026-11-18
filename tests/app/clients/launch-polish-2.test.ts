import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #194 (Chloe's launch-polish round 2): copy-from-last-session containment.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const SESSION_PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const BLOCK_ACTIONS = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
);
const COPY_BUTTON = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/CopyPreviousAreasButton.tsx",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("5. whole-session copy is TEMPORARILY CONTAINED (zero writes)", () => {
  const action = codeOnly(BLOCK_ACTIONS).slice(
    codeOnly(BLOCK_ACTIONS).indexOf(
      "export async function copyPreviousSessionAreasAction",
    ),
    codeOnly(BLOCK_ACTIONS).indexOf("export type SoftDeleteBlockInput"),
  );

  it("keeps the authenticated + current-session lineage checks", () => {
    expect(action).toContain("getCurrentPractitionerWithStudio()");
    expect(action).toContain(
      "assertSessionForClient(studio.id, input.clientId, input.sessionId)",
    );
    expect(action).toContain("Inactive practitioners cannot log sessions.");
  });

  it("returns a fixed unavailable result and performs ZERO writes/reads of the source", () => {
    expect(action).toMatch(
      /Copy all areas from last session is temporarily unavailable/,
    );
    // No source-session lookup, no session_blocks read/insert, no revalidate.
    expect(action).not.toContain("createClient(");
    expect(action).not.toContain('.from("session_blocks")');
    expect(action).not.toContain('.from("sessions")');
    expect(action).not.toContain(".insert(");
    expect(action).not.toContain("copiedCount");
    expect(action).not.toContain("previousSessionId)"); // never dereferenced
  });

  it("the control is a NON-INTERACTIVE notice — it never calls the action", () => {
    expect(COPY_BUTTON).not.toContain("copyPreviousSessionAreasAction");
    expect(COPY_BUTTON).not.toContain('"use client"');
    expect(COPY_BUTTON).not.toContain("onClick");
    expect(COPY_BUTTON).toMatch(/Temporarily unavailable/);
    expect(COPY_BUTTON).toMatch(/Copy settings/); // points to the safe in-form path
    // Never implies data loss.
    expect(COPY_BUTTON).not.toMatch(/lost|deleted|removed your/i);
  });

  it("the draft-model copy panel (0157) renders only on an empty electrolysis chart with a canonical eligible source", () => {
    // Migration 0157 replaced the paused one-tap copy with the ephemeral editable
    // preview panel (CopyPreviousAreasPanel), gated on the CANONICAL source
    // descriptor (same authority the commit RPC derives its source from).
    expect(SESSION_PAGE).toMatch(
      /blockData\.blocks\.length === 0 &&\s*\n?\s*canCopyFromPrevious && \(/,
    );
    expect(SESSION_PAGE).toMatch(/<CopyPreviousAreasPanel/);
    expect(SESSION_PAGE).toMatch(/whole_session_copy_source_descriptor/);
  });
});
