import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export type DB = ReturnType<typeof makeDB>;

export function makeDB(d1: D1Database) {
  return drizzle(d1, { schema, casing: "snake_case" });
}

export * from "./schema.ts";
export { schema };
