// Failures raised below the HTTP layer — mail pipelines, permissions, rate
// limiting. They carry a transport-neutral code so the same failure can become
// a JSON 4xx/5xx on the API and a tagged NO on IMAP; only the transport edges
// (api/index.ts, imap/session.ts) translate codes. Nothing outside `api/` may
// throw Hono's HTTPException.
export type AppErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "upstream"
  | "internal";

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const STATUS = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  upstream: 502,
  internal: 500,
} as const;

export function httpStatus(code: AppErrorCode): (typeof STATUS)[AppErrorCode] {
  return STATUS[code];
}

// Run an insert/update, mapping a SQLite UNIQUE violation to a conflict while
// letting every other error surface — so FK/schema bugs aren't masked as
// "already in use". Drizzle wraps the driver error ("Failed query: …") and
// stashes the original "UNIQUE constraint failed" text on `.cause`, so match
// the whole cause chain.
export async function wrapUnique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("conflict", message);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (/UNIQUE/i.test(e.message)) return true;
  }
  return false;
}
