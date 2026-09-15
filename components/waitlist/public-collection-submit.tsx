import { cx, CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import {
  JOIN_COLLECTION_NOTICE,
  PRIVACY_POLICY_PATH,
} from "@/lib/waitlist/join-copy";

// ===========================================================================
// THE POINT-OF-COLLECTION DISCLOSURE, OWNED WITH THE CONTROL THAT COLLECTS
// ===========================================================================
//
// WHY THIS COMPONENT EXISTS, STATED AS THE DEFECT IT CLOSES.
//
// The disclosure was twice attached to a SURFACE rather than to the CAPABILITY.
// `ProfileFields` is what collects; two components wrapped it, each supplying its
// own `type="submit"`, and each was expected to REMEMBER to also render a notice
// and a Privacy Policy link. `WaitlistJoinForm` was fixed by hand; the next
// review found `CompleteProfilePanel` missing the same thing. That is not two
// copy bugs — it is one missing structural coupling, and it would have recurred
// for the third surface.
//
// So the submit control and the disclosure are now ONE component. A surface
// cannot render the call to action without the notice, because there is no path
// to one without the other. The invariant stops being a rule someone follows and
// becomes a shape.
//
// It also puts the disclosure where it legally belongs: at the point of
// submission, adjacent to the action, rather than in a footer or behind a
// disclosure widget.
//
// ---------------------------------------------------------------------------
// WHY NOT IN `ProfileFields`, WHICH IS THE THING THAT ACTUALLY COLLECTS
// ---------------------------------------------------------------------------
//
// Because `ProfileFields` renders NO submit control — verified, and asserted by
// the drift guard — so it is reusable on a surface that submits nothing: a
// review step, an operator read-back, a confirmation screen. Legal copy there
// would announce "we use these details to manage this waitlist" on a surface
// that collects nothing, which is a FALSE disclosure. A false disclosure is
// worse than an absent one, because it is unfalsifiable by the reader.
//
// The rule the guard encodes is therefore not "ProfileFields implies a notice"
// but "ProfileFields BEHIND A SUBMIT implies a notice".
//
// ---------------------------------------------------------------------------
// WHY NOT A SHARED `<CollectionNotice/>` THE SURFACES BOTH RENDER
// ---------------------------------------------------------------------------
//
// That removes WORDING drift — the two-vocabulary problem — but not OMISSION
// drift, which is what actually happened here twice. A shared component still
// has to be remembered, so surface three forgets it exactly as surface two did.
// Coupling it to the CTA is what makes forgetting unexpressible.
//
// ---------------------------------------------------------------------------
// WHAT THE COPY MAY AND MAY NOT SAY
// ---------------------------------------------------------------------------
//
// `JOIN_COLLECTION_NOTICE` describes what happens when someone uses this form.
// It does NOT claim the data is collected in production today, because both
// WAIT-04 surfaces are dormant and unreachable from `app/`. The mirror error is
// equally untrue and equally forbidden: `app/privacy/page.tsx` must NOT yet
// describe these categories. Both become true together, in the change that
// activates collection — WAIT-04B, recorded as
// `privacy_policy_describes_activated_collection` in the binding contract.
//
// PRESENTATION ONLY. No fetch, no action, no server import. The surface owns what
// happens on submit; this owns what is shown while asking.
// ===========================================================================

const CARD_BG = "#FAFAF7";
const INK = "#0A0A0A";
const MUTED = "#6B6B6B";

export function PublicCollectionSubmit({
  studioName,
  label,
  pendingLabel,
  submitting,
  testId,
  supportingLines = [],
  error = null,
}: {
  /** Named in the notice, so the sentence says whose waitlist this is. */
  studioName: string;
  label: string;
  pendingLabel: string;
  submitting: boolean;
  testId: string;
  /**
   * Surface-specific reassurances shown between the control and the notice —
   * "joining does not reserve an appointment", "answering does not move you".
   * Deliberately NOT where the disclosure goes: those vary per surface, the
   * disclosure does not, which is the whole point of this component.
   */
  supportingLines?: ReadonlyArray<string>;
  error?: string | null;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="public-collection-submit">
      <button
        type="submit"
        disabled={submitting}
        data-testid={testId}
        className={cx(
          CONTROL_MIN_TOUCH,
          FOCUS_RING,
          "w-full px-6 py-3 text-[13px] font-medium uppercase disabled:opacity-60 sm:w-auto sm:self-start",
        )}
        style={{ backgroundColor: INK, color: CARD_BG, letterSpacing: "0.1em" }}
      >
        {submitting ? pendingLabel : label}
      </button>

      {supportingLines.map((line) => (
        <p key={line} className="text-[13px] leading-[1.6]" style={{ color: MUTED }}>
          {line}
        </p>
      ))}

      {/* THE DISCLOSURE. Rendered unconditionally and inseparably from the
          control above it — there is no prop that omits it, and no arrangement
          of this component that emits a CTA without it. */}
      <p
        className="text-[13px] leading-[1.6]"
        style={{ color: MUTED }}
        data-testid="public-collection-notice"
      >
        {studioName} and Hone {JOIN_COLLECTION_NOTICE} See Hone&rsquo;s{" "}
        <a
          href={PRIVACY_POLICY_PATH}
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: INK }}
          data-testid="public-collection-privacy-link"
        >
          Privacy Policy
        </a>
        .
      </p>

      {error && (
        <span role="alert" data-testid={`${testId}-error`} className="text-[13px] text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}
