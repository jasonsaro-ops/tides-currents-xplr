# Tides & Currents Enhanced

NOAA CO-OPS / NDBC coastal intelligence dashboard with a **3D hydro pane** (WeatherXplr Enhanced–style split stage).

## Features

- Full map explorer: stations, NDBC buoys, NWS alerts, product overlays, radar
- **3D HYDRO** pane (Three.js): animated water surface, flow particles, tide gauge
- Driven by **nearby real observations** (water level, currents, waves, water temp)
- Click the map or use presets (Philadelphia, NY Harbor, Miami, Galveston, Seattle)

## 3D meaning (honest)

The 3D view is a **graphical synthesis**, not a full hydrodynamic model:

| Visual | Data source |
|--------|-------------|
| Surface height / gauge float | CO-OPS water level (MLLW) |
| Wave amplitude | NDBC significant wave height |
| Flow particle direction/speed | CO-OPS currents when available; else light wind proxy |
| Water color | Water temperature (°F) |

## Deploy

Static GitHub Pages:

1. Push this repo (include `data/`)
2. Enable Pages from `main` / root
3. Hard-refresh after deploy

No Cloudflare Worker required for 3D (runs fully in-browser).

## Stack

- Leaflet map · Chart.js · Three.js r128
- NOAA CO-OPS MDAPI / Data API · NDBC · NWS Alerts · RainViewer

## Repo name suggestion

`tides-currents-enhanced`
