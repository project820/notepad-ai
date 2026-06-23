# Product Review

^^ A bit of everything

## Summary

This document mixes every block kind in one place. It combines prose, lists, a table, code, a quote, a callout, and a chart. The goal is to confirm the engine contains heterogeneous content. Each block must stay inside the safe area on every slide.

### Why It Matters

Real handovers are rarely uniform. They jump between narrative and data without warning. A robust layout engine must handle that gracefully.

## Details

- The onboarding flow was rewritten end to end.
- Two legacy screens were retired.
- A new settings panel shipped behind a flag.

| Metric | Before | After |
| --- | --- | --- |
| Steps | 9 | 5 |
| Drop-off | 38% | 19% |
| Time | 4m | 2m |

```ts
function activate(flag: string, user: string): boolean {
  const enabled = rollout.includes(flag);
  return enabled && cohort(user) === 'beta';
}
```

> The simpler flow nearly halved drop-off without any new tutorial.

```callout:success
The redesign hit its primary metric in the first week. Adoption kept climbing through the following sprint.
```

## Adoption

```chart
{
  "type": "line",
  "title": "Weekly adoption",
  "labels": ["W1", "W2", "W3", "W4"],
  "series": [{ "name": "active", "values": [120, 180, 240, 310] }],
  "note": "Active users per week"
}
```

The chart should render as inline SVG with no remote assets. Its caption stays within the safe area.
