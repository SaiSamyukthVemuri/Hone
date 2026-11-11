// 0325: the recipient's "None of these times work" (both answers required) and "I no longer need an appointment" are used only when this flag is
// on. OFF BY DEFAULT, and the off path is the existing screen, unchanged. Turning it on before 0325 is applied would make every such tap fail closed
// with an honest message, so enabling it is a release step that follows the apply, not a code change. Exactly "1" enables it.
export function waitlistDeclineAnswersEnabled(): boolean {
  return process.env.WAITLIST_DECLINE_ANSWERS === "1";
}
