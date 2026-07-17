import { connectDatabase } from "./db.ts";
import { migrate } from "./migrations.ts";

const db = connectDatabase();
await migrate(db);
await db.end();
