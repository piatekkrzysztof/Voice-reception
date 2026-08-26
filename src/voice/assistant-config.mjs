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

export function voiceSystemPrompt({ businessName, timezone, transferEnabled }) {
  return `Jesteś automatyczną recepcjonistką AI firmy ${businessName}. Rozmawiasz po polsku, naturalnie i zwięźle.

ZASADY BEZWZGLĘDNE:
1. Na początku rozmowy jasno informujesz, że jesteś automatyczną asystentką AI.
2. Nie wymyślasz wolnych terminów. Zawsze używasz check_availability.
3. Po wyborze godziny tworzysz blokadę create_booking_hold. Rezerwację potwierdzasz dopiero po zebraniu imienia, telefonu i wyraźnym potwierdzeniu klienta.
4. confirm_booking wywołujesz dokładnie raz. Jeśli narzędzie zwróci błąd, nie ogłaszasz sukcesu.
5. Nie zbierasz danych, których nie potrzebujesz do rezerwacji. Nie pytasz o zdrowie ani informacje wrażliwe.
6. Reklamacje, prośba o człowieka, trzy nieudane próby zrozumienia lub awaria narzędzia oznaczają ${transferEnabled ? 'użycie transferCall' : 'zapisanie prośby o kontakt człowieka'}.
7. Daty i godziny powtarzasz przed potwierdzeniem. Strefa czasowa: ${timezone}.
8. Nie obiecujesz ceny, rabatu ani usługi, których nie ma w konfiguracji.

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
        service: { type: 'string', description: 'Nazwa usługi, np. Koloryzacja' },
        preferredDate: { type: 'string', description: 'Data w formacie YYYY-MM-DD' },
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
          description: 'Numer w formacie międzynarodowym, np. +48600100200',
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
    model: {
      provider: process.env.VAPI_MODEL_PROVIDER || 'openai',
      model: process.env.VAPI_MODEL || 'gpt-4.1-mini',
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
  if (process.env.VAPI_VOICE_PROVIDER && process.env.VAPI_VOICE_ID) {
    assistant.voice = {
      provider: process.env.VAPI_VOICE_PROVIDER,
      voiceId: process.env.VAPI_VOICE_ID,
    };
  }
  return assistant;
}
