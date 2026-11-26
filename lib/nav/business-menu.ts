// The owner's Business menu: the destinations behind the one word, shared by the desktop menu and the phone sheet so they cannot drift.
//
// PRESENTATION ONLY. Whether to show the menu is decided by the caller from the role the shell already resolved. Hiding it protects
// nothing: Overview, Capacity, Statements and Analytics each keep their own server-side owner check, which is the authority.
// There is deliberately no /business hub page of links. "Overview" is a destination of its own (the owner's figures for a reporting period, at
// /financials/overview), asked for by the operator on 26 Nov 2026; it is not a hub, and the menu still lists the destinations.
export const BUSINESS_MENU_LABEL = "Business";

export const BUSINESS_MENU_ITEMS = [
  { href: "/financials/overview", label: "Overview", testId: "nav-business-overview" },
  { href: "/dashboard/capacity", label: "Capacity", testId: "nav-business-capacity" },
  { href: "/financials/statement", label: "Statements", testId: "nav-business-statement" },
  { href: "/financials/analytics", label: "Analytics", testId: "nav-business-analytics" },
] as const;

/** Is `pathname` inside a Business destination (so the menu reads as the current section)? */
export function isBusinessPath(pathname: string | null): boolean {
  if (!pathname) return false;
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return BUSINESS_MENU_ITEMS.some((i) => p === i.href || p.startsWith(`${i.href}/`));
}
