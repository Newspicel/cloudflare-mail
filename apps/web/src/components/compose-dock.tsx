import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api.ts";
import { type MessageRow, mailboxesQuery } from "@/lib/queries.ts";

interface ComposeState {
  open: boolean;
  replyToMessage: MessageRow | null;
  initialTo?: string;
}

const listeners = new Set<(s: ComposeState) => void>();
let state: ComposeState = { open: false, replyToMessage: null };

export function openCompose(partial: Partial<ComposeState> = {}): void {
  state = { ...state, open: true, replyToMessage: null, initialTo: undefined, ...partial };
  for (const l of listeners) l(state);
}
export function closeCompose(): void {
  state = { open: false, replyToMessage: null };
  for (const l of listeners) l(state);
}

export function ComposeDock() {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  if (!s.open) return null;
  return <ComposePanel state={s} />;
}

function ComposePanel({ state: s }: { state: ComposeState }) {
  const qc = useQueryClient();
  const { data: mailboxes } = useQuery(mailboxesQuery);
  const sendable = (mailboxes?.mailboxes ?? []).filter((m) => (m.perms & 2) === 2);

  const [mailboxId, setMailboxId] = useState(s.replyToMessage?.mailboxId ?? sendable[0]?.id ?? "");
  const [to, setTo] = useState(s.replyToMessage?.fromAddr ?? s.initialTo ?? "");
  const [subject, setSubject] = useState(
    s.replyToMessage ? prefixSubject(s.replyToMessage.subject) : "",
  );
  const [text, setText] = useState("");

  const send = useMutation({
    mutationFn: async () => {
      return api<{ messageId: string; threadId: string }>("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          mailboxId,
          to: to
            .split(/[,;]\s*/)
            .filter(Boolean)
            .map((address) => ({ address })),
          subject,
          text,
          inReplyTo: s.replyToMessage?.id ? undefined : undefined,
        }),
      });
    },
    onSuccess: () => {
      toast.success("Message sent");
      qc.invalidateQueries({ queryKey: ["threads", mailboxId] });
      closeCompose();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Send failed");
    },
  });

  return (
    <div className="fixed bottom-0 right-6 z-40 flex h-[520px] w-[520px] flex-col overflow-hidden rounded-t-xl border bg-card shadow-2xl shadow-black/20">
      <div className="flex items-center justify-between bg-foreground/95 px-4 py-2 text-background">
        <div className="text-sm font-medium">New message</div>
        <button
          type="button"
          onClick={closeCompose}
          className="rounded p-1 text-background/80 hover:bg-background/10 hover:text-background"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-4 py-3 text-sm">
        <label className="flex items-center gap-2 border-b py-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">From</span>
          <select
            value={mailboxId}
            onChange={(e) => setMailboxId(e.target.value)}
            className="flex-1 bg-transparent outline-none"
          >
            {sendable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 border-b py-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">To</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            className="flex-1 bg-transparent outline-none"
          />
        </label>
        <label className="flex items-center gap-2 border-b py-1.5">
          <span className="w-12 shrink-0 text-xs text-muted-foreground">Subject</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1 bg-transparent outline-none"
          />
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 resize-none bg-transparent py-2 outline-none"
          placeholder="Write your message…"
        />
      </div>
      <div className="flex items-center justify-between border-t px-4 py-3">
        <button
          type="button"
          onClick={() => send.mutate()}
          disabled={send.isPending || !mailboxId || !to}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-105 disabled:opacity-50"
        >
          {send.isPending ? "Sending…" : "Send"}
        </button>
        <span className="text-xs text-muted-foreground">
          {sendable.length === 0 && "No sendable mailboxes"}
        </span>
      </div>
    </div>
  );
}

function prefixSubject(s: string): string {
  if (/^re:/i.test(s.trim())) return s;
  return `Re: ${s}`;
}
