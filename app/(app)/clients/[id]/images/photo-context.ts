import { sessionBlockSideLabel } from "@/lib/sessions/side-labels";
import type { SessionBlockSide } from "@/lib/types/database";

// PR #274. Pure, display-only helpers that turn EXISTING treatment-photo
// metadata (treatment_images.client_id / session_id / session_block_id, all
// from migration 0092) plus the attached session block's structured area
// fields (primary_area / side / custom_area_detail, migration 0039) into
// human-facing context tags. These NEVER expose raw IDs, storage paths, bucket
// names, or signed URLs — only labels. No DB/schema/security change.

// Chloe pilot feedback: the card said "Block photo" while the upload selector
// said "Treatment area photo" — one consistent, practitioner-friendly label.
export type PhotoScopeLabel =
  | "Client photo"
  | "Session photo"
  | "Treatment area photo";

export type SessionBlockAreaInput = {
  primary_area: string | null;
  side: SessionBlockSide | null;
  custom_area_detail: string | null;
} | null;

// Most-specific scope wins: block > session > client. Every image is attached
// to a client (client_id is required), so "Client photo" is the floor.
export function treatmentPhotoScopeLabel(input: {
  sessionId: string | null;
  sessionBlockId: string | null;
}): PhotoScopeLabel {
  if (input.sessionBlockId) return "Treatment area photo";
  if (input.sessionId) return "Session photo";
  return "Client photo";
}

// Area tag — only meaningful when a session block is attached:
//   - "Treatment area: <area · side · detail>" when an area was recorded
//   - "Area not recorded" when the block is attached but has no area
//   - null when there is no attached block (no area tag at all)
// Mirrors the canonical block-area label in session-blocks-view.tsx.
export function treatmentPhotoAreaLabel(
  sessionBlockId: string | null,
  block: SessionBlockAreaInput,
): string | null {
  if (!sessionBlockId) return null;
  const area = block?.primary_area?.trim();
  if (!area) return "Area not recorded";
  const extras: string[] = [];
  if (block && block.side && block.side !== "n/a") {
    const sideLabel = sessionBlockSideLabel(block.side);
    if (sideLabel) extras.push(sideLabel);
  }
  const detail = block?.custom_area_detail?.trim();
  if (detail) extras.push(detail);
  const text = extras.length > 0 ? `${area} · ${extras.join(" · ")}` : area;
  return `Treatment area: ${text}`;
}

// PR #284. Concise label for a session-block option in the attach-at-upload
// context selector (no "Treatment area:" prefix). Same area/side/detail
// composition as treatmentPhotoAreaLabel; "Area not recorded" when blank.
// Pure + display-only — the option's VALUE carries the id, never shown text.
export function sessionBlockOptionLabel(block: SessionBlockAreaInput): string {
  const area = block?.primary_area?.trim();
  if (!area) return "Area not recorded";
  const extras: string[] = [];
  if (block && block.side && block.side !== "n/a") {
    const sideLabel = sessionBlockSideLabel(block.side);
    if (sideLabel) extras.push(sideLabel);
  }
  const detail = block?.custom_area_detail?.trim();
  if (detail) extras.push(detail);
  return extras.length > 0 ? `${area} · ${extras.join(" · ")}` : area;
}
