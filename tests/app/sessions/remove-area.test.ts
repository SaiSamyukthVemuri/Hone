import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Willow P1-B source pins: the remove-area action calls the atomic RPC with the
// right payload, the UI is wired with an attached-data warning + required
// reason, and the control is draft-only (the page gates the whole editor on
// !isFinalized; the RPC rejects finalized as the backstop).

const ROOT = process.cwd();
const ACTIONS = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts"),
  "utf8",
);
const VIEW = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx"),
  "utf8",
);
const BUTTON = readFileSync(join(ROOT, "components/remove-area-button.tsx"), "utf8");
const PAGE = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"),
  "utf8",
);

describe("removeSessionAreaAction — calls the atomic RPC", () => {
  it("invokes soft_delete_session_area with the named args", () => {
    expect(ACTIONS).toMatch(/export async function removeSessionAreaAction/);
    expect(ACTIONS).toMatch(
      /supabase\.rpc\("soft_delete_session_area", \{\s*\n?\s*p_session_id: input\.sessionId,\s*\n?\s*p_block_id: input\.blockId,\s*\n?\s*p_reason: reason,/,
    );
  });

  it("requires a >=10-char reason and re-checks session∈client lineage", () => {
    expect(ACTIONS).toMatch(/reason\.length < 10/);
    expect(ACTIONS).toMatch(/assertSessionForClient\(studio\.id, input\.clientId, input\.sessionId\)/);
  });

  it("maps a business raise (23514) to its message, else a generic error, and revalidates", () => {
    expect(ACTIONS).toMatch(/error\.code === "23514"/);
    expect(ACTIONS).toMatch(/revalidatePath\(`\/clients\/\$\{input\.clientId\}\/sessions\/\$\{input\.sessionId\}`\)/);
  });
});

describe("chart editor wires the Remove area control", () => {
  it("imports + renders RemoveAreaButton in the area section with the pass count", () => {
    expect(VIEW).toMatch(/import \{ RemoveAreaButton \}/);
    expect(VIEW).toMatch(/import \{ removeSessionAreaAction \}/);
    expect(VIEW).toMatch(/<RemoveAreaButton[\s\S]{0,220}action=\{removeSessionAreaAction\}/);
    expect(VIEW).toMatch(/passCount=\{block\.electrolysis_entries\.length\}/);
  });
});

describe("RemoveAreaButton — warning + required reason + soft-delete framing", () => {
  it("summarizes attached passes/photos before removal and requires a reason", () => {
    expect(BUTTON).toMatch(/recorded pass/i);
    expect(BUTTON).toMatch(/photos attached to this area/i);
    expect(BUTTON).toMatch(/Reason \(required/i);
    // Confirm button disabled until the reason is long enough.
    expect(BUTTON).toMatch(/disabled=\{pending \|\| reason\.trim\(\)\.length < 10\}/);
  });

  it("frames it as a preserved soft-delete and surfaces errors accessibly", () => {
    expect(BUTTON).toMatch(/soft-deleted/i);
    expect(BUTTON).toMatch(/role="alert"/);
  });
});

describe("draft-only gating", () => {
  it("the page renders the editor (SessionBlocksView) only when NOT finalized", () => {
    const guardIdx = PAGE.indexOf("!isFinalized &&");
    const viewIdx = PAGE.indexOf("<SessionBlocksView");
    expect(guardIdx).toBeGreaterThan(-1);
    // The editor is inside the !isFinalized guard (draft-only).
    expect(viewIdx).toBeGreaterThan(guardIdx);
  });
});
