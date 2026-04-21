import type { DB } from "@cfmail/db";
import type { User } from "./auth.ts";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  EMAIL: SendEmail;
  USER_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_URL: string;
  TEMP_DOMAIN: string;
  BETTER_AUTH_SECRET?: string;
}

export interface HonoVars {
  db: DB;
  user: User | null;
  sessionId: string | null;
  shareMailboxId: string | null;
}

export type AppBindings = { Bindings: Env; Variables: HonoVars };
