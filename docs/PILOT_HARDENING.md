# Zabezpieczenia pilota jednej osoby

## Zakres

Jedna instalacja obsługuje jedną osobę wykonującą wszystkie trzy usługi.
Blokada konsultacji, strzyżenia lub koloryzacji wyklucza każdy nakładający się
termin innej usługi. PostgreSQL serializuje tworzenie blokad wspólnym kluczem
organizacji; sąsiadujące, nienakładające się wizyty pozostają dostępne.
Model wielu niezależnych pracowników wymaga osobnych zasobów i nie jest tu wdrożony.

## Potwierdzenie i awarie Cal.com

Przed wysłaniem rezerwacji aplikacja atomowo zajmuje hold i zapisuje dane potrzebne
do dokończenia operacji. Dziennik pozostaje w `voice_holds.confirmation_json`.
Po sukcesie lokalnej transakcji jest czyszczony. Dane dziennika nie trafiają do logów
ani listy operacyjnej; nierozwiązana operacja wymaga wyjaśnienia przez właściciela.

Po timeoucie, utracie odpowiedzi, nieprawidłowym JSON lub błędzie zapisu lokalnego:

- nie ma automatycznego ponawiania POST tworzącego wizytę,
- hold pozostaje `confirming` także po TTL i restarcie,
- kolejne potwierdzenie zwraca `BOOKING_PENDING`,
- co minutę (gdy proces działa) wykonywana jest kontrola Cal.com,
- panel pokazuje „Rezerwacje do sprawdzenia” i przycisk „SPRAWDŹ CAL.COM”,
- endpoint właściciela `POST /api/voice/reconcile` umożliwia taką samą kontrolę.

Odzyskanie wymaga jednej zaakceptowanej rezerwacji z pasującymi metadanymi
`source`, `holdId`, typem wydarzenia oraz dokładnym początkiem i końcem wizyty.
Nieznany wynik lub wiele dopasowań pozostawia blokadę i zgłasza alert.
Rezerwacja jednoznacznie anulowana/odrzucona pozwala zwolnić próbę.
Brak wyniku wyszukiwania **nie dowodzi**, że zapis się nie udał; właściciel musi
wyjaśnić taki przypadek w Cal.com. Nie wolno ręcznie kasować blokady w ciemno.

Kontrola używa [listy rezerwacji API Cal.com](https://cal.com/docs/api-reference/v2/bookings/get-all-bookings)
w wersji `2026-05-01` z paginacją kursorem, do 10 stron po 100 rekordów.
Osiągnięcie limitu pozostawia operację do sprawdzenia.
Nie jest to pełna synchronizacja wszystkich późniejszych zmian wykonanych w Cal.com.

## Anulowanie

Anulowanie jest dostępne przez zalogowany panel właściciela. Narzędzie głosowe
`cancel_booking` zostało usunięte z konfiguracji, a serwer odrzuca również wywołania
ze starszego asystenta (`CANCELLATION_REQUIRES_OWNER`). Nazwisko, numer telefonu
lub identyfikator rezerwacji nie stanowią dowodu tożsamości.
Samodzielne anulowanie głosowe wymaga przyszłego kanału weryfikacji (np. OTP).
Asystent kieruje prośby o anulowanie/zmianę do obsługi; nie obiecuje nieistniejącego
zgłoszenia do oddzwonienia.

## Wdrożenie i test odbiorczy

1. Wykonaj backup i zatrzymaj przyjmowanie nowych rozmów na czas aktualizacji.
2. Wdróż backend. Migracja `002_booking_recovery.sql` jest addytywna i uruchamia
   się automatycznie pod blokadą migracji. SQLite dodaje kolumny przy otwarciu.
3. Zsynchronizuj konfigurację Vapi przez `npm run voice:sync` i sprawdź narzędzia.
4. Sprawdź konflikt między koloryzacją i konsultacją, a następnie sąsiednie terminy.
5. Sprawdź, że stary `cancel_booking` jest odrzucany, a panel nadal anuluje wizytę.
6. Sprawdź odzyskiwanie na środowisku testowym — testy nie wymagają konta Cal.com.

`node --test` obejmuje utraconą odpowiedź, restart, upływ TTL, błąd lokalnego zapisu,
audyt po sukcesie, blokady między usługami oraz identyfikację wyniku Cal.com.
`TEST_DATABASE_URL` powinien wskazywać wyłącznie izolowaną bazę testową; test kontraktowy
sprawdza też migrację, wyścig różnych usług, izolację tenantów i trwały dziennik PostgreSQL.
