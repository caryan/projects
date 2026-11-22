# QR Pairing Kit — notes for building two-player games

The QR pairing kit links two browsers on the same wifi over a direct WebRTC connection, with
no server. Each laptop shows a QR code to the other's webcam (or the codes are pasted). Use it
for every two-player / networked game in this repo rather than writing new WebRTC code.

- **Canonical source:** the block between `// QR PAIRING KIT v2` and `END QR PAIRING KIT` in
  [`qr-pair.html`](qr-pair.html). That page is also the reference UI and demo (shared sketchpad).
- **Tests:** `uv run tests/qr_pair_kit_test.py` (headless Chrome; see [Testing](#testing)).
- **Version:** v2. The `v2` in the marker and `PairCodec`'s `VERSION` (2) change together.

## Using it in a new game

1. Keep the single-file rule: copy the whole kit block **unchanged** into the game's `<script>`.
   Don't edit it in the game. Fix or extend it in `qr-pair.html`, then re-copy (see
   [Changing the kit](#changing-the-kit)).
2. Include the two libraries with their integrity hashes, exactly as `qr-pair.html` does:
   `qrcode-generator@1.4.4` (cdnjs) and `jsqr@1.4.0` (jsdelivr), each with `integrity` and
   `crossorigin="anonymous"`.
3. Copy the pairing UI from `qr-pair.html` as a starting point: the `#intro` and `#pairing` HTML,
   the `#failure-tips` template, and the "Page UI" script section (`startPairing`, `handleCode`,
   `setStatus`, and so on). It handles roles, the camera, paste fallback, timeouts, re-pairing
   and errors. Restyle it freely.
4. Give the game its own app name: `new PeerLink({ app: 'snake@1' })`. Laptops running different
   app names refuse each other (`closed` with reason `'mismatch'`). Bump the `@n` whenever the
   game's message format changes.
5. Run `uv run tests/qr_pair_kit_test.py web/your-game.html` to check the copied kit.

## API

```js
const link = new PeerLink({ app: 'snake@1' });

// Host                                          // Guest
const code = await link.createOfferCode();       const reply = await link.acceptOfferCode(code);
drawQrCode(canvas, code);                        drawQrCode(canvas, reply);
await link.acceptAnswerCode(reply);

link.onopen = ({ peerId, reconnected }) => {};   // both channels up and the hello exchanged
link.onmessage = (msg, { fast }) => {};          // msg is always a plain object
link.onstatechange = (state, reason) => {};      // 'connected' | 'unstable' | 'closed'
link.onrtt = (ms) => {};                         // about once a second

link.send(obj);       // reliable + ordered. Returns false if not queued; never throws
link.sendFast(obj);   // unreliable + unordered; dropped if 64 KB is already queued
link.sharedNow();     // ms; reads the same on both laptops once link.clockReady
link.rtt; link.isHost; link.isOpen; link.backlog; link.peerId; link.close();

new QrScanner(videoEl, (text) => acceptedBool).start();   // .stop()
PairCodec.decode(code);  // throws an Error with a user-readable message on a bad code
```

- **States:** `unstable` means no contact for about 5 s, and it may recover by itself. `closed` is
  final, with reason `'left'` (the other side closed or navigated away, noticed in about 50 ms),
  `'lost'` (no contact for about 15 s), `'local'` (we closed) or `'mismatch'`.
- **Messages:** message types starting with `__` are reserved for the kit, and `send` refuses them.
  The limit is 256 KB per message, and bigger ones are refused with a console warning, so split
  big state.
- **`reconnected`:** true when the other laptop is the same page load as last time. A reload
  counts as a new peer. Use it to decide between resuming and starting a new game.

## Game patterns (learned the hard way, so follow them)

- **Make the host authoritative.** The host runs the rules and owns the state. The guest sends
  inputs and draws what the host says. This prevents the two sides drifting apart and limits
  cheating.
- **Know who sent a message from which link it arrived on**, never from a field in the message.
  Validate every incoming message: types, ranges, array lengths. The demo's `isPoint` /
  `isPointList` show the style.
- **Use the right channel:**
  - `send` for events that must arrive, such as moves, scores, "game over" and chat.
  - `sendFast` for frequent snapshots, such as positions and the pointer. A lost reliable packet
    on wifi holds up every message behind it (100–300 ms stutters), and the fast channel avoids
    that.
- **Fast messages can be lost, duplicated or reordered.** Number them (`n: ++seq`) and drop
  anything older than the newest seen. Send full state rather than changes, and repeat it every
  few hundred ms so a lost packet heals by itself. The demo's `cursor` message shows this. Reset
  the "newest seen" number on each `onopen`.
- **Send on a tick, not per input event.** Batch once per frame or at a fixed rate (20–60 Hz). The
  demo batches stroke points per `requestAnimationFrame`. If `send` returns false, keep the data
  and retry next tick. If `link.backlog` keeps growing, send less.
- **Use `sharedNow()` to time things,** such as round starts, countdowns and when an input happened.
  It's the host's `performance.now()`, and the guest's estimate is accurate to within a few ms on a
  LAN. Never compare raw `performance.now()` or `Date.now()` values across laptops.
- **Resync on every open.** In `onopen`, the host sends the full state (chunked under 256 KB), and
  the guest replaces its own. The demo's `sendSync` / `sync-begin` show this. Re-pairing then
  doubles as resuming the game.
- **Keep game state serializable** so a dropped link can be fixed with **Pair again** and the game
  continues.

## Limits and gotchas

- **Same local network only.** There's no STUN or TURN, by design, so it never touches a server.
  The connection is blocked by client isolation (guest, school, hotel or office wifi), by VPNs, and
  on macOS by Privacy & Security → Local Network being off for the browser. Over the internet it
  would need a server, and that would be a different design.
- **No automatic reconnect.** Once a link is `closed` it's gone, and the laptops have to show
  codes again. Roaming between access points or getting a new IP address kills it. That's why the
  resync-on-open pattern matters.
- **Camera before offer.** Browsers only share the real LAN IP once camera permission is granted.
  Without it, candidates are `.local` mDNS names, which makes longer codes, and some networks
  block mDNS. The UI starts the camera before creating the offer for this reason.
- **Background tabs.** A hidden tab gets no `requestAnimationFrame` and timers throttled to 1 Hz.
  The link stays up, but a rAF-driven game loop stops. Pause the game on `visibilitychange`, or
  have the host treat a silent guest as paused.
- **Untrusted input.** Codes come from whatever is held up to the camera, and messages come from
  the other laptop. Don't put either into `innerHTML`. Browser error messages can quote parts of
  a code, so error text should always go in via `textContent`.
- **Browsers.** Only Chrome has been tested. Firefox and Safari should work, since the rebuilt
  description uses standard fields, but check them before relying on it.

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
- **On open:** each side sends `__hello {id, app}` on the reliable channel. `onopen` fires once
  both channels are open and the hello matches.
- **Clock and goodbye:**
  - `__ping` and `__pong` run on the fast channel every second. The clock offset comes from the
    fastest of the last 16 round trips.
  - `__bye` is sent on `close()` and on `pagehide`.

## Changing the kit

1. Edit the block in `qr-pair.html`.
2. If the code format **or** the channel protocol changes (channels, `__` messages), bump
   `PairCodec`'s `VERSION` and the `vN` in the marker comment, so old and new pages refuse each
   other at the scan with a clear message.
3. Run `uv run tests/qr_pair_kit_test.py --demo` and add a test for the change.
4. Find every game with a copy (`grep -l "QR PAIRING KIT" web/*.html`), re-copy the block into
   each, and run the tests on each file.

## Testing

```
uv run tests/qr_pair_kit_test.py                       # kit tests on web/qr-pair.html
uv run tests/qr_pair_kit_test.py web/game.html         # a game's copy of the kit
uv run tests/qr_pair_kit_test.py --demo                # plus the demo end to end in two windows
uv run tests/qr_pair_kit_test.py --slow-scan 70        # plus a host that takes 70 s to scan
```

- **What runs:**
  - Kit tests pair two `PeerLink`s over loopback in one headless page. They cover hostile codes,
    both channels, refused sends, junk frames, the clock, close reasons and app mismatch.
  - The demo test drives two Chrome windows over the DevTools protocol. It covers pairing by
    pasted codes, drawing, the pointer, disconnect, **Pair again** with resync, and tab close.
- **Using it for a game's own end-to-end test:** follow `run_demo_test`, and use separate
  windows, not tabs (background tabs get no rAF or input). Use a viewport tall enough for the
  play area, because synthetic mouse events outside the viewport fire `pointerleave`.
- **What still needs real hardware:**
  - webcam scanning (distance, glare, brightness)
  - two physical machines on real wifi
  - Firefox and Safari
