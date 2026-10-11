import { ImageResponse } from "next/og";

// Static-ish OG/social card generated with the built-in next/og ImageResponse
// (Next 15; no new dependency). Outputs a 1200x630 PNG. Next auto-wires this
// as og:image AND twitter:image site-wide via the file convention, so no
// metadata edits are needed in layout.tsx. No client data; branded copy only.
// PR #244: the card leads with the public category phrase (treatment memory
// for electrologists) instead of the old "practice software" framing.
//
// MKT-03 REVISION 3 (the anti-slop pass) put the card in the site's own
// palette and words. It drew a tracked, all-caps label in grey on near-white,
// a slogan the site no longer uses, and a middle-dot list of features. Now it
// is the marketing surface's paper, ink and green, the category in sentence
// case, and the homepage's own headline. The colours are the `@theme` values
// in app/globals.css, written out because an edge ImageResponse cannot read
// CSS variables.
const PAPER = "#f7f4ee";
const INK = "#17211f";
const MUTED = "#556661";
const MINERAL = "#1e6b62";
const HAIRLINE = "#e2ddd3";

export const runtime = "edge";
export const alt =
  "Hone, electrolysis practice software: start the next treatment where the last one ended.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: PAPER,
          color: INK,
          padding: "76px",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, color: MINERAL }}>
          Treatment memory for electrologists
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 128,
              fontWeight: 700,
              letterSpacing: "-0.04em",
              lineHeight: 1,
            }}
          >
            Hone
          </div>
          <div style={{ display: "flex", fontSize: 46, marginTop: 22, lineHeight: 1.15, maxWidth: 900 }}>
            Start the next treatment where the last one ended.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${HAIRLINE}`,
            paddingTop: 28,
            fontSize: 30,
            color: MUTED,
          }}
        >
          <div style={{ display: "flex" }}>Electrolysis practice software</div>
          <div style={{ display: "flex", color: INK }}>hone.care</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
