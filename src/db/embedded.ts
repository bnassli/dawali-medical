import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not determine a free port")));
      }
    });
  });
}

export interface EmbeddedPostgresHandle {
  connectionString: string;
  stop: () => Promise<void>;
}

/**
 * Starts a throwaway, real PostgreSQL instance using the `embedded-postgres`
 * package (real Postgres binaries, no Docker/psql required). Used by the
 * Vitest global setup and `npm run db:validate` when TEST_DATABASE_URL is
 * not set.
 */
export async function startEmbeddedPostgres(
  databaseName = "dawali_test",
): Promise<EmbeddedPostgresHandle> {
  const port = await findFreePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "dawali-embedded-pg-"));

  // Capture recent log/error lines so that if the underlying postgres
  // process exits early (which the `embedded-postgres` package surfaces as
  // an opaque, reason-less rejection), we can still throw something
  // actionable instead of "undefined". A common cause on Windows is running
  // as an Administrator — real PostgreSQL refuses to start under an
  // administrative account for security reasons; run as a standard
  // (non-admin) OS user, or set TEST_DATABASE_URL to point at a real
  // reachable PostgreSQL instance instead.
  const recentOutput: string[] = [];
  const record = (messageOrError: unknown) => {
    const text =
      messageOrError instanceof Error
        ? messageOrError.message
        : String(messageOrError);
    recentOutput.push(text.trim());
    if (recentOutput.length > 40) recentOutput.shift();
  };

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    onLog: record,
    onError: record,
  });

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(databaseName);
  } catch (err) {
    const detail = recentOutput.filter(Boolean).join("\n");
    throw new Error(
      `Embedded PostgreSQL failed to start (port ${port}, dataDir ${dataDir}).` +
        (detail ? `\n--- postgres output ---\n${detail}` : "") +
        `\n--- original error ---\n${String(err instanceof Error ? err.stack ?? err.message : err)}`,
    );
  }

  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/${databaseName}`;

  return {
    connectionString,
    stop: async () => {
      await pg.stop();
    },
  };
}
