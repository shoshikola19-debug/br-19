#!/usr/bin/env python3
"""Scrape TrainKothai's PUBLIC server-rendered pages for BR 19.

What this does (tested 2026-11-10 from this VM):
  - GET https://trainkothai.com/trains -> train directory (name + number)
    from the JSON-LD ItemList embedded in the HTML.
  - GET https://trainkothai.com/track/<number> -> per-train timetable
    (stops with code, English + Bengali name, scheduled time, km),
    route, duration, classes, operating days, last-7-runs delay history.

What it does NOT do:
  - Live position / speed / current delay are NOT in the static HTML.
    They load client-side from /api/v1/live/track/<n>, which needs a
    session cookie from POST /api/v1/session with a valid Cloudflare
    Turnstile token (human check). A server cannot solve that, so the
    live API returns 401 {"error":"pass_required"} from a server.
    The BR 19 app therefore shows schedule + history honestly and links
    out to trainkothai.com/track/<n> for the live view.

Politeness: 1 request per ~1.2s, browser-like User-Agent, short timeouts.
Output: data/trains.json  {"generatedAt": ..., "source": ..., "trains": [...]}
"""
import json, re, sys, time, urllib.request, urllib.error

BASE = "https://trainkothai.com"
UA = {"User-Agent": "BR19-Train-App/1.0 (+https://trainkothai.com; polite scraper, 1 req/1.2s)"}
DELAY = 1.2

def fetch(url):
    # urllib hits IncompleteRead on trainkothai's chunked responses;
    # curl handles them fine.
    import subprocess
    out = subprocess.run(["curl", "-s", "--max-time", "30", "-A", UA["User-Agent"], url],
                         capture_output=True, timeout=40)
    if out.returncode != 0:
        raise RuntimeError(f"curl failed rc={out.returncode} for {url}")
    return out.stdout.decode("utf-8", "replace")

def strip_tags(html):
    s = re.sub(r"<script.*?</script>", "", html, flags=re.S)
    s = re.sub(r"<style.*?</style>", "", s, flags=re.S)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s

def parse_directory(html):
    """JSON-LD ItemList: {"url": ".../track/751", "name": "Lalmoni Express (751)"}"""
    m = re.search(r'"@type":"ItemList","itemListElement":\[(.*?)\]\}</script>', html, re.S)
    trains = []
    if m:
        for it in re.finditer(r'"url":"https://trainkothai\.com/track/(\d+)","name":"([^"]+?)\s*\((\d+)\)"', m.group(1)):
            trains.append({"number": int(it.group(1)), "name": it.group(2).strip()})
    # de-dup, keep order
    seen, out = set(), []
    for t in trains:
        if t["number"] not in seen:
            seen.add(t["number"]); out.append(t)
    return out

def _rsc_text(html):
    """Join all Next.js RSC push payloads in document order, JS-unescaping
    each. Long strings (e.g. timetables) are split across several pushes,
    so only the joined text has them contiguous."""
    out = []
    needle = 'self.__next_f.push([1,"'
    i = 0
    while True:
        j = html.find(needle, i)
        if j < 0:
            break
        k = j + len(needle)
        buf = []
        while k < len(html):
            c = html[k]
            if c == "\\":
                buf.append(html[k:k + 2]); k += 2; continue
            if c == '"':
                break
            buf.append(c); k += 1
        raw = "".join(buf)
        try:
            out.append(json.loads('"' + raw + '"'))
        except Exception:
            out.append(raw.encode().decode("unicode_escape", errors="ignore"))
        i = k + 1
    return "".join(out)

def parse_timetable(html):
    """Timetable JSON array, taken from the joined RSC payload where it is
    contiguous (it is split across pushes in the raw HTML)."""
    text = _rsc_text(html)
    stop_re = (r'\{"code":"([^"]*)","name":"([^"]*)","bn":"([^"]*)",'
               r'"sched":"([^"]*)","act":"([^"]*)","platform":"([^"]*)",'
               r'"km":(\d+),"status":"([^"]*)"\}')
    m = re.search(r'\[' + stop_re + r'(?:,' + stop_re + r')*\]', text)
    if m:
        try:
            arr = json.loads(m.group(0))
            if isinstance(arr, list) and arr and isinstance(arr[0], dict) and "name" in arr[0]:
                return arr
        except Exception:
            pass
    stops = []
    for sm in re.finditer(stop_re, text):
        stops.append({"code": sm.group(1), "name": sm.group(2), "bn": sm.group(3),
                      "sched": sm.group(4), "act": sm.group(5), "platform": sm.group(6),
                      "km": int(sm.group(7)), "status": sm.group(8)})
    return stops or None

def parse_track_page(html, number, name):
    text = strip_tags(html)
    text = text.replace("&amp;", "&").replace("&#x27;", "'")
    stops = parse_timetable(html)
    # duration e.g. "5h 10m · Ibrahimabad → Mymensingh Jn"
    dur = None
    dm = re.search(r"(\d+h\s*\d+m)\s*·", text)
    if dm: dur = dm.group(1).replace(" ", "")
    # delay history: "Delay (min) — Last 7 Tracked Runs 7D 14D avg ~3h 7m +13 3 Nov ..."
    hist = {"avgMin": None, "runs": []}
    hm = re.search(r"Delay \(min\) — Last 7 Tracked Runs.*?avg ~([\dh\s]+m)", text)
    if hm:
        parts = hm.group(1).strip().split()
        mins = 0
        for p in parts:
            if p.endswith("h"): mins += int(p[:-1]) * 60
            elif p.endswith("m"): mins += int(p[:-1])
        hist["avgMin"] = mins
    for rm in re.finditer(r"\+(\d+)\s+(\d+)\s+Nov", text):
        hist["runs"].append({"day": int(rm.group(2)), "delayMin": int(rm.group(1))})
    # classes
    classes = None
    cm = re.search(r"Classes & Service ([A-Za-z ,\\-]+?) Operating Days", text)
    if cm: classes = cm.group(1).strip()
    days = None
    dm2 = re.search(r"Operating Days ([MTWTFSS ]+?) Advertisement", text)
    if dm2: days = dm2.group(1).strip()
    # from/to from title
    frm = to = None
    tm = re.search(r"—\s*(.+?)\s+to\s+(.+?)\s*\| TrainKothai", text)
    if tm: frm, to = tm.group(1).strip(), tm.group(2).strip()
    if stops:
        frm = stops[0]["name"]; to = stops[-1]["name"]
    return {"number": number, "name": name, "from": frm, "to": to,
            "duration": dur, "classes": classes, "operatingDays": days,
            "delayHistory": hist, "stops": stops or [],
            "trackUrl": f"{BASE}/track/{number}"}

def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "data/trains.json"
    only = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 and sys.argv[2] else None
    print("fetching directory ...", flush=True)
    directory = parse_directory(fetch(BASE + "/trains"))
    print(f"directory: {len(directory)} trains", flush=True)
    if only:
        directory = [t for t in directory if t["number"] in only]
        print(f"limited to: {[t['number'] for t in directory]}", flush=True)
    trains = []
    for i, t in enumerate(directory):
        try:
            html = fetch(f"{BASE}/track/{t['number']}")
            rec = parse_track_page(html, t["number"], t["name"])
            trains.append(rec)
            print(f"[{i+1}/{len(directory)}] {t['number']} {t['name']}: "
                  f"{len(rec['stops'])} stops, {rec['from']} -> {rec['to']}, "
                  f"avg delay {rec['delayHistory']['avgMin']}m", flush=True)
        except urllib.error.HTTPError as e:
            print(f"[{i+1}] {t['number']} HTTP {e.code}", flush=True)
        except Exception as e:
            print(f"[{i+1}] {t['number']} error: {e}", flush=True)
        time.sleep(DELAY)
    data = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S+06:00", time.localtime()),
            "source": "trainkothai.com (public pages; schedules use public BR data, live positions are community-sourced)",
            "sourceNote": "Live position is NOT in these pages; it needs a Cloudflare Turnstile session on trainkothai.com. See README.",
            "trainCount": len(trains), "trains": trains}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"wrote {out_path}: {len(trains)} trains", flush=True)

if __name__ == "__main__":
    main()
