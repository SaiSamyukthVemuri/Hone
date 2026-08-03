import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #307. Per-photo practitioner note/caption. The action is RLS-scoped and
// row-affected-checked exactly like the archive hardening; the UI shows the note
// on the card + modal with Add/Edit inline editing. Source-grep (the images UI
// isn't DOM-rendered in the node env) + a scope guard that upload / sanitizer /
// storage / signed-URL / archive / session-attach behavior is untouched.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\{\/\*/.test(l))
    .join("\n");

const ACTIONS = read("app/(app)/clients/[id]/images/actions.ts");
const MANAGER = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
const MANAGER_CODE = codeOnly(MANAGER);
const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const TYPES = read("lib/types/database.ts");

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------
describe("updateTreatmentImageNoteAction", () => {
  // The action body only.
  const START = ACTIONS.indexOf("export async function updateTreatmentImageNoteAction");
  const END = ACTIONS.indexOf("export async function archiveTreatmentImageAction");
  const ACTION = ACTIONS.slice(START, END);

  it("exists and caps the note at 1000 characters", () => {
    expect(START).toBeGreaterThan(-1);
    // The cap lives in a plain module (a "use server" file can only export
    // async functions) and is imported by both the action and the UI.
    const CONST = read("app/(app)/clients/[id]/images/note-constants.ts");
    expect(CONST).toMatch(/export const TREATMENT_NOTE_MAX_LENGTH = 1000/);
    expect(ACTION).toMatch(/trimmed\.length > TREATMENT_NOTE_MAX_LENGTH/);
    expect(ACTION).toMatch(/Note is too long/);
  });

  it("uses the RLS client (createClient) — never the service-role admin", () => {
    expect(ACTION).toMatch(/const supabase = await createClient\(\)/);
    expect(ACTION).not.toMatch(/createAdminClient/);
  });

  it("trims and stores whitespace-only as NULL", () => {
    expect(ACTION).toMatch(/input\.note\.trim\(\)/);
    expect(ACTION).toMatch(/trimmed\.length > 0 \? trimmed : null/);
  });

  it("saves the note through the 0168 command, with the same scoping enforced in-DB", () => {
    // L18 Phase 4: the scoping (id + studio + client + not-already-archived)
    // moved INSIDE set_treatment_image_note, where it is enforced in the same
    // statement as the write and the studio is derived from auth.uid().
    expect(ACTION).toMatch(/rpc\("set_treatment_image_note"/);
    expect(ACTION).toMatch(/p_image_id: input\.imageId/);
    expect(ACTION).toMatch(/p_client_id: input\.clientId/);
    expect(ACTION).toMatch(/p_note: value/);
    expect(ACTION).not.toMatch(/p_studio_id/);
    expect(ACTION).toMatch(/if \(!data\)/);

    const MIGRATION = readFileSync(
      path.join(process.cwd(), "supabase/migrations/0168_treatment_image_write_commands.sql"),
      "utf8",
    );
    const seg = MIGRATION.slice(
      MIGRATION.indexOf("function public.set_treatment_image_note("),
    );
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/set practitioner_note = v_note/);
    expect(body).toMatch(/t\.id = p_image_id/);
    expect(body).toMatch(/t\.studio_id = v_studio/);
    expect(body).toMatch(/t\.client_id = p_client_id/);
    expect(body).toMatch(/t\.deleted_at is null/);
  });

  it("returns generic errors and revalidates the images path; no token/PII log", () => {
    expect(ACTION).toMatch(/Treatment photo not found\./);
    expect(ACTION).toMatch(/Could not save the note/);
    expect(ACTION).toMatch(/revalidatePath\(`\/clients\/\$\{input\.clientId\}\/images`\)/);
    expect(ACTION).not.toMatch(/console\.|recordOpsAlert/);
  });
});

// ---------------------------------------------------------------------------
// Types + query
// ---------------------------------------------------------------------------
describe("types + query carry practitioner_note (read-only)", () => {
  it("TreatmentImage type gains practitioner_note", () => {
    expect(TYPES).toMatch(/practitioner_note: string \| null;/);
  });
  it("the image query selects practitioner_note and maps it to row.note", () => {
    expect(PAGE).toMatch(/practitioner_note,/);
    expect(PAGE).toMatch(/note: m\.practitioner_note \?\? null/);
  });
});

// ---------------------------------------------------------------------------
// UI (card + modal)
// ---------------------------------------------------------------------------
describe("note UI on card + modal", () => {
  it("PhotoNoteEditor shows the note text + Add note / Edit note", () => {
    expect(MANAGER).toMatch(/function PhotoNoteEditor/);
    expect(MANAGER).toMatch(/\{note \? "Edit note" : "Add note"\}/);
    expect(MANAGER).toMatch(/whitespace-pre-wrap break-words text-xs/);
  });
  it("has an inline textarea editor with Save / Cancel calling the action", () => {
    expect(MANAGER).toMatch(/<textarea/);
    expect(MANAGER).toMatch(/maxLength=\{TREATMENT_NOTE_MAX_LENGTH\}/);
    expect(MANAGER).toMatch(/updateTreatmentImageNoteAction\(\{/);
    expect(MANAGER).toMatch(/Saving…|Save/);
    expect(MANAGER).toMatch(/onClick=\{cancel\}/);
  });
  it("renders the editor on BOTH the card and the modal", () => {
    const uses = MANAGER.match(/<PhotoNoteEditor/g) ?? [];
    expect(uses.length).toBe(2);
    expect(MANAGER).toMatch(/note=\{img\.note\}/); // card
    expect(MANAGER).toMatch(/note=\{modal\.note\}/); // modal
  });
});

describe("scope guard: no upload/sanitizer/storage/signed-url/archive/attach change", () => {
  it("does not touch the sanitizer, storage path build, signing, archive, or attach", () => {
    // The note action file adds only the note action — it must not alter these.
    for (const src of [MANAGER_CODE, PAGE]) {
      expect(src).not.toMatch(/sanitizeFilename|createSignedUrl\([^)]*ttl|storage_path\s*=/);
    }
    // The note action never deletes/archives or changes attach context.
    const noteAction = ACTIONS.slice(
      ACTIONS.indexOf("export async function updateTreatmentImageNoteAction"),
      ACTIONS.indexOf("export async function archiveTreatmentImageAction"),
    );
    expect(noteAction).not.toMatch(/deleted_at: new Date|storage\.|session_block_id|sessionId/);
  });
});
