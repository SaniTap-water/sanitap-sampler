#!/usr/bin/env python3
"""Screenshots of the usage-survey mode for the README: the laptop draw view (1440 wide) and the phone field
view (390x844). Uses the fake sample frame (data/sample-water-points.csv) and SYNTHETIC building footprints
and barriers injected through window.SAMPLER_TEST, so no real household or water point position is shown.

    python3 test/screens.py [--out docs/screens]
Needs Playwright with Chromium (preinstalled; never `playwright install`)."""
import argparse, functools, http.server, os, threading
from playwright.sync_api import sync_playwright

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNTH = r"""
window.SAMPLER_TEST = {
  // a regular village of small squares around the point, with a little deterministic jitter
  buildings: async (lat, lon) => {
    const out = []; const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574; let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let x = -700; x <= 700; x += 45) for (let y = -700; y <= 700; y += 45) {
      if (x * x + y * y > 700 * 700 || rnd() < 0.55) continue;
      const cx = x + (rnd() - .5) * 20, cy = y + (rnd() - .5) * 20, d = 4 + rnd() * 4;
      const ring = [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]].map(([a, b]) => [lon + a / kx, lat + b / ky]);
      out.push({ geometry: { type: 'Polygon', coordinates: [ring] }, properties: { bf_source: 'google' } });
    }
    return out;
  },
  // one river crossing the east of the circle
  overpass: async (lat, lon) => { const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574;
    return { elements: [{ type: 'way', tags: { waterway: 'river' }, geometry: [[450, -1200], [380, 0], [470, 1200]].map(([x, y]) => ({ lat: lat + y / ky, lon: lon + x / kx })) }] }; }
};
"""


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/index.html"


def prepare(pg, url):
    pg.goto(url); pg.wait_for_timeout(800)
    pg.click('#btn-sample'); pg.wait_for_timeout(600)
    pg.click('nav button[data-tab="params"]')
    pg.select_option('#p-mode', 'usage'); pg.fill('#p-round', '2026-DRY'); pg.fill('#p-drawn-by', 'Demo (fake frame)')
    pg.evaluate("() => { const s = document.getElementById('p-stratum'); s.value = 'FD'; s.dispatchEvent(new Event('input')); }")
    pg.click('#btn-draw'); pg.wait_for_selector('#usage-results:not(.hidden)')
    pg.click('#btn-prepare'); pg.wait_for_function("document.querySelector('#u-msg .msg.ok')", timeout=60000)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default=os.path.join(REPO, "docs", "screens")); a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    srv, url = serve()
    with sync_playwright() as p:
        b = p.chromium.launch()
        lap = b.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
        lap.add_init_script(SYNTH); pg = lap.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        prepare(pg, url)
        pg.screenshot(path=os.path.join(a.out, "usage-laptop-draw-1440.png"), full_page=True)
        pg.click('nav button[data-tab="map"]'); pg.wait_for_timeout(2500)
        pg.screenshot(path=os.path.join(a.out, "usage-laptop-map-1440.png"), full_page=True)
        # the phone: GPS about 150 m south-west of the first drawn point of the fake frame
        lat_lon = pg.evaluate("""async () => { const r = await new Promise(res => { const q = indexedDB.open('sanitap-sampler', 1); q.onsuccess = () => { const tx = q.result.transaction('rounds').objectStore('rounds').getAll(); tx.onsuccess = () => res(tx.result[0]); }; }); return [r.points[0].lat, r.points[0].lon]; }""")
        phone = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, service_workers="block",
                              geolocation={"latitude": lat_lon[0] - 0.0012, "longitude": lat_lon[1] - 0.0012}, permissions=["geolocation"])
        phone.add_init_script(SYNTH); ph = phone.new_page(); ph.on("pageerror", lambda e: errs.append(str(e)))
        prepare(ph, url)
        ph.click('nav button[data-tab="field"]'); ph.wait_for_timeout(2500)
        ph.click('#f-buttons button[data-o="refused"]'); ph.wait_for_timeout(600)
        ph.click('#f-buttons button[data-o="interviewed"]'); ph.wait_for_timeout(1500)
        ph.evaluate("window.scrollTo(0, 0)"); ph.wait_for_timeout(300)
        ph.screenshot(path=os.path.join(a.out, "usage-phone-field-390x844.png"))
        ph.screenshot(path=os.path.join(a.out, "usage-phone-field-390x844-full.png"), full_page=True)
        b.close()
    srv.shutdown()
    print("screenshots in", a.out, "| page errors:", errs or "none")


if __name__ == "__main__":
    main()
