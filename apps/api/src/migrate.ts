import { pool, closeDatabase } from "./db.js";
import { migrate } from "./migrations.js";

try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database schema is up to date.");
} finally {
  await closeDatabase();
}
