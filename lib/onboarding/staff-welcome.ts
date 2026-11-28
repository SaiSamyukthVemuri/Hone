export type StaffRole = "practitioner" | "receptionist";

export function staffWelcomeKey(role: StaffRole, membershipId: string) {
  return `hone_welcome_${role}_${membershipId}`;
}

export function staffWelcomeSteps(role: StaffRole, booking: boolean) {
  if (role === "practitioner")
    return [
      {
        text: "Check the name clients see on your schedule.",
        link: "Open my profile",
        href: "/settings/profile",
      },
      {
        text: "Open your calendar and choose one of your visits.",
        link: "Open my calendar",
        href: "/calendar",
      },
      {
        text: "Open the client from that visit to review their history before charting.",
      },
    ];
  return [
    {
      text: "Choose Month, Week or Day to see the studio schedule.",
      link: "Open day schedule",
      href: "/desk?view=day",
    },
    {
      text: "Open an appointment to see its practitioner and the contact details available for that visit.",
    },
    ...(booking
      ? [
          {
            text: "Use Find time, choose an opening, then search for the client. Check the contact hint before confirming the booking.",
          },
        ]
      : []),
  ];
}
