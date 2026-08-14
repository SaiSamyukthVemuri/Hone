import "server-only";
import { getClinicalNoteHistory } from "./queries";
import type { ClinicalNoteKind } from "@/lib/types/database";
import type { ClinicalNoteSectionData } from "@/components/clinical-notes-section";

// Static presentation copy for the two clinical-note kinds. The order here is
// the order the two cards render in on every surface.
const KIND_META: Record<
  ClinicalNoteKind,
  { label: string; description: string; placeholder: string }
> = {
  consultation: {
    label: "Consultation notes",
    description:
      "Dated consultation record: goals, history, expectations, plan discussed.",
    placeholder:
      "What the client wants, relevant history, expectations set, plan discussed, next steps…",
  },
  skin_hair_analysis: {
    label: "Skin & hair analysis",
    description:
      "Dated skin and hair assessment: type, condition, growth, and treatment-area findings.",
    placeholder:
      "Skin type/condition, hair type/colour/density, growth pattern, area-specific findings…",
  },
};

const KIND_ORDER: ReadonlyArray<ClinicalNoteKind> = [
  "consultation",
  "skin_hair_analysis",
];

// Fetch both kinds' recent history (which also contains the current entry) and
// shape them into the section data the client component renders. `historyLimit`
// bounds the per-kind read so compact surfaces (charting/prep) never trigger an
// unbounded client-history load.
export async function buildClinicalNoteSections(
  clientId: string,
  opts: { historyLimit?: number } = {},
): Promise<ClinicalNoteSectionData[]> {
  const limit = opts.historyLimit ?? 25;
  const results = await Promise.all(
    KIND_ORDER.map((kind) =>
      getClinicalNoteHistory(clientId, kind, { limit }),
    ),
  );
  return KIND_ORDER.map((kind, i) => ({
    kind,
    ...KIND_META[kind],
    notes: results[i].notes,
    total: results[i].total,
  }));
}
