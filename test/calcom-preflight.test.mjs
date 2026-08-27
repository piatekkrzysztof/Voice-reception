import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCalcomConfiguration } from '../src/voice/calcom-preflight.mjs';

function configuration(overrides = {}) {
  return {
    apiKey: 'cal_test_secret',
    apiUrl: 'https://api.cal.test',
    timeoutMs: 8_000,
    defaultAttendeeEmail: 'recepcja@example.com',
    reserveSlots: true,
    eventTypes: { coloring: 101, haircut: 102, consultation: 103 },
    ...overrides,
  };
}

function successfulFetch(requests) {
  return async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/v2/event-types'))
      return Response.json({
        status: 'success',
        data: [
          { id: 101, title: 'Koloryzacja', lengthInMinutes: 120 },
          { id: 102, title: 'Strzyżenie', lengthInMinutes: 60 },
          { id: 103, title: 'Konsultacja', lengthInMinutes: 30 },
        ],
      });
    return Response.json({
      status: 'success',
      data: { '2030-01-02': [{ start: '2030-01-02T09:00:00Z' }] },
    });
  };
}

test('preflight wskazuje wszystkie brakujące dane bez wysyłania żądania', async () => {
  let called = false;
  const result = await checkCalcomConfiguration({
    calcom: configuration({
      apiKey: '',
      defaultAttendeeEmail: '',
      reserveSlots: false,
      eventTypes: { coloring: null, haircut: null, consultation: null },
    }),
    fetchImpl: async () => {
      called = true;
    },
  });
  assert.equal(result.ready, false);
  assert.equal(called, false);
  assert.ok(result.issues.some((issue) => issue.includes('CALCOM_API_KEY')));
  assert.ok(result.issues.some((issue) => issue.includes('CALCOM_DEFAULT_ATTENDEE_EMAIL')));
  assert.ok(result.issues.some((issue) => issue.includes('CALCOM_RESERVE_SLOTS')));
  assert.equal(result.issues.filter((issue) => issue.includes('Uzupełnij ID')).length, 3);
  assert.equal(
    result.issues.some((issue) => issue.includes('null min')),
    false,
  );
});

test('po podaniu klucza preflight pokazuje ID typów wydarzeń przed pełnym mapowaniem', async () => {
  const requests = [];
  const result = await checkCalcomConfiguration({
    calcom: configuration({
      defaultAttendeeEmail: '',
      eventTypes: { coloring: null, haircut: null, consultation: null },
    }),
    fetchImpl: successfulFetch(requests),
    now: new Date('2030-01-01T12:00:00Z'),
  });
  assert.equal(result.ready, false);
  assert.equal(requests.length, 1);
  assert.equal(result.eventTypes.length, 3);
  assert.deepEqual(
    result.eventTypes.map((eventType) => eventType.id),
    [101, 102, 103],
  );
});

test('preflight uwierzytelnia API v2 i potwierdza trzy zgodne typy wydarzeń', async () => {
  const requests = [];
  const result = await checkCalcomConfiguration({
    calcom: configuration(),
    fetchImpl: successfulFetch(requests),
    now: new Date('2030-01-01T12:00:00Z'),
  });
  assert.equal(result.ready, true);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].options.headers['cal-api-version'], '2024-06-14');
  assert.equal(requests[0].options.headers.authorization, 'Bearer cal_test_secret');
  assert.ok(
    requests
      .slice(1)
      .every((request) => request.options.headers['cal-api-version'] === '2024-09-04'),
  );
  assert.ok(result.services.every((service) => service.availableSlots === 1));
});

test('preflight odrzuca błędny czas usługi i kalendarz bez dostępności', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const response = await successfulFetch(requests)(url, options);
    if (String(url).endsWith('/v2/event-types')) {
      const payload = await response.json();
      payload.data[1].lengthInMinutes = 45;
      return Response.json(payload);
    }
    if (String(url).includes('eventTypeId=103'))
      return Response.json({ status: 'success', data: {} });
    return response;
  };
  const result = await checkCalcomConfiguration({
    calcom: configuration(),
    fetchImpl,
    now: new Date('2030-01-01T12:00:00Z'),
  });
  assert.equal(result.ready, false);
  assert.ok(
    result.issues.some((issue) => issue.includes('Strzyżenie') && issue.includes('45 min')),
  );
  assert.ok(
    result.issues.some((issue) => issue.includes('Konsultacja') && issue.includes('brak wolnych')),
  );
});
