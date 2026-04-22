import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// Connect to the always-present postgres system DB to create app databases
const systemUrl = url.replace(/\/[^/]+$/, "/postgres");
const admin = postgres(systemUrl, { max: 1 });

for (const dbName of ["inngest", "transcribe"]) {
  const [row] = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  try {
  if (!row) {
    console.log(`Creating database "${dbName}"...`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  }
  } catch (error) {
    console.error("[Database]: failed to create db", dbName)
  }
}

await admin.end();

// Run Drizzle migrations against the transcribe database
const client = postgres(url, { max: 1 });
const db = drizzle(client);
console.log("Running database migrations...");
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations complete.");
await client.end();
