// Compose-template placeholders. Each token is replaced at insert time with a
// value pulled from the current compose context (recipient, sender, date). The
// settings editor lists these so users know what they can drop into a body.

export interface TemplateContext {
  recipientName?: string;
  recipientEmail?: string;
  myName?: string;
  myEmail?: string;
}

export const TEMPLATE_TOKENS: { token: string; label: string }[] = [
  { token: "{{recipient_name}}", label: "Recipient name" },
  { token: "{{recipient_first_name}}", label: "Recipient first name" },
  { token: "{{recipient_email}}", label: "Recipient email" },
  { token: "{{my_name}}", label: "Your name" },
  { token: "{{my_email}}", label: "Your email" },
  { token: "{{date}}", label: "Today's date" },
];

/** Substitute {{tokens}} in a template body/subject from the compose context. */
export function fillTemplate(input: string, ctx: TemplateContext): string {
  const recipientName = ctx.recipientName?.trim() ?? "";
  const values: Record<string, string> = {
    recipient_name: recipientName,
    recipient_first_name: recipientName.split(/\s+/)[0] ?? "",
    recipient_email: ctx.recipientEmail?.trim() ?? "",
    my_name: ctx.myName?.trim() ?? "",
    my_email: ctx.myEmail?.trim() ?? "",
    date: new Date().toLocaleDateString(),
  };
  return input.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}
