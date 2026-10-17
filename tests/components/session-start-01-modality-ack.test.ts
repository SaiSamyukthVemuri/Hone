import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// SESSION-START-01 — the press that used to do nothing.
//
// /clients/[id]/sessions/new rendered each modality as its own server
// `<form>` around a raw `<button type="submit">`. The page had no
// "use client", no useFormStatus, no disabled state and no pending styling, so
// NOTHING on screen was capable of changing when the card was pressed. On the
// linked-appointment path the server action can take seconds — the practitioner
// watched an idle screen, and a second press issued a second start_session.
//
// DESIGN.md LAW 4: "Every control acknowledges immediately. A press is
// confirmed before its result arrives. A control that has been activated must
// never look idle."
//
// This slice fixes the ACKNOWLEDGEMENT only. The backend waterfall behind it is
// measured and cut separately; a spinner is not allowed to stand in for that.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const PICKER_PATH = "app/(app)/clients/[id]/sessions/new/ModalityPicker.tsx";
const PAGE_PATH = "app/(app)/clients/[id]/sessions/new/page.tsx";
const PICKER = code(PICKER_PATH);
const PAGE = code(PAGE_PATH);

describe("SESSION-START-01: the client leaf, and only the leaf", () => {
  it("the picker is a client component", () => {
    expect(read(PICKER_PATH).trimStart().startsWith('"use client"')).toBe(true);
  });

  it("does NOT drag the clinical page into the client", () => {
    // The page loads client, previous-session summary and last charted
    // treatment. Hydrating all of that to render a spinner on two cards would
    // trade one latency problem for another.
    expect(PAGE).not.toContain('"use client"');
    expect(PAGE).not.toContain("useFormStatus");
  });

  it("the spinner primitive stays server-compatible and is not forked", () => {
    expect(code("components/ui/spinner.tsx")).not.toContain('"use client"');
    expect(PICKER).toContain('from "@/components/ui/spinner"');
    // No second spinner, no animation library.
    expect(PICKER).not.toMatch(/animate-spin/);
  });
});

describe("SESSION-START-01: ONE form is the mechanism, not a detail", () => {
  it("renders exactly one form", () => {
    // Two forms was the old shape. useFormStatus only reports the form it is
    // inside, so with a form per card the pressed card can know it is busy but
    // its SIBLING cannot — which is precisely the requirement. One form makes
    // the sibling state fall out of the same hook instead of needing a second,
    // hand-reset source of truth.
    expect(PICKER.match(/<form\b/g) ?? []).toHaveLength(1);
  });

  it("the modality rides the submit button, so the server contract is unchanged", () => {
    // startSessionAction reads formData.get("modality"). The browser submits
    // only the button actually pressed, so name/value on the button carries it.
    expect(PICKER).toMatch(/name="modality"/);
    expect(PICKER).toMatch(/value=\{modality\}/);
    // NEGATIVE CONTROL: a hidden modality input per card would mean two forms
    // again, or an ambiguous single form submitting both modalities.
    expect(PICKER).not.toMatch(/type="hidden"[\s\S]{0,60}name="modality"/);
  });

  it("the shared hidden fields are spelled once, not per card", () => {
    expect(PICKER.match(/name="client_id"/g) ?? []).toHaveLength(1);
    expect(PICKER.match(/name="appointment_id"/g) ?? []).toHaveLength(1);
  });
});

describe("SESSION-START-01: what the practitioner sees on press", () => {
  it("BOTH cards disable while the action is in flight", () => {
    // This is the sibling requirement AND the double-submit requirement in one
    // line: disabled is driven by `pending` (the form is busy), not by
    // `isChosen` (this card was the one pressed).
    expect(PICKER).toMatch(/disabled=\{pending\}/);
    // NEGATIVE CONTROL: `disabled={isChosen}` would look correct in a
    // screenshot of the pressed card while leaving the sibling live — a second
    // start_session on a different modality is exactly the accident this
    // forbids.
    expect(PICKER).not.toMatch(/disabled=\{isChosen\}/);
  });

  it("only the pressed card announces itself busy", () => {
    // aria-busy is conditional on isChosen, not on pending. Announcing on both
    // would tell a screen-reader user that the modality they did NOT choose is
    // working.
    expect(PICKER).toMatch(/aria-busy=\{isChosen \|\| undefined\}/);
    expect(PICKER).not.toMatch(/aria-busy=\{pending/);
  });

  it("the spinner is silent, because aria-busy is already the voice", () => {
    // Spinner defaults to aria-hidden and only speaks when given `label`.
    // Passing one here would double-announce against aria-busy — the pairing
    // Button already uses.
    expect(PICKER).toMatch(/<Spinner size="sm" \/>/);
    expect(PICKER).not.toMatch(/<Spinner[^>]*label=/);
  });

  it("which card is pending comes from the submitted data, not from memory", () => {
    // `data` is the FormData the browser actually sent, so the pressed card is
    // identified by the submission rather than by state this component set and
    // would then have to clear on every error path.
    expect(PICKER).toMatch(/const \{ pending, data \} = useFormStatus\(\)/);
    expect(PICKER).toMatch(/data\?\.get\("modality"\)/);
    // NEGATIVE CONTROL: no local pending state to leak or reset.
    expect(PICKER).not.toContain("useState");
  });

  it("hydration is signalled from the CLIENT snapshot, and the server says false", () => {
    // Why this is a source assertion and not only a browser one: if the server
    // snapshot ever returned `true`, `data-hydrated` would be present in the
    // SSR HTML, the e2e precondition that waits for it would pass instantly,
    // and every acknowledgement case in this slice would go back to racing
    // hydration — silently, and while still green.
    //
    // useSyncExternalStore's third argument IS the server snapshot. Pinning
    // the pair is what keeps the browser precondition non-vacuous.
    expect(PICKER).toMatch(/useSyncExternalStore\(\s*subscribeToNothing,\s*\(\) => true,\s*\(\) => false,\s*\)/);
    expect(PICKER).toMatch(/data-hydrated=\{hydrated \? "true" : undefined\}/);
    // And it must stay OFF the button: the attribute marks the island, not a
    // control, so a future edit cannot turn it into a second pending signal.
    expect(PICKER).not.toMatch(/<button[\s\S]{0,400}?data-hydrated/);
  });
});

describe("SESSION-START-01: geometry is stable on press", () => {
  it("the spinner slot is reserved whether or not it holds a spinner", () => {
    // A card that grows when pressed moves its sibling under the practitioner's
    // thumb mid-action. The slot is a fixed size-4 box rendered unconditionally;
    // only its CONTENTS are conditional.
    expect(PICKER).toMatch(/inline-flex size-4 shrink-0/);
    expect(PICKER).toMatch(/\{isChosen \? <Spinner size="sm" \/> : null\}/);
  });

  it("the description stays IN FLOW while pending — the card cannot shrink", () => {
    // The defect this replaced: swapping the description for "Starting
    // session…" shortened the card wherever the description wrapped and
    // the pending text did not — single-column 390px being the obvious case.
    // opacity-0 keeps the box, so the height is the description's height in
    // both states.
    expect(PICKER).toMatch(/className=\{isChosen \? "opacity-0" : undefined\}>\{description\}/);
    // NEGATIVE CONTROL: the swap must not come back. This is the assertion
    // that would have caught the original implementation.
    expect(PICKER).not.toMatch(/isChosen \? "Starting session…" : description/);
  });

  it("the hidden half is the OVERLAY, never the description", () => {
    // Button records the trap: aria-hidden on the held text collapses the
    // control's accessible name to empty for exactly as long as it is busy,
    // so a screen-reader user is told "busy" about a control that no longer
    // says what it is. The overlay is the decoration; aria-busy announces.
    expect(PICKER).toMatch(/aria-hidden="true" className="absolute inset-0/);
    // Matching the description's WHOLE tag is the assertion: if an aria-hidden
    // attribute were added to it, this exact shape would stop matching.
    expect(PICKER).toMatch(
      /<span className=\{isChosen \? "opacity-0" : undefined\}>\{description\}<\/span>/,
    );
  });

  it("NEGATIVE CONTROL: the slot is not itself conditional", () => {
    // `{isChosen && <span className="size-4">…}` would pass a test that only
    // checked "a spinner appears", while reflowing the card on every press.
    const slot = PICKER.slice(PICKER.indexOf("ml-auto inline-flex size-4"));
    expect(slot.slice(0, 200)).not.toMatch(/isChosen &&/);
  });
});

describe("SESSION-START-01: the old defect cannot come back", () => {
  it("no raw submit button survives on this route's picker", () => {
    // The card IS the submit control now, so type="submit" is expected in the
    // picker — but it must carry the pending contract with it.
    const submits = PICKER.match(/type="submit"/g) ?? [];
    expect(submits).toHaveLength(1);
    expect(PICKER).toContain("useFormStatus");
  });

  it("the page no longer builds its own card or imports the action directly", () => {
    // Both would be a route back to a server-rendered form with no pending
    // state — the exact shape this slice removed.
    expect(PAGE).not.toContain("ModalityCard");
    expect(PAGE).not.toContain("startSessionAction");
    expect(PAGE).toContain("<ModalityPicker");
  });

  it("the card is reachable by keyboard and shows it", () => {
    // The old card had `transition hover:` and no focus-visible ring at all.
    // LAW 6: focus must be visible and must survive.
    expect(PICKER).toContain("FOCUS_RING");
    expect(PICKER).toContain("CONTROL_DISABLED");
  });
});
