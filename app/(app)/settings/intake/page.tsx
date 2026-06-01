import { INTAKE_STEPS, type Question } from "@/lib/intake/questions";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { PostcareSettingsForm } from "../studio/PostcareSettingsForm";
import { PolicySettingsForm } from "../studio/PolicySettingsForm";

// Intake & Postcare settings page. Two surfaces:
//
//   1. Read-only preview of the current health intake form (the same
//      INTAKE_STEPS the public wizard and the practitioner intake
//      review consume). No `<form>`, no server action, no DB read.
//      Inputs are disabled as a secondary defense; the primary
//      guarantee is the absence of mutation primitives.
//
//   2. Owner-only Postcare email content editor. Previously lived
//      under Settings → Studio; moved here so postcare content sits
//      next to the intake form (Chloe expected to find it near the
//      forms area, not under Studio). The form component itself is
//      reused unchanged; no data, schema, action, send, or template
//      behaviour was modified by this move.
//
// Conditional questions are shown in line with their step, annotated
// with a "Shown when ..." caption resolved from the parent question's
// label + the value-set the conditional fires on. This keeps the
// preview faithful to what a real intake feels like while making the
// branching legible at a glance.
//
// Render mode: dynamic (default). The route lives inside the
// authenticated (app)/settings layout, which loads the current
// practitioner via cookies on every request. The prior `force-static`
// directive was removed in PR #90 because it caused Next.js to
// pre-render the route at build time and bake a redirect to /login
// into the static output.
export const metadata = { title: "Intake & Postcare" };

export default async function IntakeAndPostcarePage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-medium">Intake form preview</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Preview only. Nothing here is saved or sent.
        </p>
        <p className="text-xs text-neutral-500">
          This is the current health intake form your clients see when they
          open a booking confirmation or an intake update link.
        </p>
      </div>
      <ol className="flex flex-col gap-6">
        {INTAKE_STEPS.map((step) => (
          <li
            key={step.id}
            className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
          >
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Step {step.id} of {INTAKE_STEPS.length} &middot; {step.shortLabel}
              </span>
              <h3 className="text-lg font-medium tracking-tight">
                {step.title}
              </h3>
              {step.description && (
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {step.description}
                </p>
              )}
            </div>
            <ul className="mt-5 flex flex-col gap-5">
              {step.questions.map((q) => (
                <li key={q.key}>
                  <QuestionPreview q={q} stepQuestions={step.questions} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      {isOwner && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="border-t border-neutral-200 dark:border-neutral-800" />
          <div className="flex flex-col gap-2">
            <h2 id="postcare" className="scroll-mt-24 text-xl font-medium">
              Postcare email content
            </h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Used by the manual <em>Send postcare</em> button on an
              appointment. You write the clinical content; Hone never
              invents medical advice. Send is always manual; no
              auto-send. Postcare data lives on the studio record and
              is unchanged by moving this editor here.
            </p>
          </div>
          <PostcareSettingsForm
            initial={{
              postcare_aftercare_text: studio.postcare_aftercare_text ?? "",
              postcare_warning_signs_text:
                studio.postcare_warning_signs_text ?? "",
              postcare_product_recommendations_text:
                studio.postcare_product_recommendations_text ?? "",
              postcare_review_url: studio.postcare_review_url ?? "",
              postcare_review_prompt_text:
                studio.postcare_review_prompt_text ?? "",
              postcare_contact_email: studio.postcare_contact_email ?? "",
            }}
            studioOwnerEmail={studio.owner_email}
          />

          <div className="border-t border-neutral-200 dark:border-neutral-800" />

          <PolicySettingsForm
            initial={{
              cancellation_policy_text: studio.cancellation_policy_text ?? "",
              no_show_policy_text: studio.no_show_policy_text ?? "",
              policy_version: studio.policy_version,
              policy_updated_at: studio.policy_updated_at,
            }}
          />
        </div>
      )}
    </section>
  );
}

function QuestionPreview({
  q,
  stepQuestions,
}: {
  q: Question;
  stepQuestions: ReadonlyArray<Question>;
}) {
  const conditional = q.conditional
    ? formatConditional(q.conditional, stepQuestions)
    : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <label className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {q.label}
          {q.required && <span className="ml-1 text-red-600">*</span>}
        </label>
        {q.helpText && (
          <span className="text-xs text-neutral-500">{q.helpText}</span>
        )}
        {conditional && (
          <span className="text-xs italic text-neutral-500">{conditional}</span>
        )}
      </div>
      <Control q={q} />
      {q.followUpNotesPrompt && (
        <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {q.followUpNotesPrompt}
          </span>
          <textarea
            aria-label={q.followUpNotesPrompt}
            disabled
            rows={2}
            placeholder="Client follow-up notes"
            className="min-h-[44px] w-full cursor-not-allowed rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950"
          />
        </div>
      )}
    </div>
  );
}

// Renders a static, non-interactive version of each question type.
// No <form>, no onChange handlers, all native inputs disabled. The
// component is a Server Component; no React state is created.
function Control({ q }: { q: Question }) {
  const baseDisabled =
    "cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900";

  if (q.type === "short_text") {
    return (
      <input
        type="text"
        disabled
        placeholder="Client answer"
        aria-label={q.label}
        className={`min-h-[44px] w-full ${baseDisabled}`}
      />
    );
  }
  if (q.type === "long_text") {
    return (
      <textarea
        disabled
        rows={3}
        placeholder="Client answer"
        aria-label={q.label}
        className={`min-h-[44px] w-full ${baseDisabled}`}
      />
    );
  }
  if (q.type === "date") {
    return (
      <input
        type="date"
        disabled
        aria-label={q.label}
        className={`min-h-[44px] w-full ${baseDisabled}`}
      />
    );
  }
  if (q.type === "yes_no") {
    return (
      <div className="flex gap-2">
        {[
          { v: "yes", label: "Yes" },
          { v: "no", label: "No" },
        ].map((opt) => (
          <span
            key={opt.v}
            className="min-h-[44px] flex-1 cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 text-center text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {opt.label}
          </span>
        ))}
      </div>
    );
  }
  if (q.type === "single_select") {
    return (
      <div className="flex flex-col gap-2">
        {(q.options ?? []).map((opt) => (
          <span
            key={opt.value}
            className="min-h-[44px] cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {opt.label}
          </span>
        ))}
      </div>
    );
  }
  if (q.type === "multi_select") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(q.options ?? []).map((opt) => (
          <span
            key={opt.value}
            className="min-h-[44px] cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {opt.label}
          </span>
        ))}
      </div>
    );
  }
  if (q.type === "checkbox") {
    return (
      <span className="flex items-start gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900">
        <input
          type="checkbox"
          disabled
          aria-label={q.label}
          className="mt-0.5 h-5 w-5 cursor-not-allowed rounded border-neutral-300"
        />
        <span>{q.label}</span>
      </span>
    );
  }
  return null;
}

// Build a human-readable "Shown when ..." caption from a conditional
// rule by looking up the parent question's label and translating each
// allowed value to its option label (or "Yes"/"No" for yes_no). Pure
// function over the step's question list; no I/O.
function formatConditional(
  rule: { whenKey: string; whenEquals: ReadonlyArray<string> },
  stepQuestions: ReadonlyArray<Question>,
): string {
  const parent = stepQuestions.find((qq) => qq.key === rule.whenKey);
  const parentLabel = parent ? parent.label : rule.whenKey;
  const valueLabels = rule.whenEquals.map((v) => {
    if (parent?.type === "yes_no") {
      return v === "yes" ? "Yes" : v === "no" ? "No" : v;
    }
    const opt = parent?.options?.find((o) => o.value === v);
    return opt?.label ?? v;
  });
  const joined =
    valueLabels.length <= 1
      ? valueLabels.join("")
      : valueLabels.length === 2
        ? valueLabels.join(" or ")
        : `${valueLabels.slice(0, -1).join(", ")}, or ${valueLabels[valueLabels.length - 1]}`;
  return `Shown when "${parentLabel}" is ${joined}.`;
}
