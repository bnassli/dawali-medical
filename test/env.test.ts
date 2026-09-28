import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

/** Docker Compose passes unset optional settings as empty strings (R6a). */
describe("environment parsing", () => {
  it("treats empty optional values as unset instead of failing", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@db:5432/d",
      APP_ORIGIN: "https://localhost",
      ANTHROPIC_API_KEY: "",
      INVOICE_AI_MODEL: "",
      SEED_ADMIN_EMAIL: "",
      SEED_ADMIN_PASSWORD: " ",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.INVOICE_AI_MODEL).toBe("claude-sonnet-5");
    expect(env.SEED_ADMIN_EMAIL).toBeUndefined();
    expect(env.SEED_ADMIN_PASSWORD).toBeUndefined();
  });

  it("still rejects a value that is set but invalid", () => {
    expect(() => parseEnv({ SEED_ADMIN_EMAIL: "not-an-email" })).toThrow();
  });
});
