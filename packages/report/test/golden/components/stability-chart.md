**Packages by instability and abstractness** (instability I against abstractness A)

| # | Package | Instability I | Abstractness A | Distance | Ca | Ce | Exported types | Position |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | core | 0.1 | 0.1 | 0.8 | 9 | 1 | 10 | zone of pain |
| 2 | ports | 0.9 | 1 | 0.9 | 1 | 9 | 2 (A weak) | zone of uselessness |
| 3 | app | 0.6 | 0.4 | 0 | 2 | 3 | 5 | outside the zones |

_The dashed diagonal is the main sequence, where A + I = 1. A zone starts 0.5 from it (structure.packages.zoneDistance): the zone of pain is concrete and stable (A + I at most 0.5) and the zone of uselessness is abstract and unstable (A + I at least 1.5). Square points are inside a zone, round points are not, and the table gives each position in words. A guideline orders and labels results; it decides nothing._

_Of the 3 measured packages, 1 are in the zone of pain, 1 in the zone of uselessness and 1 outside the zones._

_The table lists 3 of 6 packages, furthest from the main sequence first; 3 not listed: 3 have no instability (no dependency in or out) or no abstractness (no language adapter reads them)._
