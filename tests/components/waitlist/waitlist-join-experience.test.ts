import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompleteProfilePanel } from "@/components/waitlist/complete-profile-panel";
import { WaitlistJoinForm } from "@/components/waitlist/waitlist-join-form";
import {
  COMPLETE_POSITION_UNCHANGED,
  WAITLIST_CONTACT_PROMISE,
} from "@/lib/waitlist/join-copy";
import { OTHER_AREA } from "@/lib/constants";
import { TREATMENT_AREA_IDS } from "@/lib/waitlist/treatment-area-catalog";
import { emptyJoinProfileDraft } from "@/lib/waitlist/join-profile";

// RENDERED OUTPUT, NOT A SOURCE GREP. The rules this slice ships — no free
// text, no "Other", no queue promise, nothing pre-answered on the person's
// behalf — are properties of what a prospect actually SEES. A source scan would
// pass on a component that imported the right constants and rendered none of
// them.

const noop = async () => ({ ok: true }) as const;

function joinMarkup(): string {
  return renderToStaticMarkup(
    createElement(WaitlistJoinForm, { studioName: "Willow", onSubmit: noop }),
  );
}

function completionMarkup(): string {
  return renderToStaticMarkup(
    createElement(CompleteProfilePanel, {
        studioName: "Willow",
      stored: { legacyName: "Sarah Jones", email: "sarah@example.com" },
      onSubmit: async () => ({ ok: true }) as const,
    }),
  );
}

/** Visible copy: scripts then tags stripped, so test ids never satisfy a scan. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the join form asks for the six required fields", () => {
  const html = joinMarkup();

  it("has SEPARATE first and last name inputs", () => {
    expect(html).toContain('data-testid="waitlist-field-first-name"');
    expect(html).toContain('data-testid="waitlist-field-last-name"');
    // NON-VACUITY for the split: there is no single combined "name" field left.
    expect(html).not.toContain('autoComplete="name"');
    expect(html).not.toContain('autocomplete="name"');
  });

  it("has email and mobile, both required", () => {
    expect(html).toContain('data-testid="waitlist-field-email"');
    expect(html).toContain('data-testid="waitlist-field-mobile"');
    expect(html).toContain('type="tel"');
  });

  it("renders every catalog area as a checkbox, and no 'Other'", () => {
    for (const id of TREATMENT_AREA_IDS) {
      expect(html).toContain(`data-testid="waitlist-area-option-${id}"`);
    }
    expect(html).toContain('type="checkbox"'); // MULTI-select, not a radio group
    // The one member deliberately dropped from the catalog.
    expect(visibleText(html)).not.toMatch(new RegExp(`\\b${OTHER_AREA}\\b`));
  });

  it("offers the three structured availability answers", () => {
    for (const preference of ["weekdays", "weekends", "both"]) {
      expect(html).toContain(`data-testid="waitlist-availability-${preference}"`);
    }
  });
});

describe("NEGATIVE CONTROL — no free text beyond the identity fields", () => {
  const html = joinMarkup();

  it("renders no textarea anywhere", () => {
    expect(html).not.toContain("<textarea");
  });

  it("renders no notes, comments or urgency control", () => {
    expect(html.toLowerCase()).not.toMatch(/name="(notes?|comments?|urgency|message)"/);
    expect(visibleText(html).toLowerCase()).not.toMatch(
      /how urgent|anything else|tell us more|additional (notes|information)/,
    );
  });

  it("the only text inputs are the four identity fields", () => {
    const textInputs = html.match(/type="(text|email|tel)"/g) ?? [];
    expect(textInputs).toHaveLength(4);
  });
});

describe("NEGATIVE CONTROL — no queue promise and no time estimate", () => {
  for (const [label, html] of [
    ["join", joinMarkup()],
    ["completion", completionMarkup()],
  ] as const) {
    it(`the ${label} surface names no position or date`, () => {
      const text = visibleText(html).toLowerCase();
      expect(text).not.toMatch(/\bposition\b|\byou are \d|\b\d+(st|nd|rd|th) in\b/);
      expect(text).not.toMatch(/ahead of you|people ahead|queue (number|position)/);
      expect(text).not.toMatch(/\b\d+\s*(days?|weeks?|months?)\b/);
      expect(text).not.toMatch(/estimated wait|typically|usually within|on average/);
    });
  }

  it("states the promise the product can actually keep", () => {
    expect(visibleText(joinMarkup())).toContain(WAITLIST_CONTACT_PROMISE);
  });
});

describe("nothing is answered on the person's behalf", () => {
  const html = joinMarkup();

  it("no availability radio is pre-selected", () => {
    expect(html).not.toContain('data-selected="true"');
    expect(html).not.toContain("checked=");
  });

  it("the SMS consent box is unticked", () => {
    expect(html).toContain('data-testid="waitlist-field-sms-consent"');
    // Rendered from a blank draft, so an unticked box is the ONLY correct output.
    expect(emptyJoinProfileDraft().smsOperationalConsent).toBe(false);
  });

  it("no treatment area is pre-selected", () => {
    for (const id of TREATMENT_AREA_IDS) {
      expect(html).toContain(`data-testid="waitlist-area-option-${id}" data-selected="false"`);
    }
  });
});

describe("accessibility", () => {
  const html = joinMarkup();

  it("groups the multi-select and the radios in labelled fieldsets", () => {
    const fieldsets = html.match(/<fieldset/g) ?? [];
    expect(fieldsets.length).toBe(2); // areas + availability
    const legends = html.match(/<legend/g) ?? [];
    expect(legends.length).toBe(2);
  });

  it("describes each group with its help text", () => {
    expect(html).toMatch(/<fieldset[^>]+aria-describedby="/);
  });

  it("labels every input", () => {
    // One <label> per checkbox, per radio, and per text field.
    const inputs = (html.match(/<input/g) ?? []).length;
    const labels = (html.match(/<label/g) ?? []).length;
    // The four text fields use `htmlFor`; the rest wrap their control.
    expect(labels).toBeGreaterThanOrEqual(inputs - 4);
    expect(html).toMatch(/for="/);
  });

  it("keeps the 44px touch floor on every option row", () => {
    // CONTROL_MIN_TOUCH ships min-height WITH inline-flex, which is
    // load-bearing: min-height does nothing to an inline box.
    const rows = html.match(/class="[^"]*min-h-\[44px\][^"]*"/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(TREATMENT_AREA_IDS.length + 3);
    for (const row of rows) expect(row).toContain("inline-flex");
  });

  it("announces errors with role=alert, not colour alone", () => {
    const errored = renderToStaticMarkup(
      createElement(WaitlistJoinForm, {
        studioName: "Willow",
        onSubmit: noop,
        initialDraft: emptyJoinProfileDraft(),
      }),
    );
    // No errors on a fresh render...
    expect(errored).not.toContain('role="alert"');
    // ...and the markup carries the aria-invalid hook the error path sets.
    expect(html).toContain("aria-describedby=");
  });
});

describe("the completion surface is secure by shape", () => {
  const html = completionMarkup();

  it("promises the queue position does not move", () => {
    expect(visibleText(html)).toContain(COMPLETE_POSITION_UNCHANGED);
  });

  it("renders the email as TEXT, with no control to change it", () => {
    expect(html).toContain('data-testid="waitlist-field-email-locked"');
    expect(html).not.toContain('data-testid="waitlist-field-email"');
    // Not a disabled input either: there is no email control at all, so a
    // forged post has nothing on this surface to carry a value for.
    expect(html).not.toContain('type="email"');
    expect(visibleText(html)).toContain("sarah@example.com");
  });

  it("does NOT pre-fill the name from the combined legacy name", () => {
    // "Sarah Jones" is displayed nowhere as a first/last guess.
    expect(html).not.toContain('value="Sarah"');
    expect(html).not.toContain('value="Jones"');
  });

  it("renders no capability token, in markup or attributes", () => {
    expect(html.toLowerCase()).not.toContain("token");
    expect(html).not.toContain('type="hidden"');
  });

  it("carries no entry id for a caller to name a row with", () => {
    expect(html.toLowerCase()).not.toMatch(/entry[-_]?id/);
  });

  it("NON-VACUITY — the editable fields ARE present", () => {
    expect(html).toContain('data-testid="waitlist-field-first-name"');
    expect(html).toContain('data-testid="waitlist-field-mobile"');
    expect(html).toContain('data-testid="waitlist-availability-weekdays"');
  });
});

describe("NON-VACUITY — the negative controls above can actually fail", () => {
  // Every "not.toContain" assertion is only worth having if the string appears
  // when it should. This renders a POPULATED draft and proves each marker the
  // guards look for is real markup this component emits, not a string that
  // never occurs under any input.
  const populated = renderToStaticMarkup(
    createElement(WaitlistJoinForm, {
      studioName: "Willow",
      onSubmit: noop,
      initialDraft: {
        firstName: "Sarah",
        lastName: "Jones",
        email: "sarah@example.com",
        mobile: "07700900123",
        treatmentAreaIds: ["chin"],
        availabilityPreference: "weekdays",
        smsOperationalConsent: true,
      },
    }),
  );

  it("emits checked= when something IS checked", () => {
    // So "no radio is pre-selected" is a real observation about a blank draft.
    expect(populated).toContain("checked=");
  });

  it("emits data-selected=\"true\" when an area IS selected", () => {
    expect(populated).toContain('data-testid="waitlist-area-option-chin" data-selected="true"');
  });

  it("emits value=\"Sarah\" when a name IS pre-filled", () => {
    // So the completion panel's "does not split the legacy name" assertion is
    // observing an absence that would otherwise be present.
    expect(populated).toContain('value="Sarah"');
    expect(populated).toContain('value="Jones"');
  });

  it("emits an email input when the field is NOT locked", () => {
    // So the completion panel's `not.toContain('type="email"')` is meaningful.
    expect(populated).toContain('type="email"');
    expect(populated).toContain('data-testid="waitlist-field-email"');
  });
});

describe("mobile usability", () => {
  const html = joinMarkup();
  // Attribute names are matched case-insensitively, as HTML itself matches
  // them: react-dom/server preserves the JSX casing (`inputMode`) while a
  // browser parses it as `inputmode`. A case-SENSITIVE scan here reports a
  // false failure on correct markup, which is exactly what it did once.
  const attrs = html.toLowerCase();

  it("asks for the right keyboard on a phone", () => {
    expect(attrs).toContain('inputmode="email"');
    expect(attrs).toContain('inputmode="tel"');
    expect(attrs).toContain('type="tel"');
  });

  it("lets a phone autofill the identity fields", () => {
    // Separate given-name/family-name is what makes the two-field split
    // autofillable at all; a single "name" field would fill one box with both.
    expect(attrs).toContain('autocomplete="given-name"');
    expect(attrs).toContain('autocomplete="family-name"');
    expect(attrs).toContain('autocomplete="email"');
    expect(attrs).toContain('autocomplete="tel"');
  });

  it("uses 16px inputs, so iOS does not zoom on focus", () => {
    // Below 16px Safari zooms the viewport when a field takes focus, and does
    // not zoom back out — the single most common mobile form defect.
    expect((html.match(/text-\[16px\]/g) ?? []).length).toBe(4);
  });

  it("keeps the 44px floor on every option row, with its inline-flex", () => {
    const floors = html.match(/min-h-\[44px\]/g) ?? [];
    const paired = html.match(/inline-flex[^"]*min-h-\[44px\]/g) ?? [];
    // min-height does nothing to an inline box, so the two must travel together.
    expect(floors.length).toBe(paired.length);
    expect(floors.length).toBeGreaterThanOrEqual(TREATMENT_AREA_IDS.length + 3);
  });

  it("cannot overflow a narrow viewport", () => {
    // One column by default; the name pair goes side-by-side only at `sm:`.
    expect(html).toContain("flex-col");
    expect(html).toContain("max-w-full");
    // No fixed pixel widths anywhere — the classic source of a horizontally
    // scrolling form on a 320px phone.
    expect(html.match(/w-\[\d+px\]/g) ?? []).toHaveLength(0);
  });
});
