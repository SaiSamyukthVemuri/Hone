import Link from "next/link";
import { SectionLabel } from "@/components/ui/section-label";

// The profile's contact column: how to reach this client, always on screen next to every tab.
// Server component, display only. Phone and email are real tel:/mailto: links with a 44px touch
// target; a value the client does not have is simply absent, not a blank row. The full client
// details (birthday, emergency contact) stay in the Overview's Client info card, and the portal
// access card lives under Messages, so this column does not duplicate them.

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

const LINK =
  "inline-flex min-h-[44px] items-center break-all text-sm text-neutral-800 underline-offset-2 hover:underline dark:text-neutral-200 md:min-h-0";

export function ContactSidebar({
  clientId,
  phone,
  email,
  address,
}: {
  clientId: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}) {
  return (
    // On phones the tab's own content comes first (directly under the tab bar); the contact card follows.
    // From md up it is the left column, in DOM order.
    <aside
      aria-label="Contact"
      data-testid="client-profile-contact"
      className="order-last min-w-0 md:order-none"
    >
      <section className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <SectionLabel as="h2" size="caption">
          Contact
        </SectionLabel>
        {phone && (
          <a href={telHref(phone)} className={LINK}>
            {phone}
          </a>
        )}
        {email && (
          <a href={`mailto:${email}`} className={LINK}>
            {email}
          </a>
        )}
        {address && <p className="whitespace-pre-line text-sm text-neutral-500">{address}</p>}
        {!phone && !email && !address && <p className="text-sm text-neutral-500">Not recorded</p>}
        <Link
          href={`/clients/${clientId}/edit`}
          className="mt-1 inline-flex min-h-[44px] w-fit items-center text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100 md:min-h-0"
        >
          Edit contact
        </Link>
      </section>
    </aside>
  );
}
