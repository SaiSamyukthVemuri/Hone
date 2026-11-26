"use client";

// The month field of the statements' month controls. Choosing a month submits the existing GET form, so the picker behaves like the reference's (it
// applies when picked); the form's own submit button stays in the page for anyone without scripting. No state, no request of its own.
export function MonthPickerInput({ defaultValue, min, max, className }: { defaultValue: string; min: string; max?: string; className: string }) {
  return (
    // keyed by the month: the field keeps what a person typed into it, so without a key, Back/Forward (or an arrow) moves the page to another month
    // while the field still shows the one that was picked. A new month is a new field, showing that month (HON-100).
    <input
      key={defaultValue}
      // The picker submits a plain GET form, so Back/Forward land on a page the browser restores: with autocomplete on, it also puts back what was last typed
      // into the field (the month that was picked), not the month the restored page is for. Measured in Chromium: Back twice showed the picked month.
      autoComplete="off"
      type="month"
      name="month"
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={className}
      onChange={(e) => {
        if (e.currentTarget.value) e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
