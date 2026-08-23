# Bezpieczeństwo Voice Reception

## Zaimplementowane

- HMAC dla tokenów slotów i kontrola czasu ważności,
- TTL holdów i unikalny indeks aktywnej rezerwacji,
- idempotencja potwierdzenia,
- stałoczasowe porównanie sekretu webhooka,
- timeouty adaptera Cal.com i zachowanie `fail closed`,
- nagrywanie wyłączone w konfiguracji Vapi,
- brak zapisu pełnej transkrypcji,
- limity JSON, CSP i bezpieczne nagłówki HTTP,
- jednorazowa konfiguracja pierwszego właściciela ograniczona do localhost lub `VOICE_SETUP_TOKEN`,
- hasła hashowane przez `scrypt` z losową solą,
- losowe sesje administratora przechowywane w cookie `HttpOnly; SameSite=Strict`, z samym SHA-256 tokenu w bazie,
- ochrona operacji przed obcym `Origin` i żądaniami `cross-site`,
- limit pięciu prób logowania w piętnastominutowym oknie,
- walidacja produkcyjna blokująca HTTP, SQLite i słabe sekrety,
- automatyczny HTTPS, HSTS i prywatna sieć kontenerów,
- PostgreSQL z parametryzowanymi zapytaniami, pulą i migracjami pod blokadą,
- brak sekretów w repozytorium.

W trybie Vapi wymagane są zarówno `VOICE_WEBHOOK_SECRET`, jak i `VAPI_SERVER_CREDENTIAL_ID`. Agent nie może ogłosić rezerwacji, dopóki `confirm_booking` nie zwróci sukcesu.

## Przed prawdziwymi danymi klienta

- zewnętrzny secrets manager zamiast pliku środowiskowego,
- RLS oraz testy izolacji tenantów na poziomie bazy,
- centralny IdP, MFA i rozdzielenie ról dla wielu użytkowników,
- szyfrowanie, backup i sprawdzony restore,
- OpenTelemetry, alerty i redakcja danych w logach,
- DPA, lista subprocessorów i polityka retencji,
- analiza podstawy prawnej przed ewentualnym nagrywaniem,
- niezależne testy bezpieczeństwa.
