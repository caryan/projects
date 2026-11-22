# QR Pair library — notes for building two-player games

`web/lib/qr-pair.js` links two browsers on the same wifi over a direct WebRTC connection, with
no server. Each laptop shows a QR code to the other's webcam (or the codes are pasted). Use it
for every two-player / networked game in this repo rather than writing new WebRTC code.

- **Source:** [`qr-pair.js`](qr-pair.js), an ES module with no build step. It loads its two QR
  libraries from CDNs itself, pinned by integrity hashes.
- **Demo and reference app:** [`../qr-pair.html`](../qr-pair.html), a shared sketchpad. Copy its
  patterns.
- **Tests:** `uv run tests/qr_pair_test.py --demo` (headless Chrome; see [Testing](#testing)).
- **Version:** `QR_PAIR_VERSION` = 2. This is also the version stamped into every pairing code.

## Using it in a game

A game is still a single HTML file in `web/`. It imports the library and mounts the ready-made
pairing UI:

```html
<div id="pairing"></div>
<section id="game" hidden>…</section>

<script type="module">
import { mountPairing } from './lib/qr-pair.js';

let link = null;
const pairing = mountPairing(document.getElementById('pairing'), {
    app: 'snake@1',                         // required; both laptops must match
    onConnected: (newLink, { reconnected }) => {
        link = newLink;
        // Set every handler here, before returning, so no message is missed.
        link.onmessage = (msg, { fast }) => { /* validate, then apply */ };
        link.onstatechange = (state, reason) => { /* 'unstable' / 'closed' UI */ };
        document.getElementById('game').hidden = false;
        if (pairing.role === 'host') link.send({ t: 'state', /* full game state */ });
    },
});

// Offer a "Pair again" button once the link is closed:
//   document.getElementById('game').hidden = true; pairing.start();
</script>
```

- **Serve over http(s).** ES modules don't load from `file://`. For local work, run
  `python3 -m http.server` in the repo root and open `http://localhost:8000/web/<game>.html`.
  The camera also needs a secure context: `localhost` and the deployed https site are fine, but
  `http://192.168.x.x` is not. To try two real laptops before deploying, use the paste fallback,
  or push and use projects.colmryan.org.
- **Choose an app name.** Every game has its own, e.g. `'snake@1'`. Bump `@n` whenever the
  game's message format changes. Laptops with different names refuse each other with a clear
  message.
- **Theme the UI with CSS variables** set on the container: `--qrp-ink`, `--qrp-ink-soft`,
  `--qrp-surface`, `--qrp-field`, `--qrp-line`, `--qrp-accent`, `--qrp-ok`, `--qrp-bad`,
  `--qrp-mono` and `--qrp-shadow`. `qr-pair.html` maps the site's tokens onto them. Elements
  carry `data-qrp="…"` names for extra styling or tests.

## API

### `mountPairing(container, options)`: the usual entry point

| option | |
|---|---|
| `app` | **required**. App name and version, e.g. `'snake@1'` |
| `onConnected(link, { peerId, reconnected })` | **required**. Called when the link opens. The app now owns the `PeerLink` |
| `onRoleChosen(role)` | optional, called when Host or Join is clicked |
| `role` | optional `'host'` or `'guest'`, to skip the Host / Join choice |
| `howTo` | default `true`. Shows the "How to pair" steps |

It returns `{ role, start(role?), chooseRole(), destroy() }`.
- The UI hides its container once connected.
- `start()` shows it again and pairs in the same role. Call it after the old link has closed.
- `chooseRole()` goes back to Host / Join.

The component handles the camera, the paste fallback, mismatched codes, timeouts, "Try again",
troubleshooting tips and re-pairing.

### `PeerLink`: the connection

```js
link.send(obj);       // reliable + ordered. Returns false if not queued; never throws
link.sendFast(obj);   // unreliable + unordered; dropped if 64 KB is already queued
link.sharedNow();     // ms; reads the same on both laptops once link.clockReady
link.rtt; link.isHost; link.isOpen; link.backlog; link.peerId; link.app; link.close();
link.onmessage = (msg, { fast }) => {};       // msg is always a plain object
link.onstatechange = (state, reason) => {};   // 'connected' | 'unstable' | 'closed'
link.onrtt = (ms) => {};                      // about once a second
```

- **States:** `unstable` means no contact for about 5 s, and it may recover by itself. `closed` is
  final, with reason `'left'` (the other side closed or navigated away, noticed in about 50 ms),
  `'lost'` (no contact for about 15 s), `'local'` (we closed) or `'mismatch'` (different app
  name).
- **Messages:** message types starting with `__` are reserved for the library. The limit is
  256 KB per message, and bigger ones are refused with a console warning, so split big state.
- **`reconnected`:** true when the other laptop is the same page load as last time. A reload
  counts as a new peer.
- **Pairing by hand** (only for a custom pairing UI):
  ```js
  const link = new PeerLink({ app });
  // host:
  const code = await link.createOfferCode();
  await link.acceptAnswerCode(reply);
  // guest:
  const reply = await link.acceptOfferCode(code);
  ```
  `onopen(info)` fires when the link is ready.

### Lower-level pieces

- **`drawQrCode(canvas, text)`:** async; resolves to the module count.
- **`new QrScanner(video, text => accepted)`:** `.start()` (async) and `.stop()`.
- **`PairCodec`:** `.encode(sdp, kind)`, `.decode(code)` (throws an Error with a user-readable
  message) and `.toSdp(info)`.
- **`loadQrLibraries()`:** loads both QR libraries. Nothing needs to call it, because
  `drawQrCode`, `QrScanner` and `mountPairing` load what they need.

## Game patterns (learned the hard way, so follow them)

- **Make the host authoritative.** The host runs the rules and owns the state. The guest sends
  inputs and draws what the host says. This prevents the two sides drifting apart and limits
  cheating.
- **Know who sent a message from which side of the link it arrived on**, never from a field in the
  message. Validate every incoming message: types, ranges, array lengths. The demo's
  `isPoint` / `isPointList` show the style.
- **Use the right channel:**
  - `send` for events that must arrive, such as moves, scores, "game over" and chat.
  - `sendFast` for frequent snapshots, such as positions and pointers. A lost reliable packet on
    wifi holds up every message behind it (100–300 ms stutters), and the fast channel avoids that.
- **Fast messages can be lost, duplicated or reordered.** Number them (`n: ++seq`) and drop
  anything older than the newest seen. Send full state rather than changes, and repeat it every
  few hundred ms so a lost packet heals by itself. The demo's `cursor` message shows this. Reset
  the "newest seen" number each time a link opens.
- **Send on a tick, not per input event.** Batch once per frame or at a fixed rate (20–60 Hz). The
  demo batches stroke points per `requestAnimationFrame`. If `send` returns false, keep the data
  and retry next tick. If `link.backlog` keeps growing, send less.
- **Use `sharedNow()` to time things,** such as round starts, countdowns and when an input happened.
  It's the host's `performance.now()`, and the guest's estimate is accurate to within a few ms on a
  LAN. Never compare raw `performance.now()` or `Date.now()` values across laptops.
- **Resync on every open.** In `onConnected`, the host sends the full state (chunked under
  256 KB), and the guest replaces its own. The demo's `sendSync` / `sync-begin` show this. Then
  "Pair again" doubles as resuming the game.
- **Keep game state serializable** so a dropped link can be fixed with Pair again and the game
  continues.

## Limits and gotchas

- **Same local network only.** There's no STUN or TURN, by design, so it never touches a server.
  The connection is blocked by client isolation (guest, school, hotel or office wifi), by VPNs, and
  on macOS by Privacy & Security → Local Network being off for the browser.
- **No automatic reconnect.** Once a link is `closed` it's gone, and the laptops show codes again
  via `pairing.start()`. Roaming between access points or getting a new IP address kills it.
- **Camera before offer.** Browsers only share the real LAN IP once camera permission is granted.
  Without it, candidates are `.local` mDNS names, which makes longer codes, and some networks
  block mDNS. `mountPairing` starts the camera before creating the offer for this reason.
- **Background tabs.** A hidden tab gets no `requestAnimationFrame` and timers throttled to 1 Hz.
  The link stays up, but a rAF-driven game loop stops. Pause on `visibilitychange`, or have the
  host treat a silent guest as paused.
- **Untrusted input.** Codes come from whatever is held up to the camera, and messages come from
  the other laptop. Don't put either into `innerHTML`. Browser error messages can quote parts of
  a code, so error text should always go in via `textContent`.
- **Needs internet the first time.** The two QR libraries come from cdnjs and jsdelivr. Once the
  page and libraries are loaded, the link itself is entirely local.
- **Browsers.** Only Chrome has been tested. Firefox and Safari should work, but check them
  before relying on it.

## How it works (short)

- **The code:** `PairCodec` keeps only what's needed from the browser's 500–1,500-character
  session description: ICE username and password, the SHA-256 certificate fingerprint, the DTLS
  role, and up to 3 host addresses (IPv4, mDNS UUID, IPv6, or a strictly checked hostname). It
  packs them into about 64 bytes with a version nibble and a CRC-8. The bytes are written in
  Crockford base32, which uses QR's alphanumeric mode, so each code is about 104 characters.
- **Rebuilding:** `toSdp` turns a code back into a complete description from a fixed template, and
  every value is checked first.
- **Security:** the fingerprint travels over the camera, so the encrypted DTLS link is
  authenticated by the physical exchange. Someone who photographs both codes still can't sit in
  the middle.
- **Channels:** two pre-negotiated channels, `reliable` (id 0) and `fast` (id 1, unordered, no
  retransmits).
- **On open:** each side sends `__hello {id, app}` on the reliable channel. `onopen` /
  `onConnected` fire once both channels are open and the hello matches.
- **Clock and goodbye:**
  - `__ping` and `__pong` run on the fast channel every second. The clock offset comes from the
    fastest of the last 16 round trips.
  - `__bye` is sent on `close()` and on `pagehide`.

## Changing the library

Every game imports the live file, so a change reaches all of them at once.

1. Keep the API backward compatible: add options and methods, don't rename or remove them. If
   a breaking change is unavoidable, update every game in the same commit. Find them with
   `grep -l "lib/qr-pair.js" web/*.html`.
2. If the code format **or** the channel protocol changes (channels, `__` messages), bump
   `QR_PAIR_VERSION`. Pages from before and after the change then refuse each other at the scan,
   with a clear message. This matters because a laptop can have an old copy cached.
3. Run `uv run tests/qr_pair_test.py --demo` and add a test for the change.
4. Changing the CDN libraries means updating `QR_LIBRARIES` with new integrity hashes:
   `curl -sL URL | openssl dgst -sha384 -binary | openssl base64 -A`.

## Testing

```
uv run tests/qr_pair_test.py                  # library tests
uv run tests/qr_pair_test.py --demo           # plus web/qr-pair.html end to end in two windows
uv run tests/qr_pair_test.py --slow-scan 70   # plus a host that takes 70 s to scan
```

- **What runs:**
  - Library tests import the module into a blank page served from the repo and pair two
    `PeerLink`s over loopback. They cover exports, CDN loading with integrity, hostile codes,
    both channels, refused sends, junk frames, the clock, close reasons and app mismatch.
  - The demo test drives two Chrome windows over the DevTools protocol. It covers pairing via
    `data-qrp` elements and pasted codes, drawing, the pointer, disconnect, Pair again with
    resync, and tab close. It reads demo state through `window.qrPairDemo`, because module
    variables aren't global.
- **Testing a game:** copy `run_demo_test`, and expose a similar `window.<game>` hook. Use
  separate windows, not tabs (background tabs get no rAF or input). Use a viewport tall enough
  for the play area, because synthetic mouse events outside the viewport fire `pointerleave`.
- **What still needs real hardware:**
  - webcam scanning (distance, glare, brightness)
  - two physical machines on real wifi
  - Firefox and Safari
