import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar } from '../src/voice/calendar.mjs';
import { buildVapiAssistantConfig } from '../src/voice/assistant-config.mjs';
import { normalizePhoneNumber } from '../src/voice/service.mjs';

function voiceConfig() {
  return {
    calendarProvider: 'calcom',
    timezone: 'Europe/Warsaw',
    holdMinutes: 5,
    calcom: {
      apiKey: 'cal_test_key',
      apiUrl: 'https://api.cal.test',
      defaultAttendeeEmail: 'recepcja@example.com',
      reserveSlots: false,
    },
  };
}

test('polski numer krajowy jest normalizowany bez wymagania dyktowania +48', () => {
  assert.equal(normalizePhoneNumber('600 100 200'), '+48600100200');
  assert.equal(normalizePhoneNumber('48 600-100-200'), '+48600100200');
  assert.equal(normalizePhoneNumber('+49 151 23456789'), '+4915123456789');
  assert.equal(normalizePhoneNumber('123'), null);
});

test('adapter Cal.com używa wersji API slotów 2024-09-04', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          '2030-01-02': [
            { start: '2030-01-02T10:00:00.000+01:00', end: '2030-01-02T11:00:00.000+01:00' },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const calendar = createCalendar(voiceConfig());
    const slots = await calendar.availability({
      date: '2030-01-02',
      service: { name: 'Strzyżenie', durationMinutes: 60, externalEventTypeId: 88 },
    });
    assert.equal(slots.length, 1);
    assert.equal(captured.options.headers['cal-api-version'], '2024-09-04');
    assert.match(captured.url, /eventTypeId=88/);
    assert.match(captured.url, /timeZone=Europe%2FWarsaw/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('adapter Cal.com rezerwuje stały slot bez parametru zmiennej długości', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return Response.json(
      { status: 'success', data: { reservationUid: 'reservation-1' } },
      { status: 201 },
    );
  };
  try {
    const config = voiceConfig();
    config.calcom.reserveSlots = true;
    const calendar = createCalendar(config);
    const uid = await calendar.reserve({
      service: { externalEventTypeId: 88, durationMinutes: 60 },
      startAt: '2030-01-02T09:00:00.000Z',
    });
    assert.equal(uid, 'reservation-1');
    assert.equal(captured.options.headers['cal-api-version'], '2024-09-04');
    assert.equal(captured.body.eventTypeId, 88);
    assert.equal(captured.body.reservationDuration, 5);
    assert.equal(captured.body.slotDuration, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('adapter Cal.com tworzy booking w API 2026-02-25 bez omijania konfliktów', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          uid: 'cal-booking-1',
          start: '2030-01-02T09:00:00.000Z',
          end: '2030-01-02T10:00:00.000Z',
        },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const calendar = createCalendar(voiceConfig());
    const result = await calendar.book({
      hold: {
        id: 'HOLD-1',
        startAt: '2030-01-02T09:00:00.000Z',
        endAt: '2030-01-02T10:00:00.000Z',
      },
      service: { externalEventTypeId: 88 },
      customer: { name: 'Anna Nowak', phone: '+48600100200' },
    });
    assert.equal(result.uid, 'cal-booking-1');
    assert.equal(captured.options.headers['cal-api-version'], '2026-02-25');
    assert.equal(captured.body.attendee.email, 'recepcja@example.com');
    assert.equal(captured.body.allowConflicts, undefined);
    assert.deepEqual(captured.body.metadata, { source: 'voice-reception', holdId: 'HOLD-1' });
    assert.equal(captured.body.metadata.customerPhone, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timeout Cal.com jest błędem kontrolowanym i nie udaje dostępności', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  };
  try {
    const calendar = createCalendar(voiceConfig());
    await assert.rejects(
      calendar.availability({
        date: '2030-01-02',
        service: { name: 'Strzyżenie', durationMinutes: 60, externalEventTypeId: 88 },
      }),
      (error) => error.code === 'CALCOM_TIMEOUT' && error.status === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('limit Cal.com zwraca kontrolowane przeciążenie z Retry-After', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 'error', message: 'Too many requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7' },
    });
  try {
    const calendar = createCalendar(voiceConfig());
    await assert.rejects(
      calendar.availability({
        date: '2030-01-02',
        service: { name: 'Strzyżenie', durationMinutes: 60, externalEventTypeId: 88 },
      }),
      (error) =>
        error.code === 'CALCOM_RATE_LIMITED' && error.status === 503 && error.retryAfter === 7,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('konfiguracja Vapi ujawnia AI i zabezpiecza każdy tool tym samym credentialId', () => {
  const config = {
    publicBaseUrl: 'https://voice.example.com',
    voice: {
      business: { name: 'Atelier Północ' },
      timezone: 'Europe/Warsaw',
      humanTransferNumber: '+48123456789',
      vapi: {
        serverCredentialId: 'cred-123',
        modelProvider: 'openai',
        model: 'gpt-4.1-mini',
        voiceProvider: '',
        voiceId: '',
      },
    },
  };
  const assistant = buildVapiAssistantConfig(config);
  assert.match(assistant.firstMessage, /automatyczna asystentka AI/i);
  assert.match(assistant.model.messages[0].content, /\{\{"now" \| date:/);
  assert.match(assistant.model.messages[0].content, /Konsultacja \(30 min\)/);
  assert.match(assistant.model.messages[0].content, /dziewięć cyfr bez wymagania prefiksu \+48/);
  assert.match(assistant.model.messages[0].content, /User's Keypad Entry/);
  assert.deepEqual(assistant.transcriber, {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'pl',
    numerals: true,
  });
  assert.deepEqual(assistant.backgroundSpeechDenoisingPlan, {
    smartDenoisingPlan: { enabled: true },
  });
  assert.deepEqual(assistant.keypadInputPlan, {
    enabled: true,
    timeoutSeconds: 0,
    delimiters: ['#'],
  });
  assert.equal(assistant.server.credentialId, 'cred-123');
  const functionTools = assistant.model.tools.filter((tool) => tool.type === 'function');
  assert.equal(functionTools.length, 5);
  assert.ok(functionTools.every((tool) => tool.server.credentialId === 'cred-123'));
  assert.deepEqual(functionTools[0].function.parameters.properties.service.enum, [
    'Konsultacja',
    'Strzyżenie',
    'Koloryzacja',
  ]);
  const holdTool = functionTools.find((tool) => tool.function.name === 'create_booking_hold');
  assert.deepEqual(holdTool.function.parameters.required, ['service', 'preferredDate', 'time']);
  assert.match(holdTool.function.parameters.properties.time.description, /piętnasta = 15:00/);
  const phoneTool = functionTools.find((tool) => tool.function.name === 'validate_phone_number');
  assert.deepEqual(phoneTool.function.parameters.required, ['phone']);
  assert.match(assistant.model.messages[0].content, /Nigdy samodzielnie nie liczysz/);
  assert.match(
    functionTools.find((tool) => tool.function.name === 'confirm_booking').function.parameters
      .properties.phone.description,
    /9 cyfr bez prefiksu/,
  );
  assert.ok(assistant.model.tools.some((tool) => tool.type === 'transferCall'));
});
