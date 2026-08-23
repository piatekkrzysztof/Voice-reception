import { createVoiceDatabase as createSqliteDatabase } from './database.mjs';
import { createPostgresDatabase } from './postgres-database.mjs';

export async function createVoiceDatabase({ config, path, tenantId, seedCalls = [] }) {
  if (config.database.provider === 'postgres') {
    return createPostgresDatabase({ config: config.database, tenantId, seedCalls });
  }
  return createSqliteDatabase({ path, tenantId, seedCalls });
}
