function functionTool(name, description, properties, required, serverUrl, credentialId) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
    server: { url: serverUrl, timeoutSeconds: 10, ...(credentialId ? { credentialId } : {}) },
  };
}

const BOOKABLE_SERVICES = ['Konsultacja', 'Strzyżenie', 'Koloryzacja'];

export function voiceSystemPrompt({ businessName, timezone, transferEnabled }) {
  return `Jesteś automatyczną recepcjonistką AI firmy ${businessName}. Rozmawiasz po polsku, naturalnie i zwięźle.

AKTUALNA DATA I CZAS (${timezone}): {{"now" | date: "%Y-%m-%d %H:%M (%A)", "${timezone}"}}.
OFERTA: Konsultacja (30 min), Strzyżenie (60 min), Koloryzacja (120 min).

ZASADY BEZWZGLĘDNE:
1. Na początku rozmowy jasno informujesz, że jesteś automatyczną asystentką AI.
2. Nie wymyślasz wolnych terminów. Zawsze używasz check_availability.
3. Po wyborze godziny tworzysz blokadę create_booking_hold. Rezerwację potwierdzasz dopiero po zebraniu imienia, telefonu i wyraźnym potwierdzeniu klienta.
4. confirm_booking wywołujesz dokładnie raz. Jeśli narzędzie zwróci błąd, nie ogłaszasz sukcesu.
5. Nie zbierasz danych, których nie potrzebujesz do rezerwacji. Nie pytasz o zdrowie ani informacje wrażliwe.
6. Reklamacje, prośba o człowieka, trzy nieudane próby zrozumienia lub awaria narzędzia oznaczają ${transferEnabled ? 'użycie transferCall' : 'zapisanie prośby o kontakt człowieka'}.
7. Określenia „dzisiaj”, „jutro”, „pojutrze”, dni tygodnia i miesiące przeliczasz względem aktualnej daty podanej wyżej. Nigdy nie zakładasz roku z pamięci modelu. Do check_availability wysyłasz przyszłą datę w formacie YYYY-MM-DD.
8. Daty i godziny powtarzasz przed potwierdzeniem. Strefa czasowa: ${timezone}.
9. Obsługujesz wyłącznie trzy usługi z sekcji OFERTA. Jeśli klient opisuje inną potrzebę, prosisz o wybór jednej z nich. Nie wymyślasz usług, cen ani rabatów.
10. Gdy check_availability zwróci DATE_IN_PAST, ponownie odczytujesz aktualną datę, poprawiasz rok i wykonujesz najwyżej jedną ponowną próbę.
11. Polski numer telefonu przyjmujesz jako dziewięć cyfr bez wymagania prefiksu +48. Najpierw prosisz o pełne zdanie „Mój numer telefonu to…”, a potem o cyfry w trzech grupach po trzy. Powtarzasz numer i prosisz o potwierdzenie.
12. Jeśli pierwsza próba głosowa nie zawiera pełnych dziewięciu cyfr, prosisz o wpisanie numeru na klawiaturze telefonu i naciśnięcie #. Wiadomość „User's Keypad Entry:” traktujesz jako numer, usuwasz # i nie prosisz o kolejne powtórki głosowe.

CEL: rozwiązać sprawę w pierwszym kontakcie, ale nigdy kosztem poprawności rezerwacji.`;
}

export function buildVapiAssistantConfig(config) {
  const webhookUrl = `${config.publicBaseUrl}/api/webhooks/vapi`;
  const voice = config.voice;
  const credentialId = voice.vapi.serverCredentialId;
  const tools = [
    functionTool(
      'check_availability',
      'Sprawdza prawdziwe wolne terminy usługi. Wywołaj przed zaproponowaniem godziny.',
      {
        service: {
          type: 'string',
          enum: BOOKABLE_SERVICES,
          description: 'Jedna z usług dostępnych w ofercie',
        },
        preferredDate: {
          type: 'string',
          description:
            'Przyszła data w formacie YYYY-MM-DD, obliczona względem aktualnej daty ze strefy Europe/Warsaw',
        },
        timeRange: {
          type: 'string',
          enum: ['morning', 'afternoon', 'any'],
          description: 'Preferowana pora dnia',
        },
      },
      ['service', 'preferredDate'],
      webhookUrl,
      credentialId,
    ),
    functionTool(
      'create_booking_hold',
      'Blokuje wybrany termin na pięć minut. Użyj po wyborze klienta.',
      {
        slotId: {
          type: 'string',
          description: 'Podpisany identyfikator zwrócony przez check_availability',
        },
      },
      ['slotId'],
      webhookUrl,
      credentialId,
    ),
    functionTool(
      'confirm_booking',
      'Potwierdza wcześniej zablokowany termin. Użyj tylko po wyraźnej zgodzie klienta.',
      {
        holdId: { type: 'string' },
        customerName: { type: 'string' },
        phone: {
          type: 'string',
          description:
            'Polski numer jako 9 cyfr bez prefiksu albo pełny numer międzynarodowy; spacje i myślniki są dozwolone',
        },
        email: { type: 'string', description: 'E-mail, jeżeli klient go podał' },
      },
      ['holdId', 'customerName', 'phone'],
      webhookUrl,
      credentialId,
    ),
    functionTool(
      'cancel_booking',
      'Odwołuje istniejącą rezerwację po potwierdzeniu tożsamości klienta.',
      {
        bookingId: { type: 'string' },
        reason: { type: 'string' },
      },
      ['bookingId'],
      webhookUrl,
      credentialId,
    ),
    { type: 'endCall' },
  ];
  if (voice.humanTransferNumber) {
    tools.push({
      type: 'transferCall',
      destinations: [{ type: 'number', number: voice.humanTransferNumber }],
    });
  }

  const assistant = {
    name: `${voice.business.name} Recepcja PL`.slice(0, 40),
    firstMessage: `Dzień dobry, tu automatyczna asystentka AI firmy ${voice.business.name}. Mogę pomóc umówić lub zmienić wizytę. W każdej chwili może Pan lub Pani poprosić o rozmowę z pracownikiem.`,
    firstMessageMode: 'assistant-speaks-first',
    firstMessageInterruptionsEnabled: true,
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'pl',
    },
    keypadInputPlan: {
      enabled: true,
      timeoutSeconds: 0,
      delimiters: ['#'],
    },
    model: {
      provider: voice.vapi.modelProvider,
      model: voice.vapi.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: voiceSystemPrompt({
            businessName: voice.business.name,
            timezone: voice.timezone,
            transferEnabled: Boolean(voice.humanTransferNumber),
          }),
        },
      ],
      tools,
    },
    server: { url: webhookUrl, timeoutSeconds: 15, ...(credentialId ? { credentialId } : {}) },
    serverMessages: ['tool-calls', 'status-update', 'end-of-call-report'],
    maxDurationSeconds: 600,
    backgroundSound: 'off',
    artifactPlan: { recordingEnabled: false },
    analysisPlan: {
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: 'object',
          properties: {
            intent: { type: 'string' },
            outcome: {
              type: 'string',
              enum: ['BOOKED', 'RESCHEDULED', 'CANCELLED', 'TRANSFERRED', 'RESOLVED', 'UNRESOLVED'],
            },
            bookingId: { type: 'string' },
            aiDisclosure: { type: 'boolean' },
            followupRequired: { type: 'boolean' },
          },
        },
      },
    },
  };
  if (voice.vapi.voiceProvider && voice.vapi.voiceId) {
    assistant.voice = {
      provider: voice.vapi.voiceProvider,
      voiceId: voice.vapi.voiceId,
    };
  }
  return assistant;
}
