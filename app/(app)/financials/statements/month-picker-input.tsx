"use client";

// The month field of the statements' month controls. Choosing a month submits the existing GET form, so the picker behaves like the reference's (it
// applies when picked); the form's own submit button stays in the page for anyone without scripting. No state, no request of its own.
export function MonthPickerInput({ defaultValue, min, max, className }: { defaultValue: string; min: string; max?: string; className: string }) {
  return (
    <input
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
