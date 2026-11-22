# Client groups

Owners can organise the client directory using reusable names such as Paused,
Follow up or Completed. These are labels chosen by the studio, not a statement
that treatment has finished or that a client can book, owes money or has consented.
Nothing is sent when a group changes.

From **Clients → Manage groups**, create or rename a group. Names contain 1–60
characters, are unique regardless of capitalisation and surrounding spaces, and
are limited to 100 groups per studio. A rename updates the label wherever it is
shown. If another tab has renamed it, reload before editing again.

On the client's **Overview → Client groups**, add a group or remove one assigned
group. A client can belong to several groups. Each action changes only that one
membership. Existing assignments survive Active / Archived changes. First release
has no automatic assignment, bulk changes or group deletion.

On **Clients**, choose one group beside the existing search/sort controls. It
combines with the current view, name/email/phone search, intake, upcoming-appointment
and last-visit controls. Counts and pagination describe the combined result. Group
names are not added to the general text-search definition.

Groups are available only to studio owners. Practitioners and receptionists do not
receive group names or memberships. If support is not installed or a read fails,
the ordinary directory remains usable and the group section says unavailable.
A requested group that cannot be checked stops results until retried or removed;
it never silently expands the selection to all clients.

Deployment is pending the [reviewed SQL proposal](proposals/client-groups/README.md)
and OPS qualification. This document describes the prepared workflow, not proof
that a hosted migration has been applied.
