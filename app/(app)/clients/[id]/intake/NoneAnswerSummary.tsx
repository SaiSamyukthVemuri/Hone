"use client";

import { useState } from "react";

// Render helper for a multi_select intake answer where the client
// selected only the exclusive "None" sentinel. Shows the None
// option's label in bold, plus a second line listing what was
// negated. Truncates to the first 5 options with a "+N more"
// toggle so the practitioner can see the full list on demand
// without flooding the review grid when one isn't needed (e.g.
// medical_conditions has 14 entries).
//
// Pure UI; no server interaction, no state mutation. Old intakes
// render identically because the options list is read from the
// current INTAKE_STEPS at render time (the stored response is
// just the NONE sentinel value).
export function NoneAnswerSummary({
  noneLabel,
  options,
}: {
  noneLabel: string;
  options: ReadonlyArray<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = options.length;
  const shouldTruncate = total > 5 && !expanded;
  const visible = shouldTruncate ? options.slice(0, 5) : options;
  const hiddenCount = total - visible.length;

  return (
    <span>
      <span className="font-medium">{noneLabel}</span>
      {total > 0 && (
        <span className="block text-xs text-neutral-500">
          out of: {visible.join(", ")}
          {hiddenCount > 0 && (
            <>
              {", "}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-700 dark:decoration-neutral-700 dark:hover:decoration-neutral-300"
              >
                +{hiddenCount} more
              </button>
            </>
          )}
          {expanded && total > 5 && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-700 dark:decoration-neutral-700 dark:hover:decoration-neutral-300"
              >
                Show less
              </button>
            </>
          )}
        </span>
      )}
    </span>
  );
}
