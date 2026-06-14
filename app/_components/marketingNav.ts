// Shared nav config for the marketing site. PR #244 keeps the nav
// short and human and drops the "Agentic support" item, so the public
// pitch leads with treatment memory and records rather than agentic
// language. The nav points at the homepage story sections (homepage-
// relative anchors, "/#id", so they work from any marketing page)
// plus Pricing and Sign in. The primary action everywhere is the Book
// walkthrough CTA (MARKETING_CTA), rendered as a button beside the
// nav, not as a plain link.
export type NavItem = { href: string; label: string };

export const MARKETING_NAV: ReadonlyArray<NavItem> = [
  { href: "/#product", label: "Product" },
  { href: "/#records", label: "Records" },
  { href: "/pricing", label: "Pricing" },
  { href: "/login", label: "Sign in" },
];

export const MARKETING_CTA: NavItem = {
  href: "/demo",
  label: "Book walkthrough",
};

export const MARKETING_PALETTE = {
  bg: "#FAFAF7",
  ink: "#0A0A0A",
  muted: "#6B6B6B",
  rule: "#E5E2DA",
  card: "#FFFFFF",
  // PR #242: soft accent tokens for the product mockups, tuned to the
  // warm marketing palette but echoing the app's surfaces (the blue
  // treatment-memory band, amber record reminders, green done state).
  blueBg: "#EEF3FB",
  blueRule: "#D6E2F2",
  blueInk: "#28456B",
  amberBg: "#FBF3E2",
  amberRule: "#EFE0BE",
  amberInk: "#7A5A18",
  greenBg: "#E4EFE3",
  greenRule: "#CFE3CE",
  greenInk: "#2B5A2B",
  chip: "#F4F2EC",
  // PR #246 visual system: a faint warm panel tone for alternating
  // section bands, and the app-window chrome bar tone for the hero
  // preview frame. Both stay inside the calm, clinical warm palette.
  band: "#F3F1E9",
  chrome: "#F0EEE6",
} as const;
