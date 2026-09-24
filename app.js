/**
 * TIDES & CURRENTS XPLR
 * Hardened boot · scrollable rails · Montco three-tone alerts · zip search
 */
(function () {
  "use strict";

  const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi";
  const DATAAPI = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const REFRESH_MS = 120000;

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
  let watched = [];
  let floatWindows = new Map();
  let floatZ = 1000;
  let chartInstances = new Map();
  let refreshTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = 0;
  let soundEnabled = false;
  let currentBasemap = "dark";
  let basemapLayers = {};
  let radarState = { playing: false, frames: [], idx: 0, layer: null, timer: null };
  let zipCenter = null; // {lat,lng} when searching by zip
  let knownAlertIds = new Set();
  let alertsBaseline = false;

  // ---------- DOM helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function toast(msg, ms) {
    ms = ms || 2800;
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add("hidden"); }, ms);
  }

  function fmtNum(n, d) {
    d = d == null ? 2 : d;
    if (n == null || isNaN(+n)) return "—";
    return (+n).toFixed(d);
  }

  function utcNow() {
    return new Date().toISOString().slice(11, 19);
  }

  // ---------- MONTCO THREE-TONE AUDIO ----------
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function scheduleTone(freq, startTime, duration, waveType, peakGain) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waveType;
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  // FIRE-style — urgent alternating two-tone (used for severe/extreme flood alerts)
  function playFireTone() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [880, 660, 880, 660].forEach(function (freq, i) {
      scheduleTone(freq, now + i * 0.15, 0.14, "sawtooth", 0.2);
    });
  }

  // EMS-style — calm rising two-note (used for moderate / watch)
  function playEmsTone() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    scheduleTone(523.25, now, 0.32, "sine", 0.2);
    scheduleTone(784.0, now + 0.28, 0.4, "sine", 0.2);
  }

  // TRAFFIC-style — short double-beep (used for advisory / soft refresh)
  function playTrafficTone() {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    scheduleTone(440, now, 0.1, "triangle", 0.2);
    scheduleTone(440, now + 0.17, 0.1, "triangle", 0.2);
  }

  function playAlertToneForSeverity(sev) {
    if (!soundEnabled) return;
    const s = (sev || "").toLowerCase();
    if (s.indexOf("extreme") >= 0 || s.indexOf("severe") >= 0) playFireTone();
    else if (s.indexOf("moderate") >= 0) playEmsTone();
    else playTrafficTone();
  }

  function playSoftRefreshTone() {
    if (!soundEnabled) return;
    playTrafficTone();
  }

  function updateSoundUI() {
    const btn = $("#soundToggle");
    if (!btn) return;
    btn.classList.toggle("on", soundEnabled);
    btn.classList.toggle("active", soundEnabled);
    btn.textContent = soundEnabled ? "Tones On" : "Tones Off";
  }

  // ---------- LAYOUT ----------
  function collectLayout() {
    const root = document.documentElement;
    const collapsed = {};
    $$(".panel").forEach(function (p, i) {
      const t = (p.querySelector("h2") && p.querySelector("h2").textContent.trim()) || ("p" + i);
      collapsed[t] = p.classList.contains("collapsed");
    });
    const nc = {};
    $$("input[data-nc]").forEach(function (cb) { nc[cb.dataset.nc] = cb.checked; });
    const usgs = {};
    $$("input[data-usgs]").forEach(function (cb) { usgs[cb.dataset.usgs] = cb.checked; });
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      leftW: parseInt(getComputedStyle(root).getPropertyValue("--left-w"), 10) || 280,
      rightW: parseInt(getComputedStyle(root).getPropertyValue("--right-w"), 10) || 320,
      collapsed: collapsed,
      layers: { nc: nc, usgs: usgs },
      basemap: currentBasemap,
      filters: {
        state: ($("#stateFilter") && $("#stateFilter").value) || "",
        type: ($("#typeFilter") && $("#typeFilter").value) || "",
        product: ($("#productFilter") && $("#productFilter").value) || "none",
        showWaterLevels: $("#showWaterLevels") ? $("#showWaterLevels").checked : true,
        showCurrents: $("#showCurrents") ? $("#showCurrents").checked : true,
        showPorts: $("#showPorts") ? $("#showPorts").checked : false,
        showWarnings: $("#showWarnings") ? $("#showWarnings").checked : false,
        showBuoys: $("#showBuoys") ? $("#showBuoys").checked : true
      },
      map: map ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() } : null,
      watches: watched.map(function (w) { return w.id; })
    };
  }

  function applyLayout(state) {
    if (!state || typeof state !== "object") return;
    const root = document.documentElement;
    if (state.leftW) root.style.setProperty("--left-w", state.leftW + "px");
    if (state.rightW) root.style.setProperty("--right-w", state.rightW + "px");
    if (state.collapsed) {
      $$(".panel").forEach(function (p) {
        const t = p.querySelector("h2") && p.querySelector("h2").textContent.trim();
        if (t && state.collapsed[t]) p.classList.add("collapsed");
        else p.classList.remove("collapsed");
      });
    }
    if (state.layers && state.layers.nc) {
      Object.keys(state.layers.nc).forEach(function (k) {
        const cb = $('input[data-nc="' + k + '"]');
        if (cb) {
          cb.checked = !!state.layers.nc[k];
          cb.dispatchEvent(new Event("change"));
        }
      });
    }
    if (state.basemap) setBasemap(state.basemap);
    if (state.filters) {
      const f = state.filters;
      if (f.state != null && $("#stateFilter")) $("#stateFilter").value = f.state;
      if (f.type != null && $("#typeFilter")) $("#typeFilter").value = f.type;
      if (f.product != null && $("#productFilter")) $("#productFilter").value = f.product;
      if (f.showWaterLevels != null && $("#showWaterLevels")) $("#showWaterLevels").checked = f.showWaterLevels;
      if (f.showCurrents != null && $("#showCurrents")) $("#showCurrents").checked = f.showCurrents;
      if (f.showPorts != null && $("#showPorts")) $("#showPorts").checked = f.showPorts;
      if (f.showWarnings != null && $("#showWarnings")) $("#showWarnings").checked = f.showWarnings;
      if (f.showBuoys != null && $("#showBuoys")) $("#showBuoys").checked = f.showBuoys;
      applyFilters();
    }
    if (state.map && map) {
      map.setView([state.map.lat, state.map.lng], state.map.zoom);
    }
    if (Array.isArray(state.watches)) {
      watched = [];
      state.watches.forEach(function (id) {
        const s = stations.find(function (x) { return x.id === id; }) ||
          buoyStations.find(function (x) { return x.id === id; });
        if (s) addWatch(s, true);
      });
      renderWatches();
    }
    if (map) setTimeout(function () { map.invalidateSize(); }, 50);
    saveLayoutLocal();
  }

  function saveLayoutLocal() {
    try { localStorage.setItem("tcx_layout_v2", JSON.stringify(collectLayout())); } catch (e) {}
  }

  function loadLayoutLocal() {
    try {
      const raw = localStorage.getItem("tcx_layout_v2");
      if (raw) applyLayout(JSON.parse(raw));
    } catch (e) {}
  }

  function exportLayout() {
    const blob = new Blob([JSON.stringify(collectLayout(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tcx-layout-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Layout exported");
  }

  function importLayoutFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        applyLayout(JSON.parse(reader.result));
        toast("Layout imported");
      } catch (e) {
        toast("Invalid layout file");
      }
    };
    reader.readAsText(file);
  }

  function loadLayoutFromUrl(url) {
    toast("Loading layout…");
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function (j) {
        applyLayout(j);
        toast("Layout loaded from URL");
      })
      .catch(function () {
        toast("Failed to load layout URL");
      });
  }

  // ---------- FLOATING WINDOWS ----------
  function bringToFront(win) {
    floatZ += 1;
    win.style.zIndex = String(floatZ);
  }

  function closeFloat(key) {
    const entry = floatWindows.get(key);
    if (!entry) return;
    const chart = chartInstances.get(key);
    if (chart) {
      try { chart.destroy(); } catch (e) {}
      chartInstances.delete(key);
    }
    // also clear chart keys with suffix
    ["_wl", "_pred"].forEach(function (suf) {
      const c = chartInstances.get(key + suf);
      if (c) {
        try { c.destroy(); } catch (e) {}
        chartInstances.delete(key + suf);
      }
    });
    entry.el.remove();
    floatWindows.delete(key);
  }

  function openFloat(key, title, sub, bodyHtml, opts) {
    opts = opts || {};
    if (floatWindows.has(key)) {
      bringToFront(floatWindows.get(key).el);
      return floatWindows.get(key).el;
    }
    const layer = $("#floatLayer");
    if (!layer) return null;
    const win = document.createElement("div");
    win.className = "float-win" + (opts.edgeClass ? " " + opts.edgeClass : "");
    win.dataset.key = key;
    const w = opts.width || 440;
    const offset = (floatWindows.size % 8) * 28;
    win.style.left = Math.min(80 + offset, Math.max(8, window.innerWidth - w - 20)) + "px";
    win.style.top = Math.min(70 + offset, Math.max(8, window.innerHeight - 200)) + "px";
    win.style.width = w + "px";

    win.innerHTML =
      '<div class="float-head">' +
        '<div style="min-width:0">' +
          '<div class="float-title"></div>' +
          (sub ? '<div class="float-sub"></div>' : "") +
        "</div>" +
        '<div class="float-actions">' +
          '<button type="button" class="icon-btn float-watch" title="Add to watch">★</button>' +
          '<button type="button" class="icon-btn float-close" title="Close">×</button>' +
        "</div>" +
      "</div>" +
      '<div class="float-body"></div>';

    win.querySelector(".float-title").textContent = title;
    if (sub) win.querySelector(".float-sub").textContent = sub;
    win.querySelector(".float-body").innerHTML = bodyHtml;

    layer.appendChild(win);
    floatWindows.set(key, { el: win });
    bringToFront(win);

    // drag
    const head = win.querySelector(".float-head");
    let drag = null;
    head.addEventListener("mousedown", function (e) {
      if (e.target.closest("button")) return;
      bringToFront(win);
      drag = { x: e.clientX - win.offsetLeft, y: e.clientY - win.offsetTop };
      win.classList.add("dragging");
      e.preventDefault();
    });
    function onMove(e) {
      if (!drag) return;
      win.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.x)) + "px";
      win.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.y)) + "px";
    }
    function onUp() {
      if (drag) {
        drag = null;
        win.classList.remove("dragging");
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    win.querySelector(".float-close").onclick = function () { closeFloat(key); };
    win.querySelector(".float-watch").onclick = function () {
      const st = stations.find(function (s) { return s.id === key; }) ||
        buoyStations.find(function (s) { return s.id === key; });
      if (st) {
        addWatch(st);
        toast("Watching " + (st.name || st.id));
      }
    };

    win.querySelectorAll(".float-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        win.querySelectorAll(".float-tab").forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        const pane = tab.dataset.pane;
        win.querySelectorAll("[data-pane-content]").forEach(function (p) {
          p.style.display = p.dataset.paneContent === pane ? "" : "none";
        });
      });
    });

    return win;
  }

  // ---------- MAP ----------
  function initMap() {
    if (typeof L === "undefined") {
      toast("Map library failed to load — check network / CDN");
      console.error("Leaflet (L) is undefined");
      return;
    }
    const mapEl = $("#map");
    if (!mapEl) return;

    map = L.map(mapEl, {
      center: [38.5, -77.0],
      zoom: 6,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true
    });

    basemapLayers = {
      dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, subdomains: "abcd", updateWhenIdle: true
      }),
      imagery: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19
      }),
      topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17 }),
      streets: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, subdomains: "abcd"
      }),
      ocean: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 13
      })
    };
    basemapLayers.dark.addTo(map);

    if (typeof L.markerClusterGroup === "function") {
      markersLayer = L.markerClusterGroup({
        maxClusterRadius: 48,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        disableClusteringAtZoom: 12
      });
    } else {
      markersLayer = L.layerGroup();
    }
    map.addLayer(markersLayer);

    buoyLayer = L.layerGroup().addTo(map);
    nwsAlertLayer = L.layerGroup().addTo(map);

    // Force size after layout settles
    setTimeout(function () {
      if (map) map.invalidateSize(true);
    }, 100);
    setTimeout(function () {
      if (map) map.invalidateSize(true);
    }, 500);

    window.addEventListener("resize", function () {
      if (map) map.invalidateSize(true);
    });

    const zi = $("#zoomInBtn");
    const zo = $("#zoomOutBtn");
    const loc = $("#locateBtn");
    const fit = $("#fitBtn");
    if (zi) zi.onclick = function () { map.zoomIn(); };
    if (zo) zo.onclick = function () { map.zoomOut(); };
    if (loc) loc.onclick = function () { map.locate({ setView: true, maxZoom: 11 }); };
    if (fit) fit.onclick = function () {
      if (stations.length) {
        const b = L.latLngBounds(stations.map(function (s) { return [s.lat, s.lng]; }));
        map.fitBounds(b.pad(0.08));
      }
    };
  }

  function setBasemap(name) {
    if (!map || !basemapLayers[name]) return;
    Object.keys(basemapLayers).forEach(function (k) {
      if (map.hasLayer(basemapLayers[k])) map.removeLayer(basemapLayers[k]);
    });
    basemapLayers[name].addTo(map);
    currentBasemap = name;
    $$("#basemapChips .chip").forEach(function (c) {
      c.classList.toggle("active", c.dataset.bm === name);
    });
    saveLayoutLocal();
  }

  function markerIcon(type, fresh) {
    const cls = "tcx-marker " + (type || "wl") + (fresh ? " fresh" : "");
    return L.divIcon({
      className: "",
      html: '<div class="' + cls + '"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }

  function stationType(s) {
    if (s.type === "buoy") return "buoy";
    if (s.ports) return "curr";
    const prods = s.products || [];
    const hasCurr = prods.some(function (p) { return /current/i.test(p); });
    if (hasCurr) return "curr";
    const hasMet = prods.some(function (p) {
      return /air_temperature|wind|humidity|visibility|air_pressure/i.test(p);
    });
    const hasWl = prods.some(function (p) { return /water_level|predictions/i.test(p); });
    if (hasMet && !hasWl) return "met";
    return "wl";
  }

  function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    const filtered = getFilteredStations();
    filtered.forEach(function (s) {
      if (!s.lat || !s.lng) return;
      const type = stationType(s);
      const m = L.marker([s.lat, s.lng], { icon: markerIcon(type, s._fresh) });
      m.bindTooltip("<strong>" + (s.name || s.id) + "</strong><br/><span class=\"mono\">" + s.id + "</span>", {
        direction: "top", offset: [0, -8]
      });
      m.on("click", function () { openStationWindow(s); });
      markersLayer.addLayer(m);
    });
    const sc = $("#stationCount");
    const sb = $("#stationBadge");
    if (sc) sc.textContent = filtered.length.toLocaleString();
    if (sb) sb.textContent = String(filtered.length);
  }

  function renderBuoys() {
    if (!buoyLayer) return;
    buoyLayer.clearLayers();
    const show = $("#showBuoys") ? $("#showBuoys").checked : true;
    if (!show) {
      if ($("#buoyCount")) $("#buoyCount").textContent = "0";
      return;
    }
    buoyStations.forEach(function (b) {
      if (!b.lat || !b.lng) return;
      const m = L.marker([b.lat, b.lng], { icon: markerIcon("buoy", b._fresh) });
      m.bindTooltip("<strong>" + (b.name || b.id) + "</strong><br/>NDBC buoy", {
        direction: "top", offset: [0, -8]
      });
      m.on("click", function () { openBuoyWindow(b); });
      buoyLayer.addLayer(m);
    });
    if ($("#buoyCount")) $("#buoyCount").textContent = buoyStations.length.toLocaleString();
  }

  // ---------- DATA ----------
  function loadStations() {
    const listEl = $("#stationList");
    if (listEl) listEl.innerHTML = '<div class="empty-state">Loading stations…</div>';

    return Promise.all([
      fetch(MDAPI + "/stations.json?type=waterlevels&status=active").then(function (r) {
        if (!r.ok) throw new Error("WL " + r.status);
        return r.json();
      }),
      fetch(MDAPI + "/stations.json?type=currents&status=active").then(function (r) {
        if (!r.ok) throw new Error("CU " + r.status);
        return r.json();
      })
    ])
      .then(function (pair) {
        const wl = pair[0];
        const cu = pair[1];
        const mapById = {};
        function ingest(list, typeHint) {
          const arr = (list && list.stations) ? list.stations : (Array.isArray(list) ? list : []);
          arr.forEach(function (s) {
            const id = String(s.id || s.stationId || "");
            if (!id) return;
            const existing = mapById[id] || {
              id: id,
              name: s.name || id,
              lat: +s.lat,
              lng: +(s.lng != null ? s.lng : s.lon),
              state: s.state || "",
              products: [],
              ports: !!s.ports,
              type: typeHint
            };
            existing.name = s.name || existing.name;
            if (+s.lat) existing.lat = +s.lat;
            const lon = s.lng != null ? s.lng : s.lon;
            if (+lon) existing.lng = +lon;
            existing.state = s.state || existing.state;
            if (s.products) {
              const prods = Array.isArray(s.products)
                ? s.products
                : (s.products.products || []);
              prods.forEach(function (p) {
                const name = typeof p === "string" ? p : (p.name || p.product || "");
                if (name && existing.products.indexOf(name) < 0) existing.products.push(name);
              });
            }
            if (typeHint === "currents") existing.ports = true;
            mapById[id] = existing;
          });
        }
        ingest(wl, "waterlevels");
        ingest(cu, "currents");
        stations = Object.keys(mapById).map(function (k) { return mapById[k]; })
          .filter(function (s) { return s.lat && s.lng; });
        populateStateFilter();
        renderMarkers();
        renderStationList();
        toast(stations.length + " stations loaded");
        if (map) setTimeout(function () { map.invalidateSize(true); }, 100);
      })
      .catch(function (e) {
        console.error("loadStations", e);
        if (listEl) {
          listEl.innerHTML =
            '<div class="empty-state">Could not load stations.<br/>Check network / CORS.<br/><button type="button" class="action-btn primary" id="retryStations" style="margin-top:10px">Retry</button></div>';
          const btn = $("#retryStations");
          if (btn) btn.onclick = function () { loadStations(); };
        }
        toast("Failed to load stations");
      });
  }

  function loadBuoys() {
    const urls = [
      "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt",
      "https://corsproxy.io/?https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
    ];
    function tryUrl(i) {
      if (i >= urls.length) {
        if ($("#buoyCount")) $("#buoyCount").textContent = "—";
        return Promise.resolve();
      }
      return fetch(urls[i])
        .then(function (r) {
          if (!r.ok) throw new Error("buoy " + r.status);
          return r.text();
        })
        .then(function (text) {
          const lines = text.trim().split("\n").slice(2);
          const list = [];
          lines.forEach(function (line) {
            const p = line.trim().split(/\s+/);
            if (p.length < 6) return;
            const id = p[0];
            const lat = parseFloat(p[1]);
            const lon = parseFloat(p[2]);
            if (!isFinite(lat) || !isFinite(lon)) return;
            if (lat < 15 || lat > 72 || lon < -180 || lon > -50) return;
            list.push({
              id: id, lat: lat, lng: lon, type: "buoy", name: "NDBC " + id,
              wind: p[6] !== "MM" ? p[6] : null,
              gst: p[7] !== "MM" ? p[7] : null,
              wvht: p[8] !== "MM" ? p[8] : null,
              atmp: p[13] !== "MM" ? p[13] : null,
              wtmp: p[14] !== "MM" ? p[14] : null,
              _fresh: true
            });
          });
          buoyStations = list;
          renderBuoys();
        })
        .catch(function () {
          return tryUrl(i + 1);
        });
    }
    return tryUrl(0);
  }

  function loadNwsAlerts() {
    return fetch("https://api.weather.gov/alerts/active?event=Coastal%20Flood%20Warning,Coastal%20Flood%20Watch,Coastal%20Flood%20Advisory,Flood%20Warning,Flood%20Watch")
      .then(function (r) {
        if (!r.ok) throw new Error("nws " + r.status);
        return r.json();
      })
      .then(function (j) {
        const prev = knownAlertIds;
        nwsAlerts = (j.features || []).map(function (f) {
          return {
            id: f.id,
            event: (f.properties && f.properties.event) || "Alert",
            headline: (f.properties && f.properties.headline) || "",
            severity: (f.properties && f.properties.severity) || "",
            area: (f.properties && f.properties.areaDesc) || "",
            onset: f.properties && f.properties.onset,
            ends: f.properties && f.properties.ends,
            desc: (f.properties && f.properties.description) || "",
            url: (f.properties && f.properties["@id"]) || f.id,
            geometry: f.geometry
          };
        });
        // three-tone alerts for NEW items
        if (alertsBaseline && soundEnabled) {
          nwsAlerts.forEach(function (a) {
            if (!prev.has(a.id)) playAlertToneForSeverity(a.severity);
          });
        }
        knownAlertIds = new Set(nwsAlerts.map(function (a) { return a.id; }));
        alertsBaseline = true;
        renderAlerts();
        if ($("#showWarnings") && $("#showWarnings").checked) drawAlertZones();
      })
      .catch(function () {
        if ($("#warningsCount")) $("#warningsCount").textContent = "Alerts unavailable";
      });
  }

  function drawAlertZones() {
    if (!nwsAlertLayer) return;
    nwsAlertLayer.clearLayers();
    if (!$("#showWarnings") || !$("#showWarnings").checked) return;
    nwsAlerts.forEach(function (a) {
      if (!a.geometry) return;
      try {
        const layer = L.geoJSON(a.geometry, {
          style: { color: "#ff4438", weight: 1, fillOpacity: 0.12, fillColor: "#ff4438" }
        });
        layer.bindTooltip(a.event + (a.area ? " — " + a.area : ""));
        layer.on("click", function () { openAlertWindow(a); });
        nwsAlertLayer.addLayer(layer);
      } catch (e) {}
    });
  }

  // ---------- FILTERS / SEARCH / ZIP ----------
  function populateStateFilter() {
    const sel = $("#stateFilter");
    if (!sel) return;
    const states = [];
    const seen = {};
    stations.forEach(function (s) {
      if (s.state && !seen[s.state]) {
        seen[s.state] = true;
        states.push(s.state);
      }
    });
    states.sort();
    sel.innerHTML = '<option value="">All states</option>' +
      states.map(function (st) {
        return '<option value="' + st + '">' + (STATE_NAMES[st] || st) + "</option>";
      }).join("");

    const qs = $("#quickStates");
    if (!qs) return;
    qs.innerHTML = ["FL", "CA", "NY", "TX", "WA", "LA", "VA", "ME"]
      .filter(function (s) { return seen[s]; })
      .map(function (s) {
        return '<button type="button" class="qs-btn" data-st="' + s + '">' + s + "</button>";
      }).join("");
    qs.querySelectorAll(".qs-btn").forEach(function (btn) {
      btn.onclick = function () {
        if ($("#stateFilter")) $("#stateFilter").value = btn.dataset.st;
        applyFilters();
        qs.querySelectorAll(".qs-btn").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
      };
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getFilteredStations() {
    const st = ($("#stateFilter") && $("#stateFilter").value) || "";
    const ty = ($("#typeFilter") && $("#typeFilter").value) || "";
    const showWl = !$("#showWaterLevels") || $("#showWaterLevels").checked;
    const showCu = !$("#showCurrents") || $("#showCurrents").checked;
    const portsOnly = $("#showPorts") && $("#showPorts").checked;
    const q = (($("#searchInput") && $("#searchInput").value) || "").trim().toLowerCase();

    let list = stations.filter(function (s) {
      if (st && s.state !== st) return false;
      if (portsOnly && !s.ports) return false;
      const t = stationType(s);
      if (ty === "waterlevels" && t !== "wl") return false;
      if (ty === "currents" && t !== "curr") return false;
      if (ty === "met" && t !== "met") return false;
      if (ty === "ports" && !s.ports) return false;
      if (!showWl && t === "wl") return false;
      if (!showCu && t === "curr") return false;
      if (q && !/^\d{5}(-\d{4})?$/.test(q)) {
        const hay = (s.name + " " + s.id + " " + s.state).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    // zip proximity sort / filter
    if (zipCenter && /^\d{5}/.test(q.replace(/-.*/, ""))) {
      list = list
        .map(function (s) {
          return { s: s, d: haversineKm(zipCenter.lat, zipCenter.lng, s.lat, s.lng) };
        })
        .filter(function (x) { return x.d < 80; })
        .sort(function (a, b) { return a.d - b.d; })
        .map(function (x) { return x.s; });
    }

    return list;
  }

  function applyFilters() {
    renderMarkers();
    renderStationList();
    renderBuoys();
    saveLayoutLocal();
  }

  function isZipQuery(q) {
    return /^\d{5}(-\d{4})?$/.test((q || "").trim());
  }

  function geocodeZip(zip) {
    const z = zip.trim().slice(0, 5);
    // Nominatim (OSM) — polite User-Agent via browser is limited; works for light use
    const url = "https://nominatim.openstreetmap.org/search?postalcode=" + encodeURIComponent(z) +
      "&country=us&format=json&limit=1";
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (arr) {
        if (arr && arr[0]) {
          zipCenter = { lat: +arr[0].lat, lng: +arr[0].lon };
          if (map) {
            map.setView([zipCenter.lat, zipCenter.lng], 10);
          }
          applyFilters();
          toast("Centered on ZIP " + z);
        } else {
          zipCenter = null;
          toast("ZIP not found");
        }
      })
      .catch(function () {
        zipCenter = null;
        toast("ZIP lookup failed");
      });
  }

  function onSearchInput() {
    const q = (($("#searchInput") && $("#searchInput").value) || "").trim();
    if (isZipQuery(q)) {
      clearTimeout(onSearchInput._zipT);
      onSearchInput._zipT = setTimeout(function () { geocodeZip(q); }, 400);
    } else {
      zipCenter = null;
      clearTimeout(onSearchInput._t);
      onSearchInput._t = setTimeout(applyFilters, 200);
    }
  }

  function renderStationList() {
    const list = getFilteredStations().slice(0, 250);
    const el = $("#stationList");
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<div class="empty-state">No stations match filters</div>';
      return;
    }
    el.innerHTML = list.map(function (s) {
      const t = stationType(s);
      return (
        '<div class="station-item edge-' + t + '" data-id="' + s.id + '">' +
          '<div class="name">' + (s.name || s.id) + "</div>" +
          '<div class="meta">' + s.id + " · " + (s.state || "—") + " · " + t + "</div>" +
        "</div>"
      );
    }).join("");
    el.querySelectorAll(".station-item").forEach(function (item) {
      item.onclick = function () {
        const s = stations.find(function (x) { return x.id === item.dataset.id; });
        if (s) {
          openStationWindow(s);
          if (map) map.setView([s.lat, s.lng], Math.max(map.getZoom(), 10));
        }
      };
    });
  }

  function renderAlerts() {
    if ($("#warningsCount")) {
      $("#warningsCount").textContent = nwsAlerts.length + " active coastal / flood alerts";
    }
    const el = $("#warningsList");
    if (!el) return;
    if (!nwsAlerts.length) {
      el.innerHTML = '<div class="muted">No active coastal flood alerts</div>';
      return;
    }
    el.innerHTML = nwsAlerts.slice(0, 50).map(function (a) {
      const sev = (a.severity || "").toLowerCase();
      let cls = "sev-advisory";
      if (sev.indexOf("extreme") >= 0 || sev.indexOf("severe") >= 0) cls = "sev-severe";
      else if (sev.indexOf("moderate") >= 0) cls = "sev-moderate";
      else if (sev.indexOf("minor") >= 0) cls = "sev-minor";
      return (
        '<div class="alert-item ' + cls + '" data-id="' + a.id + '">' +
          '<div class="al-title">' + a.event + "</div>" +
          '<div class="al-meta">' + (a.area || "") + " · " + (a.severity || "") + "</div>" +
        "</div>"
      );
    }).join("");
    el.querySelectorAll(".alert-item").forEach(function (item) {
      item.onclick = function () {
        const a = nwsAlerts.find(function (x) { return x.id === item.dataset.id; });
        if (a) openAlertWindow(a);
      };
    });
  }

  // ---------- WATCH ----------
  function addWatch(station, silent) {
    if (watched.some(function (w) { return w.id === station.id; })) return;
    watched.push({ id: station.id, station: station, data: null, lastFetch: 0 });
    if (!silent) renderWatches();
    refreshWatch(watched[watched.length - 1]);
    saveLayoutLocal();
  }

  function removeWatch(id) {
    watched = watched.filter(function (w) { return w.id !== id; });
    renderWatches();
    saveLayoutLocal();
  }

  function refreshWatch(w) {
    const url = DATAAPI + "?date=latest&station=" + encodeURIComponent(w.id) +
      "&product=water_level&datum=MLLW&units=english&time_zone=gmt&format=json";
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        const d = j && j.data && j.data[0];
        if (d) {
          w.data = d;
          w.lastFetch = Date.now();
          w.station._fresh = true;
        }
        renderWatches();
      })
      .catch(function () {});
  }

  function refreshAllWatches() {
    return Promise.all(watched.map(refreshWatch));
  }

  function renderWatches() {
    const el = $("#watchList");
    if (!el) return;
    if (!watched.length) {
      el.innerHTML = '<div class="empty-state muted">Click a station → Add to watch</div>';
      return;
    }
    el.innerHTML = watched.map(function (w) {
      const v = w.data && w.data.v != null ? fmtNum(w.data.v, 2) + " ft" : "—";
      const t = (w.data && w.data.t) || "";
      return (
        '<div class="watch-card" data-id="' + w.id + '">' +
          '<div class="wc-head">' +
            '<span class="wc-name">' + (w.station.name || w.id) + "</span>" +
            '<span class="wc-id">' + w.id + "</span>" +
          "</div>" +
          '<div class="wc-val">' + v + "</div>" +
          '<div class="wc-src">' + (t ? t + " UTC · " : "") + "CO-OPS · click for details</div>" +
        "</div>"
      );
    }).join("");
    el.querySelectorAll(".watch-card").forEach(function (card) {
      card.onclick = function () {
        const w = watched.find(function (x) { return x.id === card.dataset.id; });
        if (w) openStationWindow(w.station);
      };
    });
  }

  // ---------- STATION / BUOY / ALERT WINDOWS ----------
  function openStationWindow(s) {
    const key = s.id;
    const t = stationType(s);
    const products = (s.products || []).join(", ") || "—";
    const body =
      '<div class="float-tabs">' +
        '<button type="button" class="float-tab active" data-pane="overview">Overview</button>' +
        '<button type="button" class="float-tab" data-pane="levels">Water level</button>' +
        '<button type="button" class="float-tab" data-pane="pred">Predictions</button>' +
        '<button type="button" class="float-tab" data-pane="meta">Metadata</button>' +
      "</div>" +
      '<div data-pane-content="overview">' +
        '<div class="meta-grid">' +
          '<div class="meta-card"><div class="ml">Station ID</div><div class="mv mono">' + s.id + "</div></div>" +
          '<div class="meta-card"><div class="ml">State</div><div class="mv">' + (s.state || "—") + "</div></div>" +
          '<div class="meta-card"><div class="ml">Latitude</div><div class="mv mono">' + fmtNum(s.lat, 5) + "</div></div>" +
          '<div class="meta-card"><div class="ml">Longitude</div><div class="mv mono">' + fmtNum(s.lng, 5) + "</div></div>" +
          '<div class="meta-card"><div class="ml">Type</div><div class="mv">' + t + "</div></div>" +
          '<div class="meta-card"><div class="ml">PORTS®</div><div class="mv">' + (s.ports ? "Yes" : "No") + "</div></div>" +
        "</div>" +
        '<div class="btn-row">' +
          '<button type="button" class="action-btn primary" data-act="watch">★ Add to watch</button>' +
          '<button type="button" class="action-btn" data-act="center">Center map</button>' +
          '<a class="action-btn" href="https://tidesandcurrents.noaa.gov/stationhome.html?id=' + s.id + '" target="_blank" rel="noopener">NOAA station ↗</a>' +
        "</div>" +
        '<div id="liveVals_' + s.id + '" class="meta-grid"><div class="meta-card skeleton" style="height:48px;grid-column:1/-1"></div></div>' +
      "</div>" +
      '<div data-pane-content="levels" style="display:none">' +
        '<div class="chart-box"><canvas id="chart_wl_' + s.id + '"></canvas></div>' +
        '<div class="muted">Last 48 h water level (MLLW, English units)</div>' +
      "</div>" +
      '<div data-pane-content="pred" style="display:none">' +
        '<div class="chart-box"><canvas id="chart_pred_' + s.id + '"></canvas></div>' +
        '<div class="muted">Tide predictions (next 48 h)</div>' +
      "</div>" +
      '<div data-pane-content="meta" style="display:none">' +
        '<div class="meta-card" style="margin-bottom:10px">' +
          '<div class="ml">Available products</div>' +
          '<div class="mv" style="font-size:12px;font-weight:400;margin-top:6px">' + products + "</div>" +
        "</div>" +
        '<div class="source-bar">' +
          'Metadata: <a href="' + MDAPI + "/stations/" + s.id + '.json" target="_blank" rel="noopener">CO-OPS MDAPI</a><br/>' +
          "Observations: NOAA Data API" +
        "</div>" +
      "</div>" +
      '<div class="source-bar">' +
        'Source: NOAA CO-OPS · <a href="https://tidesandcurrents.noaa.gov/" target="_blank" rel="noopener">tidesandcurrents.noaa.gov</a>' +
      "</div>";

    const win = openFloat(key, s.name || s.id, "Station " + s.id + " · " + (s.state || ""), body, {
      edgeClass: "edge-" + t
    });
    if (!win) return;
    const watchBtn = win.querySelector('[data-act="watch"]');
    const centerBtn = win.querySelector('[data-act="center"]');
    if (watchBtn) watchBtn.onclick = function () { addWatch(s); toast("Added to watch"); };
    if (centerBtn) centerBtn.onclick = function () { if (map) map.setView([s.lat, s.lng], 12); };

    loadStationLive(s, win);
    loadStationChart(s, "water_level", "chart_wl_" + s.id, key + "_wl");
    loadStationChart(s, "predictions", "chart_pred_" + s.id, key + "_pred");
  }

  function loadStationLive(s, win) {
    const box = win.querySelector("#liveVals_" + s.id);
    if (!box) return;
    const products = ["water_level", "air_temperature", "water_temperature", "wind", "air_pressure"];
    Promise.all(products.map(function (p) {
      return fetch(DATAAPI + "?date=latest&station=" + encodeURIComponent(s.id) +
        "&product=" + p + "&datum=MLLW&units=english&time_zone=gmt&format=json")
        .then(function (r) { return r.json(); })
        .then(function (j) {
          return { product: p, data: (j && j.data && j.data[0]) || null };
        })
        .catch(function () { return { product: p, data: null }; });
    })).then(function (results) {
      const cards = results.filter(function (r) { return r.data; }).map(function (r) {
        let label = r.product.replace(/_/g, " ");
        let val = r.data.v != null ? r.data.v : (r.data.s != null ? r.data.s : "—");
        let unit = "";
        if (r.product === "water_level") unit = " ft MLLW";
        if (r.product.indexOf("temp") >= 0) unit = " °F";
        if (r.product === "wind") { val = r.data.s; unit = " kn"; }
        if (r.product === "air_pressure") unit = " mb";
        return '<div class="meta-card"><div class="ml">' + label + '</div><div class="mv accent">' + val + unit + "</div></div>";
      });
      box.innerHTML = cards.length ? cards.join("") : '<div class="muted">No recent observations</div>';
    });
  }

  function loadStationChart(s, product, canvasId, chartKey) {
    function tryDraw() {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      if (typeof Chart === "undefined") return;

      const hours = 48;
      const end = new Date();
      const begin = new Date(end.getTime() - hours * 3600 * 1000);
      function fmt(d) {
        return d.toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 12);
      }

      let url;
      if (product === "predictions") {
        url = DATAAPI + "?begin_date=" + fmt(begin) + "&end_date=" + fmt(new Date(end.getTime() + hours * 3600 * 1000)) +
          "&station=" + encodeURIComponent(s.id) + "&product=predictions&datum=MLLW&units=english&time_zone=gmt&interval=h&format=json";
      } else {
        url = DATAAPI + "?begin_date=" + fmt(begin) + "&end_date=" + fmt(end) +
          "&station=" + encodeURIComponent(s.id) + "&product=water_level&datum=MLLW&units=english&time_zone=gmt&format=json";
      }

      fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          let pts = [];
          if (product === "predictions") {
            pts = (j.predictions || []).map(function (p) { return { t: p.t, v: +p.v }; });
          } else {
            pts = (j.data || []).map(function (p) { return { t: p.t, v: +p.v }; });
          }
          drawChart(canvas, chartKey, pts, product === "predictions" ? "Predicted level (ft)" : "Water level (ft MLLW)");
        })
        .catch(function () {});
    }
    // chart canvas only exists after float is in DOM; slight delay for tab switch is fine
    setTimeout(tryDraw, 50);
  }

  function drawChart(canvas, key, points, label) {
    if (typeof Chart === "undefined") return;
    if (chartInstances.has(key)) {
      try { chartInstances.get(key).destroy(); } catch (e) {}
      chartInstances.delete(key);
    }
    if (!points.length) return;
    const labels = points.map(function (p) { return (p.t && p.t.slice(11, 16)) || ""; });
    const data = points.map(function (p) { return p.v; });
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: label,
          data: data,
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34,211,238,0.12)",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: "#5c6b82", maxTicksLimit: 8, font: { size: 10 } },
            grid: { color: "rgba(255,255,255,0.04)" }
          },
          y: {
            ticks: { color: "#5c6b82", font: { size: 10 } },
            grid: { color: "rgba(255,255,255,0.06)" }
          }
        }
      }
    });
    chartInstances.set(key, chart);
  }

  function openBuoyWindow(b) {
    const key = b.id;
    const body =
      '<div class="meta-grid">' +
        '<div class="meta-card"><div class="ml">Buoy ID</div><div class="mv mono">' + b.id + "</div></div>" +
        '<div class="meta-card"><div class="ml">Type</div><div class="mv">NDBC</div></div>' +
        '<div class="meta-card"><div class="ml">Lat / Lon</div><div class="mv mono">' + fmtNum(b.lat, 4) + ", " + fmtNum(b.lng, 4) + "</div></div>" +
        '<div class="meta-card"><div class="ml">Wind</div><div class="mv accent">' + (b.wind != null ? b.wind : "—") + " kn</div></div>" +
        '<div class="meta-card"><div class="ml">Gust</div><div class="mv">' + (b.gst != null ? b.gst : "—") + " kn</div></div>" +
        '<div class="meta-card"><div class="ml">Wave height</div><div class="mv accent">' + (b.wvht != null ? b.wvht : "—") + " m</div></div>" +
        '<div class="meta-card"><div class="ml">Air temp</div><div class="mv">' + (b.atmp != null ? b.atmp : "—") + " °C</div></div>" +
        '<div class="meta-card"><div class="ml">Water temp</div><div class="mv">' + (b.wtmp != null ? b.wtmp : "—") + " °C</div></div>" +
      "</div>" +
      '<div class="btn-row">' +
        '<a class="action-btn primary" href="https://www.ndbc.noaa.gov/station_page.php?station=' + b.id + '" target="_blank" rel="noopener">NDBC station ↗</a>' +
        '<button type="button" class="action-btn" data-act="center">Center map</button>' +
      "</div>" +
      '<div class="source-bar">Source: <a href="https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt" target="_blank" rel="noopener">NDBC latest_obs</a></div>';

    const win = openFloat(key, b.name || b.id, "NDBC buoy", body, { edgeClass: "edge-buoy" });
    if (win) {
      const c = win.querySelector('[data-act="center"]');
      if (c) c.onclick = function () { if (map) map.setView([b.lat, b.lng], 10); };
    }
  }

  function openAlertWindow(a) {
    const key = "alert_" + a.id;
    const sev = (a.severity || "").toLowerCase();
    let edge = "edge-advisory";
    if (sev.indexOf("extreme") >= 0 || sev.indexOf("severe") >= 0) edge = "edge-alert";
    else if (sev.indexOf("moderate") >= 0) edge = "edge-watch";

    const body =
      '<div class="meta-grid">' +
        '<div class="meta-card" style="grid-column:1/-1"><div class="ml">Event</div><div class="mv">' + a.event + "</div></div>" +
        '<div class="meta-card"><div class="ml">Severity</div><div class="mv">' + (a.severity || "—") + "</div></div>" +
        '<div class="meta-card"><div class="ml">Area</div><div class="mv" style="font-size:12px">' + (a.area || "—") + "</div></div>" +
      "</div>" +
      '<p style="font-size:12px;color:var(--text-muted);margin:10px 0;white-space:pre-wrap;max-height:180px;overflow:auto">' +
        (a.headline || a.desc || "").slice(0, 800) +
      "</p>" +
      '<div class="source-bar">Source: <a href="https://api.weather.gov/" target="_blank" rel="noopener">NWS Alerts API</a>' +
        (a.url ? ' · <a href="' + a.url + '" target="_blank" rel="noopener">Full alert</a>' : "") +
      "</div>";

    openFloat(key, a.event, a.severity || "Alert", body, { width: 420, edgeClass: edge });
  }

  // ---------- RADAR ----------
  function initNowCoast() {
    $$("input[data-nc]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (cb.dataset.nc === "radar") {
          const box = $("#radarControls");
          if (box) box.classList.toggle("hidden", !cb.checked);
          if (cb.checked) startRadar();
          else stopRadar();
        }
        saveLayoutLocal();
      });
    });
    const play = $("#radarPlayBtn");
    const prev = $("#radarPrevBtn");
    const next = $("#radarNextBtn");
    const refr = $("#radarRefreshBtn");
    const opac = $("#radarOpacity");
    if (play) play.onclick = function () {
      radarState.playing = !radarState.playing;
      play.textContent = radarState.playing ? "⏸" : "▶";
      if (radarState.playing) tickRadar();
      else clearTimeout(radarState.timer);
    };
    if (prev) prev.onclick = function () {
      radarState.idx = Math.max(0, radarState.idx - 1);
      showRadarFrame();
    };
    if (next) next.onclick = function () {
      radarState.idx = Math.min(radarState.frames.length - 1, radarState.idx + 1);
      showRadarFrame();
    };
    if (opac) opac.oninput = function () {
      if (radarState.layer) radarState.layer.setOpacity((+opac.value) / 100);
    };
    if (refr) refr.onclick = function () { startRadar(); };
  }

  function startRadar() {
    stopRadar();
    fetch("https://api.rainviewer.com/public/weather-maps.json")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        const frames = (j.radar && j.radar.past || []).concat(j.radar && j.radar.nowcast || []).slice(-12);
        radarState.frames = frames.map(function (f) {
          return {
            time: f.time,
            url: "https://tilecache.rainviewer.com" + f.path + "/256/{z}/{x}/{y}/2/1_1.png"
          };
        });
        radarState.idx = radarState.frames.length - 1;
        showRadarFrame();
        radarState.playing = true;
        if ($("#radarPlayBtn")) $("#radarPlayBtn").textContent = "⏸";
        tickRadar();
      })
      .catch(function () { toast("Radar frames unavailable"); });
  }

  function showRadarFrame() {
    if (!map) return;
    const f = radarState.frames[radarState.idx];
    if (!f) return;
    if (radarState.layer) map.removeLayer(radarState.layer);
    const op = ($("#radarOpacity") && +$("#radarOpacity").value) || 70;
    radarState.layer = L.tileLayer(f.url, { opacity: op / 100, zIndex: 300 }).addTo(map);
    const d = new Date(f.time * 1000);
    if ($("#radarFrameLabel")) $("#radarFrameLabel").textContent = "Frame " + (radarState.idx + 1) + "/" + radarState.frames.length;
    if ($("#radarTimeLabel")) $("#radarTimeLabel").textContent = d.toISOString().slice(11, 16) + " UTC";
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
    if (radarState.layer && map) {
      map.removeLayer(radarState.layer);
      radarState.layer = null;
    }
    if ($("#radarPlayBtn")) $("#radarPlayBtn").textContent = "▶";
  }

  // ---------- REFRESH ----------
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
    const m = String(Math.floor(left / 60));
    const s = String(left % 60).padStart(2, "0");
    if ($("#nextRefresh")) $("#nextRefresh").textContent = m + ":" + s;
  }

  function softRefresh() {
    nextRefreshAt = Date.now() + REFRESH_MS;
    playSoftRefreshTone();
    Promise.all([refreshAllWatches(), loadNwsAlerts(), loadBuoys()])
      .then(function () {
        stations.forEach(function (s) { s._fresh = false; });
        toast("Data refreshed", 1600);
      });
  }

  // ---------- SPLITTERS / PANELS ----------
  function initSplitters() {
    const root = document.documentElement;
    $$(".splitter").forEach(function (sp) {
      let dragging = false;
      sp.addEventListener("mousedown", function (e) {
        e.preventDefault();
        dragging = true;
        sp.classList.add("dragging");
        const which = sp.dataset.split;
        function onMove(ev) {
          if (!dragging) return;
          const grid = $("#mainGrid");
          if (!grid) return;
          const rect = grid.getBoundingClientRect();
          if (which === "left") {
            const w = Math.min(400, Math.max(180, ev.clientX - rect.left));
            root.style.setProperty("--left-w", w + "px");
          } else {
            const w = Math.min(420, Math.max(200, rect.right - ev.clientX));
            root.style.setProperty("--right-w", w + "px");
          }
          if (map) map.invalidateSize(true);
        }
        function onUp() {
          dragging = false;
          sp.classList.remove("dragging");
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          saveLayoutLocal();
          if (map) map.invalidateSize(true);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  function initPanels() {
    $$(".panel-head").forEach(function (head) {
      head.addEventListener("click", function (e) {
        if (e.target.closest("button, a, input, select")) return;
        const panel = head.closest(".panel");
        if (panel) panel.classList.toggle("collapsed");
        saveLayoutLocal();
      });
    });
  }

  function initClock() {
    function tick() {
      if ($("#utcClock")) $("#utcClock").textContent = utcNow();
    }
    tick();
    setInterval(tick, 1000);
  }

  function initUI() {
    const soft = $("#softRefreshBtn");
    if (soft) soft.onclick = function () { softRefresh(); };

    const reset = $("#resetFilters");
    if (reset) reset.onclick = function () {
      if ($("#stateFilter")) $("#stateFilter").value = "";
      if ($("#typeFilter")) $("#typeFilter").value = "";
      if ($("#productFilter")) $("#productFilter").value = "none";
      if ($("#showWaterLevels")) $("#showWaterLevels").checked = true;
      if ($("#showCurrents")) $("#showCurrents").checked = true;
      if ($("#showPorts")) $("#showPorts").checked = false;
      if ($("#showWarnings")) $("#showWarnings").checked = false;
      if ($("#showBuoys")) $("#showBuoys").checked = true;
      zipCenter = null;
      applyFilters();
    };

    ["stateFilter", "typeFilter", "productFilter"].forEach(function (id) {
      const el = $("#" + id);
      if (el) el.addEventListener("change", applyFilters);
    });
    ["showWaterLevels", "showCurrents", "showPorts", "showWarnings", "showBuoys"].forEach(function (id) {
      const el = $("#" + id);
      if (el) el.addEventListener("change", function () {
        if (id === "showWarnings") drawAlertZones();
        applyFilters();
      });
    });

    const search = $("#searchInput");
    if (search) search.addEventListener("input", onSearchInput);

    const chips = $("#basemapChips");
    if (chips) chips.addEventListener("click", function (e) {
      const chip = e.target.closest(".chip");
      if (chip) setBasemap(chip.dataset.bm);
    });

    const rw = $("#refreshWarningsBtn");
    if (rw) rw.onclick = function () { loadNwsAlerts(); };

    const cw = $("#clearWatches");
    if (cw) cw.onclick = function () {
      watched = [];
      renderWatches();
      saveLayoutLocal();
    };

    // layout modal
    const layoutBtn = $("#layoutBtn");
    const layoutModal = $("#layoutModal");
    if (layoutBtn && layoutModal) {
      layoutBtn.onclick = function () { layoutModal.classList.remove("hidden"); };
    }
    const closeLayout = $("#closeLayoutModal");
    if (closeLayout && layoutModal) {
      closeLayout.onclick = function () { layoutModal.classList.add("hidden"); };
      layoutModal.addEventListener("click", function (e) {
        if (e.target === layoutModal) layoutModal.classList.add("hidden");
      });
    }
    const exportBtn = $("#exportLayoutBtn");
    if (exportBtn) exportBtn.onclick = exportLayout;
    const importFile = $("#importLayoutFile");
    if (importFile) importFile.onchange = function (e) {
      const f = e.target.files && e.target.files[0];
      if (f) importLayoutFile(f);
    };
    const resetLayout = $("#resetLayoutBtn");
    if (resetLayout) resetLayout.onclick = function () {
      localStorage.removeItem("tcx_layout_v2");
      location.reload();
    };
    const loadUrlBtn = $("#loadLayoutUrlBtn");
    if (loadUrlBtn) loadUrlBtn.onclick = function () {
      const u = ($("#layoutUrlInput") && $("#layoutUrlInput").value.trim()) || "";
      if (u) loadLayoutFromUrl(u);
    };

    // sound — requires user gesture to unlock AudioContext
    try {
      soundEnabled = localStorage.getItem("tcx_sound") === "1";
    } catch (e) {
      soundEnabled = false;
    }
    updateSoundUI();
    const soundBtn = $("#soundToggle");
    if (soundBtn) {
      soundBtn.onclick = function () {
        soundEnabled = !soundEnabled;
        try { localStorage.setItem("tcx_sound", soundEnabled ? "1" : "0"); } catch (e) {}
        updateSoundUI();
        if (soundEnabled) {
          getAudioCtx();
          playTrafficTone(); // confirmation (Montco traffic tone)
        }
        toast(soundEnabled ? "Alert tones on" : "Alert tones off");
      };
    }

    document.addEventListener("keydown", function (e) {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "/") {
        e.preventDefault();
        if ($("#searchInput")) $("#searchInput").focus();
      }
      if (e.key === "Escape") {
        const keys = Array.from(floatWindows.keys());
        if (keys.length) closeFloat(keys[keys.length - 1]);
        else if ($("#layoutModal")) $("#layoutModal").classList.add("hidden");
      }
      if (e.key === "r" || e.key === "R") softRefresh();
    });
  }

  // ---------- BOOT ----------
  function boot() {
    try {
      initClock();
      initMap();
      initSplitters();
      initPanels();
      initUI();
      initNowCoast();

      const params = new URLSearchParams(location.search);
      const layoutUrl = params.get("layout");
      if (layoutUrl) loadLayoutFromUrl(layoutUrl);
      else loadLayoutLocal();

      // parallel data load — don't block UI
      loadStations();
      loadBuoys();
      loadNwsAlerts();
      startRefreshCycle();
    } catch (err) {
      console.error("boot error", err);
      toast("Startup error — see console");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
