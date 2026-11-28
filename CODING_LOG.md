# Coding Log

One short entry per AI-assisted session that ships a new tool or an update to one. Newest first.
Each entry records what was built, the harness and model used, and what it cost in tokens, with a dollar estimate at Anthropic API list prices (what the usage would cost through the API, not a subscription bill).
Get the usage numbers for the current session with `uv run python/session_usage.py`.

<!-- Template:
## YYYY-MM-DD · Tool name (new | update) · `path/to/file`
- **Precis:** two or three sentences on what was built or changed and any notable design decisions.
- **Harness / model:** Claude Code x.y.z · model-id
- **Tokens:** N in · N cache write · N cache read · N out · ~$N est. at API list prices
-->

## 2026-11-27 · Ricochet Tanks (new) · `web/ricochet-tanks.html`
- **Precis:** Two-player tank duel in a random maze with shells that bounce off walls, playable on one keyboard or on two laptops linked through `lib/qr-pair.js`. The maze is a depth-first walk with a quarter of the leftover inner walls knocked out to add loops. Shells are swept as rays against radius-grown wall rectangles so they reflect cleanly and never tunnel. Over the link the host is authoritative: the guest sends a key bitmask and a fire-press count on the fast channel, and draws ~60 Hz host snapshots interpolated 35 ms behind the shared clock. Mazes and scores go on the reliable channel, and Pair again resumes the match. It's the first app split into a page plus ES modules (`web/ricochet-tanks/`: sim, net, render, main; noted in CLAUDE.md), with headless tests in `tests/ricochet_tanks_test.py` that reuse the qr-pair harness.
- **Harness / model:** Claude Code 2.1.332 · claude-opus-5-5 (24 calls)
- **Tokens:** 48 in · 136.9k cache write · 2.65M cache read · 81.0k out · ~$3.24 est. at API list prices

## 2026-11-21 · QR Pair (security review, game hardening, shared library) · `web/lib/qr-pair.js`
- **Precis:** A skeptical review found an XSS: a crafted code's address was echoed by Chrome's SDP parse error into `innerHTML`. That's fixed, along with SDP line injection (strict hostname checks) and missing SRI on the CDN scripts. `PeerLink` then gained a second unreliable/unordered "fast" channel, never-throwing sends with backpressure, junk-message filtering, a shared clock (`sharedNow()`), a hello handshake with app-name checking and reconnect detection, and in-page **Pair again** with host resync. The pairing code then moved out of the demo into an importable ES module, `web/lib/qr-pair.js`, with a drop-in `mountPairing()` UI and on-demand SRI-pinned CDN loading. It has reuse notes in `web/lib/qr-pair.md` (linked from CLAUDE.md) and headless-Chrome tests in `tests/qr_pair_test.py`, and `web/qr-pair.html` is now its demo.
- **Harness / model:** Claude Code 2.1.330 · claude-opus-5-5 (59 calls)
- **Tokens:** 126 in · 335.7k cache write · 8.68M cache read · 136.3k out · ~$7.15 est. at API list prices

## 2026-11-21 · QR Pair (new) · `web/qr-pair.html`
- **Precis:** Prototype for pairing two laptops on the same wifi with no server: each shows a QR code to the other's webcam, which sets up a direct WebRTC data channel, with a shared sketchpad as the demo. Only the essential WebRTC fields (ICE username and password, certificate fingerprint, addresses) are packed into a ~104-character Crockford base32 code, which the other side rebuilds into a full description. The pairing kit is a self-contained block meant to be copied into future two-player games. A follow-up added connection-health states (connected / lost contact / disconnected) shown in the top bar, plus a goodbye message sent on Disconnect or tab close, so the other side finds out within a fraction of a second instead of 15 s. It is framed as a general browser-to-browser connection demo (Host / Join a connection) and listed on the index under Network.
- **Harness / model:** Claude Code 2.1.330 · claude-opus-5-5 (36 calls)
- **Tokens:** 84 in · 81.8k cache write · 3.08M cache read · 58.3k out · ~$2.44 est. at API list prices

## 2026-11-21 · Hedgehog Dash (new) · `web/hedgehog-dash-typing.html`
- **Precis:** Learn-to-type game: hedgehogs chase the player and typing the prompted letters and words keeps them ahead. Getting caught means being beamed up by aliens.
- **Harness / model:** Claude Code 2.1.330 · claude-opus-5-5 (28 calls)
- **Tokens:** 60 in · 116.9k cache write · 3.05M cache read · 78.2k out · ~$3.11 est. at API list prices

## 2026-11-15 · Learn to Tell Time (update) · `web/learn-to-tell-time.html`
- **Precis:** Added a reset control for the stored stars and sticker counts (they persist in browser storage, so there was no way to start over before).
- **Harness / model:** Claude Code 2.1.325 · claude-opus-5-5 (12 calls)
- **Tokens:** 28 in · 22.2k cache write · 614.5k cache read · 4.0k out · ~$0.38 est. at API list prices

## 2026-11-15 · Learn to Tell Time (update) · `web/learn-to-tell-time.html`
- **Precis:** Made the clock game livelier: alarm-clock face, spinning hands, tap-to-answer choices, hints, sounds, confetti and collectible stickers.
- **Harness / model:** Claude Code 2.1.325 · claude-opus-5-5 (15 calls), after an interrupted 2-call start on Claude Code 2.1.227 · claude-opus-5
- **Tokens:** 36 in · 92.8k cache write · 1.31M cache read · 40.8k out · ~$1.90 est. at API list prices

## 2025-03-20 · PDF Comparison Finder (new) · `web/pdf-comparison-finder.html`
- **Precis:** Adapted the duplicate finder to compare two PDFs and report pages and runs of pages from the first file that also appear in the second.
- **Harness / model:** Claude Code research preview · model not recorded
- **Tokens:** not recorded · $0.73 as reported by Claude Code (3m 22s API time, +981/−49 lines)

## 2025-03-20 · PDF Duplicate Page Finder (new) · `web/pdf-find-duplicate-page.html`
- **Precis:** Finds duplicate pages within a single PDF by rendering each page and hashing it in the browser. Most of the session went into false positives: the hash moved from a small square thumbnail to the page's full rendered resolution, and consecutive duplicate pages are grouped into sections.
- **Harness / model:** Claude Code research preview · model not recorded
- **Tokens:** not recorded · $0.77 as reported by Claude Code (4m 38s API time, +776/−126 lines)

## Earlier sessions, not recorded
LaTeX Unicode completion (2025-12-26), mortgage refinance calculator (2026-01), Learn to Tell Time first version (2026-02-22), cryogenic attenuation calculator and the site redesign (2026-07-10). See git history.
