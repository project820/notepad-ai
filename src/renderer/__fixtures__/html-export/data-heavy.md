# Annual Data Pack

^^ Charts of every kind

## Revenue by Quarter

```chart
{
  "type": "bar",
  "title": "Revenue",
  "labels": ["Q1", "Q2", "Q3", "Q4"],
  "series": [{ "name": "2025", "values": [320, 410, 480, 560] }],
  "unit": "k USD"
}
```

## Growth Trend

```chart
{
  "type": "line",
  "title": "MoM growth",
  "labels": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  "series": [{ "name": "growth", "values": [3, 5, 4, 7, 6, 9] }],
  "unit": "%"
}
```

## Traffic Mix

```chart
{
  "type": "pie",
  "title": "Channels",
  "labels": ["Direct", "Search", "Social", "Referral"],
  "series": [{ "values": [44, 31, 15, 10] }],
  "unit": "%"
}
```

## Storage Split

```chart
{
  "type": "donut",
  "title": "Storage",
  "labels": ["Hot", "Warm", "Cold"],
  "series": [{ "values": [22, 38, 40] }],
  "unit": "%"
}
```

## Release Timeline

```chart
{
  "type": "timeline",
  "title": "Milestones",
  "labels": ["Alpha", "Beta", "GA", "v2"],
  "series": [{ "values": [1, 2, 3, 4] }]
}
```

## Supporting Figures

| Quarter | Revenue | Cost | Margin |
| --- | --- | --- | --- |
| Q1 | 320 | 210 | 110 |
| Q2 | 410 | 250 | 160 |
| Q3 | 480 | 280 | 200 |
| Q4 | 560 | 300 | 260 |

Every chart is deterministic inline SVG. No chart may pull a remote asset, and no figure may overflow its slide.
