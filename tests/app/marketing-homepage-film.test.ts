import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { FILM, ANALYTICS_EVENTS } from "@/lib/marketing/content";

// Film V1 contract (copy deck v2.2 §12b/§13).
//
// Two kinds of claim are pinned here, and they are pinned differently.
//
//   THE PLAYER'S CONTRACT is a claim about source: autoplay only where a page
//   opts in and never against reduced motion or Save-Data, a truthful
//   Pause/Play control, no media fetched before playback is wanted, an
//   accessible name and a real text equivalent. Those are read out of the
//   component here and proved as behaviour in e2e/marketing-homepage-film.spec.ts.
//
//   THE ASSET'S PROPERTIES are a claim about a FILE. "25 seconds", "1920x1080"
//   and above all "there is no audio track" were copied into a TypeScript
//   constant from a document, and a document cannot be re-read when someone
//   swaps the mp4. So this file re-derives them from the bytes on every run.
//   `hasAudioTrack: false` is the premise for shipping a player with no unmute
//   control and no captions; if a recut ever arrives with sound, this goes red
//   the same day rather than on the day a Deaf visitor finds out.

const ROOT = process.cwd();

// Strip comments before any ABSENCE scan. Half the assertions below are of the
// form "this attribute appears nowhere", and the component's own comments
// explain at length why it appears nowhere — naming it each time. Scanning raw
// source would make a file fail for documenting itself. Line comments first: a
// line comment may contain the two characters that open a block comment, and
// stripping blocks first treats that as a real opener and eats live code up to
// the next close.
function codeOnly(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const PLAYER_RAW = readFileSync(
  join(ROOT, "app/_components/marketing/ProductFilm.tsx"),
  "utf8",
);
const PLAYER = codeOnly(PLAYER_RAW);
const PAGE = readFileSync(join(ROOT, "app/page.tsx"), "utf8");

describe("the comment stripper itself", () => {
  it("drops prose and keeps code", () => {
    const src = ["// there is no autoPlay here", "const autoPlay = 1;"].join("\n");
    expect(codeOnly(src)).toContain("const autoPlay");
    expect(codeOnly(src).match(/autoPlay/g) ?? []).toHaveLength(1);
  });

  it("is not blinded by a line comment containing a block opener", () => {
    const src = ["// see next/* for the rest", "const kept = 1;", "/* real */"].join("\n");
    expect(codeOnly(src)).toContain("const kept");
  });
});

// ---------------------------------------------------------------------------
// A minimal ISO-BMFF walker. Enough to answer: how long, how big, which tracks.
// ---------------------------------------------------------------------------
type Box = { type: string; start: number; end: number };

function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    let header = 8;
    if (size === 1) {
      // 64-bit `largesize` follows the type.
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header) break;
    out.push({ type, start: i + header, end: i + size });
    i += size;
  }
  return out;
}

function descend(buf: Buffer, path: string[], start: number, end: number): Box | null {
  let scope = { start, end };
  let found: Box | null = null;
  for (const want of path) {
    found = children(buf, scope.start, scope.end).find((b) => b.type === want) ?? null;
    if (!found) return null;
    scope = { start: found.start, end: found.end };
  }
  return found;
}

/** Every track's handler type ("vide", "soun", "sbtl", …), in track order. */
function trackHandlers(buf: Buffer, moov: Box): string[] {
  return children(buf, moov.start, moov.end)
    .filter((b) => b.type === "trak")
    .map((trak) => {
      const hdlr = descend(buf, ["mdia", "hdlr"], trak.start, trak.end);
      // hdlr: version+flags(4), pre_defined(4), handler_type(4).
      return hdlr ? buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) : "????";
    });
}

const FILM_PATH = join(ROOT, "public", FILM.src.replace(/^\//, ""));

describe("the asset on disk is the asset the constant describes", () => {
  it("FILM.src resolves to a real file under public/", () => {
    expect(() => statSync(FILM_PATH), `${FILM.src} is not on disk`).not.toThrow();
    expect(statSync(FILM_PATH).isFile()).toBe(true);
  });

  it("its duration, dimensions and track list match FILM", () => {
    const buf = readFileSync(FILM_PATH);
    const moov = descend(buf, ["moov"], 0, buf.length);
    expect(moov, "no moov box — not a readable MP4").not.toBeNull();

    const mvhd = descend(buf, ["mvhd"], moov!.start, moov!.end);
    expect(mvhd, "no mvhd box").not.toBeNull();
    const version = buf.readUInt8(mvhd!.start);
    const timescale =
      version === 1 ? buf.readUInt32BE(mvhd!.start + 20) : buf.readUInt32BE(mvhd!.start + 12);
    const duration =
      version === 1
        ? Number(buf.readBigUInt64BE(mvhd!.start + 24))
        : buf.readUInt32BE(mvhd!.start + 16);
    // Rounded: a container duration can carry a sub-frame tail.
    expect(Math.round(duration / timescale)).toBe(FILM.durationSeconds);

    const trak = children(buf, moov!.start, moov!.end).find((b) => b.type === "trak");
    const tkhd = descend(buf, ["tkhd"], trak!.start, trak!.end);
    // width/height are the final 8 bytes of tkhd, as 16.16 fixed point, in both
    // box versions — read from the end rather than counting forward past a
    // version-dependent run of fields.
    const w = buf.readUInt32BE(tkhd!.end - 8) >> 16;
    const h = buf.readUInt32BE(tkhd!.end - 4) >> 16;
    expect({ w, h }).toEqual({ w: FILM.width, h: FILM.height });
  });

  it("carries no audio track — the premise for a silent player", () => {
    const buf = readFileSync(FILM_PATH);
    const moov = descend(buf, ["moov"], 0, buf.length)!;
    const handlers = trackHandlers(buf, moov);

    expect(handlers, "expected at least one media track").not.toHaveLength(0);
    expect(handlers).toContain("vide");
    expect(
      handlers.includes("soun"),
      "the film gained an audio track: the player now needs captions and an unmute control before it ships",
    ).toBe(FILM.hasAudioTrack);
    expect(FILM.hasAudioTrack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE PLAYBACK CONTRACT (MKT-03). Source tripwires, read from the
// comment-stripped component. The behaviour itself — frames decoding, the loop
// wrapping, Pause stopping the clock, the reduced-motion poster, a refused
// autoplay — is proved in a real browser by e2e/marketing-homepage-film.spec.ts.
// What is pinned here is the shape that makes those outcomes structural.
//
// This REPLACES the MKT-02B contract, which pinned the opposite: no autoplay
// at all, one play() reachable only from a click, native controls after it.
// The product decision changed (the homepage film now plays muted while in
// view), so the old pins were the obsolete half; the asset, poster, transcript,
// analytics and middleware pins around them still hold and are unchanged.
// ---------------------------------------------------------------------------
const filmCall = (src: string): string => src.match(/<ProductFilm\b[^>]*\/>/)?.[0] ?? "";
const HOMEPAGE_CALL = filmCall(PAGE);
const DEMO_CALL = filmCall(readFileSync(join(ROOT, "app/demo/page.tsx"), "utf8"));

/** The span of the stripped component between two markers. */
function between(from: string, to: string): string {
  const start = PLAYER.indexOf(from);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  const end = PLAYER.indexOf(to, start);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return PLAYER.slice(start, end);
}

describe("autoplay is the homepage's choice, and never against the visitor's", () => {
  it("is opt-in per page: off by default, on only where a page says so", () => {
    expect(PLAYER).toMatch(/autoplay = false/);
    expect(HOMEPAGE_CALL, "homepage film call site not found").not.toBe("");
    expect(HOMEPAGE_CALL).toMatch(/\bautoplay\b/);
    // /demo is a lead form. Its visitors came to fill it in, not to spend
    // 3.6 MB on a film they did not ask for, so it stays manual.
    expect(DEMO_CALL, "/demo film call site not found").not.toBe("");
    expect(DEMO_CALL).not.toMatch(/\bautoplay\b/);
  });

  it("starts in code, never through the autoplay ATTRIBUTE", () => {
    // The attribute would start (and fetch) before reduced motion, Save-Data
    // or visibility had a chance to say no.
    expect(PLAYER).not.toMatch(/\bautoPlay\b/);
    expect(PLAYER).not.toMatch(/\bautoplay=/i);
  });

  it("reduced motion and Save-Data both mean: start on the poster", () => {
    expect(PLAYER).toMatch(/matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    expect(PLAYER).toMatch(/connection\?\.saveData === true/);
    expect(PLAYER).toMatch(/const manual = reduce\.matches \|\| saveData;/);
    expect(PLAYER).toMatch(/setAwaitingStart\(manual\)/);
  });

  it("is muted, inline and looping", () => {
    const video = between("<video", "/>");
    for (const attr of ["muted", "loop", "playsInline"]) {
      expect(video, `<video> is missing ${attr}`).toMatch(new RegExp(`\\b${attr}\\b`));
    }
  });

  it("plays only while half on screen, and a person's Pause is final", () => {
    const observer = between("new IntersectionObserver(", "observer.observe(");
    expect(observer).toMatch(/threshold: 0\.5/);
    expect(observer).toMatch(/if \(heldByPerson\.current \|\| refused\.current\) return;/);
    // Off screen it stops, so a loop never runs down a phone's battery unseen.
    expect(observer).toMatch(/\.pause\(\)/);
  });

  it("fetches nothing until playback is wanted", () => {
    // The <video> exists only in the mounted branch, and asks for nothing
    // until play() — so a reduced-motion, Save-Data or /demo visit fetches no
    // media bytes before a person presses Play (counted, in the browser spec).
    expect(PLAYER).toMatch(/\{mounted \? \(\s*<video/);
    expect(between("<video", "/>")).toMatch(/preload="none"/);
  });
});

describe("the control tells the truth, and survives a refusal", () => {
  it("labels itself from what the media element reports, not from intent", () => {
    expect(PLAYER).toMatch(/onPlay=\{\(\) => setPaused\(false\)\}/);
    expect(PLAYER).toMatch(/onPause=\{\(\) => setPaused\(true\)\}/);
    expect(PLAYER).toMatch(/\{paused \? "Play" : "Pause"\}/);
  });

  it("brings the start control back when the browser refuses — but not for its own pause()", () => {
    const attempt = between("function attemptPlay()", "function startByPerson()");
    // AbortError is our own pause() interrupting a pending play(): not a refusal.
    expect(attempt).toMatch(/error\.name === "AbortError"\) return;/);
    expect(attempt).toMatch(/refused\.current = true;/);
    expect(attempt).toMatch(/setAwaitingStart\(true\)/);
  });

  it("runs a person's play() inside their click", () => {
    // Safari in Low Power Mode honours play() only inside the gesture; an
    // effect that runs after the click is too late.
    const start = between("function startByPerson()", "function toggle()");
    const flush = start.indexOf("flushSync(");
    expect(flush, "startByPerson must commit the video synchronously").toBeGreaterThan(-1);
    expect(start.indexOf("attemptPlay()")).toBeGreaterThan(flush);
    expect(start).not.toMatch(/useEffect|setTimeout|requestAnimationFrame/);
  });
});

describe("the poster is fetched eagerly, not discovered late", () => {
  it("is a static import rendered through next/image with priority", () => {
    expect(PLAYER).toMatch(/from "next\/image"/);
    expect(PLAYER).toMatch(/import posterImage from "@\/app\/_media\//);
    expect(PLAYER).toMatch(/\bpriority\b/);
    // `loading="lazy"` would take the poster out of the preload scanner.
    expect(PLAYER).not.toMatch(/loading="lazy"/);
  });

  it("declares intrinsic dimensions so the frame reserves its own space", () => {
    // A 16:9 box sized from FILM, so the film section never shifts layout while
    // the poster decodes or the video replaces it.
    expect(PLAYER).toMatch(/aspectRatio/);
    expect(PLAYER).toMatch(/FILM\.width/);
    expect(PLAYER).toMatch(/FILM\.height/);
  });
});

describe("accessible without sight and without sound", () => {
  it("the film, its start button and its Pause control all carry a name", () => {
    expect(PLAYER).toMatch(/aria-label=\{FILM\.accessibleName\}/);
    expect(PLAYER).toMatch(/Play: \$\{FILM\.accessibleName\}/);
    // The visible word leads the accessible name (WCAG 2.5.3): "Pause the
    // product film", with the suffix for assistive tech only.
    expect(PLAYER).toMatch(/<span className="sr-only"> the product film<\/span>/);
    // The name states the running time and that it is silent, so nobody waits
    // for narration that does not exist.
    expect(FILM.accessibleName).toMatch(/25 seconds/);
    expect(FILM.accessibleName).toMatch(/silent/i);
  });

  it("ships the §12b card sequence as a real text equivalent", () => {
    // Seven cards, in the film's order.
    expect(FILM.transcript).toHaveLength(7);
    expect(FILM.transcript[0]).toMatch(/Monday, Sep 14/);
    expect(FILM.transcript[6]).toMatch(/Pick up where you left off/);
    for (const card of FILM.transcript) expect(card.length).toBeGreaterThan(20);

    expect(PLAYER).toMatch(/FILM\.transcript\.map/);

    // Visually hidden, never REMOVED. `hidden`, display:none or aria-hidden
    // would take it out of the accessibility tree as well, which is the
    // opposite of the point. Scoped to the transcript element, because
    // aria-hidden is correct elsewhere in the file — the decorative glyphs
    // legitimately carry it, and a whole-file scan would forbid that too.
    const at = PLAYER.indexOf("id={transcriptId}");
    expect(at, "transcript element not found").toBeGreaterThan(-1);
    const transcript = PLAYER.slice(at, PLAYER.indexOf("</div>", at));
    expect(transcript).toContain("sr-only");
    expect(transcript).not.toMatch(/\bhidden(=|\s|\/?>)/);
    expect(transcript).not.toMatch(/aria-hidden/);
    expect(transcript).not.toMatch(/display:\s*none/);
    // And it is announced with the film and its start control.
    expect((PLAYER.match(/aria-describedby=\{transcriptId\}/g) ?? []).length).toBe(2);
  });

  it("renders the demo-data disclosure in every state, once, under the picture", () => {
    // The poster frame and the film both burn these exact words into their own
    // corner, so the one HTML copy is the caption under the frame. It is the
    // figure's last child and outside every playback branch, so a visitor who
    // never sees the film move still reads it. (It used to be repeated ON the
    // poster as well: a third copy of the same line in one place.)
    expect((PLAYER.match(/POSITIONING\.demoDataLabel/g) ?? []).length).toBe(1);
    expect(PLAYER).toMatch(
      /<figcaption[^>]*>\s*\{POSITIONING\.demoDataLabel\}\s*<\/figcaption>\s*<\/figure>/,
    );
  });

  it("hands focus on: to Pause after a start, back to Play after a refusal", () => {
    // Each start control unmounts the button that was pressed; focus left on
    // a removed element falls to the top of the document.
    expect(between("function startByPerson()", "function toggle()")).toMatch(
      /toggleRef\.current\?\.focus\(\)/,
    );
    expect(between("function attemptPlay()", "function startByPerson()")).toMatch(
      /if \(hadFocus\) startRef\.current\?\.focus\(\)/,
    );
  });

  it("both controls are real buttons whose focus survives forced colours", () => {
    expect((PLAYER.match(/<button\s/g) ?? []).length).toBe(2);
    expect((PLAYER.match(/type="button"/g) ?? []).length).toBe(2);
    // An outline, not a ring: box-shadow rings vanish in forced-colours mode,
    // and LAW 6 says focus must not depend on colour the system may override.
    expect((PLAYER.match(/focus-visible:outline-2/g) ?? []).length).toBe(2);
    expect(PLAYER).not.toMatch(/outline-none/);
  });

  it("the Pause control meets the 44px touch floor in both dimensions", () => {
    const toggle = between("ref={toggleRef}", ">");
    expect(toggle).toMatch(/\bmin-h-11\b/);
    expect(toggle).toMatch(/\bmin-w-11\b/);
  });
});

describe("motion", () => {
  it("nothing animates but the film itself", () => {
    // No entrance, no pulse, no animated glyph. The control's hover is a colour
    // change on the shared UI duration (DESIGN contract 8), not motion.
    expect(PLAYER).not.toMatch(/animate-|@keyframes|\btransform\b/);
    expect(PLAYER).toMatch(/duration-\[var\(--hone-duration-ui\)\]/);
  });
});

describe("analytics stays inside the existing allowlist", () => {
  it("film_play marks a person pressing Play — never autoplay, never Pause", () => {
    expect(ANALYTICS_EVENTS.filmPlay).toBe("marketing:film_play");
    // The start button, and the toggle only while it reads "Play".
    expect(PLAYER).toMatch(/data-event=\{ANALYTICS_EVENTS\.filmPlay\}/);
    expect(PLAYER).toMatch(/data-event=\{paused \? ANALYTICS_EVENTS\.filmPlay : undefined\}/);
  });

  it("the player wires up no analytics transport of its own", () => {
    // It carries a data-event attribute and nothing else; the shared delegator
    // in MarketingAnalytics is the only thing that sends anything. A direct
    // track()/gtag()/fetch() here would be a second, unreviewed path.
    expect(PLAYER).not.toMatch(/@vercel\/analytics/);
    expect(PLAYER).not.toMatch(/\btrack\(/);
    expect(PLAYER).not.toMatch(/\bgtag\b/);
    expect(PLAYER).not.toMatch(/\bfetch\(/);
    expect(PLAYER).not.toMatch(/navigator\.sendBeacon/);
  });

  it("carries no timing, completion or identity payload", () => {
    expect(PLAYER).not.toMatch(/currentTime/);
    expect(PLAYER).not.toMatch(/onTimeUpdate|onEnded|onProgress/);
  });
});

describe("the homepage consumes the film as section 1", () => {
  it("renders the player edge to edge on a phone, and closes on the film's own end card", () => {
    expect(PAGE).toMatch(/<ProductFilm\b/);
    expect(HOMEPAGE_CALL).toMatch(/\bbleed\b/);
    // The end-card wording is COPY and belongs to MKT-02A's POSITIONING, not to
    // this lane's asset constant. What is pinned here is that the page actually
    // closes on it — the film's last frame and the page's last words agreeing.
    expect(PAGE).toMatch(/POSITIONING\.filmClosingLine/);
  });
});

// ---------------------------------------------------------------------------
// The film must be reachable WITHOUT a session.
// ---------------------------------------------------------------------------
//
// THIS IS HERE BECAUSE IT SHIPPED BROKEN ONCE. `public/film/...mp4` is a public
// marketing asset on the anonymous homepage, but the Supabase session
// middleware matches every path it does not explicitly exclude, so the request
// answered 307 -> /login. The browser got an HTML login page where it expected
// video and reported MEDIA_ERR_SRC_NOT_SUPPORTED: the film did not play for a
// logged-out visitor, which is every visitor the homepage is for.
//
// Pinned in BOTH directions, because the interesting failure is not the film
// becoming unreachable again — it is someone fixing that with a `film/` PREFIX.
// The repo has already paid for that lesson once: a `fonts/` prefix exemption
// silently un-authenticated `/fonts/private`, a real grouped route, with no
// file named `app/fonts/...` anywhere to give it away. A prefix here would do
// the same to anything under /film.
//
// Read from the TypeScript AST rather than by regex over the source, and from
// EVERY matcher entry rather than the first: Next treats the array as
// alternatives, so a later broad entry re-runs the middleware no matter what
// entry [0] says, and a commented-out copy of an old pattern would feed a text
// scan the stale one.
function middlewareMatchers(): string[] {
  const source = ts.createSourceFile(
    "middleware.ts",
    readFileSync(join(ROOT, "middleware.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "matcher") ||
        (ts.isStringLiteral(node.name) && node.name.text === "matcher")) &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        found.push(
          ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)
            ? el.text
            : `<non-literal:${ts.SyntaxKind[el.kind]}>`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the film is reachable without a session, and nothing else is", () => {
  const entries = middlewareMatchers();
  const runsMiddleware = (p: string) =>
    entries.some((e) => new RegExp(`^${e}$`).test(p));

  it("the matcher was actually read", () => {
    expect(entries.length, "no middleware matcher entries found").toBeGreaterThan(0);
    for (const e of entries) expect(e).not.toMatch(/^<non-literal:/);
  });

  it("the film's exact URL bypasses the auth middleware", () => {
    expect(
      runsMiddleware(FILM.src),
      `${FILM.src} must NOT be matched by ANY middleware matcher entry`,
    ).toBe(false);
  });

  it("the exclusion is the exact file, never a /film prefix", () => {
    for (const guarded of [
      "/film",
      "/film/anything",
      "/film/private",
      // A suffix must not ride on the exact filename.
      `${FILM.src}/extra`,
      // Near-miss prefixes and case.
      "/filmx/dashboard",
      "/xfilm/dashboard",
      FILM.src.toUpperCase(),
      // Another video must not inherit the exemption.
      "/film/some-other-clip.mp4",
      // And the authenticated app is untouched.
      "/dashboard",
      "/clients",
    ]) {
      expect(
        runsMiddleware(guarded),
        `${guarded} MUST still run through the auth middleware`,
      ).toBe(true);
    }
  });

  it("does NOT exempt .mp4 as a whole extension class", () => {
    // One character cheaper, and it would serve every future .mp4 on every
    // route without a session check. This application stores clinical media.
    const images = "/x.png";
    expect(runsMiddleware(images), "image class is pre-existing").toBe(false);
    expect(runsMiddleware("/anywhere/else/video.mp4")).toBe(true);
  });
});
