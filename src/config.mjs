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
  const voiceProvider = env.VOICE_PROVIDER || (env.VAPI_API_KEY ? 'vapi' : 'local');
  const calendarProvider = env.CALENDAR_PROVIDER || (env.CALCOM_API_KEY ? 'calcom' : 'local');

  return {
    projectRoot,
    port: Number(env.PORT || 4173),
    host: env.HOST || '127.0.0.1',
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://127.0.0.1:${env.PORT || 4173}`).replace(/\/$/, ''),
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
        locale: env.VOICE_LOCALE || 'pl-PL'
      },
      vapi: {
        apiKey: env.VAPI_API_KEY || '',
        assistantId: env.VAPI_ASSISTANT_ID || '',
        phoneNumberId: env.VAPI_PHONE_NUMBER_ID || '',
        serverCredentialId: env.VAPI_SERVER_CREDENTIAL_ID || '',
        apiUrl: (env.VAPI_API_URL || 'https://api.vapi.ai').replace(/\/$/, '')
      },
      calcom: {
        apiKey: env.CALCOM_API_KEY || '',
        apiUrl: (env.CALCOM_API_URL || 'https://api.cal.com').replace(/\/$/, ''),
        defaultAttendeeEmail: env.CALCOM_DEFAULT_ATTENDEE_EMAIL || '',
        reserveSlots: boolean(env.CALCOM_RESERVE_SLOTS),
        eventTypes: {
          coloring: integer(env.CALCOM_EVENT_TYPE_KOLORYZACJA),
          haircut: integer(env.CALCOM_EVENT_TYPE_STRZYZENIE),
          consultation: integer(env.CALCOM_EVENT_TYPE_KONSULTACJA)
        }
      }
    }
  };
}

export function publicVoiceConfig(config) {
  const voice = config.voice;
  const externalUrlReady = /^https:\/\//.test(config.publicBaseUrl);
  return {
    business: voice.business,
    timezone: voice.timezone,
    provider: voice.provider,
    calendarProvider: voice.calendarProvider,
    webhookUrl: `${config.publicBaseUrl}/api/webhooks/vapi`,
    integrations: {
      database: { name: 'Booking DB', detail: 'SQLite / transakcje', mode: 'live', ready: true },
      voice: {
        name: 'Telefonia AI',
        detail: voice.provider === 'vapi' ? 'Vapi' : 'Adapter lokalny',
        mode: voice.provider === 'vapi' ? 'external' : 'local',
        ready: voice.provider === 'local' || Boolean(voice.vapi.apiKey && voice.vapi.assistantId && voice.vapi.phoneNumberId)
      },
      calendar: {
        name: 'Kalendarz',
        detail: voice.calendarProvider === 'calcom' ? 'Cal.com' : 'Adapter lokalny',
        mode: voice.calendarProvider === 'calcom' ? 'external' : 'local',
        ready: voice.calendarProvider === 'local' || Boolean(voice.calcom.apiKey && Object.values(voice.calcom.eventTypes).every(Boolean))
      },
      publicWebhook: {
        name: 'Publiczny edge',
        detail: externalUrlReady ? 'HTTPS' : 'Tylko localhost',
        mode: externalUrlReady ? 'external' : 'local',
        ready: externalUrlReady
      },
      webhookAuth: {
        name: 'Webhook auth',
        detail: voice.webhookSecret ? 'Credential aktywny' : 'Tryb lokalny',
        mode: voice.webhookSecret ? 'secured' : 'local',
        ready: voice.provider === 'local' || Boolean(voice.webhookSecret && voice.vapi.serverCredentialId)
      }
    }
  };
}
