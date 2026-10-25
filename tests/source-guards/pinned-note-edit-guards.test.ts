import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source guards for editing a mutable pinned client note (client_pinned_notes —
// an operational reminder, NOT the append-only immutable client_clinical_notes).
// These pin the safety contract the DB test can't see. Since 0254 the edit is the
// database command edit_client_pinned_note (author-or-owner, tenant-scoped,
// optimistic-concurrency, audited, mutates ONLY the text); the action is a thin
// caller that derives the studio from the session.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Strip comments so assertions test CODE, not the safety prose in the comments.
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS = "app/(app)/clients/[id]/pinned-notes-actions.ts";
const CARD = "components/client-pinned-notes-card.tsx";
const PAGE = "app/(app)/clients/[id]/page.tsx";

// The edit action body only (between its declaration and the next action).
function editBody(): string {
  const src = code(ACTIONS);
  const from = src.indexOf("editClientPinnedNoteAction");
  const to = src.indexOf("removeClientPinnedNoteAction");
  return src.slice(from, to);
}

describe("pinned-note edit — server action contract", () => {
  it("exports editClientPinnedNoteAction", () => {
    expect(code(ACTIONS)).toMatch(/export async function editClientPinnedNoteAction/);
  });

  it("authorizes from the SESSION (getCurrentPractitionerWithStudio), never the form studio", () => {
    expect(editBody()).toMatch(/const \{ studio \} = await getCurrentPractitionerWithStudio\(\)/);
  });

  it("HON-44 / 0254: the edit is the database command, on the USER session client; no service-role write, no table UPDATE", () => {
    const b = editBody();
    expect(b).toMatch(/await supabase\.rpc\("edit_client_pinned_note"/);
    expect(b).toMatch(/p_studio_id: studio\.id/);
    expect(b).toMatch(/p_client_id: clientId/);
    expect(b).toMatch(/p_note_id: noteId/);
    expect(b).toMatch(/p_original_text: originalText/);
    expect(b).toMatch(/p_text: text/);
    // never the service role, never a direct UPDATE, never insert/delete: no
    // duplicates, pinned state kept, and the author rule lives in the database.
    expect(code(ACTIONS)).not.toMatch(/createAdminClient/);
    expect(b).not.toMatch(/\.update\(/);
    expect(b).not.toMatch(/\.insert\(/);
    expect(b).not.toMatch(/\.delete\(/);
    expect(b).not.toMatch(/created_by/); // authorship is decided by the command, not the caller
  });

  it("optimistic concurrency: validates original_text and sends it to the command, which guards on the note's current text", () => {
    const b = editBody();
    expect(b).toMatch(/const originalText = trimmedString\(formData\.get\("original_text"\)\)/);
    expect(b).toMatch(/if \(!originalText\) throw/);
    expect(b).toMatch(/p_original_text: originalText/);
  });

  it("rejects a raced / stale / deleted / foreign / not-yours note with ONE fixed safe message (no raw DB leak)", () => {
    const b = editBody();
    expect(b).toMatch(/data !== true/);
    expect(b).toMatch(
      /That note changed or is no longer available\. Refresh and try again\./,
    );
    expect(b).toMatch(/if \(error\) throw new Error\("Could not update the note\. Please try again\."\)/);
    expect(b).not.toMatch(/error\.message/); // edit path never surfaces raw DB text
  });

  it("rejects empty text and over-length before touching the DB", () => {
    const b = editBody();
    expect(b).toMatch(/if \(!text\) throw/);
    expect(b).toMatch(/MAX_PINNED_NOTE_LENGTH/);
  });

});

describe("pinned-note edit — UI wiring", () => {
  it("the card exposes an Edit control + an inline editor pre-filled with the current text", () => {
    const c = read(CARD);
    expect(c).toMatch(/editAction/);
    expect(c).toMatch(/aria-label="Edit pinned note"/);
    expect(c).toMatch(/setEditText\(note\.text\)/); // pre-fill
    expect(c).toMatch(/autoFocus/);
  });

  it("cancel restores without saving (cancelEdit never calls editAction)", () => {
    const c = read(CARD);
    const cancel = c.slice(c.indexOf("function cancelEdit"), c.indexOf("function submitEdit"));
    expect(cancel).not.toMatch(/editAction|FormData/);
  });

  it("submit is disabled while pending or empty (duplicate-submit + empty guard)", () => {
    const c = read(CARD);
    expect(c).toMatch(/disabled=\{pending \|\| editText\.trim\(\)\.length === 0\}/);
  });

  it("the client profile passes editAction to the card", () => {
    const p = read(PAGE);
    expect(p).toMatch(/editAction=\{editClientPinnedNoteAction\}/);
  });
});
