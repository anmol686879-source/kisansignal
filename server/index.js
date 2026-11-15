import { createApp } from './app.js';
import { openDb, openPostgresDb } from './db.js';
import { makeSender } from './sms.js';

const env = process.env;
if (env.REQUIRE_DATABASE_URL === 'true' && !env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for this deployment.');
}
const db = env.DATABASE_URL
  ? await openPostgresDb(env.DATABASE_URL)
  : openDb(env.DATABASE_FILE || './data/kisansignal.db');
const app = createApp({ db, sms: makeSender(env), env });
const port = Number(env.PORT) || 8080;
const server = app.listen(port, () => console.log(`KisanSignal listening on :${port} (${env.NODE_ENV || 'development'}, sms=${env.SMS_PROVIDER || 'console'})`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(async () => { await db.close(); process.exit(0); }));
