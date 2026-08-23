# Voice Reception

Samodzielny produkt recepcji AI dla firm usługowych. Aplikacja łączy warstwę głosową Vapi z transakcyjnym Booking Service i kalendarzem Cal.com.

Nie zawiera kodu ani ekranów KSeF i Knowledge. To osobny produkt z własnym frontendem, serwerem, bazą, konfiguracją, testami i dokumentacją wdrożeniową.

## Co działa

- lokalna konsola operacyjna bez zewnętrznych zależności,
- jednorazowa konfiguracja właściciela, logowanie i wygasające sesje HttpOnly,
- SQLite do developmentu oraz PostgreSQL z pulą połączeń i migracjami do wdrożenia,
- podpisane sloty oraz holdy z TTL,
- ochrona przed podwójną rezerwacją i idempotentne potwierdzenia,
- tworzenie i anulowanie rezerwacji,
- adapter Cal.com API v2,
- webhook oraz narzędzia `check_availability`, `create_booking_hold`, `confirm_booking` i `cancel_booking` dla Vapi,
- obowiązkowe ujawnienie AI, możliwość transferu i wyłączone nagrywanie,
- czytelny ekran gotowości pilota,
- kontenery Node.js 24 + PostgreSQL oraz automatyczny HTTPS przez Caddy,
- CI uruchamiające testy SQLite, prawdziwy test transakcji PostgreSQL i budowę obrazu.

Tryb lokalny jest w pełni uruchamialny, ale nie odbiera prawdziwych telefonów. Do pilota telefonicznego potrzebne są Vapi, numer, Cal.com i publiczny HTTPS.

## Uruchomienie

Wymagany jest Node.js 24 lub nowszy.

```powershell
Copy-Item .env.example .env
./start.ps1
```

Następnie otwórz [http://127.0.0.1:4173](http://127.0.0.1:4173).

Przy pierwszym uruchomieniu konsola poprosi o utworzenie konta właściciela. Hasło musi mieć minimum 12 znaków i jest zapisywane wyłącznie jako skrót `scrypt`. Nie ma domyślnego loginu ani hasła. Po konfiguracji wszystkie endpointy zawierające dane klientów i operacje rezerwacji wymagają aktywnej sesji.

Jeżeli pierwsza konfiguracja odbywa się przez publiczny adres, ustaw wcześniej długi, losowy `VOICE_SETUP_TOKEN` i podaj go w formularzu. Konfiguracja lokalna z `127.0.0.1` nie wymaga tokenu.

Testy:

```powershell
npm test
```

Reset lokalnej bazy — wykonuj przy zatrzymanym serwerze:

```powershell
npm run reset
```

## Wdrożenie Docker + PostgreSQL + HTTPS

```powershell
Copy-Item .env.production.example .env.production
docker compose --env-file .env.production up --build -d
```

Pełna procedura DNS, sekretów, readiness, migracji i backupu znajduje się w [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
src/auth.mjs                    hasła scrypt, sesje, rate limit i ochrona żądań
src/voice/service.mjs           logika rezerwacji i Tool Gateway
src/voice/database.mjs          model transakcyjny SQLite
src/voice/postgres-database.mjs PostgreSQL, pool i transakcje
src/voice/calendar.mjs          kalendarz lokalny i Cal.com
src/voice/assistant-config.mjs  konfiguracja asystenta Vapi
migrations/                     wersjonowany schemat PostgreSQL
Dockerfile / compose.yaml       obraz i stos produkcyjny
Caddyfile                       automatyczny HTTPS i reverse proxy
scripts/                        reset bazy i provisioning Vapi
test/                           testy domenowe i kontraktowe
docs/                           wdrożenie, architektura, bezpieczeństwo
```

## Granica pilota

PostgreSQL jest gotowy do pojedynczego wdrożenia i rozdziela rekordy przez `tenant_id`. Przed uruchomieniem pełnego multi-tenant SaaS potrzebne są RLS, centralny IdP z MFA i rolami, kolejka zdarzeń, monitoring, automatyczny backup, polityka retencji i panel konfiguracji tenantów.
