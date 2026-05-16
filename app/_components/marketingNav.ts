// Shared nav config for the marketing site.
// "How it works" jumps to the homepage section anchor; everything else
// is a normal route.
export type NavItem = { href: string; label: string };

export const MARKETING_NAV: ReadonlyArray<NavItem> = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/demo", label: "Demo" },
  { href: "/login", label: "Sign in" },
];

export const MARKETING_PALETTE = {
  bg: "#FAFAF7",
  ink: "#0A0A0A",
  muted: "#6B6B6B",
  rule: "#E5E2DA",
  card: "#FFFFFF",
} as const;
