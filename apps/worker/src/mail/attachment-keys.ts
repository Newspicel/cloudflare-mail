import { HTTPException } from "hono/http-exception";

// Client-supplied attachment r2Keys must live in the caller's own upload
// namespace (attachments.ts always writes `draft/<userId>/...`). Without this
// check a user could reference any key in the bucket — reading other tenants'
// raw mail on send, or deleting it on draft delete (CLAUDE.md invariant 5).
export function assertOwnedAttachmentKeys(
  userId: string,
  attachments: ReadonlyArray<{ r2Key: string }> | undefined,
): void {
  const prefix = `draft/${userId}/`;
  for (const att of attachments ?? []) {
    if (!att.r2Key.startsWith(prefix)) {
      throw new HTTPException(400, { message: "invalid attachment key" });
    }
  }
}
