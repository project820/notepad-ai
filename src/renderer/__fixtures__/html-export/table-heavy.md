# Operations Tables

^^ Tabular density check

## Service Inventory

| Service | Owner | Tier | Requests/s |
| --- | --- | --- | --- |
| auth-api | Platform | 0 | 1820 |
| billing | Finance | 1 | 540 |
| search | Discovery | 1 | 990 |
| notify | Growth | 2 | 210 |
| export | Platform | 2 | 75 |
| ingest | Data | 1 | 1310 |
| reporting | Finance | 2 | 64 |
| gateway | Platform | 0 | 2440 |

## Wide Single Row

| Region | Q1 | Q2 | Q3 | Q4 | Plan | Actual |
| --- | --- | --- | --- | --- | --- | --- |
| EMEA | 120 | 138 | 151 | 165 | 560 | 574 |

## Incident Log

| Date | Severity | Component | Minutes | Resolved By |
| --- | --- | --- | --- | --- |
| 03-02 | high | gateway | 42 | on-call |
| 03-09 | low | search | 11 | owner |
| 03-15 | medium | billing | 27 | finance |
| 03-21 | high | ingest | 63 | data |
| 03-28 | low | notify | 9 | growth |
| 04-04 | medium | export | 18 | platform |
| 04-11 | high | auth-api | 51 | platform |
| 04-18 | low | reporting | 7 | finance |
| 04-25 | medium | gateway | 22 | platform |
| 05-02 | high | ingest | 58 | data |

## Notes

Each table above must remain horizontally contained. Wide tables should be transposed or row-split by the engine rather than overflowing. The single-row regional table is the classic too-wide case.
