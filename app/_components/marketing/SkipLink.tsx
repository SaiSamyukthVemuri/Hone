// The one definition of the "skip to main content" bypass (WCAG 2.4.1).
//
// Every public marketing surface repeats a sticky nav, so without this a
// keyboard or screen-reader user traverses the whole primary navigation again
// on every page.
//
// WHY IT IS A COMPONENT RATHER THAN A LINE IN SiteHeader, which would look
// like the tidier place. Each shell that defines the `#main-content` target
// (the ten shell pages, and PolicyLayout for /privacy and /terms) renders this
// directly, so exactly the routes that gain a target also gain the link.
// `app/book/[slug]/page.tsx` is a booking surface with its own landmark
// structure and defines no such target, so it renders no link.
//
// A PLAIN <a>, NOT next/link: the target is already on the page, so a router
// navigation is the wrong primitive and would not move focus.
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-[8px] focus:bg-ink focus:px-4 focus:py-2 focus:text-[0.9375rem] focus:font-semibold focus:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)]"
    >
      Skip to main content
    </a>
  );
}
