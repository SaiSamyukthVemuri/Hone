"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import posterImage from "@/app/_media/treatment-memory-setup-frame.png";
import { ANALYTICS_EVENTS, FILM, POSITIONING } from "@/lib/marketing/content";

// Film V1 player (deck v2.2 §12b/§13). A FACADE, not a <video> that happens to
// be paused.
//
// WHY A FACADE. The requirement is "poster is the LCP candidate, video lazy".
// Those pull in opposite directions on one element: a <video poster="…"> loads
// the poster as an unoptimised PNG the preloader cannot see, and `preload="none"`
// still leaves the browser holding a media element it must lay out and decode
// into. So the two jobs are split:
//
//   BEFORE activation  an ordinary next/image, `priority`, so the poster is in
//                      the preload scanner, served as AVIF/WebP at the width
//                      actually rendered, and is a first-class LCP candidate.
//                      The <video> does not exist. Zero media bytes are
//                      fetched — not "deferred", not fetched.
//   AFTER activation   the <video> mounts and plays, because a person asked.
//
// NO AUTOPLAY, STRUCTURALLY. There is no `autoPlay` attribute anywhere in this
// file, and no `play()` in a mount effect that could fire on load. Playback is
// reachable only through `activate()`, which only a click or an Enter/Space on
// the button can call. A source guard asserts the absence rather than trusting
// this comment (tests/app/marketing-homepage-film.test.ts).
//
// WHY THERE IS NO MUTE BUTTON. The asset has no audio track at all — one `vide`
// handler, no `soun` (FILM.hasAudioTrack, parsed from the MP4 boxes). There is
// nothing to unmute and no dialogue to caption. `muted` is still set so the
// element can never surprise anyone if the file is ever swapped, and the
// accessible name says "silent" so a screen-reader user is not left waiting for
// narration that is not coming.
//
// REDUCED MOTION needs no branch here, and that is the point: the film never
// moves unless a person starts it. `prefers-reduced-motion` asks for no
// UNREQUESTED motion; suppressing a video someone just pressed play on would be
// ignoring them, not accommodating them. The facade itself has no transition,
// no pulse and no animated play glyph, so nothing moves before the click either.
export function ProductFilm({ className = "" }: { className?: string }) {
  const [activated, setActivated] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptId = useId();

  // Runs only after `activated` flips, which only activate() can do. The guard
  // keeps it from being a mount effect if this component is ever remounted in
  // an activated state.
  useEffect(() => {
    if (!activated) return;
    // A rejected promise here is ordinary (a policy or a user gesture the
    // browser did not accept); the controls stay, so the film is still
    // reachable. It must not become an unhandled rejection.
    void videoRef.current?.play().catch(() => {});
  }, [activated]);

  return (
    <figure className={`m-0 ${className}`}>
      <div
        className="relative overflow-hidden bg-band"
        style={{ aspectRatio: `${FILM.width} / ${FILM.height}` }}
      >
        {activated ? (
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full"
            src={FILM.src}
            poster={posterImage.src}
            controls
            muted
            playsInline
            preload="none"
            aria-label={FILM.accessibleName}
            aria-describedby={transcriptId}
            width={FILM.width}
            height={FILM.height}
          />
        ) : (
          <>
            {/* alt="" ON PURPOSE. The poster is not decorative, but it is
                already described twice over: the button stacked on top of it
                carries the film's accessible name, and the transcript below
                carries its content. A third description here would make a
                screen reader announce the same frame three times before
                offering the control. The image is the visual layer of a
                control that names itself.

                `sizes` DESCRIBES THE SHELL, NOT A GUESS. .mk-shell is
                min(100% - clamp(3rem,14vw,15rem), 87.5rem): the gutter is 14vw
                until it caps at 15rem, so the film is 86vw until the shell
                reaches its 1400px ceiling at ~1640px of viewport. Saying
                "1200px" here would hand the browser a candidate narrower than
                the box it actually paints into, and the LCP image would land
                softer than the file it came from. 1400 < the film's native
                1920, so it never upscales either. */}
            <Image
              src={posterImage}
              alt=""
              priority
              sizes="(min-width: 1640px) 1400px, 86vw"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <button
              type="button"
              onClick={() => setActivated(true)}
              data-event={ANALYTICS_EVENTS.filmPlay}
              aria-describedby={transcriptId}
              className="absolute inset-0 flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--color-paper)]"
            >
              {/* The play affordance. A ring and a triangle, drawn with a
                  border rather than an icon font or an SVG sprite, so it
                  carries no asset and cannot animate. */}
              <span
                aria-hidden="true"
                className="flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full border border-white/70 bg-[color:var(--color-band)]/55"
              >
                <span
                  className="ml-[0.3rem] block h-0 w-0"
                  style={{
                    borderTop: "0.6rem solid transparent",
                    borderBottom: "0.6rem solid transparent",
                    borderLeft: "1rem solid var(--color-paper)",
                  }}
                />
              </span>
              <span className="sr-only">{`Play: ${FILM.accessibleName}`}</span>
            </button>
            {/* The demo-data label sits ON the poster as well as under the
                player, because the poster is what a visitor who never presses
                play actually sees. Verbatim, and the film carries the same
                words in its own top-right corner. */}
            {/* pointer-events-none MATTERS HERE. This span paints after the
                button and overlaps it, so without it the bottom-left corner of
                a full-bleed play target is silently dead to clicks — the one
                part of the poster a visitor is most likely to be reading when
                they decide to press play. */}
            <span className="pointer-events-none absolute bottom-0 left-0 bg-[color:var(--color-band)]/80 px-3 py-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-[color:var(--color-onband-muted)]">
              {POSITIONING.demoDataLabel}
            </span>
          </>
        )}
      </div>

      {/* The text equivalent. Visually hidden, never display:none, so it stays
          in the accessibility tree and is what aria-describedby points at. */}
      <div id={transcriptId} className="sr-only">
        <p>{`Transcript of the ${FILM.durationSeconds}-second silent film, in order:`}</p>
        <ol>
          {FILM.transcript.map((card) => (
            <li key={card}>{card}</li>
          ))}
        </ol>
      </div>

      <figcaption className="mt-3 text-[0.8125rem] text-[color:var(--color-onband-muted)]">
        {POSITIONING.demoDataLabel}
      </figcaption>
    </figure>
  );
}
