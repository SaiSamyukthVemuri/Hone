"use client";

import { useEffect, useState } from "react";

type Props = {
  options: ReadonlyArray<string>;
  value: string;
  onChange: (v: string) => void;
  // Custom-input label shown when "Other" is selected.
  otherPlaceholder?: string;
  // Optional: label used to render a hidden form input, when this needs to participate in <form> submission.
  name?: string;
};

// Single-select chip selector. Selecting "Other" reveals a free-text input
// that becomes the stored value.
//
// LIVE-CONTROLLED, DELIBERATELY. The "Other" input calls `onChange` on EVERY
// keystroke. That is correct here because every parent holds ONE controlled
// string and simply replaces it.
//
// DO NOT wire this component's `onChange` to a handler that APPENDS to a list.
// That is exactly the defect fixed in the multi-area settings-block editor
// (Chloe production feedback): `AreaPicker` was live-controlled the same way and
// `MultiAreaEditor` used its `onChange` to append, so typing an 8-letter custom
// area appended and PERSISTED eight partial rows, one per keystroke. If a list-
// append parent is ever needed here, add an explicit commit (Enter + a button)
// first — see `AreaPicker`'s `customCommit="explicit"` mode and
// `lib/sessions/area-input.ts`.
export function ChipSelector({
  options,
  value,
  onChange,
  otherPlaceholder = "Describe",
  name,
}: Props) {
  const isPresetValue = options.includes(value);
  const isOtherMode = !isPresetValue && value.length > 0;
  const [otherText, setOtherText] = useState(isOtherMode ? value : "");
  const [otherOpen, setOtherOpen] = useState(isOtherMode);

  // Keep local "other" text aligned with external value (e.g. copy-from-last fills a custom string).
  useEffect(() => {
    if (options.includes(value)) {
      setOtherOpen(false);
      setOtherText("");
    } else if (value.length > 0) {
      setOtherOpen(true);
      setOtherText(value);
    }
  }, [value, options]);

  return (
    <div className="flex flex-col gap-2">
      {name && <input type="hidden" name={name} value={value} />}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const selected =
            opt === "Other" ? otherOpen : value === opt && !otherOpen;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => {
                if (opt === "Other") {
                  setOtherOpen(true);
                  onChange(otherText || "");
                } else {
                  setOtherOpen(false);
                  onChange(opt);
                }
              }}
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
      </div>
      {otherOpen && (
        <input
          type="text"
          placeholder={otherPlaceholder}
          value={otherText}
          onChange={(e) => {
            setOtherText(e.target.value);
            onChange(e.target.value);
          }}
          className="mt-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      )}
    </div>
  );
}
