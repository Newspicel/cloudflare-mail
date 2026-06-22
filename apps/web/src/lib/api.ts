export class ApiError extends Error {
  constructor(
    public status: number,
    public payload: unknown,
    message: string,
  ) {
    super(message);
  }
}

function extractMessage(payload: unknown, status: number): string {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const msg = obj.error ?? obj.message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return `Request failed (${status})`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
    ...init,
  });
  if (!res.ok) {
    // Read the body once, then try to parse it — reading twice throws
    // "body stream already read".
    const raw = await res.text();
    let payload: unknown = raw;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      // not JSON — keep the raw text
    }
    throw new ApiError(res.status, payload, extractMessage(payload, res.status));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
