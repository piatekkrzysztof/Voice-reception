import { assertValidConfig, loadConfig } from '../src/config.mjs';
import { createPostgresDatabase } from '../src/voice/postgres-database.mjs';

const config = loadConfig();
if (config.database.provider !== 'postgres') {
  throw new Error('Ustaw DATABASE_URL, aby uruchomić migracje PostgreSQL.');
}
assertValidConfig(config);

const database = await createPostgresDatabase({
  config: config.database,
  tenantId: config.voice.business.tenantId,
});
await database.close();
console.log('Migracje PostgreSQL zostały zastosowane.');
