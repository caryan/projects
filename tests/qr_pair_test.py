# /// script
# requires-python = ">=3.12"
# dependencies = ["websocket-client"]
# ///
"""Headless-Chrome tests for the QR Pair library, web/lib/qr-pair.js (see web/lib/qr-pair.md).

    uv run tests/qr_pair_test.py                  # library tests
    uv run tests/qr_pair_test.py --demo           # plus web/qr-pair.html end to end in two windows
    uv run tests/qr_pair_test.py --slow-scan 70   # plus a host that waits 70 s before "scanning"

Library tests import the module into a blank page and run two PeerLinks against each other
over loopback. The demo test opens web/qr-pair.html in two windows and pairs them by pasting
codes, using the pairing UI's data-qrp="…" elements and the page's window.qrPairDemo hooks.

Needs Google Chrome at the standard macOS path (or set CHROME=/path/to/chrome).
What this can't cover: real webcam scanning, two physical machines on real wifi, Firefox/Safari.
"""
import argparse, functools, http.server, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, threading, time
import urllib.request
import websocket

REPO = pathlib.Path(__file__).resolve().parent.parent
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# ————— Test page for the library itself (runs as a module after importing it) —————
LIB_TEST_PAGE = "/__qr-pair-test.html"
LIB_TEST_JS = r"""
import * as QR from '/web/lib/qr-pair.js';
const { PairCodec, PeerLink } = QR;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms) => { const t0 = performance.now(); while (!fn()) { if (performance.now() - t0 > ms) return false; await sleep(50); } return true; };

// Hand-build a code in the documented byte format, so hostile fields can be planted.
const ICE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const packIce = (s, o) => { o.push(s.length); let b = 0, v = 0; for (const c of s) { v = (v << 6) | ICE.indexOf(c); b += 6; while (b >= 8) { o.push((v >>> (b - 8)) & 255); b -= 8; } v &= (1 << b) - 1; } if (b > 0) o.push((v << (8 - b)) & 255); };
const crc8 = (bs) => { let c = 0; for (const x of bs) { c ^= x; for (let i = 0; i < 8; i++) c = (c & 128) ? ((c << 1) ^ 7) & 255 : (c << 1) & 255; } return c; };
const base32 = (bs) => { let b = 0, v = 0, o = ''; for (const x of bs) { v = (v << 8) | x; b += 8; while (b >= 5) { o += B32[(v >>> (b - 5)) & 31]; b -= 5; } v &= (1 << b) - 1; } if (b > 0) o += B32[(v << (5 - b)) & 31]; return o; };
const codeWithName = (version, name) => {
    const o = [version << 4]; packIce('abcd', o); packIce('abcdefghijklmnopqrstuv', o);
    for (let i = 0; i < 32; i++) o.push(171);
    const nb = new TextEncoder().encode(name); o.push(1, 3, nb.length, ...nb, 0x13, 0x88); o.push(crc8(o));
    return base32(o);
};

async function pair({ hostApp, guestApp, hostDelayMs = 0 } = {}) {
    const host = new PeerLink({ app: hostApp ?? 'test@1' });
    const guest = new PeerLink({ app: guestApp ?? 'test@1' });
    const ev = { host: [], guest: [] };
    for (const [n, l] of [['host', host], ['guest', guest]]) {
        l.onopen = (i) => ev[n].push('open');
        l.onstatechange = (s, r) => ev[n].push(`state:${s}${r ? ':' + r : ''}`);
        l.onmessage = (m, o) => ev[n].push(`msg:${JSON.stringify(m)}${o.fast ? ':fast' : ''}`);
    }
    const offer = await host.createOfferCode();
    const reply = await guest.acceptOfferCode(offer);
    await sleep(hostDelayMs);
    const t0 = performance.now();
    await host.acceptAnswerCode(reply);
    const open = await waitFor(() => (host.isOpen && guest.isOpen) || (host.state === 'closed' && guest.state === 'closed'), Math.max(30000, hostDelayMs));
    return { host, guest, ev, open: open && host.isOpen && guest.isOpen, openMs: performance.now() - t0, offer, reply };
}

(async () => {
    try {
        check('exports the documented API', ['PairCodec', 'PeerLink', 'QrScanner', 'drawQrCode', 'loadQrLibraries', 'mountPairing', 'QR_PAIR_VERSION'].every(k => k in QR));
        let noApp = 'accepted';
        try { new PeerLink(); } catch (e) { noApp = e.message; }
        check('PeerLink without an app name throws', noApp !== 'accepted', noApp);
        // The codec's version is the header nibble; find which one it accepts.
        let version = -1;
        for (let v = 1; v < 16 && version < 0; v++) { try { PairCodec.decode(codeWithName(v, 'ok.lan')); version = v; } catch {} }
        check('codec version matches QR_PAIR_VERSION', version === QR.QR_PAIR_VERSION, version);
        try {
            const [qrcodeFn, jsQRFn] = await QR.loadQrLibraries();
            const modules = await QR.drawQrCode(document.createElement('canvas'), 'TEST123');
            check('QR libraries load from CDN with integrity hashes', typeof qrcodeFn === 'function' && typeof jsQRFn === 'function' && modules > 0, `${modules}x${modules} QR`);
        } catch (e) {
            check('QR libraries load from CDN with integrity hashes', false, e.message);
        }
        for (const [label, name] of [['html', '<img src=x onerror=alert(1)>'], ['crlf', '1.2.3.4 9 typ host\r\na=x:y'], ['space', 'a b']]) {
            let msg = 'accepted';
            try { PairCodec.decode(codeWithName(version, name)); } catch (e) { msg = e.message; }
            check(`hostile address rejected (${label})`, msg !== 'accepted', msg);
        }
        let other = 'accepted';
        try { PairCodec.decode(codeWithName(version === 15 ? 14 : version + 1, 'ok.lan')); } catch (e) { other = e.message; }
        check('code from another library version rejected', other !== 'accepted', other);

        const a = await pair();
        check('pairs over loopback', a.open, `${Math.round(a.openMs)} ms after answer`);
        check('code length about 100 chars', a.offer.length < 140, `${a.offer.length} / ${a.reply.length}`);
        check('reliable channel is ordered + reliable', a.host.channel.ordered && a.host.channel.maxRetransmits === null);
        check('fast channel is unordered + no retransmits', !a.host.fastChannel.ordered && a.host.fastChannel.maxRetransmits === 0);
        check('send() reliable works', a.host.send({ t: 'hi', n: 1 }));
        check('sendFast() works', a.host.sendFast({ t: 'pos', x: 1 }));
        check('reserved "__" type refused', a.host.send({ t: '__bye' }) === false);
        check('non-object refused', a.host.send([1]) === false && a.host.send(null) === false);
        check('oversize message refused without throwing', a.host.send({ t: 'big', s: 'x'.repeat(300000) }) === false);
        for (const raw of ['null', '[1,2]', '5', '"s"', 'not json', '{"t":"__hello","id":"zz"}', '{"t":"__custom"}']) a.guest.channel.send(raw);
        a.guest.send({ t: 'after-junk' });
        await sleep(2500);
        const hostMsgs = a.ev.host.filter(e => e.startsWith('msg:'));
        check('junk frames never reach onmessage', hostMsgs.length === 1 && hostMsgs[0] === 'msg:{"t":"after-junk"}', hostMsgs.join(' '));
        check('guest got both messages, fast one flagged', a.ev.guest.includes('msg:{"t":"hi","n":1}') && a.ev.guest.includes('msg:{"t":"pos","x":1}:fast'), a.ev.guest.join(' '));
        check('clock synced', a.guest.clockReady && a.host.clockReady, `rtt ${a.guest.rtt?.toFixed(2)} ms`);
        const skew = Math.abs(a.host.sharedNow() - a.guest.sharedNow());
        check('sharedNow agrees within 5 ms', skew < 5, `${skew.toFixed(3)} ms`);
        const t0 = performance.now();
        a.guest.close();
        await waitFor(() => a.host.state === 'closed', 20000);
        const byeMs = performance.now() - t0;
        check('other side hears close quickly as "left"', a.ev.host.includes('state:closed:left') && byeMs < 2000, `${Math.round(byeMs)} ms`);
        check('closer reports "local"', a.ev.guest.includes('state:closed:local'));
        check('send after close returns false', a.host.send({ t: 'x' }) === false);

        const m = await pair({ hostApp: 'game-a@1', guestApp: 'game-b@1' });
        check('different app names refuse each other', !m.open && m.ev.host.includes('state:closed:mismatch') && m.ev.guest.includes('state:closed:mismatch'), m.ev.host.concat(m.ev.guest).join(' '));

        const delay = Number(new URLSearchParams(location.search).get('slow') || 0);
        if (delay) {
            const c = await pair({ hostDelayMs: delay });
            check(`connects after a ${delay / 1000} s wait before the host scans`, c.open, `${Math.round(c.openMs)} ms after answer`);
            c.host.close(); c.guest.close();
        }
    } catch (e) {
        check('test run crashed', false, e.stack || e.message);
    }
    window.__results = results;
})();
"""


class Tab:
    """One page in Chrome, driven over the DevTools protocol."""

    def __init__(self, ws_url, name):
        self.ws, self.n, self.name, self.errors = websocket.create_connection(ws_url, timeout=30), 0, name, []
        self.call("Runtime.enable")
        self.call("Log.enable")

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            meth, p = m.get("method"), m.get("params", {})
            if meth == "Runtime.consoleAPICalled" and p["type"] == "error":
                self.errors.append(" ".join(str(a.get("value", a.get("description", ""))) for a in p["args"]))
            elif meth == "Runtime.exceptionThrown":
                d = p["exceptionDetails"]
                self.errors.append("uncaught: " + d.get("exception", {}).get("description", d.get("text", "")))
            elif meth == "Log.entryAdded" and p["entry"]["level"] == "error" and "favicon" not in p["entry"].get("url", ""):
                self.errors.append(p["entry"]["text"])
            if m.get("id") == self.n:
                return m.get("result", {})

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(f"{self.name}: {r['exceptionDetails'].get('exception', {}).get('description', r['exceptionDetails'])}")
        return r["result"].get("value")

    def wait(self, expr, timeout=30):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if v := self.js(expr):
                return v
            time.sleep(0.25)
        raise TimeoutError(f"{self.name}: timed out waiting for {expr}")

    def mouse(self, kind, x, y, pressed):
        self.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", buttons=1 if pressed else 0, clickCount=1)


class Browser:
    def __init__(self):
        self.port = free_port()
        self.profile = tempfile.mkdtemp()
        self.proc = subprocess.Popen(
            [CHROME, "--headless=new", "--disable-gpu", f"--remote-debugging-port={self.port}",
             f"--remote-allow-origins=http://127.0.0.1:{self.port}", f"--user-data-dir={self.profile}",
             "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                self.ws_url = self.get("/json/version")["webSocketDebuggerUrl"]
                break
            except OSError:
                time.sleep(0.1)

    def get(self, path):
        return json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}"))

    def window(self, name, url):
        # A separate window per peer, so neither is a background tab: background tabs get no
        # requestAnimationFrame and no input, unlike two real laptops.
        b = websocket.create_connection(self.ws_url, timeout=10)
        b.send(json.dumps({"id": 1, "method": "Target.createTarget", "params": {"url": "about:blank", "newWindow": True}}))
        while (m := json.loads(b.recv())).get("id") != 1:
            pass
        b.close()
        target = next(t for t in self.get("/json") if t["id"] == m["result"]["targetId"])
        tab = Tab(target["webSocketDebuggerUrl"], name)
        tab.call("Emulation.setFocusEmulationEnabled", enabled=True)
        tab.call("Emulation.setDeviceMetricsOverride", width=1100, height=1400, deviceScaleFactor=1, mobile=False)
        tab.call("Page.navigate", url=url)
        return tab

    def close(self):
        self.proc.terminate()
        self.proc.wait()
        shutil.rmtree(self.profile, ignore_errors=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(directory):
    # Pages need a secure context (localhost counts) for the camera and crypto APIs.
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", free_port()), functools.partial(Quiet, directory=directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


class Quiet(http.server.SimpleHTTPRequestHandler):
    """Serves the repo, plus the in-memory library test page."""

    def do_GET(self):
        if self.path.split("?")[0] == LIB_TEST_PAGE:
            body = (f"<!doctype html><meta charset='utf-8'><title>qr-pair test</title>"
                    f"<script type='module'>{LIB_TEST_JS}</script>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def log_message(self, *args):
        pass


def run_lib_tests(browser, slow_s):
    httpd, base = serve(str(REPO))
    try:
        tab = browser.window("library", f"{base}{LIB_TEST_PAGE}?slow={int(slow_s * 1000)}")
        tab.wait("window.__results", timeout=90 + slow_s)
        results = tab.js("window.__results")
        report("library tests: web/lib/qr-pair.js", [(r["name"], r["ok"], r["detail"]) for r in results], tab.errors)
        return all(r["ok"] for r in results)
    finally:
        httpd.shutdown()


def run_demo_test(browser):
    """Drive web/qr-pair.html in two windows: pair, draw, disconnect, pair again, close a tab."""
    httpd, base = serve(str(REPO))
    results = []
    check = lambda name, ok, detail="": results.append((name, bool(ok), str(detail)))
    url = f"{base}/web/qr-pair.html"
    A, B = browser.window("host", url), browser.window("guest", url)
    q = lambda name: f"document.querySelector('[data-qrp=\"{name}\"]')"
    paste = f"(c => {{ {q('paste')}.value = c; {q('paste-form')}.requestSubmit(); }})"
    shown = f"(t => t !== '—' && t)({q('code')}.textContent)"
    text = lambda tab, el: tab.js(f"document.getElementById('{el}').textContent")
    hidden = lambda tab, el: tab.js(f"document.getElementById('{el}').hidden")

    def pair(first):
        if first:
            A.js(f"{q('host')}.click()")
            B.js(f"{q('join')}.click()")
        else:
            A.js("document.getElementById('leave-btn').click()")   # "Pair again"
            B.js("document.getElementById('leave-btn').click()")
        B.js(f"{paste}({json.dumps(A.wait(shown).replace(' ', ''))})")
        A.js(f"{paste}({json.dumps(B.wait(shown).replace(' ', ''))})")
        for t in (A, B):
            t.wait("!document.getElementById('play').hidden && qrPairDemo.link?.isOpen", 30)

    def stroke(tab, points, release=True):
        x0, y0, w, h = tab.js("(r => [r.left, r.top, r.width, r.height])(document.getElementById('pad').getBoundingClientRect())")
        (fx, fy), rest = points[0], points[1:]
        tab.mouse("mouseMoved", x0 + w * fx, y0 + h * fy, False)
        tab.mouse("mousePressed", x0 + w * fx, y0 + h * fy, True)
        for fx, fy in rest:
            tab.mouse("mouseMoved", x0 + w * fx, y0 + h * fy, True)
            time.sleep(0.02)
        if release:
            tab.mouse("mouseReleased", x0 + w * fx, y0 + h * fy, False)

    try:
        for t in (A, B):
            t.wait("document.readyState === 'complete'", 20)
        pair(first=True)
        check("pairs by pasted codes", True)
        check("pairing UI hides itself once connected", A.js("document.getElementById('pairing-root').hidden") and B.js("document.getElementById('pairing-root').hidden"))
        check("library loaded both QR libraries (integrity checked)", all(t.js("typeof jsQR === 'function' && typeof qrcode === 'function'") for t in (A, B)))
        check("first pairing is not flagged as a reconnect", hidden(A, "rejoin-note") and hidden(B, "rejoin-note"))

        stroke(A, [(0.2 + i * 0.02, 0.2 + i * 0.01) for i in range(30)])
        stroke(B, [(0.5 - i * 0.03, 0.8) for i in range(10)])
        time.sleep(0.5)
        a_pts, b_pts = A.js("qrPairDemo.strokes.reduce((n, s) => n + s.pts.length, 0)"), B.js("qrPairDemo.strokes.reduce((n, s) => n + s.pts.length, 0)")
        check("strokes reach the other side (both directions)", A.js("qrPairDemo.strokes.some(s => s.who === 'guest')") and B.js("qrPairDemo.strokes.some(s => s.who === 'host')"), f"host {a_pts} pts, guest {b_pts} pts")
        A.mouse("mouseMoved", *A.js("(r => [r.left + r.width * 0.61, r.top + r.height * 0.3])(document.getElementById('pad').getBoundingClientRect())"), False)
        time.sleep(1.5)
        check("pointer snapshots arrive on the fast channel", not hidden(B, "peer-cursor") and B.js("document.getElementById('peer-cursor').style.left") == "61%",
              B.js("document.getElementById('peer-cursor').style.left"))
        check("round trip shown", text(A, "ping-label").endswith("ms") and text(B, "ping-label").endswith("ms"), f"{text(A, 'ping-label')} / {text(B, 'ping-label')}")
        skew = abs(A.js("qrPairDemo.link.sharedNow()") - B.js("qrPairDemo.link.sharedNow()"))
        check("shared clocks agree (incl. DevTools call gap)", skew < 50, f"{skew:.1f} ms")

        A.js("document.getElementById('leave-btn').click()")
        B.wait("document.getElementById('conn-text').textContent === 'They disconnected'", 5)
        check("Disconnect is announced on the other side", True, text(B, "conn-text"))
        check("button becomes Pair again", text(A, "leave-btn") == "Pair again" and text(B, "leave-btn") == "Pair again")

        host_pts = A.js("qrPairDemo.totalPoints")
        B.js("qrPairDemo.clearPad()")   # wipe the guest's copy so the host's sync has to restore it
        pair(first=False)
        time.sleep(0.8)
        check("Pair again reconnects without a reload and restores the host's drawing", B.js("qrPairDemo.totalPoints") == host_pts, f"{B.js('qrPairDemo.totalPoints')} of {host_pts} points")
        check("reconnect to the same laptop is detected", not hidden(A, "rejoin-note") and not hidden(B, "rejoin-note"))

        B.call("Page.navigate", url="about:blank")
        A.wait("document.getElementById('conn-text').textContent === 'They disconnected'", 5)
        check("closing the other tab is noticed at once (pagehide goodbye)", True)
    except Exception as e:
        check("demo run crashed", False, e)
    finally:
        httpd.shutdown()
    report("demo end to end: web/qr-pair.html", results, A.errors + B.errors)
    return all(ok for _, ok, _ in results)


def report(title, results, errors):
    print(f"\n{title}")
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if errors:
        print("  console errors:\n    " + "\n    ".join(errors))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="also run the web/qr-pair.html end-to-end test")
    ap.add_argument("--slow-scan", type=float, default=0, metavar="SECONDS", help="also test a slow host scan")
    args = ap.parse_args()
    if not pathlib.Path(CHROME).exists():
        sys.exit(f"Chrome not found at {CHROME}. Set CHROME=/path/to/chrome.")
    browser = Browser()
    try:
        ok = run_lib_tests(browser, args.slow_scan)
        if args.demo:
            ok = run_demo_test(browser) and ok
    finally:
        browser.close()
    print("\nALL PASSED" if ok else "\nSOME TESTS FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
