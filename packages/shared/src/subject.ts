// Reply/forward prefixes, in the languages clients commonly send them.
export const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i;

// A subject reduced to what a conversation is "about": prefixes stripped,
// case folded. Threads match on it and the web app compares replies with it.
export function normalizeSubject(subject: string): string {
  return subject.trim().replace(REPLY_PREFIX, "").toLowerCase();
}

// A subject as shown to people: the conversation's topic without "Re:"/"Fwd:".
export function displaySubject(subject: string): string {
  return subject.trim().replace(REPLY_PREFIX, "");
}

// Subject prefixes vacation/out-of-office responders put on their replies
// (`\s` covers the no-break space Outlook puts before a French colon).
const AUTO_REPLY_SUBJECT =
  /^\s*(?:automatic reply|auto[- ]?reply|autoresponse|out of (?:the )?office|abwesenheitsnotiz|automatische antwort|réponse automatique|respuesta automática|risposta automatica|resposta automática|automatisch antwoord)\s*:/i;

export function isAutoReplySubject(subject: string): boolean {
  return AUTO_REPLY_SUBJECT.test(subject);
}
