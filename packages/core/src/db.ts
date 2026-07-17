import postgres from "postgres";

export type Database = ReturnType<typeof postgres>;

export function connectDatabase(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error("DATABASE_URL is required");
  return postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
}
