# CLAUDE.md - Repository Guidelines

## Repository Structure
- `/python/` - Python script tools
- `/web/` - Web-based tools (single page HTML/JS applications)
- `/coding_logs/` - Documentation of tool development process

## Development Commands
- No formal build system is present (single-file applications)
- Test: Open web tools in browser and verify functionality
- Deploy: Update hosted version of tools on tools.colmryan.org

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
- Single-file architecture for web tools (HTML/JS/CSS in one file)
- Local-only processing (will be served from a static website)

## Documentation
- Add coding logs from Claude Code for new tools in `/coding_logs/`
- Include clear usage instructions in UI
- Document any unique algorithms or techniques used