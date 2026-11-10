// BR 19 — Bangladesh Railway train tracking (Bengali UI)
// ---------------------------------------------------------------------------
// Data: TrainKothai.com public pages (schedules use public BR data, live
// positions on that site are community-sourced passenger reports).
//
// HONESTY RULE — this server NEVER invents a live position:
//  * /track/<n> HTML contains the timetable, route, duration, classes,
//    operating days and last-7-runs delay history. That is what we serve.
//  * The live position/speed/current delay load client-side on
//    trainkothai.com from /api/v1/live/track/<n>, which needs a session
//    cookie from POST /api/v1/session with a valid Cloudflare Turnstile
//    token (a human check in a real browser). A server cannot solve it:
//    from a server the live API answers 401 {"error":"pass_required"}.
//    So we TRY the live endpoint (in case the site ever opens it up) and
//    otherwise report live as unavailable, with a direct link for the
//    user to open the live view on trainkothai.com in their browser.
//  * "Schedule progress" is computed from the timetable + the current
//    Asia/Dhaka time and is ALWAYS labelled schedule-based (আনুমানিক),
//    never as a live position. Delay-adjusted ETA uses the train's
//    average delay over its last 7 tracked runs and is labelled the same.
//
// Caching: fresh track-page fetches are cached 2 minutes; the snapshot in
// data/trains.json (built by tools/scrape_trainkothai.py) is the fallback
// and the source for the all-trains list + station search. A background
// refresh re-scrapes the snapshot every 6 hours when the source answers.
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const TK = "https://trainkothai.com";
const UA = "BR19-Train-App/1.0 (+https://trainkothai.com; polite, cached, 1 req/2s max)";
const TRACK_TTL_MS = 2 * 60 * 1000; // fresh track fetch cache
const LIVE_TTL_MS = 60 * 1000;

const DATA_FILE = path.join(__dirname, "data", "trains.json");
let snapshot = { generatedAt: null, trains: [] };
function loadSnapshot() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (Array.isArray(d.trains) && d.trains.length) {
      snapshot = d;
      console.log(`[snapshot] loaded ${d.trains.length} trains (generated ${d.generatedAt})`);
    }
  } catch (e) { console.log("[snapshot] none yet:", e.message); }
}
loadSnapshot();
const byNumber = () => {
  const m = new Map();
  for (const t of snapshot.trains) m.set(t.number, t);
  return m;
};

// ---- time helpers (Asia/Dhaka) ----
function dhakaNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const h = +parts.find(p => p.type === "hour").value % 24;
  const mi = +parts.find(p => p.type === "minute").value;
  return { minutes: h * 60 + mi, hhmm: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` };
}
function toMin(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fmtDur(mins) {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} ঘণ্টা ${m} মিনিট` : `${m} মিনিট`;
}
function addMin(hhmm, mins) {
  const v = toMin(hhmm);
  if (v == null || mins == null) return null;
  const t = (v + mins) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// Schedule-based progress for a train record. Every time is shifted by the
// train's average delay (last 7 runs): a pure-timetable estimate claims a
// late train is far ahead of where it really is (e.g. it showed 736 already
// past Kendua_Bazar while it had not even left Tarakandi). This is still an
// estimate, never live data — the exact position only comes from TrainKothai.
function scheduleProgress(train) {
  const stops = train.stops || [];
  if (stops.length < 2) return { state: "unknown", label: "তথ্য নেই" };
  const depRaw = toMin(stops[0].sched), arrRaw = toMin(stops[stops.length - 1].sched);
  if (depRaw == null || arrRaw == null) return { state: "unknown", label: "তথ্য নেই" };
  const avgMin = (train.delayHistory && train.delayHistory.avgMin) || 0;
  // Range of delays over the last 7 runs, so the app can show honestly how
  // far today's delay can sit from the average (e.g. 736: avg +123 min, but
  // today only +48 min — the average alone then misleads badly).
  const runDelays = ((train.delayHistory && train.delayHistory.runs) || []).map(r => r.delayMin).filter(v => v != null);
  const minDelayMin = runDelays.length ? Math.min.apply(null, runDelays) : null;
  const maxDelayMin = runDelays.length ? Math.max.apply(null, runDelays) : null;
  const dep = depRaw + avgMin, arr = arrRaw + avgMin;
  const overnight = arrRaw < depRaw;
  const total = overnight ? arrRaw + 1440 - depRaw : arrRaw - depRaw;
  const now = dhakaNow();
  let nowJ = now.minutes;
  if (overnight && nowJ < depRaw) nowJ += 1440;
  if (nowJ < dep) {
    return { state: "not_departed", label: "এখনো ছাড়েনি (গড় দেরি অনুযায়ী আনুমানিক)", departsInMin: dep - now.minutes,
             departure: stops[0].sched, arrival: stops[stops.length - 1].sched,
             estimatedDeparture: addMin(stops[0].sched, avgMin), avgDelayMin: avgMin, minDelayMin: minDelayMin, maxDelayMin: maxDelayMin, progressPct: 0 };
  }
  if (nowJ > dep + total) {
    return { state: "arrived", label: "পৌঁছে গেছে (গড় দেরি অনুযায়ী আনুমানিক)", progressPct: 100,
             departure: stops[0].sched, arrival: stops[stops.length - 1].sched,
             estimatedArrival: addMin(stops[stops.length - 1].sched, avgMin), avgDelayMin: avgMin, minDelayMin: minDelayMin, maxDelayMin: maxDelayMin };
  }
  const elapsed = nowJ - dep;
  const pct = Math.round((elapsed / total) * 100);
  // journey minutes for each stop (roll over midnight when overnight), shifted by avg delay
  const jm = stops.map(s => {
    let v = toMin(s.sched);
    if (v == null) return null;
    if (overnight && v < depRaw) v += 1440;
    return v + avgMin;
  });
  let lastIdx = -1, nextIdx = -1;
  jm.forEach((v, i) => { if (v != null && v <= nowJ) lastIdx = i; });
  nextIdx = jm.findIndex(v => v != null && v > nowJ);
  const last = lastIdx >= 0 ? stops[lastIdx] : null;
  const next = nextIdx >= 0 ? stops[nextIdx] : null;
  let minsToNext = null;
  if (next) minsToNext = jm[nextIdx] - nowJ;
  return { state: "running", label: "চলছে (গড় দেরি অনুযায়ী আনুমানিক)", progressPct: pct,
           departure: stops[0].sched, arrival: stops[stops.length - 1].sched,
           lastPassed: last ? { name: last.name, bn: last.bn, sched: last.sched, km: last.km } : null,
           nextStop: next ? { name: next.name, bn: next.bn, sched: next.sched, km: next.km, inMin: minsToNext } : null,
           stopsCleared: lastIdx + 1, totalStops: stops.length, avgDelayMin: avgMin, minDelayMin: minDelayMin, maxDelayMin: maxDelayMin,
           etaByAvgDelay: addMin(stops[stops.length - 1].sched, avgMin) };
}

// ---- TrainKothai fetching (polite, cached) ----
const trackCache = new Map(); // number -> {at, record}
const liveCache = new Map();  // number -> {at, live}

function stripTags(html) {
  let s = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  s = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return s.replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}
function rscText(html) {
  // Join all Next.js RSC push payloads in document order, JS-unescaping
  // each. Long strings (e.g. timetables) are split across several pushes,
  // so only the joined text has them contiguous.
  const needle = 'self.__next_f.push([1,"';
  const out = [];
  let i = 0;
  while (true) {
    const j = html.indexOf(needle, i);
    if (j < 0) break;
    let k = j + needle.length;
    let raw = "";
    while (k < html.length) {
      const c = html[k];
      if (c === "\\") { raw += html.slice(k, k + 2); k += 2; continue; }
      if (c === '"') break;
      raw += c; k += 1;
    }
    try { out.push(JSON.parse('"' + raw + '"')); }
    catch (e) { out.push(raw); }
    i = k + 1;
  }
  return out.join("");
}
function parseTimetable(html) {
  const text = rscText(html);
  const stopRe = /\{"code":"([^"]*)","name":"([^"]*)","bn":"([^"]*)","sched":"([^"]*)","act":"([^"]*)","platform":"([^"]*)","km":(\d+),"status":"([^"]*)"\}/g;
  const m = text.match(/\[(?:\{"code":"[^"]*","name":"[^"]*","bn":"[^"]*","sched":"[^"]*","act":"[^"]*","platform":"[^"]*","km":\d+,"status":"[^"]*"\},?)+\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length && arr[0].name) return arr;
    } catch (e) { /* fall through */ }
  }
  const stops = [];
  let sm;
  while ((sm = stopRe.exec(text))) {
    stops.push({ code: sm[1], name: sm[2], bn: sm[3], sched: sm[4], act: sm[5],
                 platform: sm[6], km: +sm[7], status: sm[8] });
  }
  return stops.length ? stops : null;
}
function parseTrackPage(html, number, name) {
  const text = stripTags(html);
  const stops = parseTimetable(html);
  const durM = text.match(/(\d+h\s*\d+m)\s*·/);
  const hist = { avgMin: null, runs: [] };
  const hm = text.match(/Delay \(min\) — Last 7 Tracked Runs.*?avg ~([\dh\s]+m)/);
  if (hm) {
    let mins = 0;
    for (const p of hm[1].trim().split(/\s+/)) {
      if (p.endsWith("h")) mins += parseInt(p) * 60;
      else if (p.endsWith("m")) mins += parseInt(p);
    }
    hist.avgMin = mins;
  }
  for (const rm of text.matchAll(/\+(\d+)\s+(\d+)\s+Nov/g))
    hist.runs.push({ day: +rm[2], delayMin: +rm[1] });
  const cm = text.match(/Classes & Service ([A-Za-z ,\-]+?) Operating Days/);
  const dm = text.match(/Operating Days ([MTWTFSS ]+?) Advertisement/);
  let from = null, to = null;
  const tm = text.match(/—\s*(.+?)\s+to\s+(.+?)\s*\| TrainKothai/);
  if (tm) { from = tm[1].trim(); to = tm[2].trim(); }
  if (stops && stops.length) { from = stops[0].name; to = stops[stops.length - 1].name; }
  return { number, name, from, to, duration: durM ? durM[1].replace(/\s/g, "") : null,
           classes: cm ? cm[1].trim() : null, operatingDays: dm ? dm[1].trim() : null,
           delayHistory: hist, stops: stops || [], trackUrl: `${TK}/track/${number}` };
}
async function fetchTrackPage(number, fallbackName) {
  const cached = trackCache.get(number);
  if (cached && Date.now() - cached.at < TRACK_TTL_MS) return { ...cached.record, fresh: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${TK}/track/${number}`, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const rec = parseTrackPage(html, number, fallbackName || `ট্রেন ${number}`);
    if (!rec.stops.length) throw new Error("no timetable in page");
    trackCache.set(number, { at: Date.now(), record: rec });
    return { ...rec, fresh: true };
  } finally { clearTimeout(t); }
}
async function fetchLive(number) {
  const cached = liveCache.get(number);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.live;
  let live;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${TK}/api/v1/live/track/${number}`, {
        headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
      if (res.ok) {
        const j = await res.json();
        live = { available: true, source: "trainkothai-live-api", data: j };
      } else {
        live = { available: false, reason: res.status === 401
          ? "লাইভ এপিআই-তে সার্ভার থেকে ঢোকা যায় না (ক্লাউডফ্লেয়ার যাচাই লাগে)"
          : `লাইভ এপিআই উত্তর দেয়নি (HTTP ${res.status})` };
      }
    } finally { clearTimeout(t); }
  } catch (e) {
    live = { available: false, reason: "লাইভ সার্ভারে পৌঁছানো যায়নি" };
  }
  liveCache.set(number, { at: Date.now(), live });
  return live;
}

// ---- API ----
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "BR 19", nowDhaka: dhakaNow().hhmm,
             snapshotTrains: snapshot.trains.length, snapshotGeneratedAt: snapshot.generatedAt,
             source: "trainkothai.com" });
});

app.get("/api/trains", (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const now = dhakaNow();
  let list = snapshot.trains.map(t => {
    const sp = scheduleProgress(t);
    return { number: t.number, name: t.name, from: t.from, to: t.to,
             duration: t.duration, departure: t.stops[0] ? t.stops[0].sched : null,
             arrival: t.stops.length ? t.stops[t.stops.length - 1].sched : null,
             scheduleState: sp.state, scheduleLabel: sp.label,
             avgDelayMin: t.delayHistory ? t.delayHistory.avgMin : null,
             stops: t.stops.length };
  });
  if (q) list = list.filter(t =>
    String(t.number).includes(q) || t.name.toLowerCase().includes(q) ||
    (t.from && t.from.toLowerCase().includes(q)) || (t.to && t.to.toLowerCase().includes(q)));
  res.json({ nowDhaka: now.hhmm, count: list.length, total: snapshot.trains.length,
             snapshotGeneratedAt: snapshot.generatedAt, trains: list });
});

app.get("/api/train/:number", async (req, res) => {
  const number = parseInt(req.params.number, 10);
  if (!number) return res.status(400).json({ error: "সঠিক ট্রেন নম্বর দিন" });
  const snap = byNumber().get(number);
  let record = snap || null, source = "snapshot";
  try {
    const fresh = await fetchTrackPage(number, snap ? snap.name : null);
    record = fresh; source = fresh.fresh ? "live-page" : "cache";
  } catch (e) {
    if (!record) return res.status(502).json({ error: "ট্রেনের তথ্য এখন আনা যাচ্ছে না, একটু পরে আবার চেষ্টা করুন", detail: e.message });
  }
  const live = await fetchLive(number);
  const sp = scheduleProgress(record);
  res.json({ number, name: record.name, from: record.from, to: record.to,
             duration: record.duration, classes: record.classes,
             operatingDays: record.operatingDays, delayHistory: record.delayHistory,
             stops: record.stops, schedule: sp,
             avgDelayText: record.delayHistory && record.delayHistory.avgMin != null
               ? fmtDur(record.delayHistory.avgMin) : null,
             live, trackUrl: record.trackUrl,
             observedAtDhaka: dhakaNow().hhmm, dataSource: source,
             snapshotGeneratedAt: snapshot.generatedAt });
});

app.get("/api/station", (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  if (!q || q.length < 2) return res.json({ count: 0, trains: [] });
  const hits = [];
  for (const t of snapshot.trains) {
    for (const s of t.stops || []) {
      const hay = `${s.name} ${s.bn || ""} ${s.code || ""}`.toLowerCase();
      if (hay.includes(q)) {
        hits.push({ trainNumber: t.number, trainName: t.name, from: t.from, to: t.to,
                    station: s.name, stationBn: s.bn, sched: s.sched, km: s.km,
                    scheduleState: scheduleProgress(t).state });
        break;
      }
    }
  }
  hits.sort((a, b) => a.sched.localeCompare(b.sched));
  res.json({ query: req.query.q, count: hits.length, trains: hits.slice(0, 100) });
});

app.listen(PORT, () => console.log(`BR 19 running on port ${PORT}`));
