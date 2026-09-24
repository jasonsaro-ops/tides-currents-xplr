# TIDES & CURRENTS XPLR

**Elite NOAA tides, currents & coastal intelligence dashboard.**

A fully interactive, metadata-rich explorer for NOAA CO-OPS, NDBC, NWS, USGS and nowCOAST data — designed to feel like a modern mission console (Stripe / Vercel / Apple-level polish).

## Features

- **Interactive map** with Leaflet + marker clustering
- **Floating windows** — click any station, buoy, alert or card to open a rich, draggable metadata panel with charts, products, and source links
- **Near real-time** soft refresh every **2 minutes** (no full page reload)
- **Layout persistence** — save / load panel widths, collapsed sections, active layers, map view, and watched stations
  - Local storage (automatic)
  - Export / import JSON
  - Load from a public GitHub raw URL (`?layout=https://raw.githubusercontent.com/...`)
- **Rich metadata** on every station: products, flood thresholds, last observation, official NOAA links
- **Sources always visible** — every data panel and floating window cites the originating NOAA / NDBC / USGS / NWS endpoint
- Basemaps (Dark, Imagery, Topo, Streets, Ocean)
- nowCOAST & radar overlays
- NWS coastal flood alerts
- USGS hydrology gauges
- Watch strip for multi-station live monitoring
- Search by name, ID or state

## Stack

- Leaflet 1.9 + MarkerCluster
- Chart.js 4
- NOAA CO-OPS MDAPI + Data API
- NDBC latest observations
- NWS Alerts API
- USGS Water Services
- nowCOAST / IEM NEXRAD / RainViewer

## Hosting (GitHub Pages)

1. Create a repository named **`tides-currents-xplr`**
2. Upload the contents of this folder (or push the zip)
3. Enable GitHub Pages on the `main` branch (root)
4. Open `https://<user>.github.io/tides-currents-xplr/`

### Sharing a layout

1. Click **Save Layout** → Export JSON
2. Commit the JSON into the repo (e.g. `layouts/my-view.json`)
3. Share: `https://<user>.github.io/tides-currents-xplr/?layout=https://raw.githubusercontent.com/<user>/tides-currents-xplr/main/layouts/my-view.json`

## Soft Refresh

Data is refreshed every 120 seconds in the background. The UI never hard-reloads; only values, charts and badges update. Manual soft refresh is available from the logo / header control.

## Keyboard

- `/` focuses search
- `Esc` closes the topmost floating window
- `R` triggers soft refresh (when not typing)

## License

Public domain / NOAA open data. UI code provided for open use.
