# Darmowe wdrożenie demonstracyjne: Render + Neon

Ten wariant udostępnia działającą aplikację przez publiczny adres HTTPS bez kupowania
domeny i bez opłat za serwer. Używa:

- Render Free jako hosta aplikacji Node.js,
- Neon Free jako trwałej bazy PostgreSQL,
- adresu `https://<nazwa>.onrender.com` nadawanego automatycznie przez Render.

## Ważne ograniczenie

Render Free usypia usługę po 15 minutach bez ruchu. Pierwsze żądanie po uśpieniu może
czekać około minuty. To wystarcza do portfolio, konfiguracji integracji i umawianej
demonstracji, ale nie do odbierania prawdziwych telefonów bez nadzoru. Przed demonstracją
otwórz adres aplikacji i poczekaj na jej uruchomienie. Przed pierwszym klientem zmień
instancję Render na działającą stale.

## 1. Baza w Neon

1. Załóż bezpłatne konto w Neon i utwórz projekt w europejskim regionie.
2. Utwórz bazę dla Voice Reception.
3. Skopiuj bezpośredni connection string PostgreSQL. Nie publikuj go i nie zapisuj w Git.
4. Zachowaj go jako wartość `DATABASE_URL` do następnego kroku.

Bezpośrednie połączenie jest tu lepsze od połączenia przez pooler: aplikacja jest
długotrwałym procesem i używa blokady doradczej PostgreSQL podczas migracji. W Render
limit własnej puli jest ustawiony na trzy połączenia.

## 2. Usługa w Render

1. Zaloguj się do Render kontem GitHub.
2. Wybierz **New → Blueprint** i repozytorium `Voice-reception`.
3. Render odczyta plik `render.yaml` i zaproponuje jedną bezpłatną usługę webową.
4. W formularzu sekretów wpisz wartości:
   - `DATABASE_URL` — connection string z Neon,
   - `CALCOM_API_KEY`,
   - `CALCOM_DEFAULT_ATTENDEE_EMAIL`,
   - trzy identyfikatory `CALCOM_EVENT_TYPE_*`.
5. Utwórz Blueprint i poczekaj, aż `/api/ready` przejdzie kontrolę zdrowia.

Render sam generuje trzy długie sekrety aplikacji. Ich wartości nie trafiają do
repozytorium. Adres HTTPS jest pobierany automatycznie z `RENDER_EXTERNAL_URL`, więc nie
trzeba kupować domeny ani ręcznie wpisywać `PUBLIC_BASE_URL`.

## 3. Pierwsze uruchomienie

1. Otwórz adres przydzielony przez Render.
2. W ustawieniach usługi Render odsłoń i skopiuj wartość `VOICE_SETUP_TOKEN`.
3. Utwórz pierwsze konto administratora, podając ten token. Nie używaj hasła z innego
   serwisu.
4. Zaloguj się i sprawdź ekran gotowości oraz połączenie z Cal.com.
5. Sprawdź publicznie:
   - `/api/health` — aplikacja działa,
   - `/api/ready` — PostgreSQL odpowiada.

Po utworzeniu administratora token konfiguracyjny nie pozwoli utworzyć kolejnego
pierwszego konta. Nadal przechowuj go jak sekret.

## 4. Granica darmowego wariantu

Na tym etapie `VOICE_PROVIDER=local` i `PILOT_MODE=false`. Aplikacja i prawdziwy kalendarz
działają publicznie, lecz numer telefoniczny nie jest jeszcze podłączony. Vapi włączamy po
sprawdzeniu publicznego adresu, alertów i numeru przekazania do człowieka.

Nie używaj sztucznego odpytywania aplikacji tylko po to, aby obchodzić usypianie darmowej
usługi. Na umówioną demonstrację rozgrzej ją ręcznie; do pilota bez nadzoru użyj instancji
działającej stale.
