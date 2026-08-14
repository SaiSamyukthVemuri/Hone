import { blockAreasLabel, type BlockArea } from "@/lib/sessions/block-areas";
import type { SessionBlockSide } from "@/lib/types/database";

// PR #274. Pure, display-only helpers that turn EXISTING treatment-photo
// metadata (treatment_images.client_id / session_id / session_block_id, all
// from migration 0092) plus the attached session block's structured area
// fields (primary_area / side / custom_area_detail, migration 0039) into
// human-facing context tags. These NEVER expose raw IDs, storage paths, bucket
// names, or signed URLs, only labels. No DB/schema/security change.
//
// Migration 0128: a photo is attached to ONE settings block, which may treat
// several areas. The area tag now shows EVERY treated area + laterality via the
// shared resolver ("Left cheek · Right sideburn"), never just the first.

// Chloe pilot feedback: the card said "Block photo" while the upload selector
// said "Treatment area photo", one consistent, practitioner-friendly label.
export type PhotoScopeLabel =
  | "Client photo"
  | "Session photo"
  | "Treatment area photo";

export type SessionBlockAreaInput = {
  primary_area: string | null;
  side: SessionBlockSide | null;
  custom_area_detail: string | null;
  // Migration 0128: the structured multi-area set for the attached block. When
  // present it is authoritative; otherwise the legacy primary_area + side.
  structured_areas?: ReadonlyArray<BlockArea> | null;
} | null;

// Composes the ordered area label + optional custom detail for a block, or null
// when the block records no area at all. Structured rows win; legacy primary_area
// + side is the fallback. Laterality lives in the label ("Left cheek"), so the
// old side suffix is gone.
function composeBlockAreaText(block: SessionBlockAreaInput): string | null {
  const label = blockAreasLabel(block?.structured_areas ?? null, {
    primary_area: block?.primary_area ?? null,
    side: block?.side ?? null,
  });
  if (!label) return null;
  const detail = block?.custom_area_detail?.trim();
  return detail ? `${label} · ${detail}` : label;
}

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

// Area tag, only meaningful when a session block is attached:
//   - "Treatment area: <area · side · detail>" when an area was recorded
//   - "Area not recorded" when the block is attached but has no area
//   - null when there is no attached block (no area tag at all)
// Mirrors the canonical block-area label in session-blocks-view.tsx.
export function treatmentPhotoAreaLabel(
  sessionBlockId: string | null,
  block: SessionBlockAreaInput,
): string | null {
  if (!sessionBlockId) return null;
  const text = composeBlockAreaText(block);
  if (!text) return "Area not recorded";
  return `Treatment area: ${text}`;
}

// PR #284. Concise label for a session-block option in the attach-at-upload
// context selector (no "Treatment area:" prefix). Same area/side/detail
// composition as treatmentPhotoAreaLabel; "Area not recorded" when blank.
// Pure + display-only, the option's VALUE carries the id, never shown text.
export function sessionBlockOptionLabel(block: SessionBlockAreaInput): string {
  return composeBlockAreaText(block) ?? "Area not recorded";
}
