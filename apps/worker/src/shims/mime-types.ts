// Minimal stand-in for `mime-types`, aliased in for the Worker build (see
// wrangler.jsonc). mimetext is the only consumer and only calls `contentType()`
// to validate attachment content types — a truthy return means "accepted" and
// the original string (not this return value) is what lands in the header. So
// we just confirm the input looks like `type/subtype` and skip pulling in the
// ~134 KB mime-db lookup table.
export function contentType(input: unknown): string | false {
  if (typeof input !== "string") return false;
  const t = input.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][\w!#$&^.+-]*\/[a-z0-9][\w!#$&^.+-]*$/.test(t) ? input : false;
}

export default { contentType };
