import { schema } from "@cfmail/db";
import { getAuthTables } from "better-auth/db";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { authPlugins, userAdditionalFields } from "../src/auth.ts";

// Better Auth owns the canonical column set for its tables (core + the admin,
// twoFactor and passkey plugins). We hand-write those tables in schema.ts so we
// keep snake_case casing, secondary indexes, the shared timestamp helpers and
// the explanatory comments — none of which the Better Auth CLI emits. To stop
// the two drifting on a version bump, this test asks Better Auth for the exact
// fields it expects and diffs them against the live Drizzle definitions.
//
// If it fails after upgrading better-auth: reconcile schema.ts to match, then
// `pnpm --filter @cfmail/db generate` a migration for the change.

// getAuthTables() model key -> our Drizzle table export.
const TABLES: Record<string, SQLiteTable> = {
  user: schema.user,
  session: schema.session,
  account: schema.account,
  verification: schema.verification,
  twoFactor: schema.twoFactor,
  passkey: schema.passkey,
};

// Better Auth field.type -> Drizzle column.dataType (array/json types are
// skipped — none of our auth columns use them).
const TYPE_TO_DATATYPE: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  date: "date",
};

const expected = getAuthTables({
  plugins: authPlugins("https://example.com"),
  user: { additionalFields: userAdditionalFields },
});

describe("better-auth schema vs schema.ts", () => {
  it("maps every model Better Auth expects", () => {
    expect(Object.keys(expected).toSorted()).toEqual(Object.keys(TABLES).toSorted());
  });

  for (const [model, table] of Object.entries(expected)) {
    const drizzle = TABLES[model];
    if (!drizzle) continue;

    const cols = getTableColumns(drizzle);
    const fks = getTableConfig(drizzle).foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        from: ref.columns.map((c) => c.name),
        toTable: getTableName(ref.foreignTable),
      };
    });

    describe(model, () => {
      for (const [field, attr] of Object.entries(table.fields)) {
        it(field, () => {
          const col = cols[field];
          if (!col) throw new Error(`schema.${model} is missing column "${field}"`);

          const wantType = TYPE_TO_DATATYPE[attr.type as string];
          if (wantType) expect(col.dataType).toBe(wantType);

          // required defaults to true; a required field must be NOT NULL.
          if (attr.required !== false) expect(col.notNull).toBe(true);

          if (attr.unique) expect(col.isUnique).toBe(true);

          if (attr.references) {
            const target = TABLES[attr.references.model];
            const toTable = target ? getTableName(target) : attr.references.model;
            const match = fks.find((f) => f.from.includes(col.name) && f.toTable === toTable);
            expect(
              match,
              `${model}.${field} should reference ${attr.references.model}.${attr.references.field}`,
            ).toBeDefined();
          }
        });
      }
    });
  }
});
