"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import posterImage from "@/app/_media/treatment-memory-setup-frame.png";
import { ANALYTICS_EVENTS, FILM, POSITIONING } from "@/lib/marketing/content";

// The product film player (MKT-03; Film V1 deck v2.2 §12b/§13 before it).
//
// TWO WAYS TO START, CHOSEN BY THE PAGE AND THEN BY THE VISITOR.
//
//   autoplay   The homepage. The film plays muted, inline and on a loop while
//              at least half of it is on screen, and stops as soon as less than
//              half is. It is the page's product demonstration, so it moves
//              without a click — but never against a stated preference:
//                - prefers-reduced-motion: it starts on the poster, and only a
//                  person pressing Play starts it. Switched on mid-visit, it
//                  stops the film wherever it is, and the page never starts it
//                  again;
//                - Save-Data: the same, because 3.6 MB of video the visitor did
//                  not ask for is exactly what that setting refuses;
//                - a REFUSED play() (Low Power Mode, a browser or site setting):
//                  the poster and its Play button come back, so the label never
//                  promises a film that is not running.
//   manual     Every other page (/demo). Nothing moves and nothing is fetched
//              until a person presses Play.
//
// PAUSE IS ALWAYS ONE CONTROL AWAY, AND IT TELLS THE TRUTH. Once the film has
// started there is one Pause/Play button beside the disclosure line under the
// frame — outside the picture, so it never covers the product, and always
// reachable by keyboard. Its label comes from what the media element REPORTS
// (`play`/`pause` events), not from what this component asked for, so it can
// never say "Pause" over a film that is not playing. A person's Pause is final:
// scrolling away and back never restarts a film someone stopped. And its Play
// always plays, including before the page has created the film at all (a frame
// that has not yet been half on screen).
//
// THE VIDEO IS STILL LAZY. The <video> element is created only when playback is
// actually wanted — the page's own start (on screen, preference allows) or a
// person's — so a reduced-motion or Save-Data visit, a refused autoplay and
// /demo fetch zero media bytes until someone presses Play. Before that the
// poster is an ordinary next/image with `priority`: preloaded, served as
// AVIF/WebP at the rendered width, and now inside the first screen on most
// desktops, so it is the LCP candidate the deck asked for.
//
// A PERSON'S PLAY RUNS INSIDE THEIR CLICK. Some browsers (Safari in Low Power
// Mode, for one) only honour play() inside the user's gesture. The start button
// therefore commits the <video> with flushSync and calls play() before the click
// handler returns, instead of waiting for an effect to run after it.
//
// NO AUDIO, SO NO MUTE OR CAPTIONS. The asset has one `vide` handler and no
// `soun` track (FILM.hasAudioTrack, re-derived from the MP4 boxes in
// tests/app/marketing-homepage-film.test.ts). `muted` is set anyway, which is
// also what lets a browser start it without a click. The text equivalent is
// the transcript, announced with the film.
type Start = "deciding" | "auto" | "manual";

/** The share of the frame that must be on screen for the film to play. */
const PLAY_WHEN_VISIBLE = 0.5;

type SaveDataNavigator = Navigator & { connection?: { saveData?: boolean } };

export function ProductFilm({
  autoplay = false,
  bleed = false,
  framed = false,
  className = "",
}: {
  /** Start muted, inline and looping while on screen (homepage only). */
  autoplay?: boolean;
  /** Run the frame edge to edge below the `sm` breakpoint. */
  bleed?: boolean;
  /** Draw the frame's own hairline edge and shadow, for a film whose top sits
   *  on paper. The film's picture is paper-coloured, so without an edge its
   *  top would dissolve into the page around it. */
  framed?: boolean;
  className?: string;
}) {
  // "deciding" is the server render and the first client render: the
  // preferences that choose between auto and manual exist only in the browser,
  // so no control is drawn until they are known rather than drawing a wrong one.
  const [start, setStart] = useState<Start>(autoplay ? "deciding" : "manual");
  // A start is owed to the visitor: a manual page, a stated preference, or a
  // browser that refused to play. The poster carries a Play button until then.
  const [awaitingStart, setAwaitingStart] = useState(!autoplay);
  const [mounted, setMounted] = useState(false);
  const [paused, setPaused] = useState(true);
  // First frame decoded. Until then the poster shows through the video.
  const [ready, setReady] = useState(false);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // The page may start the film by itself: autoplay, and no stated preference
  // against it. A ref, not state, because the observer reads it at the instant
  // it would start the film, and a preference switched on mid-visit has to win
  // that instant, not the next render.
  const pageMayStart = useRef(false);
  // The visitor pressed Pause. Nothing but the visitor resumes it.
  const heldByPerson = useRef(false);
  // The browser refused to start it. The page does not try again on its own.
  const refused = useRef(false);
  const transcriptId = useId();

  // Both read only refs and state setters, so their identity never changes and
  // the effects below that call them still run only when the mode does.

  // Put the poster's Play button back. If the Pause/Play control that is about
  // to unmount held focus, hand it to that button, or focus would fall back to
  // the top of the document.
  const returnToPoster = useCallback(() => {
    const hadFocus = document.activeElement === toggleRef.current;
    flushSync(() => setAwaitingStart(true));
    if (hadFocus) startRef.current?.focus();
  }, []);

  const attemptPlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const attempt = el.play();
    // An AbortError means our own pause() (or a reload) interrupted the request
    // — the film was not refused, so nothing changes. Anything else is a
    // refusal, and the visitor is owed a start again.
    attempt?.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      refused.current = true;
      returnToPoster();
    });
  }, [returnToPoster]);

  // A person's start, from the poster's Play button (or from the Play control
  // before the film exists). Commits the video and the Pause control
  // synchronously so play() runs inside the click, then hands focus to the
  // Pause control — the poster's button has just unmounted, and focus left on
  // a removed element falls back to the top of the document.
  function startByPerson() {
    heldByPerson.current = false;
    refused.current = false;
    flushSync(() => {
      setMounted(true);
      setAwaitingStart(false);
    });
    toggleRef.current?.focus();
    attemptPlay();
  }

  function toggle() {
    const el = videoRef.current;
    // No film yet: the frame has not been half on screen, so the page has not
    // created it. Play here is a person's start, exactly like the poster's.
    if (!el) {
      startByPerson();
      return;
    }
    if (el.paused) {
      heldByPerson.current = false;
      attemptPlay();
    } else {
      heldByPerson.current = true;
      el.pause();
    }
  }

  // Read the preferences once the browser can answer, and keep listening to
  // reduced motion. Switched on mid-visit, it puts the film in manual mode
  // WHATEVER the film is doing at that moment: playing, paused because it
  // scrolled away, or not created yet. Stopping only a playing film is not
  // enough — a film paused off screen would stay in auto mode and start again
  // the moment it came back into view, against the preference just set.
  //
  // So the film stops; the page gives up its own start at once (the ref) and
  // for the rest of the visit (manual mode tears the observer down); and a
  // film that was never created goes back to the poster's Play, exactly as a
  // reduced-motion visit begins. A person's Pause is untouched, and a person's
  // Play still works. Switched off again, nothing restarts: the visitor has
  // the control.
  useEffect(() => {
    if (!autoplay) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const saveData = (navigator as SaveDataNavigator).connection?.saveData === true;
    const manual = reduce.matches || saveData;
    pageMayStart.current = !manual;
    setStart(manual ? "manual" : "auto");
    setAwaitingStart(manual);

    const onChange = () => {
      if (!reduce.matches) return;
      pageMayStart.current = false;
      videoRef.current?.pause();
      setStart("manual");
      if (!videoRef.current) returnToPoster();
    };
    reduce.addEventListener("change", onChange);
    return () => reduce.removeEventListener("change", onChange);
  }, [autoplay, returnToPoster]);

  // Ordinary viewing: play while at least half the frame is on screen, stop
  // the moment less than half is, so an off-screen loop never runs down a
  // phone's battery.
  //
  // THE RATIO, NOT `isIntersecting`. The threshold decides WHEN this callback
  // runs; it does not change what `isIntersecting` means, and per the spec that
  // is any overlap at all, true at 1% visible. Gating on it restarts the film on
  // the way OUT (the callback that fires as the frame drops below half) and
  // starts a frame that is only a strip on screen at load. Chromium happens to
  // report it differently (false until the ratio reaches the lowest threshold,
  // measured in Chromium 148), so the bug cannot be seen in Chrome alone; the
  // browser spec runs these cases under both meanings.
  useEffect(() => {
    if (start !== "auto") return;
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.intersectionRatio >= PLAY_WHEN_VISIBLE) {
          if (!pageMayStart.current || heldByPerson.current || refused.current) return;
          if (!videoRef.current) flushSync(() => setMounted(true));
          attemptPlay();
        } else if (videoRef.current && !videoRef.current.paused) {
          videoRef.current.pause();
        }
      },
      { threshold: PLAY_WHEN_VISIBLE },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [start, attemptPlay]);

  const showToggle = start !== "deciding" && !awaitingStart;

  return (
    <figure
      className={`m-0 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 ${className}`}
    >
      <div
        ref={frameRef}
        className={`relative col-span-2 overflow-hidden bg-band sm:rounded-[var(--mk-radius-frame)] ${
          bleed ? "mk-bleed" : ""
        } ${framed ? "ring-1 ring-[color:var(--color-hairline-strong)] sm:shadow-[var(--mk-shadow-frame)]" : ""}`}
        style={{ aspectRatio: `${FILM.width} / ${FILM.height}` }}
      >
        {/* alt="" ON PURPOSE. The poster is not decorative, but it is already
            described: the film and its start button carry the accessible name
            and the transcript below carries its content. The image is the
            visual layer of a film that names itself.

            `sizes` describes the shell: 86vw until the shell reaches its 1400px
            ceiling at ~1640px of viewport (100vw when it bleeds on a phone).
            1400 < the film's native 1920, so it never upscales. */}
        <Image
          src={posterImage}
          alt=""
          priority
          sizes={
            bleed
              ? "(min-width: 1640px) 1400px, (min-width: 640px) 86vw, 100vw"
              : "(min-width: 1640px) 1400px, 86vw"
          }
          className="absolute inset-0 h-full w-full object-cover"
        />
        {mounted ? (
          <video
            ref={videoRef}
            className={`absolute inset-0 h-full w-full object-cover ${ready ? "" : "opacity-0"}`}
            src={FILM.src}
            muted
            loop
            playsInline
            preload="none"
            aria-label={FILM.accessibleName}
            aria-describedby={transcriptId}
            width={FILM.width}
            height={FILM.height}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
            onLoadedData={() => setReady(true)}
          />
        ) : null}
        {awaitingStart ? (
          <button
            ref={startRef}
            type="button"
            onClick={startByPerson}
            data-event={ANALYTICS_EVENTS.filmPlay}
            aria-describedby={transcriptId}
            className="absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[color:var(--color-paper)]"
          >
            {/* The start affordance: a ring and a triangle drawn with borders,
                so it carries no asset and cannot animate. */}
            <span
              aria-hidden="true"
              className="flex h-16 w-16 items-center justify-center rounded-full border border-white/70 bg-[color:var(--color-band)]/60 sm:h-[4.5rem] sm:w-[4.5rem]"
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
        ) : null}
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

      {/* The Pause/Play control sits on the disclosure line, not on the picture.
          The row keeps the control's height even before it exists, so the
          control appearing never shifts the page. */}
      <div className="col-start-2 row-start-2 flex min-h-11 items-center pt-3">
        {showToggle ? (
          <button
            ref={toggleRef}
            type="button"
            onClick={toggle}
            data-event={paused ? ANALYTICS_EVENTS.filmPlay : undefined}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-white/25 px-3 text-[0.875rem] font-medium text-paper transition-colors duration-[var(--hone-duration-ui)] hover:border-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-paper)] sm:px-4"
          >
            <span aria-hidden="true" className="flex h-3.5 w-3.5 items-center justify-center">
              {paused ? (
                <span
                  className="ml-0.5 block h-0 w-0"
                  style={{
                    borderTop: "0.4375rem solid transparent",
                    borderBottom: "0.4375rem solid transparent",
                    borderLeft: "0.6875rem solid currentColor",
                  }}
                />
              ) : (
                <span className="flex h-3.5 gap-[3px]">
                  <span className="block w-[4px] rounded-[1px] bg-current" />
                  <span className="block w-[4px] rounded-[1px] bg-current" />
                </span>
              )}
            </span>
            <span className="max-sm:sr-only">{paused ? "Play" : "Pause"}</span>
            <span className="sr-only"> the product film</span>
          </button>
        ) : null}
      </div>

      {/* The disclosure, always rendered, so a visitor who never sees the film
          move still reads it. Verbatim: the film burns the same words into its
          own corner, and so does the poster frame. */}
      <figcaption className="col-start-1 row-start-2 pt-3 text-[0.8125rem] leading-[1.5] text-[color:var(--color-onband-muted)]">
        {POSITIONING.demoDataLabel}
      </figcaption>
    </figure>
  );
}
