"use client";

import { useState, type KeyboardEvent } from "react";
import {
  BODY_ZONES,
  zoneForArea,
  type BodyZoneId,
} from "@/lib/sessions/body-zones";

// PR #270. Built-in body-map treatment-area picker. A simple SCHEMATIC body
// (inline SVG vector shapes, NO image asset, upload, canvas, drawing, or
// annotation) with clickable broad zones (Face / Neck / Torso / Arms / Legs /
// Bikini-intimate / Other). Picking a zone reveals its specific area chips,
// which set the same structured value the list-below AreaPicker uses
// (session_blocks.primary_area). Charting-only; the shared AreaPicker is
// unchanged, so the treatment-plan editor is unaffected.

export function BodyMapAreaPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
}) {
  const selectedZone = zoneForArea(value);
  const [openZone, setOpenZone] = useState<BodyZoneId | null>(selectedZone);
  const open = BODY_ZONES.find((z) => z.id === openZone) ?? null;

  function zoneGroup(id: BodyZoneId, label: string) {
    // PR #279 (Chloe charting feedback): the saved value is always a SPECIFIC
    // sub-area (e.g. "Underarms"), never a whole zone. zoneForArea maps it to its
    // owning zone (Underarms -> Arms). Previously the whole broad zone shape (both
    // arms) flooded emerald, which read as if the ENTIRE region was being treated
    // confusing when only underarms was selected. Now the broad shape gets only
    // a SUBTLE "contains the selected area" tint; the exact area is shown by the
    // highlighted area chip below + the form's "Area being charted: Underarms" line.
    const containsSelection = selectedZone === id;
    const focused = openZone === id;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpenZone(id);
      }
    };
    return {
      role: "button" as const,
      tabIndex: 0,
      "aria-label": containsSelection
        ? `Body map zone: ${label} (contains the selected area)`
        : `Body map zone: ${label}`,
      "aria-pressed": containsSelection,
      onClick: () => setOpenZone(id),
      onKeyDown,
      className:
        "cursor-pointer outline-none " +
        (containsSelection
          ? "fill-emerald-50 dark:fill-emerald-950/50"
          : focused
            ? "fill-neutral-300 dark:fill-neutral-600"
            : "fill-neutral-100 hover:fill-neutral-200 dark:fill-neutral-800 dark:hover:fill-neutral-700"),
    };
  }
  const shape = "stroke-neutral-400 dark:stroke-neutral-600";
  const labelText =
    "pointer-events-none select-none fill-neutral-700 text-[7px] font-medium dark:fill-neutral-200";

  return (
    <div className="flex flex-col gap-3">
      <svg
        id={`${idPrefix}-bodymap`}
        viewBox="0 0 140 250"
        role="group"
        aria-label="Body map"
        className="mx-auto h-56 w-auto select-none"
      >
        {/* Face / head */}
        <g {...zoneGroup("face", "Face")}>
          <circle cx="70" cy="26" r="20" strokeWidth="1" className={shape} />
          <text x="70" y="28" textAnchor="middle" className={labelText}>
            Face
          </text>
        </g>
        {/* Neck */}
        <g {...zoneGroup("neck", "Neck")}>
          <rect x="60" y="46" width="20" height="10" rx="2" strokeWidth="1" className={shape} />
        </g>
        {/* Torso */}
        <g {...zoneGroup("torso", "Torso")}>
          <rect x="42" y="56" width="56" height="72" rx="8" strokeWidth="1" className={shape} />
          <text x="70" y="92" textAnchor="middle" className={labelText}>
            Torso
          </text>
        </g>
        {/* Arms (both) */}
        <g {...zoneGroup("arms", "Arms")}>
          <rect x="22" y="58" width="16" height="64" rx="7" strokeWidth="1" className={shape} />
          <rect x="102" y="58" width="16" height="64" rx="7" strokeWidth="1" className={shape} />
          <text x="30" y="94" textAnchor="middle" className={labelText}>
            Arms
          </text>
        </g>
        {/* Bikini / intimate */}
        <g {...zoneGroup("intimate", "Bikini / intimate")}>
          <rect x="46" y="128" width="48" height="20" rx="5" strokeWidth="1" className={shape} />
          <text x="70" y="141" textAnchor="middle" className={labelText}>
            Bikini
          </text>
        </g>
        {/* Legs (both) */}
        <g {...zoneGroup("legs", "Legs")}>
          <rect x="48" y="148" width="20" height="86" rx="7" strokeWidth="1" className={shape} />
          <rect x="72" y="148" width="20" height="86" rx="7" strokeWidth="1" className={shape} />
          <text x="70" y="196" textAnchor="middle" className={labelText}>
            Legs
          </text>
        </g>
      </svg>

      {/* Neck + Other don't get a glyph label inside the figure; expose them as
          plain zone buttons so every body zone is reachable. */}
      <div className="flex flex-wrap justify-center gap-1.5">
        {BODY_ZONES.map((z) => {
          const active = openZone === z.id || selectedZone === z.id;
          return (
            <button
              key={z.id}
              type="button"
              onClick={() => setOpenZone(z.id)}
              aria-pressed={active}
              className={
                "rounded-full border px-2.5 py-1 text-xs " +
                (active
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
              }
            >
              {z.label}
            </button>
          );
        })}
      </div>

      {open && open.areas.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            {open.label}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {open.areas.map((area) => {
              const selected = value === area;
              return (
                <button
                  key={area}
                  type="button"
                  onClick={() => onChange(area)}
                  aria-pressed={selected}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs " +
                    (selected
                      ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                      : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
                  }
                >
                  {area}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {open && open.id === "other" && (
        <p className="text-xs text-neutral-500">
          For a custom area, use the list below and choose “Other”.
        </p>
      )}
    </div>
  );
}
