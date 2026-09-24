# TIDES & CURRENTS XPLR

Elite NOAA tides, currents & coastal intelligence dashboard.

## Fixes in this build

- **Map + data loading hardened** — null-safe boot, retry on station failure, map `invalidateSize` after layout
- **Scrollable columns** — left/right rails scroll independently; lists have max-height; works on smaller windows
- **Buttons & interactions** — all controls wired; floating windows for stations, buoys, alerts
- **Montco three-tone alert scheme** (Web Audio, no files):
  - **Fire tone** (sawtooth alternating) → severe / extreme flood alerts
  - **EMS tone** (rising sine C5→G5) → moderate / watch
  - **Traffic tone** (triangle double-beep) → advisory + soft refresh + tone unlock confirmation
- **ZIP code search** — type a 5-digit ZIP to geocode (Nominatim) and center map + filter nearby stations
- **Montco-style edge accents** — 3px left border colors on station cards, watch cards, alerts, and floating windows

## Soft refresh

Every **2 minutes** (soft). Manual: logo button or **R**.

## Layout save / load

- Auto localStorage
- **Layout** → Export / Import JSON
- `?layout=https://raw.githubusercontent.com/.../layout.json`

## Hosting

Repo name: `tides-currents-xplr` · GitHub Pages on `main` root.

## Stack

Leaflet · MarkerCluster · Chart.js · NOAA CO-OPS · NDBC · NWS · RainViewer · Nominatim (ZIP)
