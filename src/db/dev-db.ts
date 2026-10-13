import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * DEVELOPMENT-ONLY persistent local PostgreSQL (`npm run db:dev`,
 * `npm run db:dev:stop`). Never used by CI, tests or production.
 *
 * Runs the real PostgreSQL binaries bundled with the `embedded-postgres`
 * devDependency through `pg_ctl`, with the data directory kept in
 * `.dev-db/data` (git-ignored) so data survives restarts. `pg_ctl` starts the
 * server with a restricted token, which is what lets it run from an elevated
 * (Administrator) Windows shell where launching `postgres.exe` directly is
 * refused (docs/DECISIONS.md ADR-017).
 *
 * Host, port, user, password and database are taken from DATABASE_URL.
 */

const ROOT = process.cwd();
const DEV_DIR = path.join(ROOT, ".dev-db");
const DATA_DIR = path.join(DEV_DIR, "data");
const LOG_FILE = path.join(DEV_DIR, "postgres.log");
const PWFILE = path.join(DEV_DIR, "pwfile.tmp");

interface DevTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function readTarget(): DevTarget {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set (see .env.example).");
  const url = new URL(raw);
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `db:dev only manages a LOCAL database; DATABASE_URL host is "${host}". Refusing.`,
    );
  }
  return {
    host,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || "postgres",
  };
}

function binDir(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const dir = path.join(
    ROOT,
    "node_modules",
    "@embedded-postgres",
    `${platform}-${process.arch}`,
    "native",
    "bin",
  );
  if (!existsSync(dir)) {
    throw new Error(`PostgreSQL binaries not found at ${dir}. Run "npm install".`);
  }
  return dir;
}

function exe(name: string): string {
  return path.join(binDir(), process.platform === "win32" ? `${name}.exe` : name);
}

async function canConnect(t: DevTarget, database: string): Promise<boolean> {
  const client = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    client.end().catch(() => undefined);
    return false;
  }
}

function initCluster(t: DevTarget): void {
  mkdirSync(DEV_DIR, { recursive: true });
  writeFileSync(PWFILE, t.password, { mode: 0o600 });
  try {
    console.log(`Initialising new dev cluster in ${DATA_DIR} ...`);
    execFileSync(
      exe("initdb"),
      [
        "-D",
        DATA_DIR,
        "-U",
        t.user,
        `--pwfile=${PWFILE}`,
        "--auth=scram-sha-256",
        // Match CI/production (UTF8); Windows would otherwise default to WIN1252.
        "--encoding=UTF8",
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(PWFILE, { force: true });
  }
}

async function start(): Promise<void> {
  const t = readTarget();

  if (await canConnect(t, "postgres")) {
    console.log(`PostgreSQL already accepting connections on ${t.host}:${t.port}.`);
  } else {
    if (!existsSync(path.join(DATA_DIR, "PG_VERSION"))) initCluster(t);
    console.log(`Starting PostgreSQL on ${t.host}:${t.port} ...`);
    execFileSync(
      exe("pg_ctl"),
      [
        "-D",
        DATA_DIR,
        "-l",
        LOG_FILE,
        "-o",
        `-p ${t.port} -c listen_addresses=${t.host}`,
        "-w",
        "-t",
        "60",
        "start",
      ],
      // Do not inherit our stdio: the long-lived server would keep the caller's
      // pipes open and hang `npm run db:dev`. Server output goes to LOG_FILE.
      { stdio: "ignore" },
    );
  }

  const admin = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: "postgres",
  });
  await admin.connect();
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [
      t.database,
    ]);
    if (found.rowCount === 0) {
      // Identifier comes from our own DATABASE_URL; quote it defensively.
      await admin.query(`create database "${t.database.replace(/"/g, '""')}"`);
      console.log(`Created database ${t.database}.`);
    }
  } finally {
    await admin.end();
  }
  console.log(`Dev database ready: ${t.host}:${t.port}/${t.database} (data in .dev-db/data).`);
}

function stop(): void {
  if (!existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
    console.log("No dev cluster found; nothing to stop.");
    return;
  }
  execFileSync(exe("pg_ctl"), ["-D", DATA_DIR, "-m", "fast", "-w", "stop"], {
    stdio: "inherit",
  });
}

const command = process.argv[2] ?? "start";
Promise.resolve()
  .then(() => {
    if (command === "start") return start();
    if (command === "stop") return stop();
    throw new Error(`Unknown command "${command}" (use start | stop).`);
  })
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("db:dev failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
