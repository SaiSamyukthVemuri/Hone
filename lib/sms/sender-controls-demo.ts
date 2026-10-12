// SMS-SENDER-CONTROL-01 (#824): the FAKE provider account the studio number
// controls demonstrate (Codex P2 4250699100). Pure data, safe for the client
// panel to show: synthetic 555-01xx numbers and a synthetic Messaging Service
// SID. Nothing here is a real provider account or a real number.

export const DEMO_ADOPTION_INVENTORY = {
  messagingServiceSid: "MG" + "d0".repeat(16),
  numbers: {
    CA: { phoneNumber: "+14165550142", phoneNumberSid: "PN" + "c0".repeat(16) },
    US: { phoneNumber: "+12125550142", phoneNumberSid: "PN" + "a0".repeat(16) },
  },
} as const;
