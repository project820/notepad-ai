# Code Walkthrough

^^ Monospace containment check

## Setup

The snippets below vary in length. Short snippets should sit comfortably on one slide. Long snippets should be line-group split by the engine so no slide scrolls.

```bash
npm install
npm run build
npm run test
```

## A Longer Module

```ts
export function paginate(items: number[], perPage: number): number[][] {
  const pages: number[][] = [];
  let page: number[] = [];
  for (const item of items) {
    page.push(item);
    if (page.length >= perPage) {
      pages.push(page);
      page = [];
    }
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export function summarize(pages: number[][]): { count: number; total: number } {
  let total = 0;
  for (const page of pages) {
    for (const value of page) total += value;
  }
  return { count: pages.length, total };
}

export function format(summary: { count: number; total: number }): string {
  return `pages=${summary.count} total=${summary.total}`;
}
```

## Config Sample

```json
{
  "name": "containment-demo",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "private": true
}
```

## Closing

Every code block must stay within the safe area. Long blocks split across continuation slides while preserving order.
