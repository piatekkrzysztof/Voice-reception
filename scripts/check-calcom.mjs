import { loadConfig } from '../src/config.mjs';
import { checkCalcomConfiguration } from '../src/voice/calcom-preflight.mjs';

const config = loadConfig();
const jsonOutput = process.argv.includes('--json');

try {
  const result = await checkCalcomConfiguration({
    calcom: config.voice.calcom,
    timezone: config.voice.timezone,
  });

  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('Cal.com — kontrola konfiguracji (bez tworzenia rezerwacji)');
    if (result.window)
      console.log(
        `Zakres dostępności: ${result.window.start}–${result.window.end} (${result.window.timezone})`,
      );
    if (result.eventTypes.length && result.issues.length) {
      console.log('Typy wydarzeń widoczne na koncie:');
      console.table(
        result.eventTypes.map((eventType) => ({
          ID: eventType.id,
          nazwa: eventType.title,
          slug: eventType.slug,
          'czas [min]': eventType.durationMinutes,
        })),
      );
    }
    if (result.services.length)
      console.table(
        result.services.map((service) => ({
          usługa: service.service,
          'ID wydarzenia': service.eventTypeId,
          znaleziony: service.found ? 'tak' : 'nie',
          'czas [min]': service.durationMinutes ?? '—',
          'wolne sloty': service.availableSlots,
        })),
      );
    if (result.issues.length) {
      console.error('Do poprawy:');
      for (const issue of result.issues) console.error(`- ${issue}`);
    } else console.log('Wynik: konfiguracja Cal.com jest gotowa do testowej rezerwacji.');
  }
  if (!result.ready) process.exitCode = 1;
} catch (error) {
  if (jsonOutput)
    console.error(
      JSON.stringify({ ready: false, code: error.code || 'CALCOM_CHECK_FAILED' }, null, 2),
    );
  else
    console.error(`Kontrola Cal.com nie powiodła się: ${error.message} (${error.code || 'ERROR'})`);
  process.exitCode = 1;
}
