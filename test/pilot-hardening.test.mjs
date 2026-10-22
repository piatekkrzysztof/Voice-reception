import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createVoiceService } from '../src/voice/service.mjs';
import { createCalendar } from '../src/voice/calendar.mjs';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-hardening-test-'));
  const config = loadConfig({
    DATABASE_URL: '',
    NODE_ENV: 'development',
    DATA_RETENTION_ENABLED: 'false',
    VOICE_PROVIDER: 'local',
    CALENDAR_PROVIDER: 'local',
    VOICE_TENANT_ID: 'pilot-test',
  });
  const calendar = { ...createCalendar(config.voice), ...overrides };
  const options = {
    config,
    state: { calls: [] },
    databasePath: join(directory, 'voice.sqlite'),
    calendar,
  };
  let service = await createVoiceService(options);
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    calendar,
    async restart() {
      await service.close();
      service = await createVoiceService(options);
    },
    async hold(name = 'Strzyżenie', time = '10:00') {
      return (await service.createHold({ service: name, preferredDate: '2035-01-10', time })).hold;
    },
    async confirm(holdId, key = 'test-operation') {
      return service.confirmBooking({
        holdId,
        customerName: 'Klient Testowy',
        phone: '723769696',
        idempotencyKey: key,
      });
    },
  };
}

test('różne usługi blokują całą nakładającą się wizytę jednej osoby; sąsiednie terminy pozostają wolne', async (t) => {
  const f = await fixture(t);
  const hold = await f.hold('Koloryzacja', '10:00');
  await assert.rejects(f.hold('Konsultacja', '11:30'), { code: 'SLOT_UNAVAILABLE' });
  await f.confirm(hold.id);
  await assert.rejects(f.hold('Strzyżenie', '11:00'), { code: 'SLOT_UNAVAILABLE' });
  assert.equal((await f.hold('Konsultacja', '12:00')).status, 'active');
});

test('utracona odpowiedź nie pozwala ponowić POST; dziennik i blokada przetrwają restart i TTL', async (t) => {
  let writes = 0;
  let found = null;
  const f = await fixture(t, {
    async book() {
      writes += 1;
      throw Object.assign(new Error('response lost'), { code: 'CALCOM_TIMEOUT', status: 503 });
    },
    async findBooking() {
      return found;
    },
  });
  const hold = await f.hold();
  await assert.rejects(f.confirm(hold.id), { code: 'CALCOM_TIMEOUT' });
  f.service.database.raw
    .prepare('UPDATE voice_holds SET expires_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', hold.id);
  await f.restart();
  await assert.rejects(f.confirm(hold.id, 'different-tool-id'), { code: 'BOOKING_PENDING' });
  await assert.rejects(f.hold('Konsultacja', '10:30'), { code: 'SLOT_UNAVAILABLE' });
  assert.deepEqual(await f.service.reconcileBookings(), { recovered: 0, released: 0, pending: 1 });
  const pending = (await f.service.dashboard()).pendingConfirmations;
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending).includes('723769696'), false);
  found = { uid: 'cal-recovered', status: 'accepted' };
  assert.equal((await f.service.reconcileBookings()).recovered, 1);
  const result = await f.confirm(hold.id, 'third-tool-id');
  assert.equal(result.booking.providerUid, 'cal-recovered');
  assert.equal(result.idempotentReplay, true);
  assert.equal(writes, 1);
  assert.equal((await f.service.dashboard()).bookings.length, 1);
  assert.equal((await f.service.database.getHold(hold.id)).confirmationJson, null);
});

test('błąd lokalnego zapisu po sukcesie Cal.com odzyskuje wizytę bez kompensacyjnego anulowania', async (t) => {
  let writes = 0;
  let cancellations = 0;
  const f = await fixture(t, {
    async book() {
      writes += 1;
      return { uid: 'cal-known', status: 'accepted' };
    },
    async cancel() {
      cancellations += 1;
    },
    async findBooking({ hold }) {
      assert.equal(hold.providerBookingUid, 'cal-known');
      return { uid: 'cal-known', status: 'accepted' };
    },
  });
  const hold = await f.hold();
  const original = f.service.database.confirmHold;
  f.service.database.confirmHold = () => {
    throw new Error('database unavailable');
  };
  await assert.rejects(f.confirm(hold.id));
  f.service.database.confirmHold = original;
  assert.equal((await f.service.reconcileBookings()).recovered, 1);
  assert.equal(writes, 1);
  assert.equal(cancellations, 0);
});

test('błąd audytu po zatwierdzeniu nie zmienia poprawnej wizyty w błąd ani jej nie anuluje', async (t) => {
  const f = await fixture(t);
  const hold = await f.hold();
  const original = f.service.database.recordEvent;
  f.service.database.recordEvent = async (event) => {
    if (event.type === 'booking.confirmed') throw new Error('audit unavailable');
    return original(event);
  };
  assert.equal((await f.confirm(hold.id)).confirmed, true);
  assert.equal((await f.service.dashboard()).bookings[0].status, 'confirmed');
});

test('jednoznaczne odrzucenie przez Cal.com pozwala zwolnić próbę bez blokady na zawsze', async (t) => {
  const f = await fixture(t, {
    async book() {
      throw Object.assign(new Error('conflict'), { code: 'CALENDAR_CONFLICT', status: 409 });
    },
  });
  const hold = await f.hold();
  await assert.rejects(f.confirm(hold.id), { code: 'CALENDAR_CONFLICT' });
  assert.equal((await f.service.database.getHold(hold.id)).status, 'active');
  assert.equal((await f.service.dashboard()).pendingConfirmations.length, 0);
});

test('stara konfiguracja Vapi nie może anulować wizyty; zalogowany właściciel zachowuje obsługę', async (t) => {
  const f = await fixture(t);
  const booking = (await f.confirm((await f.hold()).id)).booking;
  const result = await f.service.handleVapiMessage({
    message: {
      type: 'tool-calls',
      call: { id: 'call' },
      toolCallList: [
        {
          id: 'cancel',
          name: 'cancel_booking',
          arguments: { bookingId: booking.id, phone: booking.phone },
        },
      ],
    },
  });
  assert.equal(JSON.parse(result.results[0].result).code, 'CANCELLATION_REQUIRES_OWNER');
  assert.equal((await f.service.dashboard()).bookings[0].status, 'confirmed');
  assert.equal((await f.service.cancelBooking({ bookingId: booking.id })).cancelled, true);
});

test('uzgadnianie Cal.com używa kursora, metadanych operacji i dokładnego zakresu czasu', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const hold = {
    id: 'HOLD-recovery',
    startAt: '2035-01-10T09:00:00.000Z',
    endAt: '2035-01-10T10:00:00.000Z',
  };
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['cal-api-version'], '2026-05-01');
    const params = new URL(url).searchParams;
    assert.equal(params.get('eventTypeId'), '88');
    reads += 1;
    if (reads === 1)
      return Response.json({ data: [], pagination: { hasMore: true, nextCursor: 'next' } });
    assert.equal(params.get('cursor'), 'next');
    return Response.json({
      data: [
        {
          uid: 'matched',
          eventTypeId: 88,
          start: hold.startAt,
          end: hold.endAt,
          status: 'accepted',
          metadata: { source: 'voice-reception', holdId: hold.id },
        },
      ],
      pagination: { hasMore: false },
    });
  };
  const calendar = createCalendar({
    calendarProvider: 'calcom',
    calcom: { apiKey: 'test', apiUrl: 'https://cal.test', timeoutMs: 1000 },
  });
  assert.deepEqual(await calendar.findBooking({ hold, service: { externalEventTypeId: 88 } }), {
    uid: 'matched',
    status: 'accepted',
  });
  assert.equal(reads, 2);
});

test('uzgadnianie odrzuca obcy typ usługi i wiele dopasowanych wizyt', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const hold = { id: 'hold', startAt: '2035-01-10T09:00:00Z', endAt: '2035-01-10T10:00:00Z' };
  const item = {
    uid: 'one',
    start: hold.startAt,
    end: hold.endAt,
    eventTypeId: 99,
    status: 'accepted',
    metadata: { source: 'voice-reception', holdId: 'hold' },
  };
  let items = [item];
  globalThis.fetch = async () => Response.json({ data: items, pagination: { hasMore: false } });
  const calendar = createCalendar({
    calendarProvider: 'calcom',
    calcom: { apiKey: 'test', apiUrl: 'https://cal.test' },
  });
  await assert.rejects(calendar.findBooking({ hold, service: { externalEventTypeId: 88 } }), {
    code: 'CALCOM_RECONCILIATION_CONFLICT',
  });
  items = [
    { ...item, eventTypeId: 88 },
    { ...item, uid: 'two', eventTypeId: 88 },
  ];
  await assert.rejects(calendar.findBooking({ hold, service: { externalEventTypeId: 88 } }), {
    code: 'CALCOM_RECONCILIATION_CONFLICT',
  });
});
