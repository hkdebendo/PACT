// Optional: `npm run db:generate` diffs schema.ts against the database with drizzle-kit.
// The committed SQL in migrations/ is what PACT actually runs.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/db/src/schema.ts',
  out: './packages/db/drizzle-out',
  dbCredentials: { url: './data/pact.db' },
});
