# Wdrożenie Voice Reception

## Architektura wdrożeniowa

Stos produkcyjny składa się z trzech kontenerów:

```text
Internet :80/:443
       ↓
Caddy — automatyczny HTTPS i reverse proxy
       ↓ prywatna sieć Compose
Voice Reception — Node.js 24
       ↓ pula połączeń
PostgreSQL 17 — trwały wolumen
```

Caddy pobiera i odnawia certyfikat TLS. Domena musi wskazywać rekordem DNS na serwer, a porty 80 i 443 muszą być publicznie dostępne. Aplikacja i PostgreSQL nie publikują swoich portów do Internetu.

## 1. Wymagania

- serwer Linux z Docker Engine i Docker Compose,
- domena, np. `voice.twojadomena.pl`, wskazująca na serwer,
- otwarte porty TCP 80 i 443 oraz UDP 443,
- minimum 2 GB RAM dla kontrolowanego pilota,
- zewnętrzny backup wolumenu PostgreSQL.

## 2. Sekrety i konfiguracja

```bash
cp .env.production.example .env.production
```

Wygeneruj niezależne wartości dla `POSTGRES_PASSWORD`, `VOICE_SLOT_SECRET` i `VOICE_SETUP_TOKEN`. Każda powinna mieć co najmniej 32 losowe znaki. Plik `.env.production` jest ignorowany przez Git i nie może trafić do repozytorium.

Ustaw `PUBLIC_DOMAIN` bez prefiksu `https://`, np.:

```text
PUBLIC_DOMAIN=voice.twojadomena.pl
```

`ALLOW_LOCAL_PROVIDERS=true` służy wyłącznie do kontrolowanego demo. Przed odbieraniem prawdziwych połączeń ustaw Vapi i Cal.com oraz zmień tę wartość na `false`.

## 3. Start

```bash
docker compose --env-file .env.production up --build -d
docker compose --env-file .env.production ps
```

Compose czeka na zdrowy PostgreSQL, następnie uruchamia aplikację i dopiero po jej readiness uruchamia Caddy.

## 4. Weryfikacja

```bash
curl https://voice.twojadomena.pl/api/health
curl https://voice.twojadomena.pl/api/ready
docker compose --env-file .env.production logs app --tail 100
```

Oczekiwany readiness:

```json
{"status":"ready","database":"postgres"}
```

Przy pierwszym wejściu utwórz konto właściciela, podając także `VOICE_SETUP_TOKEN`. Po zakończeniu konfiguracji token można obrócić na nową losową wartość.

## 5. Migracje i aktualizacja

Migracje są wersjonowane w katalogu `migrations/` i wykonywane pod blokadą PostgreSQL podczas startu. Można je też wykonać jawnie:

```bash
docker compose --env-file .env.production run --rm app node scripts/migrate.mjs
```

Standardowa aktualizacja:

```bash
git pull --ff-only
docker compose --env-file .env.production up --build -d
```

## 6. Backup

Przed każdą aktualizacją wykonaj `pg_dump` do katalogu znajdującego się poza wolumenem Compose. Okresowo testuj odtworzenie na osobnej bazie. Sam wolumen nie jest strategią backupu.

## 7. Granice obecnej wersji

- PostgreSQL rozdziela dane kluczem `tenant_id`, ale pełny SaaS wymaga jeszcze RLS i testów uprawnień na poziomie bazy,
- konto lokalne jest odpowiednie dla właściciela pilota; wielu operatorów wymaga IdP, MFA i ról,
- przed prawdziwymi danymi potrzebne są monitoring, alerty, retencja i formalna polityka backupu.
