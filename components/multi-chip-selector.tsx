"use client";

import { useState } from "react";

type Props = {
  options: ReadonlyArray<string>;
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  otherPlaceholder?: string;
};

// Multi-select chip selector. Selecting a preset toggles it in/out of `values`.
// Selecting "Other" reveals a free-text input; submitting that adds the typed
// value as a custom chip that can be removed by clicking it again.
export function MultiChipSelector({
  options,
  values,
  onChange,
  otherPlaceholder = "Describe",
}: Props) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");

  // Values that aren't in the option list are user-entered customs.
  const customValues = values.filter((v) => !options.includes(v));

  function toggle(option: string) {
    if (values.includes(option)) {
      onChange(values.filter((v) => v !== option));
    } else {
      onChange([...values, option]);
    }
  }

  function commitOther() {
    const trimmed = otherText.trim();
    if (!trimmed) {
      setOtherOpen(false);
      return;
    }
    if (values.includes(trimmed)) {
      setOtherText("");
      return;
    }
    onChange([...values, trimmed]);
    setOtherText("");
    setOtherOpen(false);
  }

  function removeCustom(custom: string) {
    onChange(values.filter((v) => v !== custom));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          if (opt === "Other") {
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setOtherOpen((v) => !v)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  otherOpen
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }`}
              >
                Other
              </button>
            );
          }
          const selected = values.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
              }`}
            >
              {opt}
            </button>
          );
        })}
        {customValues.map((custom) => (
          <button
            key={`custom-${custom}`}
            type="button"
            onClick={() => removeCustom(custom)}
            className="rounded-full border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-white dark:bg-white dark:text-neutral-900"
            aria-label={`Remove ${custom}`}
          >
            {custom} <span className="ml-1 opacity-70">×</span>
          </button>
        ))}
      </div>
      {otherOpen && (
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            placeholder={otherPlaceholder}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitOther();
              }
            }}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <button
            type="button"
            onClick={commitOther}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
