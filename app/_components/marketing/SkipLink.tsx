// The one definition of the "skip to main content" bypass (WCAG 2.4.1).
//
// Every public marketing surface repeats a sticky nav, so without this a
// keyboard or screen-reader user traverses the whole primary navigation again
// on every page.
//
// WHY IT IS A COMPONENT RATHER THAN A LINE IN SiteHeader.
// The marketing site has TWO shells. `SiteHeader` serves the ten shell pages;
// `MarketingHeader` serves /privacy and /terms through PolicyLayout. Putting
// the link in SiteHeader alone would give the policy routes a `#main-content`
// target with nothing pointing at it — a bypass target that cannot be reached.
//
// IT IS DELIBERATELY NOT ADDED TO MarketingHeader, even though that would look
// like the tidier place. `app/book/[slug]/page.tsx` renders MarketingHeader
// too, and that route is a booking surface with its own landmark structure.
// Adding the link there would point at a target that route does not define.
// So each shell renders this directly, and exactly the routes that gain a
// target also gain the link.
//
// A PLAIN <a>, NOT next/link: the target is already on the page, so a router
// navigation is the wrong primitive and would not move focus.
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
