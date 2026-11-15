import { clientDisplayName, type ClientIdentityFields } from "@/lib/clients/identity";

// The client profile's one name decision (HON-58), matching the directory (OPS option A):
//   - a preferred name exists  -> the header shows the preferred name ALONE; the stored name is not printed
//     (it stays reachable on the Edit page);
//   - no preferred name        -> the stored name is the heading, labelled "Name on file".
// The heading, the avatar initials and every card's `clientName` prop use `display`.
// Legal identity is not involved: this reads only `name` and `preferred_name`.
export function profileNameLines(client: ClientIdentityFields): { display: string; labelAsNameOnFile: boolean } {
  const display = clientDisplayName(client);
  const hasPreferred = (client.preferred_name ?? "").trim() !== "";
  return { display, labelAsNameOnFile: !hasPreferred && display !== "" };
}
