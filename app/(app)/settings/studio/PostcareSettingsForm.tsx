"use client";

import { useState, useTransition } from "react";
import { updateStudioPostcareAction } from "./actions";

// Per-studio postcare content. Saved values are sent verbatim into the
// postcare email after the practitioner clicks "Send postcare" on the
// appointment page. Hone never invents medical advice; these textareas
// are the practitioner's authored content.
//
// Placeholders show safer suggested phrasings the practitioner can
// adopt or rewrite. They are NOT pre-populated values in the DB; each
// studio starts empty and decides what to write.
//
// Suggested phrasings reflect Chloe's audit guidance:
//   - cooling: "clean cool compress or cold pack for short intervals"
//     (avoids hardcoding "ice cube")
//   - medications: encourages clients to consult a pharmacist or
//     doctor (electrologists don't prescribe)

const AFTERCARE_PLACEHOLDER = [
  "Example wording to adapt or replace:",
  "",
  "Keep the treated area clean and dry for the first 24 hours.",
  "You can cool the treated area with a clean cool compress or cold pack for short intervals after treatment.",
  "If you are considering an over-the-counter pain reliever or antihistamine, check with your pharmacist, doctor, or another qualified health professional to make sure it is safe for you.",
  "Avoid hot showers, saunas, and intense exercise for 24 hours.",
  "Avoid direct sun on the treated area and use SPF for the next few days.",
].join("\n");

const WARNINGS_PLACEHOLDER = [
  "Example wording to adapt or replace:",
  "",
  "Mild redness, slight swelling, and tiny scabs are normal for a few days.",
  "Contact me if you notice spreading redness, pus, or a fever, or anything that feels unusual or excessive.",
].join("\n");

const PRODUCTS_PLACEHOLDER = [
  "Example wording to adapt or replace:",
  "",
  "List the specific cleansers, SPF, or soothing products you trust for your clients.",
].join("\n");

// Suggested copy the practitioner can fill the field with via the
// "Use suggested copy" button. Distinct from the placeholder above:
// placeholders are inert hint text (CSS-rendered, not selectable,
// disappear on first keystroke); suggested copy is real text that
// gets written into the textarea's value state, ready for the
// practitioner to edit and save. Phrasing reflects Chloe's safer-
// language guidance (cool compress / cold pack, not ice cube;
// medication questions point to pharmacist / doctor; no discount or
// review automation).
const AFTERCARE_SUGGESTED = [
  "Some skin reaction after electrolysis can be normal. You may notice redness, warmth, small scabs or crusts, hives, or temporary irritation.",
  "",
  "Do not pick, scratch, or remove any crusts or scabs. Let them fall off on their own.",
  "",
  "If a reaction feels excessive, unusual, or something feels off, please email the studio as soon as possible so your practitioner can take note and adjust your future treatment settings.",
  "",
  "Hydrate well. General health supports skin healing.",
  "",
  "Avoid friction, tight clothing, heavy sweating, touching, scratching, or picking the treated area.",
  "",
  "Use gentle, unscented products. Think unscented cleanser, unscented moisturizer, aloe, or hypochlorous acid spray.",
  "",
  "Avoid perfumed products and active skincare for 3 to 5 days, including AHAs, BHAs, exfoliants, and similar active ingredients.",
  "",
  "Avoid retinol products during your course of electrolysis treatments unless your practitioner advises otherwise.",
  "",
  "Wear SPF and avoid excess sun exposure. If your face was treated, wear a hat when outdoors.",
  "",
  "You can cool the treated area with a clean cool compress or cold pack for short intervals after treatment.",
  "",
  "If your face or neck was treated, avoid makeup for 24 hours.",
  "",
  "If your underarms were treated, avoid deodorant for 48 hours.",
  "",
  "For intimate areas, wear loose cotton underwear and keep the area dry and clean.",
].join("\n");

const WARNINGS_SUGGESTED = [
  "If a reaction feels excessive, unusual, or something feels off, contact the studio as soon as possible.",
  "",
  "If you are considering numbing cream, an over-the-counter pain reliever, or an antihistamine, check with your pharmacist, doctor, or another qualified health professional to make sure it is safe for you.",
].join("\n");

const PRODUCTS_SUGGESTED = [
  "Zensa numbing cream, available through your practitioner or on well.ca",
  "",
  "Ellement hypochlorous acid spray, a Canadian company from Toronto",
  "",
  "Unscented aloe vera, such as Badger, available on well.ca",
  "",
  "Regimen Lab skincare, a Canadian brand from Toronto",
  "",
  "Derma E scar gel, available on well.ca",
  "",
  "Your practitioner may also be a helpful source of skincare guidance. If you are dealing with hyperpigmentation, ingrown hairs, acne, or other skin concerns alongside electrolysis, ask about how to plan your care.",
].join("\n");

type Props = {
  initial: {
    postcare_aftercare_text: string;
    postcare_warning_signs_text: string;
    postcare_product_recommendations_text: string;
    postcare_review_url: string;
  };
};

type SuggestKey = "aftercare" | "warnings" | "products";

export function PostcareSettingsForm({ initial }: Props) {
  const [aftercare, setAftercare] = useState(initial.postcare_aftercare_text);
  const [warnings, setWarnings] = useState(initial.postcare_warning_signs_text);
  const [products, setProducts] = useState(
    initial.postcare_product_recommendations_text,
  );
  const [reviewUrl, setReviewUrl] = useState(initial.postcare_review_url);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Per-field "click again to replace" confirmation. Stays local
  // until the practitioner confirms; resets when they cancel.
  const [confirming, setConfirming] = useState<SuggestKey | null>(null);

  // Helper: fills a field with its suggested copy. Not a hook;
  // named with a non-"use" prefix so eslint's react-hooks rule
  // doesn't flag callers. If the field is already non-empty, the
  // first click arms a one-shot confirmation and the practitioner
  // must click again to actually replace; this protects existing
  // studio-saved text from a single misclick. The suggested-copy
  // fill does NOT auto-save; the practitioner still has to click
  // "Save postcare settings".
  function applySuggestedCopy(
    key: SuggestKey,
    current: string,
    suggested: string,
    apply: (next: string) => void,
  ) {
    const isEmpty = current.trim().length === 0;
    if (isEmpty) {
      apply(suggested);
      setConfirming(null);
      return;
    }
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    apply(suggested);
    setConfirming(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("postcare_aftercare_text", aftercare);
    fd.set("postcare_warning_signs_text", warnings);
    fd.set("postcare_product_recommendations_text", products);
    fd.set("postcare_review_url", reviewUrl);
    startTransition(async () => {
      try {
        await updateStudioPostcareAction(fd);
        setHint({ kind: "saved" });
        window.setTimeout(() => setHint({ kind: "idle" }), 1500);
      } catch (err) {
        setHint({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to save.",
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-6">
      <div>
        <h3 className="text-base font-medium">Postcare email</h3>
        <p className="mt-1 text-sm text-neutral-500">
          Content sent to the client when you click <em>Send postcare</em> on
          an appointment. You write the clinical content; Hone never invents
          medical advice. Send is always manual; no auto-send.
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-sm font-medium">Aftercare instructions</span>
          <SuggestedCopyButton
            label="Use suggested copy"
            arming={confirming === "aftercare"}
            hasContent={aftercare.trim().length > 0}
            onClick={() =>
              applySuggestedCopy("aftercare", aftercare, AFTERCARE_SUGGESTED, setAftercare)
            }
            onCancel={() => setConfirming(null)}
          />
        </div>
        <textarea
          rows={8}
          value={aftercare}
          onChange={(e) => setAftercare(e.target.value)}
          placeholder={AFTERCARE_PLACEHOLDER}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <span className="text-xs text-neutral-500">
          Required before postcare can be sent. Phrase cooling guidance
          conservatively (e.g. clean cool compress, short intervals) rather
          than naming specific items. Medication guidance should point
          clients to their pharmacist or doctor; electrologists do not
          prescribe.
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-sm font-medium">
            Warning signs / when to contact you
          </span>
          <SuggestedCopyButton
            label="Use suggested copy"
            arming={confirming === "warnings"}
            hasContent={warnings.trim().length > 0}
            onClick={() =>
              applySuggestedCopy("warnings", warnings, WARNINGS_SUGGESTED, setWarnings)
            }
            onCancel={() => setConfirming(null)}
          />
        </div>
        <textarea
          rows={5}
          value={warnings}
          onChange={(e) => setWarnings(e.target.value)}
          placeholder={WARNINGS_PLACEHOLDER}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="text-sm font-medium">Product recommendations</span>
          <SuggestedCopyButton
            label="Use suggested copy"
            arming={confirming === "products"}
            hasContent={products.trim().length > 0}
            onClick={() =>
              applySuggestedCopy("products", products, PRODUCTS_SUGGESTED, setProducts)
            }
            onCancel={() => setConfirming(null)}
          />
        </div>
        <textarea
          rows={4}
          value={products}
          onChange={(e) => setProducts(e.target.value)}
          placeholder={PRODUCTS_PLACEHOLDER}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Review link (optional)
        </span>
        <input
          type="url"
          value={reviewUrl}
          onChange={(e) => setReviewUrl(e.target.value)}
          placeholder="https://g.page/r/your-google-business/review"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <span className="text-xs text-neutral-500">
          When set, the postcare email includes a neutral line: &ldquo;If you
          had a good experience, reviews help small businesses.&rdquo; Hone
          does not condition this on a positive review and does not run any
          review-reward or discount logic.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Saving…" : "Save postcare settings"}
        </button>
        {hint.kind === "saved" && (
          <span className="text-xs text-green-600 dark:text-green-400">
            Saved.
          </span>
        )}
        {hint.kind === "error" && (
          <span className="text-xs text-red-700">{hint.message}</span>
        )}
      </div>
    </form>
  );
}

// "Use suggested copy" affordance per textarea.
//
// Two-state interaction protects existing studio-saved text from a
// single misclick:
//   - When the field is empty: a single click writes the suggested
//     text into the textarea (no DB save; the practitioner still
//     needs to click Save).
//   - When the field already has content: the first click swaps the
//     label to "Replace existing text?" with a Cancel sibling. The
//     practitioner must click the same button a second time to
//     actually replace; Cancel disarms.
function SuggestedCopyButton({
  label,
  arming,
  hasContent,
  onClick,
  onCancel,
}: {
  label: string;
  arming: boolean;
  hasContent: boolean;
  onClick: () => void;
  onCancel: () => void;
}) {
  if (arming) {
    return (
      <span className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={onClick}
          className="rounded-md border border-amber-400 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
        >
          Replace existing text?
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-neutral-500 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-700 dark:decoration-neutral-700 dark:hover:decoration-neutral-300"
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
      title={
        hasContent
          ? "Replaces your current text after a confirmation click."
          : "Fills this field with the suggested wording. You can edit before saving."
      }
    >
      {label}
    </button>
  );
}
