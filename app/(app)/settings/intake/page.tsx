import { INTAKE_STEPS, type Question } from "@/lib/intake/questions";

// Backend-only preview of the current health intake form. Server-
// rendered, read-only, no `<form>` element, no submit handler, no DB
// reads, no token. The page maps over INTAKE_STEPS (the same source of
// truth the public intake wizard and the practitioner intake review
// already consume) and renders each question as a disabled control.
//
// Inputs are disabled as a secondary defense; the primary guarantee is
// the absence of any form element / server action / client component.
// Nothing on this page can mutate state.
//
// Conditional questions are shown in line with their step, annotated
// with a "Shown when ..." caption resolved from the parent question's
// label + the value-set the conditional fires on. This keeps the
// preview faithful to what a real intake feels like while making the
// branching legible at a glance.
//
// Render mode: dynamic by default (the route lives inside the
// authenticated (app)/settings layout, which loads the current
// practitioner via cookies on every request). The previous
// `force-static` directive made Next.js statically pre-render this
// route at build time; with no cookies present at build, the parent
// layout's getCurrentPractitionerWithStudio() redirected to /login,
// and that redirect was baked into the static output. Every
// subsequent request was served the baked redirect regardless of the
// caller's real auth state. Removing the directive lets the route
// render per-request alongside the layout's auth check.
export const metadata = { title: "Intake form preview" };

export default function IntakePreviewPage() {
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
