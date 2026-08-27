# Architektura Voice Reception

## Ścieżka synchroniczna

```text
telefon
  ↓
Vapi Assistant
  ↓ POST /api/webhooks/vapi
Tool Gateway
  ├── check_availability
  ├── create_booking_hold
  ├── confirm_booking
  └── cancel_booking
  ↓
Booking Service
  ├── SQLite (dev) / PostgreSQL (deploy): transakcja, TTL, idempotency, unique slot
  └── Local Calendar / Cal.com
  ↓ zdarzenia techniczne bez PII
Operations
  ├── trwałe metryki narzędzi + p95
  ├── alert webhook z cooldownem
  └── retencja i anonimizacja
```

Konsola operatora stanowi osobną granicę dostępu: przeglądarka najpierw uwierzytelnia właściciela, otrzymuje wygasającą sesję HttpOnly, a dopiero potem może odczytać rozmowy i rezerwacje lub wykonywać operacje na kalendarzu. Webhook Vapi nie korzysta z sesji przeglądarkowej — ma własny sekret i credential dostawcy.

Automatyzacje asynchroniczne i CRM nie powinny znajdować się w krytycznej ścieżce rozmowy. Mogą reagować na raport końcowy po zapisaniu wyniku przez Booking Service.

## Gwarancje

- agent proponuje wyłącznie podpisane sloty zwrócone przez kalendarz,
- hold jest ograniczony czasowo,
- aktywny termin ma unikalność wymuszoną w bazie,
- ponowione potwierdzenie z tym samym kluczem nie tworzy duplikatu,
- błąd dostawcy kończy się bez deklarowania sukcesu,
- po błędzie lokalnej finalizacji booking dostawcy jest kompensacyjnie anulowany,
- raport rozmowy nie zawiera w aplikacji audio ani pełnej transkrypcji,
- migracje PostgreSQL są wykonywane pod blokadą advisory, a równoległe próby holdu tego samego terminu są serializowane transakcyjnie.
- `PILOT_MODE` nie pozwala wystartować prawdziwego pilota z atrapą providera, wyłączoną retencją lub bez HTTPS dla alertów.

## Infrastruktura

Wdrożenie używa puli `node-postgres`, healthchecków `/api/health` i `/api/ready`, łagodnego zamknięcia po SIGTERM oraz Caddy jako terminatora TLS. Compose nie publikuje portu bazy ani aplikacji — publiczne są wyłącznie 80/443 reverse proxy. Profil `ops` wykonuje backup oraz restore drill w osobnej bazie kontrolnej.

## Droga do multi-tenant SaaS

1. RLS i testy izolacji na poziomie bazy.
2. Centralny IdP i role.
3. Kolejka zdarzeń po rozmowie.
4. Konfigurowalne usługi, lokalizacje i pracownicy.
5. Centralny monitoring SLO i zewnętrzny magazyn szyfrowanych backupów.
6. SMS, płatności, billing oraz onboarding self-service.
