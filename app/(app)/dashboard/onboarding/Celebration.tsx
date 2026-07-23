"use client";

// Tasteful, dependency-free celebration for the onboarding success step.
// Deterministic layout (no Math.random -> no hydration mismatch); the fall
// animation + reduced-motion fallback live in globals.css (.hone-confetti).
const PIECE_COUNT = 28;
const COLORS = ["#0A0A0A", "#059669", "#D97706", "#2563EB", "#DB2777"];

export function Celebration() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 -top-2 flex justify-center overflow-hidden"
      aria-hidden
    >
      <div className="relative h-0 w-full max-w-md">
        {Array.from({ length: PIECE_COUNT }).map((_, i) => (
          <span
            key={i}
            className="hone-confetti"
            style={{
              left: `${(i / PIECE_COUNT) * 100}%`,
              backgroundColor: COLORS[i % COLORS.length],
              animationDelay: `${(i % 7) * 55}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
