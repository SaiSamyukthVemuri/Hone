"use client";

import { useEffect, useState } from "react";
import { AREAS } from "@/lib/constants";

type Props = {
  name: string;
  value: string;
  onChange: (v: string) => void;
};

// Single-select chip selector backed by a hidden input for form submission.
export function AreaChipSelector({ name, value, onChange }: Props) {
  const [custom, setCustom] = useState(
    AREAS.includes(value) ? "" : value || "",
  );

  useEffect(() => {
    if (AREAS.includes(value)) {
      setCustom("");
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={value} />
      <div className="flex flex-wrap gap-2">
        {AREAS.map((a) => {
          const selected = value === a;
          return (
            <button
              key={a}
              type="button"
              onClick={() => onChange(a)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
              }`}
            >
              {a}
            </button>
          );
        })}
      </div>
      {value === "Other" && (
        <input
          type="text"
          placeholder="Describe area"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            onChange(e.target.value || "Other");
          }}
          className="mt-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      )}
    </div>
  );
}
