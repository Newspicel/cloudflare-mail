// Reply/forward prefixes, in the languages clients commonly send them.
export const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i;

// A subject reduced to what a conversation is "about": prefixes stripped,
// case folded. Threads match on it and the web app compares replies with it.
export function normalizeSubject(subject: string): string {
  return subject.trim().replace(REPLY_PREFIX, "").toLowerCase();
}
