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

test('Render przekazuje publiczny adres HTTPS bez ręcznego wpisywania domeny', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: '',
    RENDER_EXTERNAL_URL: 'https://voice-reception.onrender.com/',
    DATABASE_URL: 'postgresql://voice:secret@database.example.com:5432/voice_reception',
    DATABASE_SSL_MODE: 'verify-full',
    VOICE_SLOT_SECRET: 'slot-secret-with-more-than-32-characters',
    VOICE_SETUP_TOKEN: 'setup-token-with-more-than-32-characters',
    VOICE_PROVIDER: 'local',
    CALENDAR_PROVIDER: 'local',
    ALLOW_LOCAL_PROVIDERS: 'true',
  });

  assert.equal(config.publicBaseUrl, 'https://voice-reception.onrender.com');
  assert.equal(config.auth.secureCookies, true);
  assert.deepEqual(validateConfig(config), []);
});

test('tryb prawdziwego pilota wymaga integracji, retencji i bezpiecznego alertu', () => {
  const config = loadConfig({
    PILOT_MODE: 'true',
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://voice.example.com',
    DATABASE_URL: 'postgresql://voice:secret@database:5432/voice_reception',
    VOICE_SLOT_SECRET: 'slot-secret-with-more-than-32-characters',
    VOICE_SETUP_TOKEN: 'setup-token-with-more-than-32-characters',
    VOICE_PROVIDER: 'local',
    CALENDAR_PROVIDER: 'local',
    ALLOW_LOCAL_PROVIDERS: 'true',
    DATA_RETENTION_ENABLED: 'false',
    ALERT_WEBHOOK_URL: 'http://alerts.example.com',
  });
  const issues = validateConfig(config);
  assert.ok(issues.some((issue) => issue.includes('prawdziwych integracji')));
  assert.ok(issues.some((issue) => issue.includes('DATA_RETENTION_ENABLED')));
  assert.ok(issues.some((issue) => issue.includes('ALERT_WEBHOOK_URL')));
  assert.ok(issues.some((issue) => issue.includes('ALLOW_LOCAL_PROVIDERS')));
});

test('kompletna konfiguracja pilota przechodzi bramkę startową', () => {
  const config = loadConfig({
    PILOT_MODE: 'true',
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://voice.example.com',
    DATABASE_URL: 'postgresql://voice:secret@database:5432/voice_reception',
    DATABASE_SSL_MODE: 'disable',
    VOICE_SLOT_SECRET: 'slot-secret-with-more-than-32-characters',
    VOICE_SETUP_TOKEN: 'setup-token-with-more-than-32-characters',
    VOICE_WEBHOOK_SECRET: 'webhook-secret-with-more-than-32-characters',
    VOICE_HUMAN_TRANSFER_NUMBER: '+48123456789',
    VOICE_PROVIDER: 'vapi',
    VAPI_API_KEY: 'vapi-key',
    VAPI_ASSISTANT_ID: 'assistant-id',
    VAPI_PHONE_NUMBER_ID: 'phone-id',
    VAPI_SERVER_CREDENTIAL_ID: 'credential-id',
    CALENDAR_PROVIDER: 'calcom',
    CALCOM_API_KEY: 'cal-key',
    CALCOM_DEFAULT_ATTENDEE_EMAIL: 'recepcja@example.com',
    CALCOM_RESERVE_SLOTS: 'true',
    CALCOM_EVENT_TYPE_KOLORYZACJA: '101',
    CALCOM_EVENT_TYPE_STRZYZENIE: '102',
    CALCOM_EVENT_TYPE_KONSULTACJA: '103',
    DATA_RETENTION_ENABLED: 'true',
    ALERT_WEBHOOK_URL: 'https://alerts.example.com/voice',
  });
  assert.deepEqual(validateConfig(config), []);
});
