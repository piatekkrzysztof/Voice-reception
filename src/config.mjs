import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function boolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integer(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const voiceProvider = env.VOICE_PROVIDER || (env.VAPI_API_KEY ? 'vapi' : 'local');
  const calendarProvider = env.CALENDAR_PROVIDER || (env.CALCOM_API_KEY ? 'calcom' : 'local');
  const databaseUrl = env.DATABASE_URL || '';
  const pilotMode = boolean(env.PILOT_MODE);

  return {
    projectRoot,
    nodeEnv,
    production,
    port: Number(env.PORT || 4173),
    host: env.HOST || '127.0.0.1',
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 4173}`).replace(
      /\/$/,
      '',
    ),
    pilotMode,
    allowLocalProviders: boolean(env.ALLOW_LOCAL_PROVIDERS),
    database: {
      provider: databaseUrl ? 'postgres' : 'sqlite',
      url: databaseUrl,
      sslMode: env.DATABASE_SSL_MODE || (production ? 'verify-full' : 'disable'),
      poolMax: Number(env.DATABASE_POOL_MAX || 10),
      idleTimeoutMs: Number(env.DATABASE_IDLE_TIMEOUT_MS || 30_000),
      connectionTimeoutMs: Number(env.DATABASE_CONNECTION_TIMEOUT_MS || 5_000),
      statementTimeoutMs: Number(env.DATABASE_STATEMENT_TIMEOUT_MS || 10_000),
    },
    auth: {
      cookieName: 'voice_session',
      sessionHours: Number(env.VOICE_SESSION_HOURS || 8),
      loginMaxAttempts: Number(env.VOICE_LOGIN_MAX_ATTEMPTS || 5),
      loginWindowMinutes: Number(env.VOICE_LOGIN_WINDOW_MINUTES || 15),
      setupToken: env.VOICE_SETUP_TOKEN || '',
      secureCookies: /^https:\/\//.test(env.PUBLIC_BASE_URL || ''),
    },
    operations: {
      maxInflight: Number(env.HTTP_MAX_INFLIGHT || 25),
      requestTimeoutMs: Number(env.HTTP_REQUEST_TIMEOUT_MS || 15_000),
      alerts: {
        webhookUrl: env.ALERT_WEBHOOK_URL || '',
        bearerToken: env.ALERT_WEBHOOK_BEARER_TOKEN || '',
        cooldownMinutes: Number(env.ALERT_COOLDOWN_MINUTES || 10),
        timeoutMs: Number(env.ALERT_TIMEOUT_MS || 3_000),
      },
      retention: {
        enabled: boolean(env.DATA_RETENTION_ENABLED, production),
        intervalMinutes: Number(env.DATA_RETENTION_INTERVAL_MINUTES || 360),
        callsDays: Number(env.DATA_RETENTION_CALLS_DAYS || 30),
        bookingsDays: Number(env.DATA_RETENTION_BOOKINGS_DAYS || 365),
        eventsDays: Number(env.DATA_RETENTION_EVENTS_DAYS || 90),
        holdsDays: Number(env.DATA_RETENTION_HOLDS_DAYS || 7),
      },
    },
    voice: {
      databasePath: resolve(projectRoot, env.VOICE_DATABASE_PATH || 'data/voice.sqlite'),
      provider: voiceProvider,
      calendarProvider,
      timezone: env.VOICE_TIMEZONE || 'Europe/Warsaw',
      slotSecret: env.VOICE_SLOT_SECRET || 'local-development-slot-secret',
      webhookSecret: env.VOICE_WEBHOOK_SECRET || '',
      humanTransferNumber: env.VOICE_HUMAN_TRANSFER_NUMBER || '',
      holdMinutes: Number(env.VOICE_HOLD_MINUTES || 5),
      business: {
        tenantId: env.VOICE_TENANT_ID || 'atelier-polnoc',
        name: env.VOICE_BUSINESS_NAME || 'Atelier Północ',
        locale: env.VOICE_LOCALE || 'pl-PL',
      },
      vapi: {
        apiKey: env.VAPI_API_KEY || '',
        assistantId: env.VAPI_ASSISTANT_ID || '',
        phoneNumberId: env.VAPI_PHONE_NUMBER_ID || '',
        serverCredentialId: env.VAPI_SERVER_CREDENTIAL_ID || '',
        apiUrl: (env.VAPI_API_URL || 'https://api.vapi.ai').replace(/\/$/, ''),
        modelProvider: env.VAPI_MODEL_PROVIDER || 'openai',
        model: env.VAPI_MODEL || 'gpt-4.1-mini',
        voiceProvider: env.VAPI_VOICE_PROVIDER || '',
        voiceId: env.VAPI_VOICE_ID || '',
      },
      calcom: {
        apiKey: env.CALCOM_API_KEY || '',
        apiUrl: (env.CALCOM_API_URL || 'https://api.cal.com').replace(/\/$/, ''),
        timeoutMs: Number(env.CALCOM_TIMEOUT_MS || 8_000),
        defaultAttendeeEmail: env.CALCOM_DEFAULT_ATTENDEE_EMAIL || '',
        reserveSlots: boolean(env.CALCOM_RESERVE_SLOTS),
        eventTypes: {
          coloring: integer(env.CALCOM_EVENT_TYPE_KOLORYZACJA),
          haircut: integer(env.CALCOM_EVENT_TYPE_STRZYZENIE),
          consultation: integer(env.CALCOM_EVENT_TYPE_KONSULTACJA),
        },
      },
    },
  };
}

export function validateConfig(config) {
  const issues = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    issues.push('PORT musi być liczbą od 1 do 65535.');
  if (!['sqlite', 'postgres'].includes(config.database.provider))
    issues.push('Nieobsługiwany provider bazy danych.');
  if (config.database.provider === 'postgres' && !/^postgres(ql)?:\/\//.test(config.database.url))
    issues.push('DATABASE_URL musi być prawidłowym adresem PostgreSQL.');
  if (!['disable', 'no-verify', 'verify-full'].includes(config.database.sslMode))
    issues.push('DATABASE_SSL_MODE musi mieć wartość disable, no-verify albo verify-full.');
  if (!Number.isInteger(config.operations.maxInflight) || config.operations.maxInflight < 1)
    issues.push('HTTP_MAX_INFLIGHT musi być dodatnią liczbą całkowitą.');
  if (
    !Number.isInteger(config.operations.requestTimeoutMs) ||
    config.operations.requestTimeoutMs < 1_000
  )
    issues.push('HTTP_REQUEST_TIMEOUT_MS musi mieć co najmniej 1000 ms.');
  if (
    config.operations.alerts.webhookUrl &&
    !/^https?:\/\//.test(config.operations.alerts.webhookUrl)
  )
    issues.push('ALERT_WEBHOOK_URL musi być prawidłowym adresem HTTP(S).');
  if (
    !Number.isInteger(config.operations.alerts.cooldownMinutes) ||
    config.operations.alerts.cooldownMinutes < 0
  )
    issues.push('ALERT_COOLDOWN_MINUTES nie może być ujemny.');
  if (!Number.isInteger(config.voice.calcom.timeoutMs) || config.voice.calcom.timeoutMs < 500)
    issues.push('CALCOM_TIMEOUT_MS musi mieć co najmniej 500 ms.');
  for (const [name, value] of Object.entries({
    DATA_RETENTION_INTERVAL_MINUTES: config.operations.retention.intervalMinutes,
    DATA_RETENTION_CALLS_DAYS: config.operations.retention.callsDays,
    DATA_RETENTION_BOOKINGS_DAYS: config.operations.retention.bookingsDays,
    DATA_RETENTION_EVENTS_DAYS: config.operations.retention.eventsDays,
    DATA_RETENTION_HOLDS_DAYS: config.operations.retention.holdsDays,
  })) {
    if (!Number.isInteger(value) || value < 1)
      issues.push(`${name} musi być dodatnią liczbą całkowitą.`);
  }

  if (config.pilotMode) {
    if (!config.production) issues.push('PILOT_MODE wymaga NODE_ENV=production.');
    if (config.allowLocalProviders)
      issues.push('PILOT_MODE nie pozwala na ALLOW_LOCAL_PROVIDERS=true.');
    if (config.voice.provider !== 'vapi' || config.voice.calendarProvider !== 'calcom')
      issues.push('PILOT_MODE wymaga prawdziwych integracji Vapi i Cal.com.');
    if (config.voice.webhookSecret.length < 32)
      issues.push('PILOT_MODE wymaga VOICE_WEBHOOK_SECRET o długości co najmniej 32 znaków.');
    if (!config.voice.humanTransferNumber)
      issues.push('PILOT_MODE wymaga VOICE_HUMAN_TRANSFER_NUMBER do eskalacji rozmowy.');
    if (!config.voice.calcom.defaultAttendeeEmail)
      issues.push('PILOT_MODE wymaga CALCOM_DEFAULT_ATTENDEE_EMAIL dla rozmów bez e-maila.');
    if (!config.voice.calcom.reserveSlots)
      issues.push('PILOT_MODE wymaga CALCOM_RESERVE_SLOTS=true.');
    if (!config.operations.retention.enabled)
      issues.push('PILOT_MODE wymaga DATA_RETENTION_ENABLED=true.');
    if (!/^https:\/\//.test(config.operations.alerts.webhookUrl))
      issues.push('PILOT_MODE wymaga ALERT_WEBHOOK_URL używającego HTTPS.');
  }

  if (config.production) {
    if (!/^https:\/\//.test(config.publicBaseUrl))
      issues.push('PUBLIC_BASE_URL musi używać HTTPS w środowisku produkcyjnym.');
    if (
      config.operations.alerts.webhookUrl &&
      !/^https:\/\//.test(config.operations.alerts.webhookUrl)
    )
      issues.push('ALERT_WEBHOOK_URL musi używać HTTPS w środowisku produkcyjnym.');
    if (config.database.provider !== 'postgres')
      issues.push('Środowisko produkcyjne wymaga DATABASE_URL do PostgreSQL.');
    if (
      config.voice.slotSecret.length < 32 ||
      config.voice.slotSecret === 'local-development-slot-secret'
    )
      issues.push('VOICE_SLOT_SECRET musi mieć co najmniej 32 losowe znaki.');
    if (config.auth.setupToken.length < 32)
      issues.push('VOICE_SETUP_TOKEN musi mieć co najmniej 32 losowe znaki.');
    if (
      !config.allowLocalProviders &&
      (config.voice.provider === 'local' || config.voice.calendarProvider === 'local')
    ) {
      issues.push(
        'Produkcja wymaga Vapi i Cal.com. Dla kontrolowanego demo ustaw ALLOW_LOCAL_PROVIDERS=true.',
      );
    }
    if (config.voice.provider === 'vapi') {
      if (!config.voice.webhookSecret) issues.push('VOICE_WEBHOOK_SECRET jest wymagany dla Vapi.');
      if (
        !config.voice.vapi.apiKey ||
        !config.voice.vapi.assistantId ||
        !config.voice.vapi.phoneNumberId ||
        !config.voice.vapi.serverCredentialId
      ) {
        issues.push('Vapi wymaga API key, assistant ID, phone number ID i server credential ID.');
      }
    }
    if (config.voice.calendarProvider === 'calcom') {
      if (
        !config.voice.calcom.apiKey ||
        Object.values(config.voice.calcom.eventTypes).some((value) => !value)
      ) {
        issues.push('Cal.com wymaga API key i identyfikatorów wszystkich typów wydarzeń.');
      }
    }
  }
  return issues;
}

export function assertValidConfig(config) {
  const issues = validateConfig(config);
  if (!issues.length) return;
  const error = new Error(`Nieprawidłowa konfiguracja:\n- ${issues.join('\n- ')}`);
  error.code = 'CONFIG_INVALID';
  throw error;
}

export function publicVoiceConfig(config) {
  const voice = config.voice;
  const externalUrlReady = /^https:\/\//.test(config.publicBaseUrl);
  return {
    business: voice.business,
    timezone: voice.timezone,
    pilotMode: config.pilotMode,
    provider: voice.provider,
    calendarProvider: voice.calendarProvider,
    webhookUrl: `${config.publicBaseUrl}/api/webhooks/vapi`,
    integrations: {
      database: {
        name: 'Booking DB',
        detail:
          config.database.provider === 'postgres' ? 'PostgreSQL / pool' : 'SQLite / transakcje',
        mode: config.database.provider === 'postgres' ? 'external' : 'local',
        ready: true,
      },
      voice: {
        name: 'Telefonia AI',
        detail: voice.provider === 'vapi' ? 'Vapi' : 'Adapter lokalny',
        mode: voice.provider === 'vapi' ? 'external' : 'local',
        ready:
          voice.provider === 'local' ||
          Boolean(voice.vapi.apiKey && voice.vapi.assistantId && voice.vapi.phoneNumberId),
      },
      calendar: {
        name: 'Kalendarz',
        detail: voice.calendarProvider === 'calcom' ? 'Cal.com' : 'Adapter lokalny',
        mode: voice.calendarProvider === 'calcom' ? 'external' : 'local',
        ready:
          voice.calendarProvider === 'local' ||
          Boolean(voice.calcom.apiKey && Object.values(voice.calcom.eventTypes).every(Boolean)),
      },
      publicWebhook: {
        name: 'Publiczny edge',
        detail: externalUrlReady ? 'HTTPS' : 'Tylko localhost',
        mode: externalUrlReady ? 'external' : 'local',
        ready: externalUrlReady,
      },
      webhookAuth: {
        name: 'Webhook auth',
        detail: voice.webhookSecret ? 'Credential aktywny' : 'Tryb lokalny',
        mode: voice.webhookSecret ? 'secured' : 'local',
        ready:
          voice.provider === 'local' ||
          Boolean(voice.webhookSecret && voice.vapi.serverCredentialId),
      },
      operations: {
        name: 'Operacje pilota',
        detail:
          config.operations.retention.enabled && config.operations.alerts.webhookUrl
            ? 'Retencja i alerty aktywne'
            : 'Wymaga retencji i odbiornika alertów',
        mode: config.operations.retention.enabled ? 'retention' : 'local',
        ready: Boolean(config.operations.retention.enabled && config.operations.alerts.webhookUrl),
      },
    },
  };
}
