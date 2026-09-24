"use client";

import { useCallback, useState } from "react";
import { MARKETING_PALETTE as PALETTE } from "../marketingNav";

/**
 * The product film, click-to-play.
 *
 * DELIBERATELY NOT AUTOPLAYING, and `preload="none"`. The file is 3.6 MB and the
 * page it sits on is a lead-capture form — downloading it for a visitor who
 * never presses play spends their data to show them nothing. The poster is the
 * film's own setup frame at the same 1920x1080 box, so it holds the layout and
 * the swap to video costs no shift.
 *
 * NO CAPTIONS TRACK, and that is a truth decision rather than an omission. The
 * approved cut carries exactly one `trak` and no audio stream at all, so there
 * is nothing to caption; shipping an empty `<track kind="captions">` would
 * advertise an accessibility affordance that does not exist. What a
 * non-watching visitor needs is in the text beside it, which is why the list of
 * what the walkthrough covers is on the page and not only in the film.
 *
 * `muted` and `playsInline` are still set: a silent film must not be the reason
 * iOS refuses inline playback, and muted is the honest description of a file
 * with no audio.
 *
 * FOCUS FOLLOWS THE SWAP. Pressing play unmounts the button that holds focus,
 * and a focused element that disappears drops focus to `<body>` — so a keyboard
 * or screen-reader visitor who just asked for the film is returned to the top of
 * the document and has to tab the whole page again to reach the controls they
 * asked for. The `<video>` only ever mounts as the result of that press, so its
 * mount is exactly the right moment to hand focus over.
 */
export function ProductFilm({
  poster,
  src,
  label,
}: {
  poster: string;
  src: string;
  label: string;
}) {
  const [playing, setPlaying] = useState(false);

  // A callback ref rather than an effect: it fires on the node itself, so there
  // is no frame in which focus sits nowhere. `preventScroll` because the poster
  // and the video fill the same box — the element is already where the visitor
  // is looking, and scrolling it "into view" would only move the page under
  // them. No `tabIndex`: `controls` already puts a video in the tab order, and
  // pinning it to -1 would take it back out.
  const takeFocusOnMount = useCallback((node: HTMLVideoElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);

  return (
    <figure className="m-0">
      <div
        className="relative overflow-hidden rounded-[14px] border"
        style={{ borderColor: PALETTE.rule, backgroundColor: PALETTE.bg }}
      >
        {playing ? (
          <video
            ref={takeFocusOnMount}
            className="block aspect-video w-full"
            src={src}
            poster={poster}
            controls
            autoPlay
            muted
            playsInline
            preload="none"
            aria-label={label}
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group relative block w-full cursor-pointer border-0 p-0"
            aria-label={`Play: ${label}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={poster}
              alt=""
              width={1920}
              height={1080}
              loading="lazy"
              decoding="async"
              className="block aspect-video w-full object-cover"
            />
            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center"
            >
              <span
                className="flex h-16 w-16 items-center justify-center rounded-full shadow-sm transition-transform group-hover:scale-105"
                style={{ backgroundColor: PALETTE.card }}
              >
                <svg width="20" height="22" viewBox="0 0 20 22" fill="none" aria-hidden="true">
                  <path d="M19 11 0 22V0l19 11Z" fill={PALETTE.ink} />
                </svg>
              </span>
            </span>
          </button>
        )}
      </div>
    </figure>
  );
}
