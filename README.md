# Tides & Currents Enhanced

NOAA coastal dashboard with **multi-channel thickness mapping** (3D) and a **docked station detail pane**.

## Layout
| Left | Center | Right (topo-first) |
|------|--------|---------------------|
| Filters / Stations | Leaflet map | **Water-height topo** (primary) + collapsible **Station detail** |

Detail can be collapsed (▾) so the 3D topo absorbs the full right-rail height.
Click any ocean surface on the map to sample and rebuild the IDW water-level surface.

## Multi-channel thickness map
Inspired by hydrogeological / thickness block models:

| Channel | Visual | Source |
|---------|--------|--------|
| Water level | Column **height** (ft MLLW) | CO-OPS `water_level` |
| Water temp | Column **color** (°F) | CO-OPS / NDBC |
| Waves | **Cap** thickness (ft) | NDBC `wvht` |
| Currents | **Arrows** direction/speed | CO-OPS `currents` |

Click the map or a preset → builds columns from nearby stations.

## Station clicks → detail pane
No reliance on floating windows for primary inspection. CO-OPS and NDBC clicks fill the **Station detail** dock with live products + chart.

## Trusted sources only
| Keep | Role |
|------|------|
| **NOAA CO-OPS** MDAPI + Datagetter | Stations, WL, currents, temps, predictions (6‑min, CORS OK) |
| **NDBC** latest_obs (+ embedded series) | Buoy waves / met (via same-origin cache) |
| **NWS Alerts API** | Flood / coastal warnings |
| **RainViewer** | Optional radar |

**Removed / de-emphasized:** USGS gauges, most nowCOAST export layers, satellite, lightning, inland-flood duplicates (redundant or unreliable in-browser).

## Deploy
GitHub Pages static site. Include `data/`. No API keys required.
