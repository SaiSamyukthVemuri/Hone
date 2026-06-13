// Shared nav config for the marketing site. PR #242 repositions the
// site around treatment memory, so the nav points at the homepage
// story sections (homepage-relative anchors, "/#id", so they work
// from any marketing page) plus Pricing and Sign in. The primary
// action everywhere is the Book walkthrough CTA (MARKETING_CTA),
// rendered as a button beside the nav, not as a plain link.
export type NavItem = { href: string; label: string };

export const MARKETING_NAV: ReadonlyArray<NavItem> = [
  { href: "/#product", label: "Product" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#records", label: "Records" },
  { href: "/#agentic", label: "Agentic support" },
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
} as const;
