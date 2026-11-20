// The owner's Business menu: the two destinations behind the one word, shared by the desktop menu and the phone sheet so they cannot drift.
//
// PRESENTATION ONLY. Whether to show the menu is decided by the caller from the role the shell already resolved. Hiding it protects
// nothing: /dashboard/capacity and /financials/statement each keep their own server-side owner check, which is the authority.
// There is deliberately no /business hub.
export const BUSINESS_MENU_LABEL = "Business";

export const BUSINESS_MENU_ITEMS = [
  { href: "/dashboard/capacity", label: "Capacity", testId: "nav-business-capacity" },
  { href: "/financials/statement", label: "Statements", testId: "nav-business-statement" },
] as const;

/** Is `pathname` inside either Business destination (so the menu reads as the current section)? */
export function isBusinessPath(pathname: string | null): boolean {
  if (!pathname) return false;
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return BUSINESS_MENU_ITEMS.some((i) => p === i.href || p.startsWith(`${i.href}/`));
}
