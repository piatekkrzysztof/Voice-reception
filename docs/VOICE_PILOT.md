# Voice Reception — uruchomienie prawdziwego pilota

## Status

Kod produktu obsługuje trwałe rezerwacje, blokady terminów, idempotencję, webhook Vapi i adapter Cal.com. Domyślna konfiguracja używa jednak lokalnych adapterów, dlatego bez wykonania poniższych kroków aplikacja nie odbiera prawdziwych telefonów i nie zapisuje wizyt w Cal.com.

## 1. Konfiguracja lokalna

Skopiuj `.env.example` do `.env`. Wygeneruj długie, losowe wartości dla:

```dotenv
VOICE_SLOT_SECRET=
VOICE_WEBHOOK_SECRET=
```

Pozostaw na początku:

```dotenv
VOICE_PROVIDER=local
CALENDAR_PROVIDER=local
```

Uruchom aplikację i wykonaj próbę operacyjną w panelu Voice. Sprawdź dostępność, utwórz hold, potwierdź rezerwację i spróbuj zarezerwować ten sam termin ponownie.

## 2. Cal.com

1. Utwórz trzy event types odpowiadające usługom `coloring`, `haircut` i `consultation`.
2. Do pilota jednego właściciela wygeneruj API key. Dla produktu wieloklienckiego zaplanuj OAuth.
3. Ustaw:

```dotenv
CALENDAR_PROVIDER=calcom
CALCOM_API_KEY=
CALCOM_EVENT_TYPE_KOLORYZACJA=
CALCOM_EVENT_TYPE_STRZYZENIE=
CALCOM_EVENT_TYPE_KONSULTACJA=
CALCOM_DEFAULT_ATTENDEE_EMAIL=
CALCOM_RESERVE_SLOTS=true
CALCOM_TIMEOUT_MS=8000
```

Jeżeli klient nie podaje e-maila podczas rozmowy, `CALCOM_DEFAULT_ATTENDEE_EMAIL` jest wymagany przez obecną integrację. Docelowo warto zamiast adresu technicznego zbierać e-mail albo użyć skonfigurowanego procesu follow-up.

Po restarcie panel powinien pokazać Cal.com jako połączony. Wykonaj rezerwację testową i potwierdź ją także w panelu Cal.com.

## 3. Publiczny endpoint HTTPS

Wdróż aplikację pod stabilnym publicznym adresem HTTPS i ustaw:

```dotenv
PUBLIC_BASE_URL=https://voice.twoja-domena.pl
```

Webhook Vapi będzie dostępny pod:

```text
https://voice.twoja-domena.pl/api/webhooks/vapi
```

Tymczasowy tunel nadaje się do testów, ale nie powinien być adresem produkcyjnym.

## 4. Vapi i numer telefonu

1. Utwórz w Vapi credential typu nagłówkowego/Bearer zawierający wartość `VOICE_WEBHOOK_SECRET`.
2. Zapisz identyfikator credentialu i dane konta:

```dotenv
VOICE_PROVIDER=vapi
VAPI_API_KEY=
VAPI_PHONE_NUMBER_ID=
VAPI_SERVER_CREDENTIAL_ID=
VOICE_HUMAN_TRANSFER_NUMBER=+48...
```

3. Skonfiguruj preferowany model i głos w zmiennych `VAPI_MODEL_*` oraz `VAPI_VOICE_*`.
4. Utwórz lub zaktualizuj asystenta:

```powershell
npm run voice:sync
```

Przy pierwszym uruchomieniu skrypt wypisze `VAPI_ASSISTANT_ID`. Wpisz go do `.env`, uruchom synchronizację ponownie i przypisz asystenta do numeru telefonu w Vapi.

Konfiguracja asystenta zawiera cztery narzędzia bookingowe, wyłączone nagrywanie, analizę strukturalną, komunikat o AI i opcjonalny transfer do człowieka.

## 5. Bramka operacyjna

Przed skierowaniem prawdziwych rozmów włącz rygorystyczny tryb pilota:

```dotenv
PILOT_MODE=true
ALLOW_LOCAL_PROVIDERS=false
ALERT_WEBHOOK_URL=https://...
DATA_RETENTION_ENABLED=true
```

`PILOT_MODE` blokuje start, jeśli aplikacja nie używa PostgreSQL, HTTPS, Vapi i Cal.com albo nie ma retencji i bezpiecznego odbiornika alertów. Po zalogowaniu metryki ostatnich 24 godzin są dostępne pod `/api/ops/metrics`. Endpoint nie ujawnia danych klienta i wymaga sesji właściciela.

Wykonaj backup oraz próbne odtworzenie przed pierwszą rozmową:

```bash
docker compose --env-file .env.production --profile ops run --rm backup
docker compose --env-file .env.production --profile ops run --rm backup-verify
```

Drugi proces odtwarza dane wyłącznie do tymczasowej bazy kontrolnej i usuwa ją po sprawdzeniu. Nie nadpisuje bazy produkcyjnej.

## 6. Test odbiorczy

Pilot można uznać za technicznie podłączony dopiero, gdy przejdą wszystkie scenariusze:

- rozmówca słyszy informację, że rozmawia z AI,
- dostępność zgadza się z Cal.com i strefą `Europe/Warsaw`,
- poprawna rezerwacja pojawia się w Cal.com i w konsoli,
- powtórzone wywołanie nie tworzy duplikatu,
- dwóch rozmówców nie może zarezerwować jednego terminu,
- agent nie potwierdza wizyty przy błędzie lub timeoutcie kalendarza,
- anulowanie usuwa aktywną rezerwację,
- prośba o człowieka uruchamia transfer,
- raport końca rozmowy pokazuje właściwy wynik bez audio i pełnej transkrypcji,
- polskie nazwiska, numery telefonu, cisza i przerwanie wypowiedzi są obsługiwane akceptowalnie.
- timeout i limit zapytań Cal.com kończą narzędzie błędem zamiast potwierdzeniem,
- alert o błędzie dociera bez nazwiska, telefonu, e-maila i treści rozmowy,
- przeciążenie zwraca kontrolowane `503 SERVER_BUSY`, a nie zawiesza proces,
- backup przechodzi próbę odtworzenia.

## 7. Granica pilota

Ten etap jest przeznaczony do kontrolowanego pilota jednej firmy na osobnej instalacji. Aplikacja ma PostgreSQL, logowanie właściciela, metryki, alerty, retencję i sprawdzalny backup. Przed sprzedażą self-service wielu klientom nadal potrzebne są RLS, IdP/MFA i role, panel konfiguracji usług, kolejka zdarzeń, SMS, billing, centralny monitoring oraz formalnie zatwierdzona polityka retencji danych.
