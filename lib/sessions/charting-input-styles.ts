// Shared charting input styling. Extracted so the block charting form, the
// probe picker, and the whole-session copy editor all render identical inputs +
// chips (no drifting look between the two forms).

export const READING_INPUT_CLS =
  "rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";

export const CHIP_BASE =
  "rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50";
export const CHIP_OFF =
  "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300";
export const CHIP_ON =
  "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900";
