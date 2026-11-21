# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Summarize a Claude Code session's harness version, models and token usage.

Reads the session transcripts Claude Code keeps under ~/.claude/projects/ and
prints a block ready to paste into CODING_LOG.md, including a cost estimate at
API list prices (see PRICES below; a subscription plan bills differently).

Usage:
    uv run python/session_usage.py              # most recent session for this repo
    uv run python/session_usage.py <session-id> # a specific session (prefix ok)
    uv run python/session_usage.py --list       # list sessions for this repo
"""

import json
import sys
from collections import Counter
from pathlib import Path

# Anthropic first-party API list prices, $ per million tokens.
# Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-21).
# Cache writes bill at 1.25x input (5-minute TTL) or 2x input (1-hour TTL).
# Fast mode bills input and output at 2x; cache multipliers apply on top of that.
# Update this table (and the date above) when prices change; old log entries keep their old estimates.
PRICES = {
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_read": 0.20},
    "claude-opus-5": {"input": 5.00, "output": 25.00, "cache_read": 0.50},
    "claude-fable-5-2": {"input": 8.00, "output": 40.00, "cache_read": 0.20},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.10},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01},
}
FAST_MODE_MULTIPLIER = 2.0


def response_cost(model: str | None, usage: dict) -> float | None:
    """Estimated list-price cost of one API response, or None if the model isn't priced."""
    price = PRICES.get(model or "")
    if price is None:
        return None
    speed = FAST_MODE_MULTIPLIER if usage.get("speed") == "fast" else 1.0
    cache_creation = usage.get("cache_creation") or {}
    write_5m = cache_creation.get("ephemeral_5m_input_tokens")
    write_1h = cache_creation.get("ephemeral_1h_input_tokens")
    if write_5m is None and write_1h is None:
        # No TTL breakdown recorded: assume the default 5-minute TTL
        write_5m, write_1h = usage.get("cache_creation_input_tokens") or 0, 0
    dollars = (
        (usage.get("input_tokens") or 0) * price["input"] * speed
        + (write_5m or 0) * price["input"] * speed * 1.25
        + (write_1h or 0) * price["input"] * speed * 2.0
        + (usage.get("cache_read_input_tokens") or 0) * price["cache_read"] * speed
        + (usage.get("output_tokens") or 0) * price["output"] * speed
    )
    return dollars / 1_000_000


TOKEN_FIELDS = {
    "input_tokens": "in",
    "cache_creation_input_tokens": "cache write",
    "cache_read_input_tokens": "cache read",
    "output_tokens": "out",
}


def project_dir(repo: Path) -> Path:
    # Claude Code names the folder after the absolute path with "/" and "." replaced by "-"
    name = str(repo.resolve()).replace("/", "-").replace(".", "-")
    return Path.home() / ".claude" / "projects" / name


def summarize(transcripts: list[Path]) -> dict:
    models, tokens, versions, timestamps, seen = Counter(), Counter(), set(), [], set()
    cost, unpriced, fast_calls = 0.0, set(), 0
    first_prompt = None
    for path in transcripts:
        for line in path.open():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ts := entry.get("timestamp"):
                timestamps.append(ts)
            if v := entry.get("version"):
                versions.add(v)
            message = entry.get("message") or {}
            if entry.get("type") == "user" and first_prompt is None and not entry.get("isMeta"):
                content = message.get("content")
                if isinstance(content, list):
                    content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
                if content and not content.startswith("<"):
                    first_prompt = content.strip().splitlines()[0][:160]
            usage = message.get("usage")
            # One API response is split across several transcript lines; count it once
            if entry.get("type") == "assistant" and usage and message.get("id") not in seen:
                seen.add(message.get("id"))
                models[message.get("model")] += 1
                for field in TOKEN_FIELDS:
                    tokens[field] += usage.get(field) or 0
                fast_calls += usage.get("speed") == "fast"
                call_cost = response_cost(message.get("model"), usage)
                if call_cost is None:
                    unpriced.add(message.get("model"))
                else:
                    cost += call_cost
    return {
        "start": min(timestamps, default=""),
        "end": max(timestamps, default=""),
        "versions": sorted(versions),
        "models": models,
        "tokens": tokens,
        "first_prompt": first_prompt,
        "cost": cost,
        "unpriced": unpriced,
        "fast_calls": fast_calls,
    }


def human(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def main() -> None:
    folder = project_dir(Path.cwd())
    sessions = sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not sessions:
        sys.exit(f"No Claude Code transcripts found in {folder}")

    args = sys.argv[1:]
    if args and args[0] == "--list":
        for path in sessions:
            s = summarize([path])
            print(f"{path.stem}  {s['start'][:16]}  {s['first_prompt']!r}")
        return

    if args:
        matches = [p for p in sessions if p.stem.startswith(args[0])]
        if len(matches) != 1:
            sys.exit(f"Expected one session matching {args[0]!r}, found {len(matches)}")
        session = matches[0]
    else:
        session = sessions[-1]

    # Subagent transcripts (if any) live in a folder named after the session
    transcripts = [session, *sorted((folder / session.stem).rglob("*.jsonl"))]
    s = summarize(transcripts)
    models = ", ".join(f"{m} ({n} calls)" for m, n in s["models"].most_common() if m)
    tokens = " · ".join(f"{human(s['tokens'][f])} {label}" for f, label in TOKEN_FIELDS.items())

    print(f"session: {session.stem}  ({s['start'][:16]} → {s['end'][:16]} UTC)")
    print(f"first prompt: {s['first_prompt']!r}\n")
    print(f"- **Harness / model:** Claude Code {', '.join(s['versions'])} · {models}")
    estimate = f"~${s['cost']:.2f} est. at API list prices"
    if s["fast_calls"]:
        estimate += f", {s['fast_calls']} calls in fast mode"
    if s["unpriced"]:
        estimate += f" (excludes unpriced models: {', '.join(sorted(map(str, s['unpriced'])))})"
    print(f"- **Tokens:** {tokens} · {estimate}")


if __name__ == "__main__":
    main()
