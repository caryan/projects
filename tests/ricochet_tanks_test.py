# /// script
# requires-python = ">=3.12"
# dependencies = ["websocket-client"]
# ///
"""Headless-Chrome tests for web/ricochet-tanks.html.

    uv run tests/ricochet_tanks_test.py

Reuses the Chrome driver from tests/qr_pair_test.py. Covers the maze and physics in one window,
one-keyboard play, and two-laptop play in two windows paired by pasted codes: maze sync, guest
driving and firing, a hit and the score reaching both sides, disconnect, and Pair again
resuming the match. Reads game state through the page's window.ricochetTanks hooks.
"""
import json, pathlib, sys, time

sys.dont_write_bytecode = True   # importing the qr-pair harness shouldn't leave __pycache__ in tests/
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from qr_pair_test import CHROME, REPO, Browser, report, serve  # noqa: E402

KEYS = {  # code: (key, windowsVirtualKeyCode)
    "KeyW": ("w", 87), "KeyQ": ("q", 81), "KeyM": ("m", 77), "Space": (" ", 32),
    "ArrowUp": ("ArrowUp", 38), "ArrowLeft": ("ArrowLeft", 37),
}


def key(tab, code, kind):
    k, vk = KEYS[code]
    tab.call("Input.dispatchKeyEvent", type=kind, code=code, key=k, windowsVirtualKeyCode=vk)


def hold(tab, code, seconds):
    key(tab, code, "keyDown")
    time.sleep(seconds)
    key(tab, code, "keyUp")


def tap(tab, code):
    hold(tab, code, 0.05)


# Runs in the page: checks every maze is fully connected and closed at the border, and that
# shells fired in every direction never leave the maze.
PHYSICS_JS = r"""
(() => {
    const T = window.ricochetTanks;
    let connected = true, closed = true, escaped = 0;
    for (let n = 0; n < 200; n++) {
        const cols = 3 + (n % 8), rows = 3 + (n % 5);
        const m = T.makeMaze(cols, rows);
        if (m.h[0].some(x => !x) || m.h[rows].some(x => !x) || m.v.some(r => !r[0] || !r[cols])) closed = false;
        const seen = new Set(['0,0']), queue = [[0, 0]];
        while (queue.length) {
            const [c, r] = queue.pop();
            const go = (nc, nr, open) => { if (open && !seen.has(nc + ',' + nr)) { seen.add(nc + ',' + nr); queue.push([nc, nr]); } };
            go(c + 1, r, c + 1 < cols && !m.v[r][c + 1]); go(c - 1, r, c > 0 && !m.v[r][c]);
            go(c, r + 1, r + 1 < rows && !m.h[r + 1][c]); go(c, r - 1, r > 0 && !m.h[r][c]);
        }
        if (seen.size !== cols * rows) connected = false;
    }
    return { connected, closed };
})()
"""


def run_local_test(browser, base):
    results = []
    check = lambda name, ok, detail="": results.append((name, bool(ok), str(detail)))
    tab = browser.window("local", f"{base}/web/ricochet-tanks.html")
    g = "ricochetTanks.game"
    try:
        tab.wait("document.readyState === 'complete' && window.ricochetTanks", 20)
        p = tab.js(PHYSICS_JS)
        check("200 random mazes are all connected", p["connected"])
        check("maze borders are always closed", p["closed"])

        tab.js("document.getElementById('mode-local').click()")
        tab.wait(f"{g}.maze && {g}.phase === 1", 5)
        check("one-keyboard mode starts round 1", tab.js(f"{g}.round") == 1)
        before = tab.js(f"{g}.tanks.map(t => [t.x, t.y, t.a])")
        hold(tab, "KeyW", 0.4)
        hold(tab, "ArrowLeft", 0.3)
        after = tab.js(f"{g}.tanks.map(t => [t.x, t.y, t.a])")
        moved = abs(after[0][0] - before[0][0]) + abs(after[0][1] - before[0][1])
        check("W drives copper forward", moved > 5, f"{moved:.1f} units")
        check("left arrow turns blue", abs(after[1][2] - before[1][2]) > 0.3, f"{after[1][2] - before[1][2]:.2f} rad")
        tap(tab, "KeyQ")
        tap(tab, "KeyM")
        time.sleep(0.1)
        owners = tab.js(f"{g}.bullets.map(b => b.owner)")
        check("Q and M fire one shell each", sorted(owners) == [0, 1], owners)

        # Shells bounce around a long time without ever leaving the maze.
        tab.js(f"""(() => {{ const G = {g}; G.tanks.forEach(t => {{ t.x = -999; t.y = -999; }}); G.bullets = [];
            for (let i = 0; i < 10; i++) {{ const a = i * 0.63 + 0.1;
            G.bullets.push({{ id: 1000 + i, owner: 0, x: 30, y: 30, vx: Math.cos(a) * 165, vy: Math.sin(a) * 165, age: -60, armed: true }}); }} }})()""")
        time.sleep(3)
        out = tab.js(f"{g}.bullets.filter(b => b.x < 0 || b.y < 0 || b.x > {g}.maze.cols * 60 || b.y > {g}.maze.rows * 60).length")
        n = tab.js(f"{g}.bullets.length")
        check("bouncing shells stay inside the maze", n == 10 and out == 0, f"{n} shells, {out} outside")
        tab.js(f"{g}.bullets = []")

        # A shell aimed at blue scores copper a point once the round ends.
        tab.js("document.getElementById('new-match-btn').click()")
        tab.wait(f"{g}.phase === 1", 5)
        tab.js(f"(() => {{ const G = {g}, t = G.tanks[1]; G.bullets.push({{ id: 9999, owner: 0, x: t.x - 6, y: t.y, vx: 165, vy: 0, age: 0, armed: true }}); }})()")
        tab.wait(f"{g}.round === 2", 6)
        check("a hit on blue scores copper a point", tab.js(f"{g}.scores") == [1, 0], tab.js(f"{g}.scores"))
        check("score shows in the bar", tab.js("document.getElementById('score-0').textContent") == "1")
    except Exception as e:
        check("local run crashed", False, e)
    report("one keyboard: web/ricochet-tanks.html", results, tab.errors)
    tab.call("Page.navigate", url="about:blank")
    return all(ok for _, ok, _ in results)


def run_network_test(browser, base):
    results = []
    check = lambda name, ok, detail="": results.append((name, bool(ok), str(detail)))
    url = f"{base}/web/ricochet-tanks.html"
    A, B = browser.window("host", url), browser.window("guest", url)
    q = lambda name: f"document.querySelector('[data-qrp=\"{name}\"]')"
    paste = f"(c => {{ {q('paste')}.value = c; {q('paste-form')}.requestSubmit(); }})"
    shown = f"(t => t !== '—' && t)({q('code')}.textContent)"
    g = "ricochetTanks.game"

    def pair(first):
        if first:
            for t in (A, B):
                t.js("document.getElementById('mode-net').click()")
            A.wait(f"!!{q('host')}", 5)
            A.js(f"{q('host')}.click()")
            B.js(f"{q('join')}.click()")
        else:
            A.js("document.getElementById('leave-btn').click()")   # "Pair again"
            B.js("document.getElementById('leave-btn').click()")
        B.js(f"{paste}({json.dumps(A.wait(shown).replace(' ', ''))})")
        A.js(f"{paste}({json.dumps(B.wait(shown).replace(' ', ''))})")
        for t in (A, B):
            t.wait("!document.getElementById('game').hidden && ricochetTanks.link?.isOpen", 30)

    try:
        for t in (A, B):
            t.wait("document.readyState === 'complete' && window.ricochetTanks", 20)
        pair(first=True)
        check("pairs by pasted codes", A.js("ricochetTanks.mode") == "host" and B.js("ricochetTanks.mode") == "guest")
        B.wait(f"{g}.maze", 5)
        same = A.js(f"JSON.stringify({g}.maze)") == B.js(f"JSON.stringify({g}.maze)")
        check("guest gets the host's maze", same and B.js(f"{g}.round") == A.js(f"{g}.round"))
        A.wait(f"{g}.phase === 1", 5)
        B.wait("ricochetTanks.view && ricochetTanks.view.tanks.length === 2", 5)

        before = A.js(f"[{g}.tanks[1].x, {g}.tanks[1].y, {g}.tanks[1].a]")
        hold(B, "ArrowUp", 0.4)
        hold(B, "ArrowLeft", 0.3)
        time.sleep(0.1)
        after = A.js(f"[{g}.tanks[1].x, {g}.tanks[1].y, {g}.tanks[1].a]")
        moved = abs(after[0] - before[0]) + abs(after[1] - before[1])
        check("guest's keys drive the blue tank on the host", moved > 5 and abs(after[2] - before[2]) > 0.3, f"{moved:.1f} units, {after[2] - before[2]:.2f} rad")
        host_tank = A.js(f"[{g}.tanks[1].x, {g}.tanks[1].y]")
        guest_tank = B.js("[ricochetTanks.view.tanks[1].x, ricochetTanks.view.tanks[1].y]")
        gap = abs(host_tank[0] - guest_tank[0]) + abs(host_tank[1] - guest_tank[1])
        check("guest draws where the host says", gap < 2, f"{gap:.2f} units apart")
        tap(B, "Space")
        time.sleep(0.2)
        check("guest's Space fires a shell on the host", 1 in A.js(f"{g}.bullets.map(b => b.owner)"))
        time.sleep(0.1)
        check("guest sees the shell", B.js("ricochetTanks.view.bullets.length") >= 1)
        hold(A, "KeyW", 0.3)
        tap(A, "Space")
        time.sleep(0.2)
        check("host's own keys drive and fire copper", 0 in A.js(f"{g}.bullets.map(b => b.owner)"))

        A.js(f"{g}.bullets = []")
        A.js(f"(() => {{ const G = {g}, t = G.tanks[0]; G.bullets.push({{ id: 99999, owner: 1, x: t.x - 6, y: t.y, vx: 165, vy: 0, age: 0, armed: true }}); }})()")
        B.wait(f"{g}.round === 2", 6)
        check("a hit on copper scores blue a point on both laptops", A.js(f"{g}.scores") == [0, 1] and B.js(f"{g}.scores") == [0, 1], B.js(f"{g}.scores"))
        check("guest's scoreboard updates", B.js("document.getElementById('score-1').textContent") == "1")
        check("next round's maze reaches the guest", A.js(f"JSON.stringify({g}.maze)") == B.js(f"JSON.stringify({g}.maze)"))

        # The guest's tab going silent pauses the host.
        A.js("document.getElementById('leave-btn').click()")
        B.wait("document.getElementById('conn-text').textContent === 'They disconnected'", 5)
        check("Disconnect is announced on the other side", True)
        check("button becomes Pair again", A.js("document.getElementById('leave-btn').textContent") == "Pair again")
        B.js(f"{g}.scores = [0, 0]; {g}.maze = null")   # the host's resync has to restore these
        pair(first=False)
        B.wait(f"{g}.maze", 5)
        check("Pair again resumes the match (scores kept, maze resent)", B.js(f"{g}.scores") == [0, 1] and A.js(f"{g}.round") == 2
              and A.js(f"JSON.stringify({g}.maze)") == B.js(f"JSON.stringify({g}.maze)"), B.js(f"{g}.scores"))

        B.call("Page.navigate", url="about:blank")
        A.wait("document.getElementById('conn-text').textContent === 'They disconnected'", 5)
        check("closing the guest's tab is noticed at once", True)
    except Exception as e:
        check("network run crashed", False, e)
    report("two laptops: web/ricochet-tanks.html", results, A.errors + B.errors)
    return all(ok for _, ok, _ in results)


def main():
    if not pathlib.Path(CHROME).exists():
        sys.exit(f"Chrome not found at {CHROME}. Set CHROME=/path/to/chrome.")
    browser = Browser()
    httpd, base = serve(str(REPO))
    try:
        ok = run_local_test(browser, base)
        ok = run_network_test(browser, base) and ok
    finally:
        httpd.shutdown()
        browser.close()
    print("\nALL PASSED" if ok else "\nSOME TESTS FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
