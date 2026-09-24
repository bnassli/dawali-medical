import "dotenv/config";
import { getDatabaseUrl } from "@/lib/env";
import { seed } from "./seed";

seed(getDatabaseUrl())
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
