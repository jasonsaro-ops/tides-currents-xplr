# TIDES & CURRENTS XPLR

**Professional real-time Tides & Currents dashboard** powered by NOAA CO-OPS, styled after the ARM computer interface from *The Martian*.

![Dashboard](https://tidesandcurrents.noaa.gov/images/noaa_logo.gif)

## Features

- **Interactive zoomable map** of every active NOAA water-level and current station
- **Esri basemaps** (Dark, Imagery, Topographic, Streets, Oceans) with attribution to ESRI, TomTom, Garmin, FAO, NOAA, USGS
- **Real-time observations** via the CO-OPS Data API (`date=latest`)
- **Click any station** → floating modal with:
  - Latest water level, air/water temp, pressure, wind, visibility, humidity
  - 24-hour water-level time series chart
  - Meteorological summary
  - Currents (for PORTS current meters)
  - High/Low tide predictions
- **Filters**: State, data type (Water Levels / Currents / PORTS® / Met), product overlay
- **Search** by station name, ID, or state
- **Active sites panel** showing live values from high-traffic stations
- **Marker clustering** (toggleable)
- Pure client-side — no backend required

## Data Sources

| Source | Endpoint |
|--------|----------|
| Station inventory | `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json` |
| Real-time & historical | `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` |
| PORTS® | Physical Oceanographic Real-Time System stations flagged via `portscode` / affiliations |
| Map tiles | Esri Leaflet basemap layers |

## Quick Start (GitHub Pages)

1. Create a new GitHub repository (e.g. `tides-currents-xplr`)
2. Upload the three files:
   - `index.html`
   - `styles.css`
   - `app.js`
3. Enable **GitHub Pages** (Settings → Pages → Deploy from branch `main` / root)
4. Visit `https://<your-username>.github.io/tides-currents-xplr/`

No build step. No API keys. Works offline after the first station list load (subsequent data fetches still need network).

## Local Development

```bash
# Any static server
npx serve .
# or
python -m http.server 8080
```

Open `http://localhost:8080`.

## Color & Typography (Martian ARM)

- Background: `#0a0c0f` / `#111418`
- Accent: `#e67e22` (orange)
- Fonts: Orbitron (display) + Share Tech Mono
- UI language: uppercase labels, dense data cards, pulse LIVE indicator

## Limitations & Notes

- NOAA rate-limits aggressive polling; the dashboard refreshes the active panel every 5 minutes and only fetches on demand for the modal.
- Some current-meter stations require a `bin` parameter; the app defaults to bin 1.
- Great Lakes stations use different datums (IGLD/LWD); the UI defaults to MLLW for coastal stations.
- CORS is allowed by NOAA’s public APIs for browser use.

## License

MIT. Data © NOAA / NOS / CO-OPS. Basemaps © Esri and partners.

---

**TIDES & CURRENTS XPLR** — Explore every tide and current station in the United States.
