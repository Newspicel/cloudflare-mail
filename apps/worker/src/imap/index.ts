// Entry point for inbound TCP (the Worker's `connect` handler). Cloudflare
// Spectrum terminates TLS and hands us the plaintext socket; one invocation
// lives for the whole IMAP session.

import { makeDB } from "@cfmail/db";
import type { Env } from "../env.ts";
import { ImapSession } from "./session.ts";

export async function handleImapConnection(socket: Socket, env: Env): Promise<void> {
  let ip: string | null = null;
  try {
    ip = (await socket.opened).remoteAddress ?? null;
  } catch {
    // no socket info — rate limit by username only
  }
  const session = new ImapSession(
    {
      readable: socket.readable as ReadableStream<Uint8Array>,
      writable: socket.writable as WritableStream<Uint8Array>,
      close: () => socket.close(),
    },
    env,
    makeDB(env.DB),
    ip,
  );
  await session.run();
}
