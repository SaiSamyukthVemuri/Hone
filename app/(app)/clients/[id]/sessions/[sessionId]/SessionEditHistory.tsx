import { FormattedDateTime } from "@/components/formatted-date-time";
import type { Practitioner, SessionAudit } from "@/lib/types/database";

type Props = {
  startedAtOriginal: string;
  audit: SessionAudit[];
  practitioners: Practitioner[];
};

function fieldLabel(field: string): string {
  if (field === "started_at") return "Start time";
  return field;
}

function isLikelyIso(value: string | null): value is string {
  if (!value) return false;
  // ISO timestamps look like 2026-05-16T15:30:00.000Z or +00:00.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function renderValue(value: string | null) {
  if (value == null || value.length === 0) {
    return <span className="text-neutral-400">empty</span>;
  }
  if (isLikelyIso(value)) {
    return <FormattedDateTime iso={value} />;
  }
  return <span>{value}</span>;
}

function editorName(
  id: string | null,
  practitioners: Practitioner[],
): string {
  if (!id) return "Unknown";
  const p = practitioners.find((x) => x.id === id);
  if (!p) return "Unknown";
  return p.display_name?.trim() ? p.display_name : p.email;
}

export function SessionEditHistory({
  startedAtOriginal,
  audit,
  practitioners,
}: Props) {
  if (audit.length === 0) return null;

  const editCount = audit.length;
  return (
    <details className="rounded-md border border-neutral-200 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-900/40">
      <summary className="cursor-pointer list-none px-4 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900">
        View history ({editCount} {editCount === 1 ? "edit" : "edits"})
      </summary>
      <div className="flex flex-col gap-3 border-t border-neutral-200 px-4 py-3 text-xs dark:border-neutral-800">
        <div>
          <span className="text-neutral-500">Original logged time:</span>{" "}
          <FormattedDateTime iso={startedAtOriginal} />
        </div>
        <ul className="flex flex-col gap-2">
          {audit.map((row) => (
            <li
              key={row.id}
              className="border-l-2 border-neutral-300 pl-3 dark:border-neutral-700"
            >
              <div className="text-neutral-700 dark:text-neutral-300">
                Edited by{" "}
                <span className="font-medium">
                  {editorName(row.edited_by_practitioner_id, practitioners)}
                </span>{" "}
                on <FormattedDateTime iso={row.edited_at} />:
              </div>
              <div className="mt-0.5 text-neutral-600 dark:text-neutral-400">
                {fieldLabel(row.field)} changed from {renderValue(row.old_value)}{" "}
                to {renderValue(row.new_value)}.
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
