import { makeDB } from "@cfmail/db";
import type { Context } from "hono";
import type { AppBindings } from "./env.ts";

export function dbFromCtx(c: Context<AppBindings>) {
  const existing = c.get("db");
  if (existing) return existing;
  const db = makeDB(c.env.DB);
  c.set("db", db);
  return db;
}
