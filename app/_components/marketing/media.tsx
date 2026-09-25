import type { ReactNode } from "react";

// Marketing media: the product film and the synthetic-twin screen figures.
//
// WHY THESE ARE SHARED COMPONENTS AND NOT INLINE MARKUP. Both carry rules that
// are easy to get right once and easy to drop on the second call site: an
// explicit intrinsic size (so nothing reflows when the asset arrives), a
// responsive `srcSet` so a phone is not sent a desktop-sized file, and a
// caption that is a real `<figcaption>` rather than a paragraph that merely
// sits underneath.
//
// SERVER COMPONENTS, DELIBERATELY. A native `<video controls>` needs no client
// JavaScript, so the film costs the page nothing but the bytes a viewer asks
// for. Nothing here is interactive beyond what the browser already provides.

/**
 * The default intrinsic size: a full-viewport capture, 8:5.
 *
 * PER-FIGURE OVERRIDABLE, because not every figure is a whole viewport. The
 * session-record figure is a CROP — the band below the retired WATCH TODAY
 * panel — and is 30:7. Declaring 8:5 for it would reserve the wrong box and
 * reintroduce exactly the layout shift these attributes exist to prevent, so
 * the size travels with the figure that needs it.
 */
const SHOT_W = 1600;
const SHOT_H = 1000;

/**
 * What the figures actually measure on screen, not a guess at it.
 *
 * `Container size="wide"` resolves to `.mk-shell`, which is
 * `min(100% - clamp(3rem, 14vw, 15rem), 87.5rem)` — a 14vw gutter, so 86vw,
 * until the 87.5rem (1400px) cap takes over at about 1630px of viewport.
 * Measured across eight viewports rather than derived from the CSS by eye: a
 * `sizes` that UNDER-states the slot makes the browser pick a smaller file and
 * upscale it, which on a screenshot full of 12px UI text is exactly the blur
 * that makes people doubt the capture is real.
 */
const FIGURE_SIZES = "(min-width: 1630px) 1400px, 86vw";

/**
 * Three tiers, because two were not enough at the top end. A 1400px slot on a
 * 2x display asks for 2800 device pixels; stopping at 1600w would have upscaled
 * every screenshot by 1.75x on an ordinary large laptop.
 */
const WIDTHS = [800, 1600, 2400];

export function ScreenFigure({
  base,
  alt,
  caption,
  sizes = FIGURE_SIZES,
  priority = false,
  width = SHOT_W,
  height = SHOT_H,
}: {
  /** Path stem under /marketing/treatment-memory, without the width suffix. */
  base: string;
  alt: string;
  caption: ReactNode;
  sizes?: string;
  priority?: boolean;
  /** Intrinsic size of THIS figure's source. Defaults to a full 8:5 capture. */
  width?: number;
  height?: number;
}) {
  const src = `/marketing/treatment-memory/${base}`;
  return (
    <figure className="mt-10">
      <div className="overflow-hidden rounded-[14px] border border-[color:var(--color-hairline-strong)] bg-white">
        {/* PLAIN <img>, AND THE LINT WARNING IS ANSWERED RATHER THAN MUTED BY
            HABIT. `next/image` earns its keep by re-encoding and resizing at
            request time; these assets were already encoded to WebP at two
            widths ahead of the build (1.06MB of PNG became 178K), and the
            srcSet below is the one the optimizer would have produced. Routing
            them through the optimizer would add per-request image cost on the
            host and a pipeline this repository does not otherwise use — it has
            no other `next/image` call site — to arrive at the same bytes. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${src}-1600.webp`}
          srcSet={WIDTHS.map((w) => `${src}-${w}.webp ${w}w`).join(", ")}
          sizes={sizes}
          alt={alt}
          width={width}
          height={height}
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
