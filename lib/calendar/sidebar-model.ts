import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import {
  parseSelection,
  serializeSelection,
  type PractitionerSelection,
} from "@/lib/calendar/practitioner-selection";

// HON-48 sidebar: the page-side model. Pure; the page passes the active practitioners it ALREADY
// loaded (getPractitionersForStudio, the same read the Day view uses), so the sidebar can list
// no one the calendar would not already draw for this viewer.

export type SidebarModel = {
  selection: PractitionerSelection;
  /** The selection as a URL param; undefined when it is everyone. */
  param: string | undefined;
  practitioners: Array<{ id: string; name: string; swatchClass: string; colorLabel: string }>;
  selectedIds: string[];
};

export function buildSidebarModel(
  active: ReadonlyArray<{ id: string; display_name: string; color?: string | null }>,
  peopleParam: string | string[] | undefined,
): SidebarModel {
  const listed = active.map((p) => p.id);
  const selection = parseSelection(peopleParam, listed);
  return {
    selection,
    param: serializeSelection(selection.ids, listed),
    practitioners: active.map((p) => {
      const color = resolvePractitionerColor(p.color);
      return { id: p.id, name: p.display_name?.trim() || "Practitioner", swatchClass: color.bg, colorLabel: color.label };
    }),
    selectedIds: listed.filter((id) => selection.ids.has(id)),
  };
}
