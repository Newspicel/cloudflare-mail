import type { AppType } from "@cfmail/worker/api";
import type { ClientResponse } from "hono/client";
import { hc } from "hono/client";
import type { ResponseFormat } from "hono/types";
import type { SuccessStatusCode } from "hono/utils/http-status";

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

// Typed RPC client over the worker's composed Hono app (`AppType` is imported
// type-only — no worker code ships to the browser). Every request path and
// response body is checked against the actual route definitions at compile time.
const client = hc<AppType>("/", {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { credentials: "include", ...init }),
});

export const rpc = client.api;

// The JSON body of the success arm(s) of a route's response union. Error arms
// (4xx/5xx `{ error }` bodies) surface as a thrown ApiError instead, and
// contentless responses (204) yield undefined.
type OkBody<R> =
  R extends ClientResponse<infer D, infer S, infer F>
    ? S extends SuccessStatusCode
      ? F extends "json"
        ? D
        : undefined
      : never
    : never;

// Await an RPC call, keeping the old `api()` error contract: non-2xx throws an
// ApiError carrying status + parsed payload; 204 resolves to undefined.
export async function unwrap<R extends ClientResponse<unknown, number, ResponseFormat>>(
  promise: Promise<R>,
): Promise<OkBody<R>> {
  const res = await promise;
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
  if (res.status === 204) return undefined as OkBody<R>;
  return (await res.json()) as OkBody<R>;
}
