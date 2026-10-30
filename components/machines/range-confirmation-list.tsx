import type { RangeWarning } from "@/lib/machines/range-warnings";
import { warningKey } from "@/lib/machines/range-warnings";

// One explicit tick per out-of-range value. The value is NOT changed, limited
// or refused: this only asks the practitioner to confirm what she typed.
// Presentational and stateless so a static render can prove it; the state
// lives in MachineReadingEntry.
export function RangeConfirmationList({
  warnings,
  confirmed,
  disabled,
  labelFor,
  onToggle,
}: {
  warnings: readonly RangeWarning[];
  confirmed: ReadonlySet<string>;
  disabled: boolean;
  /** The field's own name, so the line says which value it is about. */
  labelFor: (w: RangeWarning) => string;
  onToggle: (key: string, next: boolean) => void;
}) {
  if (warnings.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
      data-testid="range-confirmations"
    >
      {warnings.map((w) => {
        const key = warningKey(w);
        return (
          <li key={key} className="text-xs text-amber-900 dark:text-amber-200">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed.has(key)}
                disabled={disabled}
                onChange={(e) => onToggle(key, e.target.checked)}
                data-testid="range-confirm"
              />
              <span>
                <span className="font-medium">
                  {labelFor(w)}: {w.value}.
                </span>{" "}
                {w.message} I have checked this value and want it recorded as entered.
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
