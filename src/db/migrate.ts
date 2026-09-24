import "dotenv/config";
import { getDatabaseUrl } from "@/lib/env";
import { runMigrations } from "./migrator";

runMigrations(getDatabaseUrl())
  .then(() => {
    console.log("Migrations applied successfully.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
