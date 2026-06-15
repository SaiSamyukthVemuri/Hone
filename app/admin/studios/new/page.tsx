import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type { PendingInvitation, Studio } from "@/lib/types/database";
import { createStudioWithOwnerInvite } from "./actions";

// Internal operator surface; never indexed. (Belt-and-braces over the
// /admin layout's isAdmin gate and the noindex on the app generally.)
export const metadata = {
  title: "New studio · Admin",
  robots: { index: false, follow: false },
};

const FIELD =
  "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";
const LABEL = "block text-sm font-medium text-neutral-800 dark:text-neutral-200";
const HINT = "mt-1 text-xs text-neutral-500";

async function loadCreated(id: string): Promise<{
  studio: Studio;
  invitation: PendingInvitation | null;
} | null> {
  const admin = createAdminClient();
  const { data: studio } = await admin
    .from("studios")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!studio) return null;
  const { data: invitation } = await admin
    .from("pending_invitations")
    .select("*")
    .eq("studio_id", id)
    .eq("role", "owner")
    .order("created_at", { ascending: false })
    .maybeSingle();
  return {
    studio: studio as Studio,
    invitation: (invitation ?? null) as PendingInvitation | null,
  };
}

export default async function NewStudioPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; error?: string }>;
}) {
  const { created, error } = await searchParams;

  if (created) {
    const result = await loadCreated(created);
    if (result) {
      return (
        <SuccessPanel
          studio={result.studio}
          invitation={result.invitation}
        />
      );
    }
  }

  return <WizardForm error={error ?? null} />;
}

function WizardForm({ error }: { error: string | null }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          New studio
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Create a studio and owner invitation. Internal setup only.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </div>
      ) : null}

      <form
        action={createStudioWithOwnerInvite}
        className="flex max-w-xl flex-col gap-5"
      >
        <div>
          <label htmlFor="name" className={LABEL}>
            Studio name
          </label>
          <input id="name" name="name" type="text" required className={FIELD} />
        </div>

        <div>
          <label htmlFor="slug" className={LABEL}>
            Booking slug
          </label>
          <input
            id="slug"
            name="slug"
            type="text"
            required
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            pattern="[a-z0-9](?:[a-z0-9\-]{0,62}[a-z0-9])?"
            placeholder="lauraelectrolysis"
            className={FIELD}
          />
          <p className={HINT}>
            Lowercase letters, numbers, and hyphens. Becomes
            <span className="font-mono"> /book/&lt;slug&gt;</span>. Must be
            unique.
          </p>
        </div>

        <div>
          <label htmlFor="owner_display_name" className={LABEL}>
            Owner display name
          </label>
          <input
            id="owner_display_name"
            name="owner_display_name"
            type="text"
            required
            className={FIELD}
          />
        </div>

        <div>
          <label htmlFor="owner_email" className={LABEL}>
            Owner email
          </label>
          <input
            id="owner_email"
            name="owner_email"
            type="email"
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="laura@example.com"
            className={FIELD}
          />
          <p className={HINT}>
            The owner must sign in with this exact address (magic link or Google
            with the same email).
          </p>
        </div>

        <div>
          <label htmlFor="timezone" className={LABEL}>
            Timezone
          </label>
          <input
            id="timezone"
            name="timezone"
            type="text"
            required
            defaultValue="America/Toronto"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={FIELD}
          />
          <p className={HINT}>IANA name, e.g. America/Toronto.</p>
        </div>

        <details className="rounded-md border border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <summary className="cursor-pointer text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Optional details
          </summary>
          <div className="mt-4 flex flex-col gap-5">
            <div>
              <label htmlFor="booking_description" className={LABEL}>
                Booking description
              </label>
              <textarea
                id="booking_description"
                name="booking_description"
                rows={2}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="address" className={LABEL}>
                Address
              </label>
              <input
                id="address"
                name="address"
                type="text"
                className={FIELD}
              />
            </div>
          </div>
        </details>

        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          Creates the studio and an <strong>owner</strong> invitation only. The
          owner&rsquo;s practitioner account is created when they first sign in
          with the invited email. No payments, no Stripe, no emails are sent.
        </div>

        <div>
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Create studio &amp; owner invitation
          </button>
        </div>
      </form>
    </div>
  );
}

function SuccessPanel({
  studio,
  invitation,
}: {
  studio: Studio;
  invitation: PendingInvitation | null;
}) {
  const bookingPath = `/book/${studio.slug}`;
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header>
        <Link
          href="/admin"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Studio created
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {studio.name} and its owner invitation are ready.
        </p>
      </header>

      <dl className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <Row label="Studio">{studio.name}</Row>
        <Row label="Booking URL">
          <Link href={bookingPath} className="font-mono underline">
            {bookingPath}
          </Link>
        </Row>
        <Row label="Timezone">{studio.timezone}</Row>
        <Row label="Owner email">{studio.owner_email}</Row>
        <Row label="Owner invitation">
          {invitation
            ? `${invitation.role} · ${invitation.status}`
            : "created"}
        </Row>
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          Next setup steps
        </h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          <li>Owner signs in at /login with the invited email.</li>
          <li>Configure services (Settings → Services).</li>
          <li>Configure availability (Settings → Availability).</li>
          <li>
            Verify the booking page (
            <Link href={bookingPath} className="font-mono underline">
              {bookingPath}
            </Link>
            ).
          </li>
          <li>Run a smoke test (docs/20 §4).</li>
          <li>Live payments remain disabled.</li>
        </ol>
      </section>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link href={`/admin/studios/${studio.id}`} className="underline">
          View studio
        </Link>
        <Link href="/admin/studios/new" className="underline">
          Create another studio
        </Link>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
