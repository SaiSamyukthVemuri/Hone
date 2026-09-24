import type { ReactNode } from "react";

// Marketing media: the product film and the synthetic-twin screen figures.
//
// WHY THESE ARE SHARED COMPONENTS AND NOT INLINE MARKUP. Both carry rules that
// are easy to get right once and easy to drop on the second call site: an
// explicit intrinsic size (so nothing reflows when the asset arrives), a
// responsive `srcSet` so a phone never downloads the 1600px variant, and a
// caption that is a real `<figcaption>` rather than a paragraph that merely
// sits underneath.
//
// SERVER COMPONENTS, DELIBERATELY. A native `<video controls>` needs no client
// JavaScript, so the film costs the page nothing but the bytes a viewer asks
// for. Nothing here is interactive beyond what the browser already provides.

/** Both screen captures are 16:10; both film posters are 16:9. */
const SHOT_W = 1600;
const SHOT_H = 1000;

export function ScreenFigure({
  base,
  alt,
  caption,
  sizes = "(min-width: 1024px) 60rem, 100vw",
  priority = false,
}: {
  /** Path stem under /marketing/treatment-memory, without the width suffix. */
  base: string;
  alt: string;
  caption: ReactNode;
  sizes?: string;
  priority?: boolean;
}) {
  const src = `/marketing/treatment-memory/${base}`;
  return (
    <figure className="mt-10">
      <div className="overflow-hidden rounded-[14px] border border-[color:var(--color-hairline-strong)] bg-white">
        <img
          src={`${src}-1600.webp`}
          srcSet={`${src}-800.webp 800w, ${src}-1600.webp 1600w`}
          sizes={sizes}
          alt={alt}
          width={SHOT_W}
          height={SHOT_H}
          // WIDTH AND HEIGHT ARE NOT DECORATION. Without them the browser has
          // no aspect ratio until the bytes land and the text below jumps when
          // they do, which is the layout shift this page is judged on.
          className="block h-auto w-full"
          loading={priority ? "eager" : "lazy"}
          decoding="async"
        />
      </div>
      <figcaption className="mt-3 text-[0.875rem] leading-[1.55] text-muted">
        {caption}
      </figcaption>
    </figure>
  );
}

export function ProductFilm({
  src,
  poster,
  label,
  caption,
}: {
  src: string;
  poster: string;
  /** The film's accessible name. */
  label: string;
  caption: ReactNode;
}) {
  return (
    <figure>
      <div className="overflow-hidden rounded-[16px] border border-[color:var(--color-hairline-strong)] bg-band">
        <video
          // SILENT FILM, PROVED RATHER THAN ASSUMED: the file carries a `vide`
          // handler and no `soun` track. WCAG 1.2.2 (captions) governs audio,
          // so there is no audio to caption; what a silent informational video
          // owes is a TEXT ALTERNATIVE, which is the caption below plus the
          // still figures and prose that follow — every claim the film makes
          // visually is also made in text on this page.
          controls
          // `preload="none"` keeps 3.5MB off the initial load. The poster is a
          // 30KB WebP, so the section looks finished before anything is
          // fetched, and the film costs bytes only once someone asks for it.
          preload="none"
          poster={poster}
          playsInline
          aria-label={label}
          width={1920}
          height={1080}
          className="block h-auto w-full"
        >
          <source src={src} type="video/mp4" />
          Your browser cannot play this video. The same walkthrough is described
          in the sections below.
        </video>
      </div>
      <figcaption className="mt-3 text-[0.875rem] leading-[1.55] text-muted">
        {caption}
      </figcaption>
    </figure>
  );
}
