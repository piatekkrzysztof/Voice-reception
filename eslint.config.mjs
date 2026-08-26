/**
 * Konfiguracja ESLint.
 *
 * Projekt nie miał dotąd lintera, więc reguły są dobrane pod jedną rzecz:
 * łapać błędy, które w JavaScripcie milczą aż do produkcji. Stylem zajmuje
 * się Prettier i celowo nie ma go tutaj — dwa narzędzia sprzeczające się
 * o przecinki kończą się wyłączaniem obu.
 *
 * Nie ma tu `eslint-config-prettier`: nie włączamy żadnej reguły stylistycznej,
 * więc nie ma czego wyłączać, a to o jedną zależność mniej. Ten projekt trzyma
 * jedną zależność produkcyjną i nie ma powodu, żeby narzędzia rosły szybciej
 * niż sam kod.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'public/vendor/**'],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Zmienna, której nikt nie czyta, zwykle znaczy, że coś zostało
      // przeniesione w połowie. Argumenty pomijamy: w wywołaniach zwrotnych
      // często trzeba przyjąć parametr, żeby dojść do następnego.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],

      // `await` w pętli po tablicy zapytań do bazy zamienia jedno żądanie
      // w dziesiątki sekwencyjnych. Ostrzeżenie, nie błąd: czasem sekwencja
      // jest właśnie tym, o co chodzi.
      'no-await-in-loop': 'warn',

      // Obietnica bez `await` i bez `catch` gubi błąd bezpowrotnie —
      // dokładnie ta cicha awaria, której w tym projekcie szukamy.
      'no-promise-executor-return': 'error',

      // Porównanie z NaN, samoprzypisanie, nieosiągalny kod po return —
      // rzeczy, które zawsze są pomyłką, a nie decyzją.
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-constant-binary-expression': 'error',

      // `==` między różnymi typami potrafi dać zaskakujący wynik przy danych
      // z zewnątrz, a tutaj wszystko przychodzi z HTTP albo z bazy.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    // Testy mają własne globalne funkcje z wbudowanego runnera Node.
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    // Kod przeglądarki w konsoli: inne środowisko, inne globalne nazwy.
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
  },
];
