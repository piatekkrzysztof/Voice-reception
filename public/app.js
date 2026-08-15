const state = {
  dashboard: null,
  hold: null,
  loading: false
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Błąd HTTP ${response.status}`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast visible ${type === 'error' ? 'error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

function setLoading(loading) {
  state.loading = loading;
  $('#refresh-button').classList.toggle('is-loading', loading);
  document.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = loading; });
}

function tomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toLocaleDateString('en-CA');
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: state.dashboard?.integration.timezone || 'Europe/Warsaw' }).format(new Date(value));
}

function formatDuration(seconds = 0) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function outcomeLabel(outcome) {
  return ({
    BOOKED: 'Rezerwacja', RESCHEDULED: 'Zmiana terminu', CANCELLED: 'Anulowana',
    TRANSFERRED: 'Transfer', RESOLVED: 'Rozwiązana', UNRESOLVED: 'Nierozwiązana', IN_PROGRESS: 'W toku'
  })[outcome] || outcome || 'Nieznany';
}

function renderIntegrations(data) {
  const integrations = Object.values(data.integration.integrations);
  $('#integration-strip').innerHTML = integrations.map((item) => `
    <article class="integration-unit ${item.ready ? '' : 'pending'}">
      <i></i><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.detail || item.mode)} · ${item.ready ? 'gotowe' : 'konfiguracja'}</span></div>
    </article>`).join('');

  const externalVoiceReady = data.integration.provider === 'vapi' && data.integration.integrations.voice.ready;
  $('#environment-label').textContent = externalVoiceReady ? 'PILOT ZEWNĘTRZNY' : 'TRYB LOKALNY';
  $('#agent-label').textContent = externalVoiceReady ? 'VAPI ASSISTANT / PL' : 'BOOKING SERVICE / PL';
  $('#agent-state').textContent = externalVoiceReady ? 'GOTOWY DO POŁĄCZEŃ' : 'TRYB LOKALNY';
  $('#system-status').textContent = externalVoiceReady ? 'AGENT ONLINE' : 'CORE ONLINE';
  $('#business-name').textContent = data.integration.business.name;
  $('#timezone-label').textContent = data.integration.timezone;
  $('#agent-greeting').textContent = `Dzień dobry, tu automatyczna asystentka AI firmy ${data.integration.business.name}. Mogę pomóc umówić wizytę, a w każdej chwili połączyć z pracownikiem.`;
}

function renderMetrics(metrics, integration) {
  const provider = integration.provider === 'vapi' ? 'VAPI' : 'LOCAL';
  const cards = [
    ['ROZMOWY', metrics.calls, 'zapisane raporty'],
    ['REZERWACJE', metrics.bookings, 'aktywnie potwierdzone'],
    ['TRANSFER', metrics.transfers, 'przekazane człowiekowi'],
    ['PROVIDER', provider, `${Number(metrics.totalCost || 0).toFixed(2)} zł kosztu`]
  ];
  $('#metric-grid').innerHTML = cards.map(([label, value, detail]) => `
    <article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join('');
}

function renderReadiness(data) {
  const integrations = data.integration.integrations;
  const items = [
    { ready: integrations.database.ready, title: 'Booking Service', copy: 'Transakcje, holdy i ochrona konfliktów.' },
    { ready: data.integration.calendarProvider === 'calcom' && integrations.calendar.ready, title: 'Cal.com', copy: 'Prawdziwe sloty i rezerwacje w kalendarzu.' },
    { ready: data.integration.provider === 'vapi' && integrations.voice.ready, title: 'Vapi + numer', copy: 'Asystent przypisany do linii telefonicznej.' },
    { ready: integrations.publicWebhook.ready && integrations.webhookAuth.ready, title: 'Publiczny edge', copy: 'HTTPS i uwierzytelniony webhook.' }
  ];
  const readyCount = items.filter((item) => item.ready).length;
  $('#readiness-score').textContent = `${readyCount} / ${items.length} GOTOWE`;
  $('#readiness-list').innerHTML = items.map((item, index) => `
    <article class="readiness-item ${item.ready ? 'ready' : ''}">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.copy)}</small></div><i></i>
    </article>`).join('');
  $('#webhook-url').textContent = data.integration.webhookUrl;
}

function renderServices(services) {
  const selected = $('#service-select').value;
  $('#service-select').innerHTML = services.map((service) => `
    <option value="${escapeHtml(service.id)}">${escapeHtml(service.name)} · ${service.durationMinutes} min</option>`).join('');
  if (services.some((service) => service.id === selected)) $('#service-select').value = selected;
}

function renderBookings(bookings) {
  $('#booking-count').textContent = `${bookings.length} ${bookings.length === 1 ? 'REKORD' : 'REKORDÓW'}`;
  if (!bookings.length) {
    $('#bookings-list').className = 'empty-state';
    $('#bookings-list').innerHTML = '<span>00</span><p>Brak rezerwacji. Pierwsza potwierdzona wizyta pojawi się tutaj.</p>';
    return;
  }
  $('#bookings-list').className = 'ledger-list';
  $('#bookings-list').innerHTML = bookings.map((booking) => `
    <article class="ledger-row">
      <div><strong>${escapeHtml(booking.customer)}</strong><small>${escapeHtml(booking.phone)}</small></div>
      <div><strong>${escapeHtml(booking.service)}</strong><small>${escapeHtml(booking.id)}</small></div>
      <div><strong>${escapeHtml(formatDate(booking.startAt))}</strong><small>${escapeHtml(booking.email || 'bez e-maila')}</small></div>
      <span class="status-pill ${booking.status === 'confirmed' ? 'good' : ''}">${escapeHtml(booking.status)}</span>
      ${booking.status === 'confirmed' ? `<button class="text-button" data-cancel-booking="${escapeHtml(booking.id)}" type="button">ANULUJ</button>` : '<span></span>'}
    </article>`).join('');
}

function renderCalls(calls, metrics) {
  $('#disclosure-rate').textContent = `AI DISCLOSURE ${metrics.aiDisclosure}%`;
  if (!calls.length) {
    $('#calls-list').className = 'empty-state';
    $('#calls-list').innerHTML = '<span>00</span><p>Brak rozmów. Raport z pierwszego połączenia Vapi pojawi się tutaj.</p>';
    return;
  }
  $('#calls-list').className = 'ledger-list';
  $('#calls-list').innerHTML = calls.map((call) => `
    <article class="ledger-row">
      <div><strong>${escapeHtml(call.caller || 'Numer zastrzeżony')}</strong><small>${escapeHtml(formatDate(call.startedAt))}</small></div>
      <div><strong>${escapeHtml(call.intent || 'Nieokreślona intencja')}</strong><small>${escapeHtml(formatDuration(call.durationSeconds))}</small></div>
      <div><strong>${escapeHtml(call.summary || call.booking || 'Bez dodatkowego opisu')}</strong><small>${Number(call.cost || 0).toFixed(2)} zł</small></div>
      <span class="status-pill ${call.outcome === 'TRANSFERRED' ? 'transfer' : 'good'}">${escapeHtml(outcomeLabel(call.outcome))}</span>
      <span></span>
    </article>`).join('');
}

async function loadDashboard({ quiet = false, force = false } = {}) {
  if (state.loading && !force) return;
  setLoading(true);
  try {
    const data = await api('/api/voice');
    state.dashboard = data;
    renderIntegrations(data);
    renderMetrics(data.metrics, data.integration);
    renderReadiness(data);
    renderServices(data.services);
    renderBookings(data.bookings);
    renderCalls(data.calls, data.metrics);
    if (!quiet) showToast('Dane operacyjne zostały odświeżone.');
  } catch (error) {
    $('#system-status').textContent = 'BŁĄD CORE';
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

function showSlots(result) {
  const stage = $('#flow-stage');
  if (!result.slots.length) {
    stage.className = 'flow-stage';
    stage.innerHTML = '<span class="stage-number">00</span><div><strong>Brak wolnych terminów</strong><p>Wybierz inny dzień albo usługę. Agent nie zaproponuje terminu spoza kalendarza.</p></div>';
    return;
  }
  stage.className = 'slot-grid';
  stage.innerHTML = result.slots.map((slot) => `
    <button class="slot-button" type="button" data-slot-id="${escapeHtml(slot.id)}">
      <strong>${escapeHtml(slot.time)}</strong><span>${slot.duration} MIN · WOLNY</span>
    </button>`).join('');
}

async function checkAvailability(event) {
  event.preventDefault();
  if (state.loading) return;
  setLoading(true);
  try {
    const result = await api('/api/voice/availability', {
      method: 'POST',
      body: JSON.stringify({ service: $('#service-select').value, preferredDate: $('#preferred-date').value })
    });
    showSlots(result);
    showToast(`Znaleziono ${result.slots.length} dostępnych terminów.`);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function selectSlot(slotId) {
  if (state.loading) return;
  setLoading(true);
  try {
    const result = await api('/api/voice/holds', { method: 'POST', body: JSON.stringify({ slotId }) });
    state.hold = result;
    const stage = $('#flow-stage');
    stage.className = 'flow-stage';
    stage.innerHTML = `
      <span class="stage-number">02</span>
      <div><strong>${escapeHtml(result.slot.service)} · ${escapeHtml(result.slot.date)} · ${escapeHtml(result.slot.time)}</strong><p>Termin został zablokowany na kilka minut. Uzupełnij dane wymagane do potwierdzenia.</p></div>
      <form class="customer-form full" id="customer-form">
        <label>Imię i nazwisko<input name="customerName" autocomplete="name" required /></label>
        <label>Telefon<input name="phone" type="tel" autocomplete="tel" placeholder="+48 600 100 200" required /></label>
        <label class="full">E-mail — opcjonalnie<input name="email" type="email" autocomplete="email" /></label>
        <button class="primary-button" type="submit">Potwierdź rezerwację <span>→</span></button>
      </form>`;
    $('#customer-form').addEventListener('submit', confirmBooking);
    showToast('Termin został bezpiecznie zablokowany.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function confirmBooking(event) {
  event.preventDefault();
  if (!state.hold || state.loading) return;
  const form = new FormData(event.currentTarget);
  setLoading(true);
  try {
    const result = await api('/api/voice/bookings', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        holdId: state.hold.hold.id,
        customerName: form.get('customerName'),
        phone: form.get('phone'),
        email: form.get('email')
      })
    });
    $('#flow-stage').className = 'flow-stage';
    $('#flow-stage').innerHTML = `<span class="stage-number">✓</span><div><strong>Rezerwacja potwierdzona</strong><p>${escapeHtml(result.booking.service)} · ${escapeHtml(formatDate(result.booking.startAt))} · ${escapeHtml(result.booking.customer)}</p></div>`;
    state.hold = null;
    showToast(`Rezerwacja ${result.booking.id} została potwierdzona.`);
    await loadDashboard({ quiet: true, force: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function cancelBooking(bookingId) {
  if (state.loading) return;
  setLoading(true);
  try {
    await api(`/api/voice/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Anulowanie z konsoli operacyjnej' })
    });
    showToast('Rezerwacja została anulowana.');
    await loadDashboard({ quiet: true, force: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setLoading(false);
  }
}

document.addEventListener('click', (event) => {
  const slot = event.target.closest('[data-slot-id]');
  if (slot) selectSlot(slot.dataset.slotId);
  const cancellation = event.target.closest('[data-cancel-booking]');
  if (cancellation) cancelBooking(cancellation.dataset.cancelBooking);
});

$('#availability-form').addEventListener('submit', checkAvailability);
$('#refresh-button').addEventListener('click', () => loadDashboard());
$('#preferred-date').min = tomorrow();
$('#preferred-date').value = tomorrow();

setInterval(() => {
  $('#clock').textContent = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
}, 1000);

loadDashboard({ quiet: true });
