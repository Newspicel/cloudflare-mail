import { useState } from "react";
import type { DraftRow, MailboxSummary, MessageRow } from "@/lib/queries.ts";
import { plusBase } from "./compose-utils.ts";

interface Options {
  draft: DraftRow | null | undefined;
  replyTo: MessageRow | null;
  forward: MessageRow | null;
  sendable: MailboxSummary[];
}

// The composer's "From" identity: the sending mailbox plus an optional
// plus-alias override, including any custom "+tag" aliases typed in compose.
export function useFromAddress({ draft: d, replyTo: rep, forward: fwd, sendable }: Options) {
  const [mailboxId, setMailboxId] = useState(
    d?.mailboxId ?? rep?.mailboxId ?? fwd?.mailboxId ?? sendable[0]?.id ?? "",
  );
  // Sender override: a plus-alias of the chosen mailbox, or null for its own
  // address. On reply, default to the sub-address the mail was delivered to
  // (hi+tag@) so the answer goes out from the same alias.
  const [fromAddress, setFromAddress] = useState<string | null>(() => {
    if (d) return d.fromAddress ?? null;
    const dt = rep?.deliveredTo;
    const mbAddr = sendable.find((m) => m.id === rep?.mailboxId)?.address;
    if (
      dt &&
      mbAddr &&
      dt.toLowerCase() !== mbAddr.toLowerCase() &&
      plusBase(dt) === mbAddr.toLowerCase()
    )
      return dt;
    return null;
  });
  const baseAddr = (id: string) => sendable.find((m) => m.id === id)?.address ?? "";
  // Custom plus-aliases the user typed in compose, so they stay selectable.
  const [customAliases, setCustomAliases] = useState<{ address: string; mailboxId: string }[]>(
    () => {
      if (d?.fromAddress && plusBase(d.fromAddress))
        return [{ address: d.fromAddress, mailboxId: d.mailboxId }];
      return [];
    },
  );
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusTag, setPlusTag] = useState("");
  // Selectable "From" addresses: each sendable mailbox, the plus-addressed
  // envelope recipient when replying to one, plus any custom alias the user added.
  const fromOptions = (() => {
    const opts = sendable.map((m) => ({ address: m.address, mailboxId: m.id }));
    const dt = rep?.deliveredTo;
    const mb = sendable.find((m) => m.id === rep?.mailboxId);
    if (
      dt &&
      mb &&
      plusBase(dt) === mb.address.toLowerCase() &&
      !opts.some((o) => o.address.toLowerCase() === dt.toLowerCase())
    )
      opts.push({ address: dt, mailboxId: mb.id });
    for (const c of customAliases)
      if (!opts.some((o) => o.address.toLowerCase() === c.address.toLowerCase())) opts.push(c);
    return opts;
  })();
  const currentFrom = fromAddress ?? baseAddr(mailboxId);
  // Apply the "+tag" typed in the picker as a sub-address of the chosen mailbox.
  const applyPlusTag = () => {
    const base = baseAddr(mailboxId);
    const at = base.lastIndexOf("@");
    if (at <= 0) return;
    const tag = plusTag.trim().replace(/^\++/, "").replace(/\s+/g, "");
    const addr = tag ? `${base.slice(0, at)}+${tag}@${base.slice(at + 1)}` : base;
    if (tag)
      setCustomAliases((prev) =>
        prev.some((c) => c.address.toLowerCase() === addr.toLowerCase())
          ? prev
          : [...prev, { address: addr, mailboxId }],
      );
    setFromAddress(tag ? addr : null);
    setPlusOpen(false);
    setPlusTag("");
  };

  return {
    mailboxId,
    setMailboxId,
    fromAddress,
    setFromAddress,
    baseAddr,
    fromOptions,
    currentFrom,
    plusOpen,
    setPlusOpen,
    plusTag,
    setPlusTag,
    applyPlusTag,
  };
}

export type FromAddress = ReturnType<typeof useFromAddress>;
