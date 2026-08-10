# TIDES & CURRENTS XPLR

Mission-control dashboard for NOAA Tides & Currents, PORTS®, NDBC buoys, NWS alerts, nowCOAST layers, and USGS gauges.

## Docking layout (FlexLayout-style)

Built on **Golden Layout** (drag / drop / snap / stack / dock):

- **Drag tab headers** to move panels
- **Drop on edges** to split rows/columns
- **Drop on center** to stack as tabs
- **Pop-out icon** on a tab → native browser window
- **Maximise** a panel for focus view
- Splitters between regions are resizable

### Layout JSON

| Control | Action |
|---------|--------|
| **SAVE LAYOUT** | Persist docking tree to `localStorage` |
| **LOAD LAYOUT** | Restore saved tree (right-click → import file) |
| **EXPORT** | Download layout JSON |
| **RESET LAYOUT** | Default mission-control arrangement |

Programmatic API:

```js
tcxLayout.save()
tcxLayout.export()
tcxLayout.reset()
tcxLayout.toJSON()
tcxLayout.load(configObject)
```

Default tree: left stack (Filters / Legend / Basemap / Alerts / nowCOAST) · Map · right stack (Realtime / States / Hydrology / Sources) · bottom Watch strip.

## Data sources

NOAA CO-OPS MDAPI + Data API · PORTS® · NDBC · NWS alerts · nowCOAST WMS · USGS OGC monitoring locations · NWPS gauges

## Host on GitHub Pages

Push the folder contents (`index.html`, `app.js`, `layout.js`, `styles.css`) to a Pages branch. Open `index.html` as the site root.
