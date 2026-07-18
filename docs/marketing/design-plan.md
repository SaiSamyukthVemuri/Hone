# Flagship Design Plan — Hone marketing site (design-plan gate, §10/§11/§12/§13)

**Status:** internal. This is the gate that must be complete **before any homepage code**.
Design thesis: **Quiet precision** — the site should feel like a well-kept treatment room:
ordered, calm, meticulous, warm toward the practitioner, trustworthy, exact, human. It
must not read as a generic Tailwind SaaS template. Self-review against the banned list is
at the bottom.

## 1. Palette (6 named colors) + contrast checks

Adopted from §10's directional set after verifying contrast. WCAG 2.1 ratios computed
with the standard sRGB relative-luminance formula.

| Token | Hex | Role |
|---|---|---|
| Paper | `#F7F4EE` | Primary background (light-first, warm) |
| Warm surface | `#EEE9E0` | Alternating section band / cards on paper |
| Ink | `#17211F` | Primary text, headings |
| Muted ink | `#556661` | Secondary text, labels, captions |
| Mineral teal | `#1E6B62` | The single ownable clinical-calm accent (links, primary CTA, active) |
| Accent wash | `#D8EAE6` | Soft teal tint for memory panels / chips |
| Dark band | `#10231F` | The one dark comparison band (inverted section) |

**Contrast results (target: body ≥ 4.5:1, large/UI ≥ 3:1):**

| Foreground / background | Ratio | Verdict |
|---|---|---|
| Ink `#17211F` on Paper `#F7F4EE` | **≈15.0:1** | AAA — body + headings |
| Muted ink `#556661` on Paper / Warm / Wash | **≈5.5 / 5.0 / 4.9:1** | AA for normal text on every marketing surface (darkened from #61706B, which failed AA on the warm/wash tints) |
| Mineral teal `#1E6B62` on Paper (links) | **≈5.7:1** | AA normal text |
| White `#FFFFFF` on Mineral teal (primary CTA) | **≈6.3:1** | AA normal text |
| Paper `#F7F4EE` on Dark band `#10231F` | **≈14.9:1** | AAA — inverted section text |
| Ink on Accent wash `#D8EAE6` | **≈13.4:1** | AAA — text on memory panels |

Rule: **Ink is the only body-text color on paper.** Muted ink is for secondary/labels
only (4.7:1 has little headroom). Mineral teal is the sole accent; no second brand hue.

## 2. Typography

**Pairing (to implement in stage 2):** a serif with optical contrast for display + a clean
grotesk for text/UI — §11's preferred *Newsreader (display) + Geist (text)*.

**Font-delivery policy (hard requirement §11):** `next/font/local` only — **no runtime and
no build-time Google Fonts network request.** The current site uses `next/font/google`
(Fraunces + Inter); that must go.
- Plan A: vendor **open-licensed WOFF2 subsets** (Newsreader = OFL, Geist = OFL) via
  `next/font/local`, record name/source/license/files in `FONTS.md`.
- Plan B (fallback, explicitly allowed): if verified WOFF2 files cannot be obtained in
  this environment, ship a **tuned system stack** with `size-adjust`/metric overrides and
  record the decision in `FONTS.md`. **Never ship unlicensed files.**
  - Display serif stack: `"Iowan Old Style","Palatino Linotype",Palatino,Georgia,ui-serif,serif`
  - Text grotesk stack: `ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`

**Type scale (fluid, clamp-based; body ≥ 16px):**

| Step | Size | Use |
|---|---|---|
| Display XL | `clamp(2.5rem, 1.55rem + 4.2vw, 4.25rem)` | Hero H1 |
| Display L | `clamp(2rem, 1.4rem + 2.6vw, 3rem)` | Section titles |
| H3 | `clamp(1.375rem, 1.15rem + 1vw, 1.75rem)` | Sub-headings, card titles |
| Body L | `1.125rem` (18px) | Lead paragraphs |
| Body | `1rem` (16px) | Default |
| Label | `0.8125rem` (13px), uppercase, `letter-spacing .08em` | Eyebrows/labels only — never body |

Line-height: display `1.05–1.12`, body `1.6`. Display usage is restrained (hero + one per
section). Measure capped ~66ch.

## 3. Spacing, radius, shadow

- **Spacing:** 4px base; scale 4/8/12/16/24/32/48/64/96/128. Section vertical rhythm
  `clamp(4rem, 8vw, 8rem)`. Container `max-width: 1120px`, gutter 20–24px.
- **Radius (restrained):** product frames/cards 12px; buttons/inputs 8px; chrome bar 12px
  top corners; pills `999px` for chips only. No "excessive rounded cards."
- **Shadow (depth only around product compositions):** exactly one elevation token used on
  product frames — `0 1px 2px rgba(16,35,31,.05), 0 18px 40px -20px rgba(16,35,31,.22)`.
  Everywhere else, separate with **1px hairline rules** (`rgba(23,33,31,.10)`), not shadow.
  No heavy shadows on generic cards.

## 4. Section-by-section layout concept (homepage, §14)

Editorial and asymmetric — not centered-everything, not repeated three-card grids.

1. **Hero** — left-weighted text column (eyebrow, H1, supporting, differentiation line,
   Request + secondary CTA, proof line) with the **signature treatment-memory product
   frame** on the right. On the dark band? No — hero stays on paper; product frame carries
   the depth.
2. **Narrative contrast (dark band)** — the one inverted section: "Your calendar remembers
   the appointment. Hone helps you remember the treatment." Calendar-vs-Hone comparison.
3. **Workflow progression** — Get booked → Prepare → Record → Preserve memory → Follow up →
   Run the practice, as a horizontal/stepped progression (not 6 identical cards); each step
   pairs a short outcome line with a small product cue.
4. **Signature capability: Treatment memory** — a wide `TreatmentMemoryPanel` composition
   (Before Today) with an annotation, left text / right visual, asymmetric.
5. **Capability groups** — the six broad groups (§7) in a structured two-column list with
   hairline rules, not a card grid.
6. **Proof / built-with** — origin + real-workflow proof (no fabricated metrics, no fake
   logos), text-led.
7. **Pricing teaser** — three-plan summary with Solo emphasized, → /pricing.
8. **Trust** — studio isolation, private photos, no ad use, no AI training, Stripe;
   evidence-backed, calm.
9. **Closing CTA** — Request a 15-minute walkthrough.

Feature/pillar/resource pages reuse these primitives with page-specific product frames.

## 5. Product-visual system (§12)

Reusable coded components (no screenshots of real client data; anonymized demo data only):
`ProductFrame`, `BrowserFrame`, `ProductSidebar`, `TreatmentMemoryPanel`, `CalendarPreview`,
`SessionRecordPreview`, `ClientTimelinePreview`, `ProductAnnotation`.

**Recreated-visual disclosure (addendum §8):** every product composition carries a visible,
screen-reader-available label — **"Illustrative product preview"** (or "Example treatment
record" for record mockups). An asset manifest is recorded in `docs/marketing/visual-manifest.md`
during the homepage/visual stage. Demo data stays anonymized (e.g. Maya R., Jordan L.,
Demo Studio, lot L-204) — never real client data.

## 6. Signature animation (§13) — one signature moment, ≤3 total

**Signature: hero treatment-memory assembly.** On load (once): the appointment card
settles → area appears → settings appears → tolerance appears → caution appears →
next-visit plan appears → a subtle SVG "memory thread" stroke connects them.
- **Transform/opacity + SVG stroke-dashoffset only.** No layout animation, no color-heavy
  effects, no parallax.
- **Runs once** (no loop), gated on in-view + not-reduced-motion.
- **Zero CLS:** the final composed frame's box is reserved; animation only reveals within
  reserved space.

The other two permitted moments are quiet in-view reveals (opacity/translateY ≤ 8px):
the **workflow progression** and the **specialist comparison** on the dark band. Nothing
else animates.

**Reduced-motion:** `prefers-reduced-motion: reduce` → every animated moment renders its
**final composed state immediately** (no thread draw, no staggered reveal). Reveal
primitives already default to visible when reduced-motion is set.

## 7. Mobile adaptation

Single column; product frames scale to 100% width; wide previews/tables live inside an
`overflow-x:auto` container so the **page body never scrolls horizontally**; 44px touch
targets; nav collapses to the existing accessible full-screen dialog pattern (keyboard +
Escape + scroll-lock). Hero product frame drops below the text on small screens.

## 8. Banned-list self-review (§10)

| Banned | Avoided by |
|---|---|
| Default blue startup palette | Warm paper + Ink + single mineral-teal accent; no blue as brand |
| Purple AI gradients | No gradients as brand; teal flat fills only |
| Glassmorphism | Opaque surfaces + hairlines only |
| Emoji icons | Custom inline SVG / no emoji |
| Repetitive three-card grids | Asymmetric editorial layouts; workflow as progression; groups as ruled list |
| Excessive rounded cards | 8–12px max radius, restrained |
| Heavy shadows everywhere | One elevation token, product frames only; hairlines elsewhere |
| Centered-everything symmetry | Left-weighted hero, alternating asymmetric bands |
| Black + acid-green dev aesthetic | Ink `#17211F` / mineral teal, warm paper |
| Cream + terracotta + serif trend | Teal (not terracotta); serif used with restraint + a grotesk |
| Floating gradient blobs | None |
| Random decorative numbers | None |
| Fake dashboard analytics | Product frames show real workflow surfaces (Before Today, session record), not invented charts/metrics |

**Gate result:** plan clears the banned list. Cleared to implement Stage 2 (design tokens +
fonts + motion primitives), then Stage 3 (homepage + product visuals).
