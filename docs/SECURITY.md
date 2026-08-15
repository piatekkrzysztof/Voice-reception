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
- brak sekretów w repozytorium.

W trybie Vapi wymagane są zarówno `VOICE_WEBHOOK_SECRET`, jak i `VAPI_SERVER_CREDENTIAL_ID`. Agent nie może ogłosić rezerwacji, dopóki `confirm_booking` nie zwróci sukcesu.

## Przed prawdziwymi danymi klienta

- publiczny HTTPS i secrets manager,
- PostgreSQL z RLS oraz testy izolacji tenantów,
- logowanie, MFA i rozdzielenie ról,
- szyfrowanie, backup i sprawdzony restore,
- OpenTelemetry, alerty i redakcja danych w logach,
- DPA, lista subprocessorów i polityka retencji,
- analiza podstawy prawnej przed ewentualnym nagrywaniem,
- niezależne testy bezpieczeństwa.
