import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FILM, ANALYTICS_EVENTS } from "@/lib/marketing/content";

// Film V1 contract (copy deck v2.2 §12b/§13).
//
// Two kinds of claim are pinned here, and they are pinned differently.
//
//   THE PLAYER'S BEHAVIOUR is a claim about source: no autoplay, nothing
//   fetched before a click, an accessible name, a real text equivalent. Those
//   are read out of the component.
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

describe("no autoplay — structurally, not by convention", () => {
  it("the player names no autoplay attribute at all", () => {
    expect(PLAYER).not.toMatch(/\bautoPlay\b/);
    expect(PLAYER).not.toMatch(/\bautoplay\b/i);
  });

  it("playback is reachable only through the activation state", () => {
    // Exactly one call site, and it sits behind the `activated` guard. A second
    // play() — in a mount effect, in a ref callback, in an IntersectionObserver
    // — is how a page starts playing at someone without being asked.
    const calls = PLAYER.match(/\.play\(\)/g) ?? [];
    expect(calls, `expected one play() call, found ${calls.length}`).toHaveLength(1);
    expect(PLAYER).toMatch(/if \(!activated\) return;/);
    expect(PLAYER).not.toMatch(/IntersectionObserver/);
  });

  it("fetches nothing until asked", () => {
    expect(PLAYER).toMatch(/preload="none"/);
    // The <video> is mounted only in the activated branch, so before the click
    // there is no media element on the page at all.
    expect(PLAYER).toMatch(/activated \?/);
  });

  it("is muted and plays inline", () => {
    expect(PLAYER).toMatch(/\bmuted\b/);
    expect(PLAYER).toMatch(/\bplaysInline\b/);
  });
});

describe("the poster is the LCP candidate", () => {
  it("is a static import rendered through next/image with priority", () => {
    expect(PLAYER).toMatch(/from "next\/image"/);
    expect(PLAYER).toMatch(/import posterImage from "@\/app\/_media\//);
    expect(PLAYER).toMatch(/\bpriority\b/);
    // `loading="lazy"` would take the poster out of the preload scanner and
    // hand LCP to whatever loads next.
    expect(PLAYER).not.toMatch(/loading="lazy"/);
  });

  it("declares intrinsic dimensions so the frame reserves its own space", () => {
    // A 16:9 box sized from FILM, so the film section never shifts layout while
    // the poster decodes.
    expect(PLAYER).toMatch(/aspectRatio/);
    expect(PLAYER).toMatch(/FILM\.width/);
    expect(PLAYER).toMatch(/FILM\.height/);
  });
});

describe("accessible without sight and without sound", () => {
  it("the player and its play control both carry an accessible name", () => {
    expect(PLAYER).toMatch(/aria-label=\{FILM\.accessibleName\}/);
    expect(PLAYER).toMatch(/Play: \$\{FILM\.accessibleName\}/);
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
    // aria-hidden is correct elsewhere in the file — the decorative play glyph
    // legitimately carries it, and a whole-file scan would forbid that too.
    const at = PLAYER.indexOf("id={transcriptId}");
    expect(at, "transcript element not found").toBeGreaterThan(-1);
    const transcript = PLAYER.slice(at, PLAYER.indexOf("</div>", at));
    expect(transcript).toContain("sr-only");
    expect(transcript).not.toMatch(/\bhidden(=|\s|\/?>)/);
    expect(transcript).not.toMatch(/aria-hidden/);
    expect(transcript).not.toMatch(/display:\s*none/);
    // And it is announced with the control, not merely present on the page.
    expect(PLAYER).toMatch(/aria-describedby=\{transcriptId\}/);
  });

  it("the play control is a real button, not a click handler on a div", () => {
    expect(PLAYER).toMatch(/<button\s/);
    expect(PLAYER).toMatch(/type="button"/);
    expect(PLAYER).toMatch(/focus-visible:ring/);
  });

  it("native controls are present once it plays", () => {
    // Keyboard scrubbing and pause, for free and correct. The asset has no
    // audio, so the volume control native chrome shows is inert — that is a
    // better trade than hand-rolling a control surface and its a11y.
    expect(PLAYER).toMatch(/\bcontrols\b/);
  });
});

describe("motion", () => {
  it("nothing moves before the click, so reduced motion needs no branch", () => {
    // The facade has no transition, animation or transform. The one moving
    // thing on the page is a film a person pressed play on, which is requested
    // motion and is not what prefers-reduced-motion is about.
    const facade = PLAYER.slice(PLAYER.indexOf("activated ?"));
    expect(facade).not.toMatch(/animate-|transition-|@keyframes|\btransform\b/);
  });
});

describe("analytics stays inside the existing allowlist", () => {
  it("the play event is declared in ANALYTICS_EVENTS and used by name", () => {
    expect(ANALYTICS_EVENTS.filmPlay).toBe("marketing:film_play");
    expect(PLAYER).toMatch(/data-event=\{ANALYTICS_EVENTS\.filmPlay\}/);
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
  it("renders the player, and the close reuses the film's own end card", () => {
    expect(PAGE).toMatch(/<ProductFilm\b/);
    // The end-card wording is COPY and belongs to MKT-02A's POSITIONING, not to
    // this lane's asset constant. What is pinned here is that the page actually
    // closes on it — the film's last frame and the page's last words agreeing.
    expect(PAGE).toMatch(/POSITIONING\.filmClosingLine/);
  });
});
