// The read-only "This visit" summary of the New view, derived from what the session actually holds for ITS modality:
// electrolysis charts as settings blocks, laser as laser entries (passes). Deriving laser from the electrolysis blocks
// told a practitioner a charted laser visit had nothing. Pure: no reads, no writes.
import { formatAreaLabel, resolveBlockAreas } from "@/lib/sessions/block-areas";

export type VisitSummary = {
  kind: "electrolysis" | "laser";
  areas: string[];
  count: number;
  nextVisitNoteRecorded: boolean;
};

type BlockLike = { deleted_at: string | null; structured_areas?: Parameters<typeof resolveBlockAreas>[0]; primary_area?: string | null; side?: string | null };
type LaserLike = { deleted_at: string | null; zone: string };

export function buildVisitSummary(o: {
  modality: string;
  blocks: ReadonlyArray<BlockLike> | null | undefined;
  laserEntries: ReadonlyArray<LaserLike> | null | undefined;
  nextSessionNote: string | null | undefined;
}): VisitSummary {
  const nextVisitNoteRecorded = Boolean(o.nextSessionNote && o.nextSessionNote.trim());
  if (o.modality === "electrolysis") {
    const live = (o.blocks ?? []).filter((b) => b.deleted_at == null);
    return {
      kind: "electrolysis",
      areas: live.flatMap((b) => resolveBlockAreas(b.structured_areas, b).map(formatAreaLabel)),
      count: live.length,
      nextVisitNoteRecorded,
    };
  }
  const live = (o.laserEntries ?? []).filter((e) => e.deleted_at == null);
  const zones: string[] = [];
  for (const e of live) {
    const z = e.zone.trim();
    if (z !== "" && !zones.includes(z)) zones.push(z);
  }
  return { kind: "laser", areas: zones, count: live.length, nextVisitNoteRecorded };
}
