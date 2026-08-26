import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig } from '../src/config.mjs';

test('produkcja odrzuca SQLite, HTTP i słabe sekrety', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'http://voice.example.com',
    VOICE_SLOT_SECRET: 'short',
    VOICE_SETUP_TOKEN: 'short',
    VOICE_PROVIDER: 'local',
    CALENDAR_PROVIDER: 'local',
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes('HTTPS')));
  assert.ok(issues.some((issue) => issue.includes('PostgreSQL')));
  assert.ok(issues.some((issue) => issue.includes('VOICE_SLOT_SECRET')));
  assert.ok(issues.some((issue) => issue.includes('VOICE_SETUP_TOKEN')));
});

test('kontrolowane demo produkcyjne akceptuje PostgreSQL i lokalne adaptery po jawnym zezwoleniu', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://voice.example.com',
    DATABASE_URL: 'postgresql://voice:secret@database:5432/voice_reception',
    DATABASE_SSL_MODE: 'disable',
    VOICE_SLOT_SECRET: 'slot-secret-with-more-than-32-characters',
    VOICE_SETUP_TOKEN: 'setup-token-with-more-than-32-characters',
    VOICE_PROVIDER: 'local',
    CALENDAR_PROVIDER: 'local',
    ALLOW_LOCAL_PROVIDERS: 'true',
  });
  assert.deepEqual(validateConfig(config), []);
});
