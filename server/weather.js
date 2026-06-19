// Server-side weather poller for the 出游助手 Tahoe itinerary dial.
//
// Once an hour (and on startup) this fetches Open-Meteo for every city on the route, then
// assembles the SAME "where you'll be each hour" series the dial expects — each tick is the
// forecast for the city the itinerary puts you in at that hour — and stores it in the DB
// (survives restarts/redeploys via the /home mount). The tourguide page fetches the result
// from GET /api/weather on load; offline it falls back to its own baked numbers.
//
// Open-Meteo is free + keyless. Node 20+ has a global fetch. The forecast window is the fixed
// trip dates below (Open-Meteo serves ~16 days ahead) — bump them to reuse for another trip.
import db from './db.js';

const PLACES = {
  bay:    { label: '湾区', lat: 37.3688, lon: -122.0363 }, // Sunnyvale
  sac:    { label: '萨城', lat: 38.5816, lon: -121.4944 }, // Sacramento
  placer: { label: '普镇', lat: 38.7296, lon: -120.7985 }, // Placerville
  tahoe:  { label: '太浩', lat: 38.9399, lon: -119.9772 }, // South Lake Tahoe
};
const DATES = ['2026-06-21', '2026-06-22'];

// hour -> place, per day — mirrors the itinerary's plan (home→valley→Tahoe, then Tahoe→home).
// sunPlace = whose sunrise/sunset drives the dial's day/night + sunset marker.
const SCHEDULE = {
  day1: { date: '2026-06-21', sunPlace: 'tahoe', hours: [
    [7, 'bay'], [8, 'sac'], [9, 'placer'], [10, 'tahoe'], [11, 'tahoe'], [12, 'tahoe'], [13, 'tahoe'],
    [14, 'tahoe'], [15, 'tahoe'], [16, 'tahoe'], [17, 'tahoe'], [18, 'tahoe'], [19, 'tahoe'], [20, 'tahoe'], [21, 'tahoe'] ] },
  day2: { date: '2026-06-22', sunPlace: 'tahoe', hours: [
    [7, 'tahoe'], [8, 'tahoe'], [9, 'tahoe'], [10, 'tahoe'], [11, 'placer'], [12, 'placer'],
    [13, 'sac'], [14, 'sac'], [15, 'sac'], [16, 'bay'], [17, 'bay'] ] },
};
const POLL_MS = 60 * 60 * 1000;

let cacheStr = null; // last good forecast, stringified — served straight from /api/weather

const decHour = (iso) => { const t = (iso || '').split('T')[1] || '0:0'; const [h, m] = t.split(':').map(Number); return h + (m || 0) / 60; };
function fmtClock(dec) {
  let h = Math.floor(dec), m = Math.round((dec - h) * 60);
  if (m === 60) { h++; m = 0; }
  const ap = h >= 12 ? 'p' : 'a'; const hh = (h % 12) || 12;
  return `${hh}:${String(m).padStart(2, '0')}${ap}`;
}

async function fetchPlace(p) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}`
    + '&hourly=temperature_2m,weather_code,precipitation_probability&daily=sunrise,sunset'
    + `&timezone=America%2FLos_Angeles&start_date=${DATES[0]}&end_date=${DATES[DATES.length - 1]}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error('open-meteo ' + r.status);
  return r.json();
}

// Build the { fetched, day1, day2 } object the dial consumes: hours = [hour, cityLabel, °C, WMO code, precip%].
function assemble(byPlace) {
  const out = { fetched: new Date().toISOString() };
  for (const dayId of Object.keys(SCHEDULE)) {
    const s = SCHEDULE[dayId];
    const sun = byPlace[s.sunPlace];
    const di = sun.daily.time.indexOf(s.date);
    const sunriseDec = decHour(sun.daily.sunrise[di]);
    const sunsetDec = decHour(sun.daily.sunset[di]);
    const hours = s.hours.map(([h, placeKey]) => {
      const d = byPlace[placeKey];
      const i = d.hourly.time.indexOf(`${s.date}T${String(h).padStart(2, '0')}:00`);
      const t = i >= 0 ? Math.round(d.hourly.temperature_2m[i]) : null;
      const c = i >= 0 ? d.hourly.weather_code[i] : 0;
      const pr = i >= 0 ? (d.hourly.precipitation_probability[i] || 0) : 0;
      return [h, PLACES[placeKey].label, t, c, pr];
    });
    out[dayId] = { sr: Math.floor(sunriseDec), ss: Math.floor(sunsetDec) + 1, sunset: Math.round(sunsetDec * 100) / 100, sunsetTxt: fmtClock(sunsetDec), hours };
  }
  return out;
}

async function poll() {
  try {
    const keys = Object.keys(PLACES);
    const results = await Promise.all(keys.map((k) => fetchPlace(PLACES[k])));
    const byPlace = {}; keys.forEach((k, i) => { byPlace[k] = results[i]; });
    const data = assemble(byPlace);
    // Sanity: never overwrite good data with a half-empty assembly.
    if (!['day1', 'day2'].every((d) => data[d].hours.every((r) => r[2] != null))) throw new Error('assembled data missing temps');
    cacheStr = JSON.stringify(data);
    try { db.saveWeather?.(data); } catch (e) { console.warn('[weather] db save failed:', e && e.message); }
    console.log(`[weather] updated ${data.fetched}`);
  } catch (e) {
    console.warn('[weather] poll failed (keeping last known):', e && e.message);
  }
}

// The last-known forecast as a JSON string, or null if we have nothing yet.
export function getWeatherJson() { return cacheStr; }

// Seed from the DB (so a fresh process serves immediately), then refresh now + hourly.
export function startWeather() {
  try { const stored = db.loadWeather?.(); if (stored) cacheStr = JSON.stringify(stored); } catch { /* ignore */ }
  poll();
  setInterval(poll, POLL_MS).unref?.();
}
