import { ImageResponse } from "next/og";

// Static-ish OG/social card generated with the built-in next/og ImageResponse
// (Next 15; no new dependency). Outputs a 1200x630 PNG. Next auto-wires this
// as og:image AND twitter:image site-wide via the file convention, so no
// metadata edits are needed in layout.tsx. No client data; branded copy only.

export const runtime = "edge";
export const alt =
  "Hone. Electrolysis practice software for booking, treatment plans, and clinical charting.";
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
          backgroundColor: "#FAFAF7",
          color: "#0A0A0A",
          padding: "76px",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 26,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#6B6B6B",
          }}
        >
          Electrolysis practice software
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
          <div style={{ display: "flex", fontSize: 42, marginTop: 18 }}>
            Never wonder what you did last session.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid #E5E2DA",
            paddingTop: 28,
            fontSize: 30,
            color: "#6B6B6B",
          }}
        >
          <div style={{ display: "flex" }}>
            Booking · Treatment plans · Clinical charting
          </div>
          <div style={{ display: "flex", color: "#0A0A0A" }}>hone.care</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
