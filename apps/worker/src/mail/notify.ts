import type { Env } from "../env.ts";

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// Best-effort transactional email (password reset, invites, etc.).
// Failures are logged but never thrown — auth flows should not 5xx on a
// missing or unverified sending domain.
export async function sendMail(env: Env, mail: OutgoingMail): Promise<void> {
  try {
    await env.EMAIL.send({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    });
  } catch (err) {
    console.error("notify.sendMail failed", err);
  }
}
