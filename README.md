# TIDES & CURRENTS XPLR

Professional NOAA tides, currents, buoys, and hydrology dashboard.

## Layout

Three-column mission layout:

| Column | Content |
|--------|---------|
| **Left** | Filters, legend, basemap, NWS alerts, nowCOAST layers |
| **Center** | Interactive map + zoom/tools |
| **Right** | Realtime stations, quick states, USGS/NWS gauges |
| **Bottom** | Watch strip — multi-station realtime cards |

Drag the vertical gutters to resize side panels. Double-click section headers to collapse.

## Data flow

1. **Filters / state** (left) → filters map markers  
2. **Map click** → station modal → optional **WATCH**  
3. **Watch bar** polls every 2 minutes (SOL chime on change)  
4. **Right realtime** shows mid-Atlantic / PORTS highlights  
5. **Hydrology** toggles NWS + USGS gauge layers on the map  

## Host

Static files for GitHub Pages: `index.html`, `app.js`, `styles.css`.
