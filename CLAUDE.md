# CLAUDE.md - Repository Guidelines

## Repository Structure
- `/python/` - Python script tools
- `/web/` - Web-based tools (mostly single-page HTML/JS applications)
- `/web/lib/` - Reusable JS modules shared by several apps, each with a notes file beside it (e.g. `qr-pair.js` + `qr-pair.md`)
- `/tests/` - Headless-browser test scripts (`uv run tests/<name>.py`)
- `CODING_LOG.md` - One-entry-per-session log of AI-assisted work (precis, harness/model, token cost)

## Development Commands
- No formal build system is present (single-file applications)
- Test: Open web tools in browser and verify functionality. Pages that import from `web/lib/` are ES modules and won't load from `file://`: run `python3 -m http.server` in the repo root and open `http://localhost:8000/web/<page>.html`
- Deploy: The repository is hosted at projects.colmryan.org (see CNAME file) by Github Pages as publishing from a branch and so deploying simply means pushing to `main`. 

## Code Style Guidelines

### python scripts
- python scripts should be self contained in one file
- you can assume we can use Python 3.12 or later
- the user should be able to run the script via `uv run script_name.py`
- following PEP 723 python version and dependencies are listed at the start of the script e.g.
```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "boto3",
#     "numpy",
#     "scipy",
# ]
```

### web apps
- HTML: Indent with 4 spaces
- JavaScript:
  - Descriptive variable and function names
  - Use ES6+ features (arrow functions, async/await)
  - Add comments for complex logic
  - Thorough error handling for user inputs
- One-off tools: single-file architecture (HTML/JS/CSS in one file) is the default
- Apps that need something already built as a reusable piece (see below): use that piece rather than rewriting it, following its own notes on how to include it
- When a feature looks likely to recur across apps (networking, input handling, rendering helpers), suggest making it a reusable piece with a canonical source, a notes file in `web/`, tests in `tests/`, and an entry below. Don't extract one speculatively from a single app
- Local-only processing (will be served from a static website)

### Reusable pieces
- **Two-player / networked games:** import `web/lib/qr-pair.js` (direct WebRTC between two browsers on the same wifi, paired by QR codes, no server; `mountPairing()` gives a ready-made pairing UI). Read `web/lib/qr-pair.md` before starting: it covers including it, the API, game patterns (host-authoritative, reliable vs fast channel, tick-based sending, `sharedNow()`, resync on open), gotchas (serve over http(s), not `file://`) and tests (`uv run tests/qr_pair_test.py --demo`). Don't write new WebRTC or signalling code. `web/qr-pair.html` is its demo and reference app.

## Documentation
- After a session that adds or updates a tool, add an entry at the top of `CODING_LOG.md` following the template there: a 2–3 sentence precis, the harness version and model, and token usage with a cost estimate. Get the numbers by running `uv run python/session_usage.py` (most recent session for this repo) at the end of the session so the totals are complete. Don't save full transcripts.
- Include clear usage instructions in UI
- Document any unique algorithms or techniques used
