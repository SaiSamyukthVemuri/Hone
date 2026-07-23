"use client";

// PR B 3E-6 — the shared "Applies to" scope control for owner-managed timed
// blocks and recurring breaks. Rendered ONLY when practitioner capacity is on.
//
//   value ""      -> studio-wide (every practitioner)
//   value <uuid>  -> that one practitioner
//
// New / changed targets may only be ACTIVE practitioners (`selectable`). An
// existing source that already points at an inactive practitioner keeps that
// value as a distinct, labelled option so the owner can edit its time/label
// without being forced to reassign — but they cannot pick an inactive
// practitioner for a source that isn't already scoped to them.

export type ScopeSelectable = { id: string; display_name: string };
export type ScopeDirectoryEntry = { display_name: string; active: boolean };
export type ScopeDirectory = Record<string, ScopeDirectoryEntry>;

// The scope the current VIEW is anchored to — drives the form's default target.
export type ViewScope =
  | { kind: "studio" }
  | { kind: "practitioner"; practitionerId: string };

// Owner-facing label for an existing source's scope. NULL -> studio-wide; an id
// missing from the directory (deleted practitioner) degrades to a neutral,
// non-PII label; an inactive practitioner is flagged so the owner knows it must
// be reassigned before it can be re-activated.
export function scopeRowLabel(
  practitionerId: string | null,
  directory: ScopeDirectory,
): string {
  if (!practitionerId) return "All practitioners";
  const entry = directory[practitionerId];
  if (!entry) return "A former practitioner";
  return entry.active
    ? `Only ${entry.display_name}`
    : `Only ${entry.display_name} — inactive`;
}

export function ScopeField({
  value,
  onChange,
  selectable,
  directory,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  selectable: ReadonlyArray<ScopeSelectable>;
  directory: ScopeDirectory;
  disabled?: boolean;
}) {
  // Surface a value that is set but not selectable (an existing inactive/former
  // scope) as its own trailing option so the current selection is preserved.
  const showExtra = value !== "" && !selectable.some((p) => p.id === value);
  const extraLabel = directory[value]?.display_name ?? "Former practitioner";

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Applies to
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Applies to"
        className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
      >
        <option value="">All practitioners</option>
        {selectable.map((p) => (
          <option key={p.id} value={p.id}>
            Only {p.display_name}
          </option>
        ))}
        {showExtra && (
          <option value={value}>Only {extraLabel} — inactive</option>
        )}
      </select>
    </label>
  );
}
