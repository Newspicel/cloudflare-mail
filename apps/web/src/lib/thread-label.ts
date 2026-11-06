import { useQuery } from "@tanstack/react-query";
import { mailboxesQuery } from "./queries.ts";

type Participant = { name?: string; address: string };

// `you+tag@x` is still you.
function baseAddress(address: string): string {
  const [local = "", domain = ""] = address.toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

/** The addresses of every mailbox the user can see: "you" in a thread. */
export function useOwnAddresses(): Set<string> {
  const { data } = useQuery(mailboxesQuery);
  return new Set((data?.mailboxes ?? []).map((m) => baseAddress(m.address)));
}

/**
 * Who a thread is with: its first participant that isn't you, so a
 * conversation you started lists under the person you wrote to.
 */
export function counterpart(
  participants: Participant[],
  own: Set<string>,
): Participant | undefined {
  return participants.find((p) => !own.has(baseAddress(p.address))) ?? participants[0];
}
