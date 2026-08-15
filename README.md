# Voice Reception

Samodzielny produkt recepcji AI dla firm usługowych. Aplikacja łączy warstwę głosową Vapi z transakcyjnym Booking Service i kalendarzem Cal.com.

Nie zawiera kodu ani ekranów KSeF i Knowledge. To osobny produkt z własnym frontendem, serwerem, bazą, konfiguracją, testami i dokumentacją wdrożeniową.

## Co działa

- lokalna konsola operacyjna bez zewnętrznych zależności,
- trwała baza SQLite dla usług, holdów, rezerwacji, rozmów i zdarzeń,
- podpisane sloty oraz holdy z TTL,
- ochrona przed podwójną rezerwacją i idempotentne potwierdzenia,
- tworzenie i anulowanie rezerwacji,
- adapter Cal.com API v2,
- webhook oraz narzędzia `check_availability`, `create_booking_hold`, `confirm_booking` i `cancel_booking` dla Vapi,
- obowiązkowe ujawnienie AI, możliwość transferu i wyłączone nagrywanie,
- czytelny ekran gotowości pilota.

Tryb lokalny jest w pełni uruchamialny, ale nie odbiera prawdziwych telefonów. Do pilota telefonicznego potrzebne są Vapi, numer, Cal.com i publiczny HTTPS.

## Uruchomienie

Wymagany jest Node.js 24 lub nowszy.

```powershell
Copy-Item .env.example .env
./start.ps1
```

Następnie otwórz [http://127.0.0.1:4173](http://127.0.0.1:4173).

Testy:

```powershell
npm test
```

Reset lokalnej bazy — wykonuj przy zatrzymanym serwerze:

```powershell
npm run reset
```

## Podłączenie dostawców

Pełna procedura znajduje się w [docs/VOICE_PILOT.md](docs/VOICE_PILOT.md). Po skonfigurowaniu `.env` asystenta Vapi można utworzyć lub zaktualizować poleceniem:

```powershell
npm run voice:sync
```

## Struktura

```text
public/                         samodzielna konsola Voice
server.mjs                      API HTTP i webhook Vapi
src/config.mjs                  konfiguracja środowiska i readiness
src/voice/service.mjs           logika rezerwacji i Tool Gateway
src/voice/database.mjs          model transakcyjny SQLite
src/voice/calendar.mjs          kalendarz lokalny i Cal.com
src/voice/assistant-config.mjs  konfiguracja asystenta Vapi
scripts/                        reset bazy i provisioning Vapi
test/                           testy domenowe i kontraktowe
docs/                           wdrożenie, architektura, bezpieczeństwo
```

## Granica pilota

SQLite jest właściwe dla developmentu oraz kontrolowanego pilota jednej firmy. Przed uruchomieniem wielu klientów potrzebne są PostgreSQL z RLS, centralne uwierzytelnianie, kolejka zdarzeń, monitoring, backup, polityka retencji i panel konfiguracji tenantów.
