/**
 * TIDES & CURRENTS XPLR
 * Elite NOAA tides / currents / coastal intelligence dashboard
 * Soft-refresh every 2 min · Floating metadata windows · Layout save/load
 */

(() => {
  "use strict";

  // ========== CONSTANTS & STATE ==========
  const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi";
  const DATAAPI = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const REFRESH_MS = 120000; // 2 minutes
  const COASTAL_STATES = [
    "AL","AK","CA","CT","DE","FL","GA","HI","LA","MA","MD","ME","MS","NC","NH","NJ","NY","OR","PA","RI","SC","TX","VA","WA","AS","GU","MP","PR","VI"
  ];
  const STATE_NAMES = {
    AL:"Alabama",AK:"Alaska",CA:"California",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",
    HI:"Hawaii",LA:"Louisiana",MA:"Massachusetts",MD:"Maryland",ME:"Maine",MS:"Mississippi",NC:"North Carolina",
    NH:"New Hampshire",NJ:"New Jersey",NY:"New York",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",
    SC:"South Carolina",TX:"Texas",VA:"Virginia",WA:"Washington",AS:"American Samoa",GU:"Guam",MP:"N. Mariana",
    PR:"Puerto Rico",VI:"U.S. Virgin Islands"
  };

  let map = null;
  let markersLayer = null;
  let buoyLayer = null;
  let nwsAlertLayer = null;
  let stations = [];
  let buoyStations = [];
  let nwsAlerts = [];
  let watched = []; // { id, station, data, lastFetch }
  let floatWindows = new Map(); // key -> { el, z }
  let floatZ = 1000;
  let chartInstances = new Map();
  let refreshTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = 0;
  let soundEnabled = localStorage.getItem("tcx_sound") !== "0";
  let currentBasemap = "dark";
  let basemapLayers = {};
  let radarState = { playing: false, frames: [], idx: 0, layer: null, timer: null };

  // ========== UTILS ==========
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(msg, ms = 2800) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add("hidden"), ms);
  }

  function fmtNum(n, d = 2) {
    if (n == null || Number.isNaN(+n)) return "—";
    return (+n).toFixed(d);
  }

  function utcNow() {
    const d = new Date();
    return d.toISOString().slice(11, 19);
  }

  function playChime() {
    if (!soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.4);
    } catch (_) {}
  }

  // ========== LAYOUT SAVE / LOAD ==========
  function collectLayout() {
    const root = document.documentElement;
    const collapsed = {};
    $$(".panel").forEach((p, i) => {
      const t = p.querySelector("h2")?.textContent?.trim() || `p${i}`;
      collapsed[t] = p.classList.contains("collapsed");
    });
    const nc = {};
    $$("input[data-nc]").forEach(cb => { nc[cb.dataset.nc] = cb.checked; });
    const usgs = {};
    $$("input[data-usgs]").forEach(cb => { usgs[cb.dataset.usgs] = cb.checked; });
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      leftW: parseInt(getComputedStyle(root).getPropertyValue("--left-w")) || 280,
      rightW: parseInt(getComputedStyle(root).getPropertyValue("--right-w")) || 320,
      collapsed,
      layers: { nc, usgs },
      basemap: currentBasemap,
      filters: {
        state: $("#stateFilter").value,
        type: $("#typeFilter").value,
        product: $("#productFilter").value,
        showWaterLevels: $("#showWaterLevels").checked,
        showCurrents: $("#showCurrents").checked,
        showPorts: $("#showPorts").checked,
        showWarnings: $("#showWarnings").checked,
        showBuoys: $("#showBuoys").checked,
      },
      map: map ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() } : null,
      watches: watched.map(w => w.id),
    };
  }

  function applyLayout(state) {
    if (!state || typeof state !== "object") return;
    const root = document.documentElement;
    if (state.leftW) root.style.setProperty("--left-w", state.leftW + "px");
    if (state.rightW) root.style.setProperty("--right-w", state.rightW + "px");
    if (state.collapsed) {
      $$(".panel").forEach(p => {
        const t = p.querySelector("h2")?.textContent?.trim();
        if (t && state.collapsed[t]) p.classList.add("collapsed");
        else p.classList.remove("collapsed");
      });
    }
    if (state.layers?.nc) {
      Object.entries(state.layers.nc).forEach(([k, on]) => {
        const cb = $(`input[data-nc="${k}"]`);
        if (cb) { cb.checked = !!on; cb.dispatchEvent(new Event("change")); }
      });
    }
    if (state.layers?.usgs) {
      Object.entries(state.layers.usgs).forEach(([k, on]) => {
        const cb = $(`input[data-usgs="${k}"]`);
        if (cb) { cb.checked = !!on; cb.dispatchEvent(new Event("change")); }
      });
    }
    if (state.basemap) setBasemap(state.basemap);
    if (state.filters) {
      const f = state.filters;
      if (f.state != null) $("#stateFilter").value = f.state;
      if (f.type != null) $("#typeFilter").value = f.type;
      if (f.product != null) $("#productFilter").value = f.product;
      if (f.showWaterLevels != null) $("#showWaterLevels").checked = f.showWaterLevels;
      if (f.showCurrents != null) $("#showCurrents").checked = f.showCurrents;
      if (f.showPorts != null) $("#showPorts").checked = f.showPorts;
      if (f.showWarnings != null) $("#showWarnings").checked = f.showWarnings;
      if (f.showBuoys != null) $("#showBuoys").checked = f.showBuoys;
      applyFilters();
    }
    if (state.map && map) {
      map.setView([state.map.lat, state.map.lng], state.map.zoom);
    }
    if (Array.isArray(state.watches)) {
      watched = [];
      state.watches.forEach(id => {
        const s = stations.find(x => x.id === id) || buoyStations.find(x => x.id === id);
        if (s) addWatch(s, true);
      });
      renderWatches();
    }
    if (map) map.invalidateSize();
    saveLayoutLocal();
  }

  function saveLayoutLocal() {
    try { localStorage.setItem("tcx_layout_v2", JSON.stringify(collectLayout())); } catch (_) {}
  }

  function loadLayoutLocal() {
    try {
      const raw = localStorage.getItem("tcx_layout_v2");
      if (raw) applyLayout(JSON.parse(raw));
    } catch (_) {}
  }

  function exportLayout() {
    const blob = new Blob([JSON.stringify(collectLayout(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tcx-layout-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Layout exported");
  }

  async function importLayoutFile(file) {
    try {
      const text = await file.text();
      applyLayout(JSON.parse(text));
      toast("Layout imported");
    } catch (e) {
      toast("Invalid layout file");
    }
  }

  async function loadLayoutFromUrl(url) {
    try {
      toast("Loading layout…");
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      applyLayout(await r.json());
      toast("Layout loaded from URL");
    } catch (e) {
      toast("Failed to load layout URL");
    }
  }

  // ========== FLOATING WINDOWS ==========
  function bringToFront(win) {
    floatZ += 1;
    win.style.zIndex = floatZ;
  }

  function closeFloat(key) {
    const entry = floatWindows.get(key);
    if (!entry) return;
    const chart = chartInstances.get(key);
    if (chart) { chart.destroy(); chartInstances.delete(key); }
    entry.el.remove();
    floatWindows.delete(key);
  }

  function openFloat(key, title, sub, bodyHtml, opts = {}) {
    if (floatWindows.has(key)) {
      bringToFront(floatWindows.get(key).el);
      return floatWindows.get(key).el;
    }
    const layer = $("#floatLayer");
    const win = document.createElement("div");
    win.className = "float-win";
    win.dataset.key = key;
    const w = opts.width || 440;
    const h = opts.height || null;
    // cascade position
    const offset = (floatWindows.size % 8) * 28;
    win.style.left = Math.min(80 + offset, window.innerWidth - w - 20) + "px";
    win.style.top = Math.min(70 + offset, window.innerHeight - 200) + "px";
    win.style.width = w + "px";
    if (h) win.style.height = h + "px";

    win.innerHTML = `
      <div class="float-head">
        <div style="min-width:0">
          <div class="float-title">${title}</div>
          ${sub ? `<div class="float-sub">${sub}</div>` : ""}
        </div>
        <div class="float-actions">
          <button type="button" class="icon-btn float-watch" title="Add to watch">★</button>
          <button type="button" class="icon-btn float-close" title="Close">×</button>
        </div>
      </div>
      <div class="float-body">${bodyHtml}</div>
    `;
    layer.appendChild(win);
    floatWindows.set(key, { el: win });
    bringToFront(win);

    // drag
    const head = win.querySelector(".float-head");
    let drag = null;
    head.addEventListener("mousedown", e => {
      if (e.target.closest("button")) return;
      bringToFront(win);
      drag = { x: e.clientX - win.offsetLeft, y: e.clientY - win.offsetTop };
      win.classList.add("dragging");
    });
    window.addEventListener("mousemove", e => {
      if (!drag) return;
      win.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.x)) + "px";
      win.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.y)) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (drag) { drag = null; win.classList.remove("dragging"); }
    });

    win.querySelector(".float-close").onclick = () => closeFloat(key);
    win.querySelector(".float-watch").onclick = () => {
      const st = stations.find(s => s.id === key) || buoyStations.find(s => s.id === key);
      if (st) { addWatch(st); toast(`Watching ${st.name || st.id}`); }
    };

    // tabs
    win.querySelectorAll(".float-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        win.querySelectorAll(".float-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const pane = tab.dataset.pane;
        win.querySelectorAll("[data-pane-content]").forEach(p => {
          p.style.display = p.dataset.paneContent === pane ? "" : "none";
        });
      });
    });

    return win;
  }

  // ========== MAP ==========
  function initMap() {
    map = L.map("map", {
      center: [38.5, -77.0],
      zoom: 6,
      zoomControl: false,
      attributionControl: false,
    });

    basemapLayers = {
      dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, subdomains: "abcd",
      }),
      imagery: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
      }),
      topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17 }),
      streets: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, subdomains: "abcd",
      }),
      ocean: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 13,
      }),
    };
    basemapLayers.dark.addTo(map);

    markersLayer = L.markerClusterGroup({
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 12,
    });
    map.addLayer(markersLayer);

    buoyLayer = L.layerGroup().addTo(map);
    nwsAlertLayer = L.layerGroup().addTo(map);

    $("#zoomInBtn").onclick = () => map.zoomIn();
    $("#zoomOutBtn").onclick = () => map.zoomOut();
    $("#locateBtn").onclick = () => {
      map.locate({ setView: true, maxZoom: 11 });
    };
    $("#fitBtn").onclick = () => {
      if (stations.length) {
        const b = L.latLngBounds(stations.map(s => [s.lat, s.lng]));
        map.fitBounds(b.pad(0.08));
      }
    };
  }

  function setBasemap(name) {
    Object.values(basemapLayers).forEach(l => map.removeLayer(l));
    if (basemapLayers[name]) {
      basemapLayers[name].addTo(map);
      currentBasemap = name;
    }
    $$("#basemapChips .chip").forEach(c => c.classList.toggle("active", c.dataset.bm === name));
    saveLayoutLocal();
  }

  function markerIcon(type, fresh) {
    const cls = `tcx-marker ${type || "wl"}${fresh ? " fresh" : ""}`;
    return L.divIcon({
      className: "",
      html: `<div class="${cls}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function stationType(s) {
    if (s.type === "buoy") return "buoy";
    if (s.ports || (s.products || []).some(p => /current/i.test(p))) return "curr";
    if ((s.products || []).some(p => /air_temperature|wind|humidity|visibility|air_pressure/i.test(p)) &&
        !(s.products || []).some(p => /water_level|predictions/i.test(p))) return "met";
    return "wl";
  }

  function renderMarkers() {
    markersLayer.clearLayers();
    const filtered = getFilteredStations();
    filtered.forEach(s => {
      if (!s.lat || !s.lng) return;
      const type = stationType(s);
      const m = L.marker([s.lat, s.lng], { icon: markerIcon(type, s._fresh) });
      m.bindTooltip(`<strong>${s.name || s.id}</strong><br/><span class="mono">${s.id}</span>`, {
        direction: "top", offset: [0, -8],
      });
      m.on("click", () => openStationWindow(s));
      markersLayer.addLayer(m);
      s._marker = m;
    });
    $("#stationCount").textContent = filtered.length.toLocaleString();
    $("#stationBadge").textContent = filtered.length;
  }

  function renderBuoys() {
    buoyLayer.clearLayers();
    if (!$("#showBuoys").checked) {
      $("#buoyCount").textContent = "0";
      return;
    }
    buoyStations.forEach(b => {
      if (!b.lat || !b.lng) return;
      const m = L.marker([b.lat, b.lng], { icon: markerIcon("buoy", b._fresh) });
      m.bindTooltip(`<strong>${b.name || b.id}</strong><br/>NDBC buoy`, { direction: "top", offset: [0, -8] });
      m.on("click", () => openBuoyWindow(b));
      buoyLayer.addLayer(m);
    });
    $("#buoyCount").textContent = buoyStations.length.toLocaleString();
  }

  // ========== DATA LOADING ==========
  async function loadStations() {
    try {
      const [wl, cu] = await Promise.all([
        fetch(`${MDAPI}/stations.json?type=waterlevels&status=active`).then(r => r.json()),
        fetch(`${MDAPI}/stations.json?type=currents&status=active`).then(r => r.json()),
      ]);
      const mapById = new Map();
      const ingest = (list, typeHint) => {
        (list?.stations || list || []).forEach(s => {
          const id = String(s.id || s.stationId || "");
          if (!id) return;
          const existing = mapById.get(id) || {
            id,
            name: s.name || id,
            lat: +s.lat,
            lng: +(s.lng || s.lon),
            state: s.state || "",
            products: [],
            ports: !!s.ports,
            type: typeHint,
          };
          existing.name = s.name || existing.name;
          existing.lat = +s.lat || existing.lat;
          existing.lng = +(s.lng || s.lon) || existing.lng;
          existing.state = s.state || existing.state;
          if (s.products) {
            const prods = Array.isArray(s.products) ? s.products : (s.products.products || []);
            prods.forEach(p => {
              const name = typeof p === "string" ? p : (p.name || p.product || "");
              if (name && !existing.products.includes(name)) existing.products.push(name);
            });
          }
          if (typeHint === "currents") existing.ports = true;
          mapById.set(id, existing);
        });
      };
      ingest(wl, "waterlevels");
      ingest(cu, "currents");
      stations = [...mapById.values()].filter(s => s.lat && s.lng);
      populateStateFilter();
      renderMarkers();
      renderStationList();
      toast(`${stations.length} stations loaded`);
    } catch (e) {
      console.error(e);
      toast("Failed to load stations");
      $("#stationList").innerHTML = `<div class="empty-state">Could not load stations. Check network.</div>`;
    }
  }

  async function loadBuoys() {
    // NDBC latest_obs — try direct then CORS proxies
    const urls = [
      "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt",
      "https://corsproxy.io/?https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt",
    ];
    let text = null;
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (r.ok) { text = await r.text(); break; }
      } catch (_) {}
    }
    if (!text) {
      $("#buoyCount").textContent = "—";
      return;
    }
    const lines = text.trim().split("\n").slice(2);
    const list = [];
    for (const line of lines) {
      const p = line.trim().split(/\s+/);
      if (p.length < 6) continue;
      const id = p[0];
      const lat = parseFloat(p[1]);
      const lon = parseFloat(p[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // rough US / coastal filter
      if (lat < 15 || lat > 72 || lon < -180 || lon > -50) continue;
      list.push({
        id, lat, lng: lon, type: "buoy", name: `NDBC ${id}`,
        wind: p[6] !== "MM" ? p[6] : null,
        gst: p[7] !== "MM" ? p[7] : null,
        wvht: p[8] !== "MM" ? p[8] : null,
        dpd: p[9] !== "MM" ? p[9] : null,
        atmp: p[13] !== "MM" ? p[13] : null,
        wtmp: p[14] !== "MM" ? p[14] : null,
        _raw: p,
        _fresh: true,
      });
    }
    buoyStations = list;
    renderBuoys();
  }

  async function loadNwsAlerts() {
    try {
      const r = await fetch("https://api.weather.gov/alerts/active?event=Coastal%20Flood%20Warning,Coastal%20Flood%20Watch,Coastal%20Flood%20Advisory,Flood%20Warning,Flood%20Watch");
      const j = await r.json();
      nwsAlerts = (j.features || []).map(f => ({
        id: f.id,
        event: f.properties?.event || "Alert",
        headline: f.properties?.headline || "",
        severity: f.properties?.severity || "",
        area: f.properties?.areaDesc || "",
        onset: f.properties?.onset,
        ends: f.properties?.ends,
        desc: f.properties?.description || "",
        url: f.properties?.@id || f.id,
        geometry: f.geometry,
      }));
      renderAlerts();
      if ($("#showWarnings").checked) drawAlertZones();
    } catch (e) {
      $("#warningsCount").textContent = "Alerts unavailable";
    }
  }

  function drawAlertZones() {
    nwsAlertLayer.clearLayers();
    if (!$("#showWarnings").checked) return;
    nwsAlerts.forEach(a => {
      if (!a.geometry) return;
      try {
        const layer = L.geoJSON(a.geometry, {
          style: { color: "#f87171", weight: 1, fillOpacity: 0.12, fillColor: "#f87171" },
        });
        layer.bindTooltip(a.event + (a.area ? ` — ${a.area}` : ""));
        layer.on("click", () => openAlertWindow(a));
        nwsAlertLayer.addLayer(layer);
      } catch (_) {}
    });
  }

  // ========== FILTERS & LISTS ==========
  function populateStateFilter() {
    const sel = $("#stateFilter");
    const states = [...new Set(stations.map(s => s.state).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All states</option>` +
      states.map(st => `<option value="${st}">${STATE_NAMES[st] || st}</option>`).join("");
    const qs = $("#quickStates");
    qs.innerHTML = ["FL","CA","NY","TX","WA","LA","VA","ME"].filter(s => states.includes(s))
      .map(s => `<button type="button" class="qs-btn" data-st="${s}">${s}</button>`).join("");
    qs.querySelectorAll(".qs-btn").forEach(btn => {
      btn.onclick = () => {
        $("#stateFilter").value = btn.dataset.st;
        applyFilters();
        qs.querySelectorAll(".qs-btn").forEach(b => b.classList.toggle("active", b === btn));
      };
    });
  }

  function getFilteredStations() {
    const st = $("#stateFilter").value;
    const ty = $("#typeFilter").value;
    const showWl = $("#showWaterLevels").checked;
    const showCu = $("#showCurrents").checked;
    const portsOnly = $("#showPorts").checked;
    const q = ($("#searchInput").value || "").trim().toLowerCase();

    return stations.filter(s => {
      if (st && s.state !== st) return false;
      if (portsOnly && !s.ports) return false;
      if (ty === "waterlevels" && stationType(s) !== "wl") return false;
      if (ty === "currents" && stationType(s) !== "curr") return false;
      if (ty === "met" && stationType(s) !== "met") return false;
      if (ty === "ports" && !s.ports) return false;
      if (!showWl && stationType(s) === "wl") return false;
      if (!showCu && stationType(s) === "curr") return false;
      if (q) {
        const hay = `${s.name} ${s.id} ${s.state}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function applyFilters() {
    renderMarkers();
    renderStationList();
    renderBuoys();
    saveLayoutLocal();
  }

  function renderStationList() {
    const list = getFilteredStations().slice(0, 200);
    const el = $("#stationList");
    if (!list.length) {
      el.innerHTML = `<div class="empty-state">No stations match filters</div>`;
      return;
    }
    el.innerHTML = list.map(s => `
      <div class="station-item" data-id="${s.id}">
        <div class="name">${s.name || s.id}</div>
        <div class="meta">${s.id} · ${s.state || "—"} · ${stationType(s)}</div>
      </div>
    `).join("");
    el.querySelectorAll(".station-item").forEach(item => {
      item.onclick = () => {
        const s = stations.find(x => x.id === item.dataset.id);
        if (s) {
          openStationWindow(s);
          map.setView([s.lat, s.lng], Math.max(map.getZoom(), 10));
        }
      };
    });
  }

  function renderAlerts() {
    $("#warningsCount").textContent = `${nwsAlerts.length} active coastal / flood alerts`;
    const el = $("#warningsList");
    if (!nwsAlerts.length) {
      el.innerHTML = `<div class="muted">No active coastal flood alerts</div>`;
      return;
    }
    el.innerHTML = nwsAlerts.slice(0, 40).map(a => {
      const sev = (a.severity || "").toLowerCase();
      const cls = sev.includes("extreme") || sev.includes("severe") ? "sev-warning" :
        sev.includes("moderate") ? "sev-watch" : "sev-advisory";
      return `<div class="alert-item ${cls}" data-id="${a.id}">
        <div class="al-title">${a.event}</div>
        <div class="al-meta">${a.area || ""} · ${a.severity || ""}</div>
      </div>`;
    }).join("");
    el.querySelectorAll(".alert-item").forEach(item => {
      item.onclick = () => {
        const a = nwsAlerts.find(x => x.id === item.dataset.id);
        if (a) openAlertWindow(a);
      };
    });
  }

  // ========== WATCH STRIP ==========
  function addWatch(station, silent) {
    if (watched.some(w => w.id === station.id)) return;
    watched.push({ id: station.id, station, data: null, lastFetch: 0 });
    if (!silent) renderWatches();
    refreshWatch(watched[watched.length - 1]);
    saveLayoutLocal();
  }

  function removeWatch(id) {
    watched = watched.filter(w => w.id !== id);
    renderWatches();
    saveLayoutLocal();
  }

  async function refreshWatch(w) {
    try {
      const url = `${DATAAPI}?date=latest&station=${w.id}&product=water_level&datum=MLLW&units=english&time_zone=gmt&format=json`;
      const r = await fetch(url);
      const j = await r.json();
      const d = j?.data?.[0];
      if (d) {
        w.data = d;
        w.lastFetch = Date.now();
        w.station._fresh = true;
      }
    } catch (_) {}
    renderWatches();
  }

  async function refreshAllWatches() {
    await Promise.all(watched.map(w => refreshWatch(w)));
  }

  function renderWatches() {
    const el = $("#watchList");
    if (!watched.length) {
      el.innerHTML = `<div class="empty-state muted">Click a station → Add to watch</div>`;
      return;
    }
    el.innerHTML = watched.map(w => {
      const v = w.data?.v != null ? `${fmtNum(w.data.v, 2)} ft` : "—";
      const t = w.data?.t || "";
      return `<div class="watch-card" data-id="${w.id}">
        <div class="wc-head">
          <span class="wc-name">${w.station.name || w.id}</span>
          <span class="wc-id">${w.id}</span>
        </div>
        <div class="wc-val">${v}</div>
        <div class="wc-src">${t ? t + " UTC · " : ""}CO-OPS · click for details</div>
      </div>`;
    }).join("");
    el.querySelectorAll(".watch-card").forEach(card => {
      card.onclick = () => {
        const w = watched.find(x => x.id === card.dataset.id);
        if (w) openStationWindow(w.station);
      };
    });
  }

  // ========== FLOATING STATION / BUOY / ALERT WINDOWS ==========
  async function openStationWindow(s) {
    const key = s.id;
    const products = (s.products || []).join(", ") || "—";
    const body = `
      <div class="float-tabs">
        <button type="button" class="float-tab active" data-pane="overview">Overview</button>
        <button type="button" class="float-tab" data-pane="levels">Water level</button>
        <button type="button" class="float-tab" data-pane="pred">Predictions</button>
        <button type="button" class="float-tab" data-pane="meta">Metadata</button>
      </div>
      <div data-pane-content="overview">
        <div class="meta-grid">
          <div class="meta-card"><div class="ml">Station ID</div><div class="mv mono">${s.id}</div></div>
          <div class="meta-card"><div class="ml">State</div><div class="mv">${s.state || "—"}</div></div>
          <div class="meta-card"><div class="ml">Latitude</div><div class="mv mono">${fmtNum(s.lat, 5)}</div></div>
          <div class="meta-card"><div class="ml">Longitude</div><div class="mv mono">${fmtNum(s.lng, 5)}</div></div>
          <div class="meta-card"><div class="ml">Type</div><div class="mv">${stationType(s)}</div></div>
          <div class="meta-card"><div class="ml">PORTS®</div><div class="mv">${s.ports ? "Yes" : "No"}</div></div>
        </div>
        <div class="btn-row">
          <button type="button" class="action-btn primary" data-act="watch">★ Add to watch</button>
          <button type="button" class="action-btn" data-act="center">Center map</button>
          <a class="action-btn" href="https://tidesandcurrents.noaa.gov/stationhome.html?id=${s.id}" target="_blank" rel="noopener">NOAA station ↗</a>
        </div>
        <div id="liveVals_${s.id}" class="meta-grid"><div class="meta-card skeleton" style="height:48px;grid-column:1/-1"></div></div>
      </div>
      <div data-pane-content="levels" style="display:none">
        <div class="chart-box"><canvas id="chart_wl_${s.id}"></canvas></div>
        <div class="muted">Last 48 h water level (MLLW, English units)</div>
      </div>
      <div data-pane-content="pred" style="display:none">
        <div class="chart-box"><canvas id="chart_pred_${s.id}"></canvas></div>
        <div class="muted">Tide predictions (next 48 h)</div>
      </div>
      <div data-pane-content="meta" style="display:none">
        <div class="meta-card" style="margin-bottom:10px">
          <div class="ml">Available products</div>
          <div class="mv" style="font-size:12px;font-weight:400;margin-top:6px">${products}</div>
        </div>
        <div class="source-bar">
          Metadata source: <a href="${MDAPI}/stations/${s.id}.json" target="_blank" rel="noopener">CO-OPS MDAPI</a><br/>
          Observations: <a href="${DATAAPI}?date=latest&station=${s.id}&product=water_level&datum=MLLW&units=english&time_zone=gmt&format=json" target="_blank" rel="noopener">Data API</a>
        </div>
      </div>
      <div class="source-bar">
        Source: NOAA CO-OPS · <a href="https://tidesandcurrents.noaa.gov/" target="_blank" rel="noopener">tidesandcurrents.noaa.gov</a>
      </div>
    `;
    const win = openFloat(key, s.name || s.id, `Station ${s.id} · ${s.state || ""}`, body);
    win.querySelector('[data-act="watch"]').onclick = () => { addWatch(s); toast("Added to watch"); };
    win.querySelector('[data-act="center"]').onclick = () => map.setView([s.lat, s.lng], 12);

    // live values
    loadStationLive(s, win);
    loadStationChart(s, "water_level", `chart_wl_${s.id}`, key + "_wl");
    loadStationChart(s, "predictions", `chart_pred_${s.id}`, key + "_pred");
  }

  async function loadStationLive(s, win) {
    const box = win.querySelector(`#liveVals_${s.id}`);
    if (!box) return;
    try {
      const products = ["water_level", "air_temperature", "water_temperature", "wind", "air_pressure"];
      const results = await Promise.all(products.map(async p => {
        try {
          const r = await fetch(`${DATAAPI}?date=latest&station=${s.id}&product=${p}&datum=MLLW&units=english&time_zone=gmt&format=json`);
          const j = await r.json();
          return { product: p, data: j?.data?.[0] || null };
        } catch { return { product: p, data: null }; }
      }));
      const cards = results.filter(r => r.data).map(r => {
        let label = r.product.replace(/_/g, " ");
        let val = r.data.v ?? r.data.s ?? "—";
        let unit = "";
        if (r.product === "water_level") unit = " ft MLLW";
        if (r.product.includes("temp")) unit = " °F";
        if (r.product === "wind") { val = r.data.s; unit = " kn"; }
        if (r.product === "air_pressure") unit = " mb";
        return `<div class="meta-card"><div class="ml">${label}</div><div class="mv accent">${val}${unit}</div></div>`;
      });
      box.innerHTML = cards.length ? cards.join("") : `<div class="muted">No recent observations</div>`;
    } catch {
      box.innerHTML = `<div class="muted">Live data unavailable</div>`;
    }
  }

  async function loadStationChart(s, product, canvasId, chartKey) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    try {
      const range = product === "predictions" ? "recent" : "recent";
      const hours = 48;
      const end = new Date();
      const begin = new Date(end.getTime() - hours * 3600 * 1000);
      const fmt = d => d.toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 12);
      let url;
      if (product === "predictions") {
        url = `${DATAAPI}?begin_date=${fmt(begin)}&end_date=${fmt(new Date(end.getTime() + hours * 3600 * 1000))}&station=${s.id}&product=predictions&datum=MLLW&units=english&time_zone=gmt&interval=hilo&format=json`;
        // fallback hourly
        const r = await fetch(url);
        let j = await r.json();
        if (!j?.predictions?.length) {
          url = `${DATAAPI}?begin_date=${fmt(begin)}&end_date=${fmt(new Date(end.getTime() + hours * 3600 * 1000))}&station=${s.id}&product=predictions&datum=MLLW&units=english&time_zone=gmt&interval=h&format=json`;
          j = await (await fetch(url)).json();
        }
        const pts = (j.predictions || []).map(p => ({ t: p.t, v: +p.v }));
        drawChart(canvas, chartKey, pts, "Predicted level (ft)");
      } else {
        url = `${DATAAPI}?begin_date=${fmt(begin)}&end_date=${fmt(end)}&station=${s.id}&product=water_level&datum=MLLW&units=english&time_zone=gmt&format=json`;
        const j = await (await fetch(url)).json();
        const pts = (j.data || []).map(p => ({ t: p.t, v: +p.v }));
        drawChart(canvas, chartKey, pts, "Water level (ft MLLW)");
      }
    } catch (e) {
      console.warn("chart", e);
    }
  }

  function drawChart(canvas, key, points, label) {
    if (chartInstances.has(key)) {
      chartInstances.get(key).destroy();
      chartInstances.delete(key);
    }
    if (!points.length) return;
    const labels = points.map(p => p.t?.slice(11, 16) || "");
    const data = points.map(p => p.v);
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label,
          data,
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34,211,238,0.12)",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: "#5c6b82", maxTicksLimit: 8, font: { size: 10 } },
            grid: { color: "rgba(255,255,255,0.04)" },
          },
          y: {
            ticks: { color: "#5c6b82", font: { size: 10 } },
            grid: { color: "rgba(255,255,255,0.06)" },
          },
        },
      },
    });
    chartInstances.set(key, chart);
  }

  function openBuoyWindow(b) {
    const key = b.id;
    const body = `
      <div class="meta-grid">
        <div class="meta-card"><div class="ml">Buoy ID</div><div class="mv mono">${b.id}</div></div>
        <div class="meta-card"><div class="ml">Type</div><div class="mv">NDBC</div></div>
        <div class="meta-card"><div class="ml">Lat / Lon</div><div class="mv mono">${fmtNum(b.lat,4)}, ${fmtNum(b.lng,4)}</div></div>
        <div class="meta-card"><div class="ml">Wind</div><div class="mv accent">${b.wind ?? "—"} kn</div></div>
        <div class="meta-card"><div class="ml">Gust</div><div class="mv">${b.gst ?? "—"} kn</div></div>
        <div class="meta-card"><div class="ml">Wave height</div><div class="mv accent">${b.wvht ?? "—"} m</div></div>
        <div class="meta-card"><div class="ml">Air temp</div><div class="mv">${b.atmp ?? "—"} °C</div></div>
        <div class="meta-card"><div class="ml">Water temp</div><div class="mv">${b.wtmp ?? "—"} °C</div></div>
      </div>
      <div class="btn-row">
        <a class="action-btn primary" href="https://www.ndbc.noaa.gov/station_page.php?station=${b.id}" target="_blank" rel="noopener">NDBC station ↗</a>
        <button type="button" class="action-btn" data-act="center">Center map</button>
      </div>
      <div class="source-bar">
        Source: <a href="https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt" target="_blank" rel="noopener">NDBC latest_obs</a>
      </div>
    `;
    const win = openFloat(key, b.name || b.id, "NDBC buoy", body);
    win.querySelector('[data-act="center"]').onclick = () => map.setView([b.lat, b.lng], 10);
  }

  function openAlertWindow(a) {
    const key = "alert_" + a.id;
    const body = `
      <div class="meta-grid">
        <div class="meta-card" style="grid-column:1/-1"><div class="ml">Event</div><div class="mv">${a.event}</div></div>
        <div class="meta-card"><div class="ml">Severity</div><div class="mv">${a.severity || "—"}</div></div>
        <div class="meta-card"><div class="ml">Area</div><div class="mv" style="font-size:12px">${a.area || "—"}</div></div>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:10px 0;white-space:pre-wrap;max-height:180px;overflow:auto">${(a.headline || a.desc || "").slice(0, 800)}</p>
      <div class="source-bar">
        Source: <a href="https://api.weather.gov/" target="_blank" rel="noopener">NWS Alerts API</a>
        ${a.url ? ` · <a href="${a.url}" target="_blank" rel="noopener">Full alert</a>` : ""}
      </div>
    `;
    openFloat(key, a.event, a.severity || "Alert", body, { width: 420 });
  }

  // ========== nowCOAST / RADAR (simplified reliable) ==========
  function initNowCoast() {
    $$("input[data-nc]").forEach(cb => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.nc;
        if (id === "radar") {
          $("#radarControls").classList.toggle("hidden", !cb.checked);
          if (cb.checked) startRadar();
          else stopRadar();
        }
        saveLayoutLocal();
      });
    });
    $("#radarPlayBtn").onclick = () => {
      radarState.playing = !radarState.playing;
      $("#radarPlayBtn").textContent = radarState.playing ? "⏸" : "▶";
      if (radarState.playing) tickRadar();
      else clearTimeout(radarState.timer);
    };
    $("#radarPrevBtn").onclick = () => { radarState.idx = Math.max(0, radarState.idx - 1); showRadarFrame(); };
    $("#radarNextBtn").onclick = () => { radarState.idx = Math.min(radarState.frames.length - 1, radarState.idx + 1); showRadarFrame(); };
    $("#radarOpacity").oninput = () => {
      if (radarState.layer) radarState.layer.setOpacity((+$("#radarOpacity").value) / 100);
    };
    $("#radarRefreshBtn").onclick = () => startRadar();
  }

  async function startRadar() {
    stopRadar();
    // RainViewer public API (CORS friendly)
    try {
      const r = await fetch("https://api.rainviewer.com/public/weather-maps.json");
      const j = await r.json();
      const frames = (j.radar?.past || []).concat(j.radar?.nowcast || []).slice(-12);
      radarState.frames = frames.map(f => ({
        time: f.time,
        url: `https://tilecache.rainviewer.com${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
      }));
      radarState.idx = radarState.frames.length - 1;
      showRadarFrame();
      radarState.playing = true;
      $("#radarPlayBtn").textContent = "⏸";
      tickRadar();
    } catch (e) {
      toast("Radar frames unavailable");
    }
  }

  function showRadarFrame() {
    const f = radarState.frames[radarState.idx];
    if (!f) return;
    if (radarState.layer) map.removeLayer(radarState.layer);
    radarState.layer = L.tileLayer(f.url, {
      opacity: (+$("#radarOpacity").value) / 100,
      zIndex: 300,
    }).addTo(map);
    const d = new Date(f.time * 1000);
    $("#radarFrameLabel").textContent = `Frame ${radarState.idx + 1}/${radarState.frames.length}`;
    $("#radarTimeLabel").textContent = d.toISOString().slice(11, 16) + " UTC";
  }

  function tickRadar() {
    if (!radarState.playing || !radarState.frames.length) return;
    radarState.idx = (radarState.idx + 1) % radarState.frames.length;
    showRadarFrame();
    radarState.timer = setTimeout(tickRadar, 700);
  }

  function stopRadar() {
    radarState.playing = false;
    clearTimeout(radarState.timer);
    if (radarState.layer) { map.removeLayer(radarState.layer); radarState.layer = null; }
    $("#radarPlayBtn").textContent = "▶";
  }

  // ========== SOFT REFRESH ==========
  function startRefreshCycle() {
    nextRefreshAt = Date.now() + REFRESH_MS;
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = setInterval(softRefresh, REFRESH_MS);
    countdownTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
  }

  function updateCountdown() {
    const left = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(1, "0");
    const s = String(left % 60).padStart(2, "0");
    $("#nextRefresh").textContent = `${m}:${s}`;
  }

  async function softRefresh() {
    nextRefreshAt = Date.now() + REFRESH_MS;
    playChime();
    await Promise.all([
      refreshAllWatches(),
      loadNwsAlerts(),
      loadBuoys(),
    ]);
    // re-mark fresh
    stations.forEach(s => { s._fresh = false; });
    toast("Data refreshed", 1600);
  }

  // ========== SPLITTERS & COLLAPSE ==========
  function initSplitters() {
    const root = document.documentElement;
    $$(".splitter").forEach(sp => {
      let dragging = false;
      sp.addEventListener("mousedown", e => {
        e.preventDefault();
        dragging = true;
        sp.classList.add("dragging");
        const which = sp.dataset.split;
        const onMove = ev => {
          if (!dragging) return;
          const grid = $("#mainGrid");
          const rect = grid.getBoundingClientRect();
          if (which === "left") {
            const w = Math.min(400, Math.max(180, ev.clientX - rect.left));
            root.style.setProperty("--left-w", w + "px");
          } else {
            const w = Math.min(420, Math.max(200, rect.right - ev.clientX));
            root.style.setProperty("--right-w", w + "px");
          }
          if (map) map.invalidateSize();
        };
        const onUp = () => {
          dragging = false;
          sp.classList.remove("dragging");
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          saveLayoutLocal();
          if (map) map.invalidateSize();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  function initPanels() {
    $$(".panel-head").forEach(head => {
      head.addEventListener("click", e => {
        if (e.target.closest("button, a, input, select")) return;
        head.closest(".panel")?.classList.toggle("collapsed");
        saveLayoutLocal();
      });
    });
  }

  // ========== CLOCK & UI BINDINGS ==========
  function initClock() {
    const tick = () => { $("#utcClock").textContent = utcNow(); };
    tick();
    setInterval(tick, 1000);
  }

  function initUI() {
    $("#softRefreshBtn").onclick = () => softRefresh();
    $("#resetFilters").onclick = () => {
      $("#stateFilter").value = "";
      $("#typeFilter").value = "";
      $("#productFilter").value = "none";
      $("#showWaterLevels").checked = true;
      $("#showCurrents").checked = true;
      $("#showPorts").checked = false;
      $("#showWarnings").checked = false;
      $("#showBuoys").checked = true;
      applyFilters();
    };
    ["stateFilter", "typeFilter", "productFilter"].forEach(id => {
      $(`#${id}`).addEventListener("change", applyFilters);
    });
    ["showWaterLevels", "showCurrents", "showPorts", "showWarnings", "showBuoys"].forEach(id => {
      $(`#${id}`).addEventListener("change", () => {
        if (id === "showWarnings") drawAlertZones();
        applyFilters();
      });
    });
    $("#searchInput").addEventListener("input", () => {
      clearTimeout($("#searchInput")._t);
      $("#searchInput")._t = setTimeout(applyFilters, 200);
    });
    $("#basemapChips").addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (chip) setBasemap(chip.dataset.bm);
    });
    $("#refreshWarningsBtn").onclick = () => loadNwsAlerts();
    $("#clearWatches").onclick = () => { watched = []; renderWatches(); saveLayoutLocal(); };

    // layout modal
    $("#layoutBtn").onclick = () => $("#layoutModal").classList.remove("hidden");
    $("#closeLayoutModal").onclick = () => $("#layoutModal").classList.add("hidden");
    $("#layoutModal").addEventListener("click", e => {
      if (e.target === $("#layoutModal")) $("#layoutModal").classList.add("hidden");
    });
    $("#exportLayoutBtn").onclick = exportLayout;
    $("#importLayoutFile").onchange = e => {
      const f = e.target.files?.[0];
      if (f) importLayoutFile(f);
    };
    $("#resetLayoutBtn").onclick = () => {
      localStorage.removeItem("tcx_layout_v2");
      location.reload();
    };
    $("#loadLayoutUrlBtn").onclick = () => {
      const u = $("#layoutUrlInput").value.trim();
      if (u) loadLayoutFromUrl(u);
    };

    $("#soundToggle").onclick = () => {
      soundEnabled = !soundEnabled;
      localStorage.setItem("tcx_sound", soundEnabled ? "1" : "0");
      $("#soundToggle").classList.toggle("active", soundEnabled);
      $("#soundToggle").textContent = soundEnabled ? "Sound" : "Muted";
      toast(soundEnabled ? "Sound on" : "Sound muted");
    };
    $("#soundToggle").classList.toggle("active", soundEnabled);

    // keyboard
    document.addEventListener("keydown", e => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "/") {
        e.preventDefault();
        $("#searchInput").focus();
      }
      if (e.key === "Escape") {
        const keys = [...floatWindows.keys()];
        if (keys.length) closeFloat(keys[keys.length - 1]);
        else $("#layoutModal").classList.add("hidden");
      }
      if (e.key === "r" || e.key === "R") softRefresh();
    });
  }

  // ========== BOOT ==========
  async function boot() {
    initMap();
    initSplitters();
    initPanels();
    initClock();
    initUI();
    initNowCoast();

    // URL layout param
    const params = new URLSearchParams(location.search);
    const layoutUrl = params.get("layout");
    if (layoutUrl) {
      await loadLayoutFromUrl(layoutUrl);
    } else {
      loadLayoutLocal();
    }

    await loadStations();
    await Promise.all([loadBuoys(), loadNwsAlerts()]);
    startRefreshCycle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
