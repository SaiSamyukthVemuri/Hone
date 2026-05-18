import type { Service } from "@/lib/types/database";
import { KNOWN_MODALITIES } from "@/lib/types/database";

// Shared formatting helpers for the service-menu UI. Used by both the public
// booking form (/book/[slug]) and the in-app client booking dialog.
//
// Decisions:
// - Render order: electrolysis, laser, consultation, then any custom
//   modalities (alpha), then "Other" (null modality) last.
// - For electrolysis, the modality is the group header, so the option label
//   shows just duration + price (the service name is redundant).
// - For laser, the service name describes the area (Underarms, Brazilian),
//   so the label shows name + price. Duration is implied by area.
// - For everything else, label shows name + duration + price.

export type ServiceModalityGroup = {
  // null for the "Other" bucket (uncategorized).
  modality: string | null;
  label: string;
  services: Service[];
};

const OTHER_KEY = "__other__";
const PREFERRED_ORDER: ReadonlyArray<string> = [
  "electrolysis",
  "laser",
  "consultation",
];

function modalityKey(s: Service): string {
  return s.modality && s.modality.trim().length > 0 ? s.modality : OTHER_KEY;
}

function labelFor(modality: string): string {
  if (modality === OTHER_KEY) return "Other";
  const known = KNOWN_MODALITIES.find((m) => m.value === modality);
  if (known) return known.label;
  // Custom modality: capitalize first letter for display.
  return modality.charAt(0).toUpperCase() + modality.slice(1);
}

export function groupServicesByModality(
  services: ReadonlyArray<Service>,
): ServiceModalityGroup[] {
  const groups = new Map<string, Service[]>();
  for (const s of services) {
    const key = modalityKey(s);
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      // Tie-break on duration so "15 min, 30 min, 45 min" reads in order.
      if (a.default_duration_minutes !== b.default_duration_minutes) {
        return a.default_duration_minutes - b.default_duration_minutes;
      }
      return a.name.localeCompare(b.name);
    });
  }

  const seen = new Set<string>();
  const ordered: ServiceModalityGroup[] = [];

  for (const m of PREFERRED_ORDER) {
    if (groups.has(m)) {
      ordered.push({ modality: m, label: labelFor(m), services: groups.get(m)! });
      seen.add(m);
    }
  }

  // Custom modalities (not in PREFERRED_ORDER, not OTHER) alpha-sorted.
  const customs = Array.from(groups.keys())
    .filter((k) => k !== OTHER_KEY && !seen.has(k))
    .sort((a, b) => a.localeCompare(b));
  for (const k of customs) {
    ordered.push({ modality: k, label: labelFor(k), services: groups.get(k)! });
  }

  if (groups.has(OTHER_KEY)) {
    ordered.push({
      modality: null,
      label: "Other",
      services: groups.get(OTHER_KEY)!,
    });
  }

  return ordered;
}

function priceTail(s: Service): string {
  return s.price_cents != null ? ` · $${(s.price_cents / 100).toFixed(0)}` : "";
}

// Per-option label for the grouped <select>. Modality-aware so the option
// text doesn't repeat the group heading.
export function formatServiceLabel(s: Service): string {
  const duration = `${s.default_duration_minutes} min`;
  const price = priceTail(s);

  if (s.modality === "electrolysis") {
    return `${duration}${price}`;
  }
  if (s.modality === "laser") {
    return `${s.name}${price}`;
  }
  return `${s.name} · ${duration}${price}`;
}
