import type { DB } from "@cfmail/db";
import type { Auth, User } from "./auth.ts";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  EMAIL: SendEmail;
  USER_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI: Ai;
}

export interface HonoVars {
  db: DB;
  auth: Auth;
  user: User | null;
  sessionId: string | null;
  shareMailboxId: string | null;
  baseUrl: string;
}

export type AppBindings = { Bindings: Env; Variables: HonoVars };
