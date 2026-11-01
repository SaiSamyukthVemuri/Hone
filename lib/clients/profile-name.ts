import { clientDisplayName, type ClientIdentityFields } from "@/lib/clients/identity";

// The client profile's one name decision (HON-58). The header heading, the avatar initials and every card's
// `clientName` prop use `display` (preferred name when set, else the stored name). When a preferred name
// differs from the stored one, the stored name is shown once, labelled "Name on file", and nowhere else.
// Legal identity is not involved: this reads only `name` and `preferred_name`.
export function profileNameLines(client: ClientIdentityFields): { display: string; nameOnFile: string | null } {
  const display = clientDisplayName(client);
  const stored = (client.name ?? "").replace(/\s+/g, " ").trim();
  return { display, nameOnFile: stored !== "" && stored !== display ? stored : null };
}
