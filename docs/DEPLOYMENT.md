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
- katalog backupów kopiowany automatycznie poza serwer aplikacji.

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

`PILOT_MODE=true` jest ostatnią bramką przed podłączeniem numeru. Wymaga prawdziwych providerów, HTTPS, retencji oraz `ALERT_WEBHOOK_URL` używającego HTTPS. Alert zawiera wyłącznie kod techniczny, komponent i identyfikator żądania — bez danych rozmówcy.

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
{ "status": "ready", "database": "postgres" }
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

Utwórz katalog dostępny wyłącznie dla operatora, a następnie wykonaj backup i próbę odtworzenia:

```bash
mkdir -p backups
chmod 700 backups
docker compose --env-file .env.production --profile ops run --rm backup
docker compose --env-file .env.production --profile ops run --rm backup-verify
```

Backup ma format `pg_dump --format=custom`, sumę SHA-256 i jest sprawdzany przez `pg_restore --list`. `backup-verify` odtwarza najnowszy plik do jednorazowej bazy `voice_reception_restore_check`, sprawdza siedem tabel aplikacji i usuwa bazę kontrolną. Nie dotyka aktywnej bazy `voice_reception`.

Codzienny backup można uruchomić z crona na serwerze:

```cron
15 2 * * * cd /opt/voice-reception && docker compose --env-file .env.production --profile ops run --rm backup >> /var/log/voice-reception-backup.log 2>&1
```

`BACKUP_RETENTION_DAYS` domyślnie wynosi 14. Co najmniej jedna kopia musi być regularnie wysyłana poza serwer; katalog `./backups` na tej samej maszynie chroni przed błędem aplikacji, ale nie przed utratą VPS.

## 7. Monitoring i retencja

- zewnętrzny monitoring odpytuje `/api/ready`,
- błędy krytyczne trafiają do `ALERT_WEBHOOK_URL` z cooldownem,
- `/api/ops/metrics` pokazuje po zalogowaniu liczbę błędów, odrzucone przeciążenia, skuteczność narzędzi, p95 i koszt ostatnich 24 godzin,
- numery telefonów i streszczenia rozmów są anonimizowane po `DATA_RETENTION_CALLS_DAYS`,
- dane klienta w rezerwacji są anonimizowane po `DATA_RETENTION_BOOKINGS_DAYS`, bez usuwania informacji o zajętym terminie i wyniku biznesowym,
- stare zdarzenia, sesje i porzucone holdy są usuwane okresowo.

## 8. Granice obecnej wersji

- PostgreSQL rozdziela dane kluczem `tenant_id`, ale pełny SaaS wymaga jeszcze RLS i testów uprawnień na poziomie bazy,
- konto lokalne jest odpowiednie dla właściciela pilota; wielu operatorów wymaga IdP, MFA i ról,
- aplikacja dostarcza metryki i webhook alertowy, ale odbiornik alertów, monitor zewnętrzny oraz wysyłka backupu poza VPS muszą zostać skonfigurowane przez operatora,
- techniczna retencja nie zastępuje zatwierdzonej z klientem polityki prawnej.
