// Shared nav config for the marketing site. Tight on purpose: a busy
// solo practitioner reading the homepage needs Pricing, Walkthrough,
// and a way to sign in. Privacy and Terms live in the footer.
export type NavItem = { href: string; label: string };

export const MARKETING_NAV: ReadonlyArray<NavItem> = [
  { href: "/pricing", label: "Pricing" },
  { href: "/demo", label: "Walkthrough" },
  { href: "/login", label: "Sign in" },
];

export const MARKETING_PALETTE = {
  bg: "#FAFAF7",
  ink: "#0A0A0A",
  muted: "#6B6B6B",
  rule: "#E5E2DA",
  card: "#FFFFFF",
} as const;
