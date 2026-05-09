# Cutting Board Evil Twin

An alternate take on Cutting Board. An arrangement-style autocut workflow applied to an in/out range on the active sequence:

1. **Silence pass** — calls into the [Silence Remover](https://github.com/IamTrevorMay/mayday-silence-remover) plugin (hard dependency).
2. **Take detection** — transcribes, identifies multiple takes, highlights all but the last for cut. Hybrid: repeated-phrase heuristic + optional Claude API tiebreak on ambiguous clusters.
3. **Refine** — normalizes every cut boundary to a single standard (pre-roll ms + audio ramp threshold).

Every run **duplicates the active sequence** as `<original> (Evil Twin)` and operates on the copy. The original is never modified.

## Status

Scaffold only — build step 1 of 10. See the parent project's `CLAUDE.md` for the full build plan.

## Requirements

- Mayday Create launcher (SDK >= 2.0.0)
- Silence Remover plugin installed
- (Optional) Anthropic API key for LLM tiebreak in step 2

## Installation

Install via Mayday Create launcher → Plugin Manager → search "Cutting Board Evil Twin" → Install.

## Development

```bash
npm install
npm run build      # builds dist/
npm run package    # builds + zips for release
```

## Release

```bash
git tag v1.0.0
git push --tags
```

The GitHub Action builds, packages, and creates a Release with the zip asset. The launcher's Plugin Manager picks up the new version automatically.
