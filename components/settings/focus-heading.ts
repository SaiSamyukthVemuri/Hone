// Moving keyboard focus to a Settings view's heading after navigation (R2).
//
// The heading is rendered by the NEW route, which can commit after the pathname
// changes (and after the mobile drawer, which held focus, is hidden). Focus that
// was inside the drawer then falls to <body>. So the shell tries at once and
// again as the view mounts, but only while focus is still nowhere: it never
// pulls focus out of a field the person has already moved to.

export const SETTINGS_HEADING_SELECTOR = "[data-settings-heading]";

/** Focus is "nowhere" when nothing, the body or the root element holds it. */
export function focusIsNowhere(
  active: Element | null,
  body: Element | null,
  root: Element | null,
): boolean {
  return active === null || active === body || active === root;
}

type HeadingRoot = {
  querySelector: (selector: string) => HTMLElement | null;
};

/**
 * Focus the heading under `root` when it exists and `active` is not already it.
 * Returns true once the heading holds focus (nothing more to do).
 */
export function focusSettingsHeading(
  root: HeadingRoot | null,
  active: Element | null,
): boolean {
  const heading = root?.querySelector(SETTINGS_HEADING_SELECTOR) ?? null;
  if (!heading) return false;
  if (active === heading) return true;
  heading.focus({ preventScroll: true });
  return true;
}

/**
 * Where focus goes when the person chooses "Stay" on the unsaved-changes dialog.
 * Only a drawer that was open when the dialog appeared is closed, and focus then
 * returns to the Menu button (the rail link that held it is hidden). Any other
 * held click came from page content (or the desktop rail): focus returns to that
 * anchor and the drawer is left alone.
 */
export function stayFocusTarget(args: {
  drawerWasOpen: boolean;
  isDesktop: boolean;
}): "menu" | "anchor" {
  return args.drawerWasOpen && !args.isDesktop ? "menu" : "anchor";
}
