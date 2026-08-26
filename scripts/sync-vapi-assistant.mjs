import { loadConfig } from '../src/config.mjs';
import { buildVapiAssistantConfig } from '../src/voice/assistant-config.mjs';

const config = loadConfig();
const vapi = config.voice.vapi;

if (!vapi.apiKey) throw new Error('Ustaw VAPI_API_KEY w pliku .env.');
if (!/^https:\/\//.test(config.publicBaseUrl))
  throw new Error('PUBLIC_BASE_URL musi być publicznym adresem HTTPS dostępnym dla Vapi.');
if (!config.voice.webhookSecret)
  console.warn(
    'UWAGA: VOICE_WEBHOOK_SECRET jest pusty. Skonfiguruj Vapi Custom Credential przed pilotem.',
  );
if (config.voice.webhookSecret && !vapi.serverCredentialId)
  console.warn('UWAGA: dodaj VAPI_SERVER_CREDENTIAL_ID, aby Vapi wysyłało sekret do webhooka.');

const assistant = buildVapiAssistantConfig(config);
const endpoint = vapi.assistantId
  ? `${vapi.apiUrl}/assistant/${vapi.assistantId}`
  : `${vapi.apiUrl}/assistant`;
const method = vapi.assistantId ? 'PATCH' : 'POST';
const response = await fetch(endpoint, {
  method,
  headers: { authorization: `Bearer ${vapi.apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify(assistant),
  signal: AbortSignal.timeout(20_000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Vapi ${response.status}: ${JSON.stringify(payload)}`);
console.log(`${vapi.assistantId ? 'Zaktualizowano' : 'Utworzono'} asystenta Vapi: ${payload.id}`);
if (!vapi.assistantId) console.log(`Dodaj do .env: VAPI_ASSISTANT_ID=${payload.id}`);
