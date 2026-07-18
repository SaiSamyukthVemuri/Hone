// TS mirror of the marketing palette + font stacks. The canonical source for
// CSS is the `@theme` block in app/globals.css; this mirror exists for the
// places that need a JavaScript value — inline SVG fills in the product visuals,
// the Open Graph image, and any computed style. Keep the two in sync.
export const MK = {
  paper: "#F7F4EE",
  warm: "#EEE9E0",
  ink: "#17211F",
  muted: "#556661",
  mineral: "#1E6B62",
  mineralDeep: "#10453F",
  wash: "#D8EAE6",
  band: "#10231F",
  onbandMuted: "#9FB3AD",
  hairline: "rgba(23,33,31,0.10)",
  hairlineStrong: "rgba(23,33,31,0.16)",
} as const;

export const MK_FONT_DISPLAY =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, ui-serif, serif';
export const MK_FONT_TEXT =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
