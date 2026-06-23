# REAL HANDOVER DOCUMENT — REQUIRED, NOT SYNTHESIZED

The containment gate ships with a **synthetic** corpus (`short.md`, `very-long.md`,
`table-heavy.md`, `code-heavy.md`, `korean.md`, `mixed.md`, `data-heavy.md`). Those
fixtures are authored test inputs and exercise the engine + real-DOM measurement
across every block kind, orientation, and layout.

They are **NOT** a substitute for the real input this feature exists to serve.

## What is missing

The user's actual **"겐츠 도쿄 출장" (Gentz Tokyo business-trip) handover** source
Markdown. Drop that real document in this directory as:

```
src/renderer/__fixtures__/html-export/gentz-handover.md
```

Do **NOT** synthesize, paraphrase, translate, or fabricate a stand-in for it. The
brief explicitly forbids a substitute. It must be the genuine source the user hands
over, byte-for-byte.

## How the gate treats it

- **Absent** (the default in this repo): the containment runner reports the real
  document as `SKIPPED-PENDING-REAL-DOC`. This is **not a pass** — it is an
  outstanding, required input. The synthetic corpus can still pass on its own; the
  real document remains a pending acceptance item.
- **Present**: the runner includes `gentz-handover.md` in the full matrix
  (slides/scroll × horizontal/vertical × viewport sizes) exactly like the synthetic
  fixtures, and **final acceptance for this feature requires it to pass.**

## Why it cannot be synthesized

A real handover has the messy, non-uniform structure (mixed Korean/English, pasted
tables, uneven heading depth, long unbroken passages) that synthetic fixtures only
approximate. Containment must be proven against the genuine article, not a tidy
imitation, before this feature can be considered done.
