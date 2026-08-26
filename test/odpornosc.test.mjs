/**
 * Odpornosc na to, co dzieje sie w prawdziwej rozmowie telefonicznej.
 *
 * Kategoria ryzyka: PIENIADZE i TERMINY. Rozmowa glosowa to najbardziej
 * zawodny kanal, jaki ten produkt obsluguje: dzwoniacy rozlacza sie w polowie,
 * Vapi ponawia webhooki po timeoucie, a kalendarz zewnetrzny bywa niedostepny
 * dokladnie w chwili potwierdzania wizyty.
 *
 * Kazdy z tych przypadkow ma dwie mozliwe zle konczowki i obu pilnuja testy
 * ponizej: podwojna rezerwacje (klient placi dwa razy albo dostaje dwa
 * terminy) oraz termin zablokowany na zawsze przez hold, ktorego nikt nie
 * zwolnil -- czyli miejsce w kalendarzu, ktorego juz nikt nie kupi.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const SEKRET_WEBHOOKA = 'odpornosc-webhook-secret';

/**
 * Uruchamia osobna instancje aplikacji na czas jednego testu.
 *
 * Osobna, a nie wspoldzielona: te testy celowo psuja stan (wygasajace holdy,
 * padajacy kalendarz), wiec wspolna baza sprawilaby, ze wynik zalezy od
 * kolejnosci uruchomienia -- a to wyglada jak blad losowy i zjada wieczor.
 */
async function uruchom(dodatkoweEnv = {}) {
  const katalog = await mkdtemp(join(tmpdir(), 'voice-odpornosc-'));
  const app = await createApp({
    voiceDbPath: join(katalog, 'voice.sqlite'),
    env: {
      VOICE_TENANT_ID: 'odpornosc-tenant',
      VOICE_PROVIDER: 'local',
      CALENDAR_PROVIDER: 'local',
      VOICE_SLOT_SECRET: 'odpornosc-slot-secret',
      VOICE_WEBHOOK_SECRET: SEKRET_WEBHOOKA,
      PUBLIC_BASE_URL: 'http://127.0.0.1:4173',
      ...dodatkoweEnv,
    },
  });

  await new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const adres = `http://127.0.0.1:${app.server.address().port}`;

  const setup = await fetch(`${adres}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@voice.test', password: 'Correct-Horse-2030!' }),
  });
  assert.equal(setup.status, 201);
  const ciasteczko = setup.headers.get('set-cookie').split(';')[0];

  async function zapytaj(sciezka, opcje = {}) {
    const odpowiedz = await fetch(`${adres}${sciezka}`, {
      ...opcje,
      headers: {
        'content-type': 'application/json',
        cookie: ciasteczko,
        ...(opcje.headers || {}),
      },
    });
    return { odpowiedz, body: await odpowiedz.json() };
  }

  async function zamknij() {
    await app.close();
    await rm(katalog, { recursive: true, force: true });
  }

  return { app, zapytaj, zamknij };
}

/** Pierwszy wolny termin danej usługi, jako podpisany identyfikator slotu. */
async function pierwszyWolnySlot(zapytaj, usluga = 'svc-coloring') {
  const { body } = await zapytaj('/api/voice/availability', {
    method: 'POST',
    body: JSON.stringify({ service: usluga, preferredDate: '2030-03-04' }),
  });
  assert.ok(body.slots.length > 0, 'brak wolnych terminow w danych testowych');
  return body.slots[0].id;
}

/** Ładunek webhooka Vapi z jednym wywołaniem narzędzia. */
function wywolanieNarzedzia({ callId, toolCallId, nazwa, argumenty }) {
  return JSON.stringify({
    message: {
      type: 'tool-calls',
      call: { id: callId },
      toolCallList: [
        {
          id: toolCallId,
          function: { name: nazwa, arguments: argumenty },
        },
      ],
    },
  });
}

test('ponowiony webhook Vapi nie tworzy drugiej rezerwacji', async (t) => {
  // Vapi ponawia webhook, gdy nie dostanie odpowiedzi w swoim limicie czasu.
  // Nasza odpowiedz mogla sie zgubic po drodze mimo poprawnego zapisu, wiec
  // to nie jest przypadek brzegowy -- to normalny tryb pracy tego kanalu.
  //
  // Klucz idempotencji powstaje z identyfikatora rozmowy i identyfikatora
  // wywolania narzedzia (service.mjs: `vapi:${callId}:${toolCall.id}`).
  // Gdyby ktos zamienil go kiedys na losowy, ponowienie zalozyloby druga
  // wizyte temu samemu klientowi, na ten sam termin.
  const { zapytaj, app, zamknij } = await uruchom();
  t.after(zamknij);

  const slotId = await pierwszyWolnySlot(zapytaj);
  const hold = await zapytaj('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId }),
  });
  assert.equal(hold.odpowiedz.status, 201);

  const ladunek = wywolanieNarzedzia({
    callId: 'rozmowa-ponowiona',
    toolCallId: 'narzedzie-potwierdz-1',
    nazwa: 'confirm_booking',
    argumenty: {
      holdId: hold.body.hold.id,
      customerName: 'Anna Nowak',
      phone: '+48600100200',
    },
  });
  const naglowki = { authorization: `Bearer ${SEKRET_WEBHOOKA}` };

  const pierwszy = await zapytaj('/api/webhooks/vapi', {
    method: 'POST',
    headers: naglowki,
    body: ladunek,
  });
  const drugi = await zapytaj('/api/webhooks/vapi', {
    method: 'POST',
    headers: naglowki,
    body: ladunek,
  });

  // Oba wywolania musza wygladac dla asystenta na udane -- odpowiedz
  // "juz zrobione" jest tu poprawna odpowiedzia, a nie bledem.
  for (const proba of [pierwszy, drugi]) {
    const wynik = JSON.parse(proba.body.results[0].result);
    assert.equal(wynik.success, true, 'ponowienie zwrocilo blad zamiast potwierdzenia');
  }

  const rezerwacje = await app.voiceService.database.listBookings('odpornosc-tenant');
  assert.equal(rezerwacje.length, 1, 'ponowiony webhook zalozyl druga rezerwacje');
});

test('ponowiony raport koncowy nie duplikuje rozmowy', async (t) => {
  // Ten sam webhook, inny typ wiadomosci. Zduplikowana rozmowa psuje kazda
  // liczbe w konsoli klienta: czas rozmow, skutecznosc, liczbe polaczen.
  const { zapytaj, app, zamknij } = await uruchom();
  t.after(zamknij);

  const raport = JSON.stringify({
    message: {
      type: 'end-of-call-report',
      call: {
        id: 'rozmowa-raport-ponowiony',
        startedAt: '2030-03-04T09:00:00.000Z',
        endedAt: '2030-03-04T09:03:20.000Z',
        customer: { number: '+48600100200' },
      },
      analysis: { structuredData: { intent: 'BOOKING', outcome: 'BOOKED' } },
    },
  });
  const naglowki = { authorization: `Bearer ${SEKRET_WEBHOOKA}` };

  await zapytaj('/api/webhooks/vapi', { method: 'POST', headers: naglowki, body: raport });
  await zapytaj('/api/webhooks/vapi', { method: 'POST', headers: naglowki, body: raport });

  const rozmowy = await app.voiceService.database.listCalls('odpornosc-tenant', 50);
  const ta = rozmowy.filter((rozmowa) => rozmowa.externalId === 'rozmowa-raport-ponowiony');
  assert.equal(ta.length, 1, 'ponowiony raport zalozyl druga rozmowe');
});

test('przerwane polaczenie nie blokuje terminu na zawsze', async (t) => {
  // Najczestszy sposob zakonczenia rozmowy glosowej: dzwoniacy sie rozlacza.
  // Jesli zdazyl zarezerwowac termin, ale nie potwierdzil, hold zostaje.
  // Bez wygasania to miejsce w kalendarzu jest stracone -- nikt go juz nie
  // kupi, a wlasciciel nie ma jak sie o tym dowiedziec.
  //
  // VOICE_HOLD_MINUTES=0 skraca zycie holdu do zera, zeby test nie musial
  // czekac piec minut ani manipulowac zegarem.
  const { zapytaj, zamknij } = await uruchom({ VOICE_HOLD_MINUTES: '0' });
  t.after(zamknij);

  const slotId = await pierwszyWolnySlot(zapytaj);
  const hold = await zapytaj('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId }),
  });
  assert.equal(hold.odpowiedz.status, 201);

  // Rozmowa sie urywa: nikt nie potwierdza. Kolejny dzwoniacy pyta o ten sam
  // termin i musi go dostac.
  const kolejny = await zapytaj('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId }),
  });
  assert.equal(kolejny.odpowiedz.status, 201, 'termin zostal zablokowany mimo wygasniecia holdu');

  // Druga polowa, wazniejsza: porzucony hold nie moze zostac potwierdzony
  // pozniej. Gdyby dalo sie go jeszcze uzyc, termin zajety juz przez kolejnego
  // dzwoniacego zostalby sprzedany drugi raz -- i to bez zadnego bledu,
  // bo z punktu widzenia systemu obie rezerwacje byly poprawne.
  const spoznione = await zapytaj('/api/voice/bookings', {
    method: 'POST',
    headers: { 'idempotency-key': 'spoznione-potwierdzenie' },
    body: JSON.stringify({
      holdId: hold.body.hold.id,
      customerName: 'Anna Nowak',
      phone: '+48600100200',
    }),
  });

  assert.notEqual(
    spoznione.odpowiedz.status,
    201,
    'wygasly hold dal sie potwierdzic i sprzedal zajety juz termin',
  );
});

test('aktywny hold nadal blokuje termin', async (t) => {
  // Druga polowa tego samego zachowania. Test wygasania sam w sobie
  // przepuscilby wersje, ktora nie blokuje NICZEGO -- a wtedy dwoch
  // dzwoniacych dostaloby ten sam termin.
  const { zapytaj, zamknij } = await uruchom({ VOICE_HOLD_MINUTES: '30' });
  t.after(zamknij);

  const slotId = await pierwszyWolnySlot(zapytaj);
  await zapytaj('/api/voice/holds', { method: 'POST', body: JSON.stringify({ slotId }) });

  const kolejny = await zapytaj('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId }),
  });

  assert.equal(kolejny.odpowiedz.status, 409);
  assert.equal(kolejny.body.error.code, 'SLOT_UNAVAILABLE');
});

test('potwierdzenie bez wymaganego klucza idempotencji jest odrzucane', async (t) => {
  // Klucz jest jedyna rzecza, ktora odroznia ponowienie od nowej rezerwacji.
  // Endpoint, ktory przyjmie zadanie bez niego, przy pierwszym timeoucie
  // zalozy druga wizyte i nikt sie nie zorientuje.
  const { zapytaj, zamknij } = await uruchom();
  t.after(zamknij);

  const slotId = await pierwszyWolnySlot(zapytaj);
  const hold = await zapytaj('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId }),
  });

  const bezKlucza = await zapytaj('/api/voice/bookings', {
    method: 'POST',
    body: JSON.stringify({
      holdId: hold.body.hold.id,
      customerName: 'Anna Nowak',
      phone: '+48600100200',
    }),
  });

  assert.equal(bezKlucza.odpowiedz.status, 400);
  assert.equal(bezKlucza.body.error.code, 'IDEMPOTENCY_REQUIRED');
});
