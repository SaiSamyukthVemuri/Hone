// The one definition of the "skip to main content" bypass (WCAG 2.4.1).
//
// Every public marketing surface repeats a sticky nav, so without this a
// keyboard or screen-reader user traverses it again on every navigation.
//
// WHY IT IS A COMPONENT AND NOT A LINE IN SiteHeader
// -------------------------------------------------
// The marketing site has TWO headers. `SiteHeader` serves the ten shell pages;
// `MarketingHeader` serves /privacy and /terms (via PolicyLayout) and also the
// public booking page. The first version put the link in SiteHeader alone, so
// the policy routes gained a `#main-content` target with nothing pointing at
// it — a bypass target that could not be reached, which review caught.
//
// The fix is shared here rather than pushed into MarketingHeader, because that
// component is also rendered by `app/book/[slug]`, which is a booking surface
// with its own landmark and its own active workstream. Adding a link there
// would either point at a target that route does not define, or require
// editing a file outside this change's scope. PolicyLayout renders this
// directly instead, so exactly the routes that gained a target also gain the
// link.
//
// A plain <a>, deliberately, not next/link: the target is already on the page,
// so a router navigation is the wrong primitive and would not move focus.
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-[8px] focus:bg-ink focus:px-4 focus:py-2 focus:text-[0.9375rem] focus:font-semibold focus:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-mineral)] focus-visible:ring-offset-2"
    >
      Skip to main content
    </a>
  );
}
