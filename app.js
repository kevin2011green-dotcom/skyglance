'use strict';

const STORE_KEY = 'skyglance:last';
const UNITS_KEY = 'skyglance:units';
const STALE_MS = 10 * 60 * 1000;

// WMO weather codes -> [label, day icon, night icon (optional)]
const WMO = {
  0: ['Clear', '☀️', '🌙'],
  1: ['Mostly clear', '🌤️', '🌙'],
  2: ['Partly cloudy', '⛅', '☁️'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌧️'],
  53: ['Drizzle', '🌦️', '🌧️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️', '🌧️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light showers', '🌦️', '🌧️'],
  81: ['Showers', '🌧️'],
  82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Thunderstorm with hail', '⛈️'],
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let units = readStore(UNITS_KEY) === 'metric' ? 'metric' : 'imperial';
let busy = false;

// ---------- storage ----------

function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function loadSaved() {
  try { return JSON.parse(readStore(STORE_KEY)); } catch { return null; }
}

// ---------- data ----------

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 15000, maximumAge: STALE_MS },
    );
  });
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

function fetchWeather({ lat, lon }, unitSystem) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
    timezone: 'auto',
    forecast_days: '7',
  });
  if (unitSystem === 'imperial') {
    params.set('temperature_unit', 'fahrenheit');
    params.set('wind_speed_unit', 'mph');
    params.set('precipitation_unit', 'inch');
  }
  return getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
}

async function fetchPlace({ lat, lon }) {
  const data = await getJson(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
  );
  const town = data.city || data.locality;
  const region = data.principalSubdivision;
  return [town, region].filter(Boolean).join(', ') || null;
}

// Past and forecast 3-hour Kp values; time tags are UTC and mark the start of each window.
async function fetchKp() {
  const rows = await getJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
  return rows
    .map((r) => ({ time: `${r.time_tag}Z`, kp: Number(r.kp) }))
    .filter((r) => Number.isFinite(r.kp));
}

const SWPC = 'https://services.swpc.noaa.gov';

function flareClass(flux) {
  if (!(flux > 0)) return null;
  const bands = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
  const [letter, base] = bands.find(([, floor]) => flux >= floor) || bands[bands.length - 1];
  return `${letter}${(flux / base).toFixed(1)}`;
}

// First line of a NOAA bulletin that reads like "ALERT: ..." or "EXTENDED WARNING: ...".
function alertHeadline(message) {
  const line = message.split(/\r?\n/).find((l) => /^[A-Z][A-Z ]*(ALERT|WARNING|WATCH|SUMMARY)[A-Z ]*:/.test(l));
  return line ? line.replace(/\s+/g, ' ').trim() : null;
}

// Solar flare feeds. Each one is optional, so a single outage doesn't blank the card.
async function fetchSolar() {
  const [flares, xrays, scales, alerts] = await Promise.allSettled([
    getJson(`${SWPC}/json/goes/primary/xray-flares-latest.json`),
    getJson(`${SWPC}/json/goes/primary/xrays-6-hour.json`),
    getJson(`${SWPC}/products/noaa-scales.json`),
    getJson(`${SWPC}/products/alerts.json`),
  ]);
  const solar = {};

  if (xrays.status === 'fulfilled') {
    // The 0.1-0.8nm band is the one flare classes are defined on.
    solar.flux = xrays.value
      .filter((r) => r.energy === '0.1-0.8nm' && r.flux > 0)
      .map((r) => [Date.parse(r.time_tag), r.flux]);
  }
  if (flares.status === 'fulfilled' && flares.value.length) {
    const f = flares.value[flares.value.length - 1];
    solar.current = f.current_class;
    if (f.max_class && f.max_time) solar.latest = { cls: f.max_class, time: f.max_time };
  }
  if (!solar.current && solar.flux && solar.flux.length) {
    solar.current = flareClass(solar.flux[solar.flux.length - 1][1]);
  }
  if (scales.status === 'fulfilled') {
    solar.odds = ['1', '2', '3']
      .map((key) => scales.value[key])
      .filter((day) => day && day.R && day.R.MinorProb != null)
      .map((day) => ({ date: day.DateStamp, m: Number(day.R.MinorProb), x: Number(day.R.MajorProb) }));
  }
  if (alerts.status === 'fulfilled') {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    solar.alerts = alerts.value
      .map((a) => ({ time: Date.parse(`${a.issue_datetime.replace(' ', 'T')}Z`), text: alertHeadline(a.message) }))
      .filter((a) => a.text && a.time >= cutoff)
      .sort((a, b) => b.time - a.time)
      .slice(0, 5);
  }
  return Object.keys(solar).length ? solar : null;
}

// ---------- formatting ----------

function describe(code, isDay) {
  const entry = WMO[code] || ['Unknown', '❔'];
  return { label: entry[0], icon: isDay ? entry[1] : entry[2] || entry[1] };
}

const round = (n) => Math.round(n);

function compass(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

// "2026-10-10T07:18" (already local to the forecast location) -> "7:18 AM"
function clock(iso, withMinutes = true) {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  const hour = h % 12 || 12;
  const suffix = h < 12 ? 'AM' : 'PM';
  return withMinutes ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

function kpLevel(kp) {
  if (kp >= 9) return ['G5 extreme storm', 'Aurora possible across most of the US.'];
  if (kp >= 8) return ['G4 severe storm', 'Aurora possible as far south as Alabama and northern California.'];
  if (kp >= 7) return ['G3 strong storm', 'Aurora possible as far south as Illinois and Oregon.'];
  if (kp >= 6) return ['G2 moderate storm', 'Aurora possible as far south as New York and Idaho.'];
  if (kp >= 5) return ['G1 minor storm', 'Aurora possible across the northern-tier US states.'];
  if (kp >= 4) return ['Active', 'Aurora possible near the US–Canada border.'];
  return ['Quiet', 'Aurora limited to the far north.'];
}

function flareLevel(cls) {
  const letter = (cls || '')[0];
  if (letter === 'X') return ['Major flare level', 'var(--kp-storm)'];
  if (letter === 'M') return ['Moderate flare level', 'var(--kp-active)'];
  if (letter === 'C') return ['Minor activity', 'var(--kp-quiet)'];
  return ['Quiet', 'var(--kp-quiet)'];
}

// Epoch ms -> "5:33 AM", with the date added when it isn't today.
function localTime(ms) {
  const when = new Date(ms);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (when.toDateString() === new Date().toDateString()) return time;
  return `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function kpColor(kp) {
  if (kp >= 5) return 'var(--kp-storm)';
  if (kp >= 4) return 'var(--kp-active)';
  return 'var(--kp-quiet)';
}

// ---------- rendering ----------

function setStatus(message, isError = false) {
  const box = $('status');
  box.textContent = message || '';
  box.className = message ? `show${isError ? ' error' : ''}` : '';
}

function renderWeather(weather, unitSystem) {
  const cur = weather.current;
  const daily = weather.daily;
  const hourly = weather.hourly;
  const windUnit = unitSystem === 'imperial' ? 'mph' : 'km/h';
  const now = describe(cur.weather_code, cur.is_day);

  document.body.classList.toggle('day', Boolean(cur.is_day));
  document.querySelector('meta[name="theme-color"]').content = cur.is_day ? '#2a6fc4' : '#0f1b33';
  $('units').textContent = unitSystem === 'imperial' ? '°F' : '°C';

  $('now-icon').textContent = now.icon;
  $('now-temp').textContent = `${round(cur.temperature_2m)}°`;
  $('now-desc').textContent = now.label;
  $('now-sub').textContent =
    `Feels like ${round(cur.apparent_temperature)}° · H ${round(daily.temperature_2m_max[0])}° L ${round(daily.temperature_2m_min[0])}°`;

  const stats = [
    ['Wind', `${round(cur.wind_speed_10m)} ${windUnit} ${compass(cur.wind_direction_10m)}`],
    ['Gusts', `${round(cur.wind_gusts_10m)} ${windUnit}`],
    ['Humidity', `${round(cur.relative_humidity_2m)}%`],
    ['Rain chance', `${daily.precipitation_probability_max[0] ?? 0}%`],
    ['Sunrise', clock(daily.sunrise[0])],
    ['Sunset', clock(daily.sunset[0])],
  ];
  $('stats').replaceChildren(...stats.map(([label, value]) => {
    const box = el('div', 'stat');
    box.append(el('div', 'label', label), el('div', 'value', value));
    return box;
  }));

  // Hourly times are local ISO strings, so plain string comparison finds "now".
  const thisHour = `${cur.time.slice(0, 13)}:00`;
  const start = Math.max(0, hourly.time.findIndex((t) => t >= thisHour));
  const hours = [];
  for (let i = start; i < Math.min(start + 24, hourly.time.length); i++) {
    const info = describe(hourly.weather_code[i], hourly.is_day[i]);
    const chance = hourly.precipitation_probability[i];
    const box = el('div', 'hour');
    box.append(
      el('div', 't', i === start ? 'Now' : clock(hourly.time[i], false)),
      el('div', 'i', info.icon),
      el('div', null, `${round(hourly.temperature_2m[i])}°`),
      el('div', 'p', chance >= 20 ? `${chance}%` : ''),
    );
    hours.push(box);
  }
  $('hourly').replaceChildren(...hours);

  const weekLow = Math.min(...daily.temperature_2m_min);
  const weekHigh = Math.max(...daily.temperature_2m_max);
  const span = weekHigh - weekLow || 1;
  $('daily').replaceChildren(...daily.time.map((date, i) => {
    const info = describe(daily.weather_code[i], true);
    const lo = daily.temperature_2m_min[i];
    const hi = daily.temperature_2m_max[i];
    const chance = daily.precipitation_probability_max[i] ?? 0;
    const name = i === 0
      ? 'Today'
      : new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'short' });

    const fill = el('div', 'fill');
    fill.style.left = `${((lo - weekLow) / span) * 100}%`;
    fill.style.right = `${((weekHigh - hi) / span) * 100}%`;
    const track = el('div', 'track');
    track.append(fill);
    const range = el('div', 'range');
    range.append(el('span', 'lo', `${round(lo)}°`), track, el('span', 'hi', `${round(hi)}°`));

    const row = el('div', 'day-row');
    row.append(
      el('div', null, name),
      el('div', 'i', info.icon),
      el('div', 'p', chance >= 20 ? `${chance}%` : ''),
      range,
    );
    return row;
  }));

  $('local').hidden = false;
}

function renderKp(rows) {
  // NOAA's "estimated" rows run past the current time, so split on the clock instead of its labels.
  const now = Date.now();
  const timed = rows.map((r) => ({ ...r, predicted: new Date(r.time).getTime() > now }));
  const observed = timed.filter((r) => !r.predicted);
  if (!observed.length) return;
  const latest = observed[observed.length - 1];
  const [level, hint] = kpLevel(latest.kp);

  $('kp-value').textContent = latest.kp.toFixed(1);
  $('kp-level').textContent = level;
  $('kp-level').style.color = kpColor(latest.kp);
  $('kp-hint').textContent = hint;

  const shown = [...observed.slice(-8), ...timed.filter((r) => r.predicted).slice(0, 8)];
  const firstPredicted = shown.findIndex((r) => r.predicted);
  const bars = [];
  const labels = [];
  shown.forEach((row, i) => {
    const bar = el('div', 'bar');
    bar.style.height = `${(Math.min(row.kp, 9) / 9) * 100}%`;
    bar.style.background = kpColor(row.kp);
    const wrap = el('div', `kp-bar${row.predicted ? ' predicted' : ''}${i === firstPredicted ? ' first-predicted' : ''}`);
    wrap.title = `Kp ${row.kp.toFixed(1)}`;
    wrap.append(bar);
    bars.push(wrap);

    const hour = new Date(row.time).getHours();
    labels.push(el('span', null, i % 2 === 0 ? `${hour % 12 || 12}${hour < 12 ? 'a' : 'p'}` : ''));
  });
  $('kp-chart').replaceChildren(...bars);
  $('kp-labels').replaceChildren(...labels);
  $('kp-card').hidden = false;
}

// X-ray flux on a log scale, with one band per flare class (B, C, M, X).
function flareChartSvg(points) {
  const W = 320, H = 110, LEFT = 14, MIN = -7.5, MAX = -3.5;
  const t0 = points[0][0];
  const span = points[points.length - 1][0] - t0 || 1;
  const yOf = (exp) => H - ((Math.min(MAX, Math.max(MIN, exp)) - MIN) / (MAX - MIN)) * H;
  const path = points
    .map(([t, flux]) => `${(LEFT + ((t - t0) / span) * (W - LEFT)).toFixed(1)},${yOf(Math.log10(flux)).toFixed(1)}`)
    .join(' ');
  const grid = [-7, -6, -5, -4]
    .map((exp) => `<line class="grid" x1="${LEFT}" x2="${W}" y1="${yOf(exp)}" y2="${yOf(exp)}"/>`)
    .join('');
  const bands = [['B', -6.5], ['C', -5.5], ['M', -4.5], ['X', -3.8]]
    .map(([letter, exp]) => `<text class="band" x="0" y="${yOf(exp) + 3}">${letter}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="X-ray flux, last 6 hours">${grid}${bands}<polyline class="line" points="${path}"/></svg>`;
}

function renderSolar(solar) {
  const [level, color] = flareLevel(solar.current);
  $('flare-now').textContent = solar.current || '–';
  $('flare-level').textContent = solar.current ? level : '';
  $('flare-level').style.color = color;
  $('flare-latest').textContent = solar.latest
    ? `Latest flare: ${solar.latest.cls}, peaked ${localTime(Date.parse(solar.latest.time))}.`
    : '';

  const hasFlux = Boolean(solar.flux && solar.flux.length > 1);
  $('flare-chart').innerHTML = hasFlux ? flareChartSvg(solar.flux) : '';
  $('flare-caption').hidden = !hasFlux;

  const odds = solar.odds || [];
  $('odds-title').hidden = !odds.length;
  $('flare-odds').replaceChildren(...odds.map((day, i) => {
    const name = i === 0
      ? 'Today'
      : new Date(`${day.date}T12:00`).toLocaleDateString(undefined, { weekday: 'short' });
    const box = el('div', 'stat');
    box.append(el('div', 'label', name), el('div', 'value', `M ${day.m}% · X ${day.x}%`));
    return box;
  }));

  const alerts = solar.alerts || [];
  $('alerts').replaceChildren(...(alerts.length
    ? alerts.map((a) => {
      const row = el('div', 'alert');
      row.append(el('div', null, a.text), el('div', 'when', localTime(a.time)));
      return row;
    })
    : [el('div', 'alert', solar.alerts ? 'None issued.' : 'Alerts unavailable right now.')]));

  $('solar-card').hidden = false;
}

function renderSpaceSummary(state) {
  const parts = [];
  if (state.kp) {
    const past = state.kp.filter((r) => new Date(r.time).getTime() <= Date.now());
    if (past.length) parts.push(`Kp ${past[past.length - 1].kp.toFixed(1)}`);
  }
  if (state.solar && state.solar.current) parts.push(`Flares ${state.solar.current}`);
  $('space-summary').textContent = parts.join(' · ');
  $('space').hidden = !(state.kp || state.solar);
}

function renderAll(state) {
  if (!state) return;
  if (state.weather) renderWeather(state.weather, state.units);
  if (state.kp) renderKp(state.kp);
  if (state.solar) renderSolar(state.solar);
  renderSpaceSummary(state);
  $('place').textContent = state.place || 'Your location';
  if (state.savedAt) {
    const when = new Date(state.savedAt);
    const sameDay = when.toDateString() === new Date().toDateString();
    const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('updated').textContent = `Updated ${sameDay ? time : `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`}`;
  }
}

// ---------- radar ----------

const RADAR_OPACITY = 0.7;
let radar = null; // { map, marker, frames, layers, index, timer, playing }

function showRadarFrame(index) {
  const layer = radar.layers[index];
  if (!radar.map.hasLayer(layer)) layer.addTo(radar.map);
  radar.layers.forEach((l, i) => l.setOpacity(i === index ? RADAR_OPACITY : 0));
  radar.index = index;
  const latest = index === radar.frames.length - 1;
  $('radar-time').textContent = `${localTime(radar.frames[index].time * 1000)}${latest ? ' (latest)' : ''}`;
}

function stopRadar() {
  if (!radar) return;
  clearTimeout(radar.timer);
  radar.playing = false;
  $('radar-play').textContent = '▶';
}

function playRadar() {
  radar.playing = true;
  $('radar-play').textContent = '⏸';
  // Put every frame on the map (invisible) so its tiles are loaded before its turn.
  radar.layers.forEach((l) => { if (!radar.map.hasLayer(l)) l.addTo(radar.map); });
  const step = () => {
    showRadarFrame((radar.index + 1) % radar.frames.length);
    const onLatest = radar.index === radar.frames.length - 1;
    radar.timer = setTimeout(step, onLatest ? 1800 : 500);
  };
  step();
}

// Rain radar for the last two hours, centred on the user. Skipped quietly when
// the map library or the radar service can't be reached (e.g. offline).
async function updateRadar({ lat, lon }) {
  if (typeof L === 'undefined') return;
  let data;
  try {
    data = await getJson('https://api.rainviewer.com/public/weather-maps.json');
  } catch {
    return;
  }
  const frames = (data.radar && data.radar.past) || [];
  if (!frames.length) return;

  $('radar-card').hidden = false;
  if (!radar) {
    // One-finger drag stays off on phones so swiping over the map still scrolls the page.
    const map = L.map('radar-map', { minZoom: 4, maxZoom: 10, dragging: !L.Browser.mobile, scrollWheelZoom: false })
      .setView([lat, lon], 8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      className: 'basemap',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const marker = L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#ffd166', fillOpacity: 1 }).addTo(map);
    radar = { map, marker, frames: [], layers: [], index: 0, timer: null, playing: false };
  } else {
    stopRadar();
    radar.layers.forEach((l) => l.remove());
    radar.marker.setLatLng([lat, lon]);
    radar.map.setView([lat, lon], radar.map.getZoom());
  }

  radar.frames = frames;
  // RainViewer's free tiles stop at zoom 7; Leaflet stretches them beyond that.
  radar.layers = frames.map((frame) => L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    opacity: 0,
    maxNativeZoom: 7,
    maxZoom: 10,
  }));
  radar.map.invalidateSize();
  showRadarFrame(frames.length - 1);
}

$('radar-play').addEventListener('click', () => {
  if (!radar) return;
  if (radar.playing) stopRadar(); else playRadar();
});

// ---------- refresh ----------

function locationProblem(err) {
  if (err && err.code === 1) return 'Location permission is off. Allow location for this app in your browser or phone settings, then tap refresh.';
  if (err && err.code === 3) return 'Finding your location took too long. Tap refresh to try again.';
  return 'Could not get your location. Tap refresh to try again.';
}

async function refresh() {
  if (busy) return;
  busy = true;
  $('refresh').classList.add('spinning');
  const saved = loadSaved();

  try {
    let coords;
    let note = '';
    setStatus(saved ? '' : 'Finding your location…');
    try {
      coords = await locate();
    } catch (err) {
      if (!saved || !saved.coords) {
        setStatus(locationProblem(err), true);
        return;
      }
      coords = saved.coords;
      note = `${locationProblem(err)} Showing your last known spot.`;
    }

    if (!saved) setStatus('Loading weather…');
    const [weather, place, kp, solar] = await Promise.allSettled([
      fetchWeather(coords, units),
      fetchPlace(coords),
      fetchKp(),
      fetchSolar(),
    ]);

    if (weather.status !== 'fulfilled') {
      setStatus(
        saved
          ? 'Could not reach the weather service. Showing the last saved forecast.'
          : 'Could not reach the weather service. Check your connection and tap refresh.',
        true,
      );
      return;
    }

    const state = {
      coords,
      units,
      weather: weather.value,
      place: place.status === 'fulfilled' && place.value ? place.value : saved && saved.place,
      kp: kp.status === 'fulfilled' && kp.value.length ? kp.value : saved && saved.kp,
      solar: solar.status === 'fulfilled' && solar.value ? solar.value : saved && saved.solar,
      savedAt: Date.now(),
    };
    writeStore(STORE_KEY, JSON.stringify(state));
    renderAll(state);
    setStatus(note, Boolean(note));
    updateRadar(coords);
  } finally {
    busy = false;
    $('refresh').classList.remove('spinning');
  }
}

$('refresh').addEventListener('click', refresh);

$('units').addEventListener('click', () => {
  if (busy) return;
  units = units === 'imperial' ? 'metric' : 'imperial';
  writeStore(UNITS_KEY, units);
  refresh();
});

// Remember whether the space weather section was left open or closed.
const SPACE_KEY = 'skyglance:space-open';
$('space').open = readStore(SPACE_KEY) !== 'no';
$('space').addEventListener('toggle', () => writeStore(SPACE_KEY, $('space').open ? 'yes' : 'no'));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    stopRadar();
    return;
  }
  const saved = loadSaved();
  if (!saved || Date.now() - saved.savedAt > STALE_MS) refresh();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without offline support */ });
}

renderAll(loadSaved());
refresh();
