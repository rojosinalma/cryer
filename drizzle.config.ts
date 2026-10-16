import { defineConfig } from "drizzle-kit";

// Only used to generate SQL from the schema (bunx drizzle-kit generate). The runtime migration
// runner is src/db/migrate.ts; copy generated statements into src/db/migrations/NNNN_*.sql.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
