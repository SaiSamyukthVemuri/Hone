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

type Props = {
  initial: {
    postcare_aftercare_text: string;
    postcare_warning_signs_text: string;
    postcare_product_recommendations_text: string;
    postcare_review_url: string;
  };
};

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
        <span className="text-sm font-medium">Aftercare instructions</span>
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
        <span className="text-sm font-medium">
          Warning signs / when to contact you
        </span>
        <textarea
          rows={5}
          value={warnings}
          onChange={(e) => setWarnings(e.target.value)}
          placeholder={WARNINGS_PLACEHOLDER}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Product recommendations</span>
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
