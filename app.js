/**
 * TIDES & CURRENTS XPLR
 * Hardened boot · scrollable rails · Montco three-tone alerts · zip search
 */
(function () {
  "use strict";

  const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi";
  const DATAAPI = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const REFRESH_MS = 120000;


  // ---------- CORS-safe fetch (GitHub Pages cannot hit NDBC / some NOAA APIs directly) ----------
  function proxyUrls(url) {
    var u = encodeURIComponent(url);
    return [
      url, // try direct first (works when server sends ACAO)
      "https://corsproxy.io/?" + u,
      "https://api.codetabs.com/v1/proxy?quest=" + u,
      "https://api.allorigins.win/raw?url=" + u,
      "https://cors.eu.org/" + url,
      "https://proxy.corsfix/" + url
    ];
  }

  function corsFetch(url, opts) {
    opts = opts || {};
    var list = proxyUrls(url);
    var i = 0;
    function next() {
      if (i >= list.length) {
        return Promise.reject(new Error("CORS blocked: " + url));
      }
      var target = list[i++];
      return fetch(target, Object.assign({ cache: "no-store" }, opts))
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r;
        })
        .catch(function () { return next(); });
    }
    return next();
  }

  function corsText(url) {
    return corsFetch(url).then(function (r) { return r.text(); });
  }

  function corsJson(url) {
    return corsFetch(url).then(function (r) { return r.json(); });
  }

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
  let tropicalStorms = [];
  let tropicalLayer = null;
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
  let ncActiveLayers = {}; // id -> Leaflet layer
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
      minZoom: 3,
      maxZoom: 18,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true
    });

    // Zero Esri raster tiles — they return 200 OK images that say "Zoom Level Not Supported".
    const TRANSPARENT_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    basemapLayers = {
      dark: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap",
        className: "tcx-tiles-dark", errorTileUrl: TRANSPARENT_TILE
      }),
      imagery: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap",
        className: "tcx-tiles-imagery", errorTileUrl: TRANSPARENT_TILE
      }),
      topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        maxNativeZoom: 15, maxZoom: 18, subdomains: "abc", attribution: "OpenTopoMap",
        errorTileUrl: TRANSPARENT_TILE
      }),
      streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap",
        errorTileUrl: TRANSPARENT_TILE
      }),
      ocean: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap",
        className: "tcx-tiles-ocean", errorTileUrl: TRANSPARENT_TILE
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
    tropicalLayer = L.layerGroup().addTo(map);
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
    map.on("moveend", function () {
      var product = ($("#productFilter") && $("#productFilter").value) || "none";
      if (product !== "none") scheduleProductOverlay();
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

  function markerIcon(type, fresh, label) {
    var cls = "tcx-marker " + (type || "wl") + (fresh ? " fresh" : "");
    var html = '<div class="' + cls + '"></div>';
    if (label != null && label !== "") {
      html = '<div class="tcx-marker-wrap">' + html
        + '<span class="tcx-marker-label">' + label + '</span></div>';
      return L.divIcon({
        className: "tcx-div-icon",
        html: html,
        iconSize: [40, 28],
        iconAnchor: [8, 8]
      });
    }
    return L.divIcon({
      className: "tcx-div-icon",
      html: html,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }

  function stationType(s) {
    if (s.type === "buoy") return "buoy";
    if (s.ports) return "curr";
    var prods = s.products || [];
    var hasCurr = prods.some(function (p) { return /current/i.test(p); });
    if (hasCurr) return "curr";
    var hasMet = prods.some(function (p) {
      return /air_temperature|wind|humidity|visibility|air_pressure/i.test(p);
    });
    var hasWl = prods.some(function (p) { return /water_level|predictions/i.test(p); });
    if (hasMet && !hasWl) return "met";
    return "wl";
  }

  function formatOverlayLabel(product, val) {
    if (val == null || isNaN(+val)) return "";
    var v = +val;
    if (product === "water_level" || product === "predictions" || product === "air_gap") return v.toFixed(1) + "ft";
    if (product === "air_temperature" || product === "water_temperature") return v.toFixed(0) + "°";
    if (product === "air_pressure") return v.toFixed(0);
    if (product === "wind" || product === "currents") return v.toFixed(0);
    if (product === "humidity") return v.toFixed(0) + "%";
    if (product === "visibility") return v.toFixed(1);
    return v.toFixed(1);
  }

  function overlayColor(product, val) {
    // simple sequential color from cool→warm by value rank is done later; solid by type fallback
    if (val == null) return null;
    return null; // use CSS class markers; labels show value
  }

  function renderMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();
    var filtered = getFilteredStations();
    var product = ($("#productFilter") && $("#productFilter").value) || "none";
    filtered.forEach(function (s) {
      if (!s.lat || !s.lng) return;
      var type = stationType(s);
      var label = "";
      if (product !== "none" && s._overlay && s._overlay.product === product && s._overlay.v != null) {
        label = formatOverlayLabel(product, s._overlay.v);
      }
      var m = L.marker([s.lat, s.lng], { icon: markerIcon(type, s._fresh, label) });
      var tip = "<strong>" + (s.name || s.id) + "</strong><br/><span class=\"mono\">" + s.id + "</span>";
      if (label) tip += "<br/><span class=\"mono\">" + product.replace(/_/g, " ") + ": " + label + "</span>";
      if (s._overlay && s._overlay.t) tip += "<br/><span class=\"mono\">" + s._overlay.t + " UTC</span>";
      m.bindTooltip(tip, { direction: "top", offset: [0, -8] });
      m.on("click", function () { openStationWindow(s); });
      markersLayer.addLayer(m);
    });
    var sc = $("#stationCount");
    var sb = $("#stationBadge");
    if (sc) sc.textContent = filtered.length.toLocaleString();
    if (sb) sb.textContent = String(filtered.length);
  }

  function renderBuoys() {
    if (!buoyLayer) return;
    buoyLayer.clearLayers();
    var show = !$("#showBuoys") || $("#showBuoys").checked;
    if (!show) {
      if ($("#buoyCount")) $("#buoyCount").textContent = "0";
      return;
    }
    var product = ($("#productFilter") && $("#productFilter").value) || "none";
    var st = ($("#stateFilter") && $("#stateFilter").value) || "";
    var q = (($("#searchInput") && $("#searchInput").value) || "").trim().toLowerCase();
    var list = buoyStations.filter(function (b) {
      if (!b.lat || !b.lng) return false;
      if (q && !/^\d{5}/.test(q)) {
        var hay = ((b.name || "") + " " + b.id).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    list.forEach(function (b) {
      var label = "";
      if (product === "water_temperature" && b.wtmp != null) label = (+b.wtmp).toFixed(0) + "°C";
      else if (product === "air_temperature" && b.atmp != null) label = (+b.atmp).toFixed(0) + "°C";
      else if (product === "wind" && b.wind != null) label = b.wind + "m/s";
      else if (product === "currents" && b.wind != null) label = ""; // NDBC has no current speed typically
      var m = L.marker([b.lat, b.lng], { icon: markerIcon("buoy", b._fresh, label) });
      var tip = "<strong>" + (b.name || b.id) + "</strong><br/>NDBC buoy";
      if (b.wtmp != null) tip += "<br/>Water " + b.wtmp + " °C";
      if (b.atmp != null) tip += "<br/>Air " + b.atmp + " °C";
      if (b.wind != null) tip += "<br/>Wind " + b.wind + " m/s";
      if (b.wvht != null) tip += "<br/>Wave " + b.wvht + " m";
      m.bindTooltip(tip, { direction: "top", offset: [0, -8] });
      m.on("click", function () { openBuoyWindow(b); });
      buoyLayer.addLayer(m);
    });
    if ($("#buoyCount")) $("#buoyCount").textContent = list.length.toLocaleString();
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
    // Prefer same-origin data/ files (no CORS). GitHub Action refreshes ndbc-latest.json.
    // Fallback: corsFetch proxies (often blocked from browser).

    function normalizeList(arr) {
      return (arr || []).map(function (b) {
        return {
          id: String(b.id),
          lat: +b.lat,
          lng: +(b.lng != null ? b.lng : b.lon),
          type: "buoy",
          name: b.name || ("NDBC " + b.id),
          owner: b.owner || "",
          program: b.program || b.pgm || "",
          stationType: b.stationType || b.type || "buoy",
          elev: b.elev || "",
          hasMet: !!b.hasMet,
          hasCurrents: !!b.hasCurrents,
          hasWaterQuality: !!b.hasWaterQuality,
          hasDart: !!b.hasDart,
          wdir: b.wdir, wind: b.wind, gst: b.gst,
          wvht: b.wvht, dpd: b.dpd, apd: b.apd, mwd: b.mwd,
          bar: b.bar, ptdy: b.ptdy, atmp: b.atmp, wtmp: b.wtmp,
          dewp: b.dewp, vis: b.vis, tide: b.tide,
          obsTime: b.obsTime || "",
          hasObs: !!(b.hasObs || b.wtmp != null || b.wind != null || b.wvht != null),
          _fresh: !!b._fresh || !!b.hasObs
        };
      }).filter(function (b) {
        return b.id && isFinite(b.lat) && isFinite(b.lng) && !(b.lat === 0 && b.lng === 0);
      });
    }

    function applyList(list, label) {
      buoyStations = list;
      renderBuoys();
      var withObs = list.filter(function (b) { return b.hasObs; }).length;
      if ($("#buoyCount")) $("#buoyCount").textContent = list.length.toLocaleString();
      toast(list.length + " NDBC stations" + (withObs ? " (" + withObs + " with obs)" : "") + (label ? " · " + label : ""), 2600);
    }

    // 1) same-origin latest (stations + obs merged)
    return fetch("data/ndbc-latest.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("no local latest");
        return r.json();
      })
      .then(function (j) {
        var list = normalizeList(j.stations || j);
        if (!list.length) throw new Error("empty local");
        applyList(list, "local cache");
      })
      .catch(function () {
        // 2) same-origin catalog only
        return fetch("data/ndbc-stations.json", { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) throw new Error("no local stations");
            return r.json();
          })
          .then(function (j) {
            var list = normalizeList(j.stations || j);
            if (!list.length) throw new Error("empty stations");
            applyList(list, "catalog");
          });
      })
      .catch(function () {
        // 3) last resort: proxied live NDBC (often blocked)
        return Promise.all([
          corsText("https://www.ndbc.noaa.gov/activestations.xml").catch(function () { return null; }),
          corsText("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt").catch(function () { return null; })
        ]).then(function (pair) {
          var xml = pair[0];
          var obsText = pair[1];
          var catalog = [];
          if (xml) {
            var re = /<station\s+([^>]+)\s*\/?>/gi, m;
            while ((m = re.exec(xml)) !== null) {
              var attrs = m[1];
              function attr(name) {
                var am = new RegExp(name + '="([^"]*)"', "i").exec(attrs);
                return am ? am[1] : "";
              }
              var id = attr("id");
              var lat = parseFloat(attr("lat"));
              var lon = parseFloat(attr("lon"));
              if (!id || !isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
              catalog.push({
                id: id, lat: lat, lng: lon, name: attr("name") || ("NDBC " + id),
                owner: attr("owner"), program: attr("pgm"), stationType: attr("type"),
                hasMet: attr("met") === "y", type: "buoy"
              });
            }
          }
          var obsMap = {};
          if (obsText) {
            var lines = obsText.trim().split("\n");
            var i = 0;
            while (i < lines.length && (lines[i].charAt(0) === "#" || /STN|YY|text/i.test(lines[i]))) i++;
            function mm(x) {
              return (!x || x === "MM" || x === "999") ? null : x;
            }
            for (; i < lines.length; i++) {
              var p = lines[i].trim().split(/\s+/);
              if (p.length < 15) continue;
              obsMap[p[0]] = {
                wdir: mm(p[8]), wind: mm(p[9]), gst: mm(p[10]), wvht: mm(p[11]),
                dpd: mm(p[12]), apd: mm(p[13]), mwd: mm(p[14]), bar: mm(p[15]),
                atmp: mm(p[17]), wtmp: mm(p[18]), dewp: mm(p[19]), vis: mm(p[20]),
                tide: mm(p[21]),
                obsTime: p[3] + "-" + p[4] + "-" + p[5] + " " + p[6] + ":" + p[7] + " UTC",
                hasObs: true, _fresh: true
              };
              if (!catalog.length) {
                catalog.push({ id: p[0], lat: +p[1], lng: +p[2], name: "NDBC " + p[0], type: "buoy" });
              }
            }
          }
          catalog.forEach(function (b) {
            var o = obsMap[b.id];
            if (o) Object.keys(o).forEach(function (k) { b[k] = o[k]; });
          });
          var list = normalizeList(catalog);
          if (!list.length) throw new Error("proxy empty");
          applyList(list, "live proxy");
        });
      })
      .catch(function (e) {
        console.error("loadBuoys", e);
        toast("NDBC unavailable — ensure data/ndbc-latest.json is in the repo");
        if ($("#buoyCount")) $("#buoyCount").textContent = "—";
      });
  }

  function loadTropicalStorms() {
    return fetch("data/nhc-active.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("no local nhc");
        return r.json();
      })
      .then(function (j) {
        tropicalStorms = (j.storms || []).filter(function (s) {
          return isFinite(+s.lat) && isFinite(+s.lng);
        });
        renderTropicalStorms();
        if (tropicalStorms.length) {
          toast(tropicalStorms.length + " active tropical system(s): " +
            tropicalStorms.map(function (s) { return s.name; }).join(", "), 3200);
        }
      })
      .catch(function () {
        // try live NHC (may CORS-fail)
        return corsJson("https://www.nhc.noaa.gov/CurrentStorms.json")
          .then(function (j) {
            tropicalStorms = (j.activeStorms || []).map(function (s) {
              return {
                id: s.id,
                name: s.name,
                classification: s.classification,
                intensity: s.intensity,
                pressure: s.pressure,
                lat: s.latitudeNumeric,
                lng: s.longitudeNumeric,
                latitude: s.latitude,
                longitude: s.longitude,
                movementDir: s.movementDir,
                movementSpeed: s.movementSpeed,
                lastUpdate: s.lastUpdate,
                binNumber: s.binNumber,
                publicAdvisory: s.publicAdvisory && s.publicAdvisory.url,
                forecastAdvisory: s.forecastAdvisory && s.forecastAdvisory.url,
                forecastDiscussion: s.forecastDiscussion && s.forecastDiscussion.url,
                forecastGraphics: s.forecastGraphics && s.forecastGraphics.url,
                raw: s
              };
            }).filter(function (s) { return isFinite(+s.lat) && isFinite(+s.lng); });
            renderTropicalStorms();
          })
          .catch(function () {
            tropicalStorms = [];
          });
      });
  }

  function stormIcon(cls) {
    var color = "#f97316";
    if (cls === "HU" || cls === "MH") color = "#ef4444";
    if (cls === "TS") color = "#fb923c";
    if (cls === "TD" || cls === "SS" || cls === "SD") color = "#fbbf24";
    if (cls === "PTC" || cls === "DB") color = "#a3a3a3";
    var html = '<div class="tcx-storm" style="--sc:' + color + '"><span>🌀</span></div>';
    return L.divIcon({
      className: "tcx-div-icon",
      html: html,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  function renderTropicalStorms() {
    if (!tropicalLayer) return;
    tropicalLayer.clearLayers();
    // respect tropical_nc checkbox if present
    var cb = $('input[data-nc="tropical_nc"]');
    var show = !cb || cb.checked;
    if (!show) return;
    tropicalStorms.forEach(function (s) {
      var m = L.marker([+s.lat, +s.lng], { icon: stormIcon(s.classification), zIndexOffset: 800 });
      var tip = "<strong>" + (s.classification || "") + " " + (s.name || s.id) + "</strong><br/>"
        + (s.intensity ? s.intensity + " kt · " : "")
        + (s.pressure ? s.pressure + " mb" : "");
      m.bindTooltip(tip, { direction: "top", offset: [0, -12] });
      m.on("click", function () { openStormWindow(s); });
      tropicalLayer.addLayer(m);
    });
  }

  function openStormWindow(s) {
    var key = "storm_" + (s.id || s.name);
    function cell(label, val, unit) {
      unit = unit || "";
      var display = (val != null && val !== "") ? (String(val) + (unit ? " " + unit : "")) : "—";
      return '<div class="meta-card"><div class="ml">' + label + '</div><div class="mv' +
        (val != null && val !== "" ? " accent" : "") + '">' + display + "</div></div>";
    }
    var clsLabel = {
      HU: "Hurricane", MH: "Major Hurricane", TS: "Tropical Storm", TD: "Tropical Depression",
      SS: "Subtropical Storm", SD: "Subtropical Depression", PTC: "Potential Tropical Cyclone",
      DB: "Disturbance", EX: "Extratropical", LO: "Low", WV: "Tropical Wave"
    };
    var body =
      '<div class="meta-grid">' +
        cell("Name", s.name, "") +
        cell("Classification", (clsLabel[s.classification] || s.classification || "—") + (s.classification ? " (" + s.classification + ")" : ""), "") +
        cell("Intensity", s.intensity, "kt") +
        cell("Pressure", s.pressure, "mb") +
        cell("Position", (s.latitude || s.lat) + " / " + (s.longitude || s.lng), "") +
        cell("Movement", (s.movementDir != null ? s.movementDir + "°" : "—") + (s.movementSpeed != null ? " at " + s.movementSpeed + " kt" : ""), "") +
        cell("Last update", s.lastUpdate ? new Date(s.lastUpdate).toUTCString() : "—", "") +
        cell("Bin", s.binNumber || "—", "") +
        cell("Storm ID", s.id || "—", "") +
      "</div>" +
      '<div class="btn-row">' +
        '<button type="button" class="action-btn primary" data-act="center">Center map</button>' +
      "</div>" +
      '<div class="source-bar">' +
        "Source: NHC CurrentStorms · " +
        (s.publicAdvisory ? '<a href="' + s.publicAdvisory + '" target="_blank" rel="noopener">Public advisory ↗</a> · ' : "") +
        (s.forecastDiscussion ? '<a href="' + s.forecastDiscussion + '" target="_blank" rel="noopener">Discussion ↗</a> · ' : "") +
        (s.forecastGraphics ? '<a href="' + s.forecastGraphics + '" target="_blank" rel="noopener">Graphics ↗</a>' : "") +
      "</div>";

    var win = openFloat(key, (s.classification || "") + " " + (s.name || "Storm"), "NHC active", body, {
      width: 440, edgeClass: "edge-alert"
    });
    if (!win) return;
    var c = win.querySelector('[data-act="center"]');
    if (c) c.onclick = function () { if (map) map.setView([+s.lat, +s.lng], 5); };
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
    var st = ($("#stateFilter") && $("#stateFilter").value) || "";
    var ty = ($("#typeFilter") && $("#typeFilter").value) || "";
    var showWl = !$("#showWaterLevels") || $("#showWaterLevels").checked;
    var showCu = !$("#showCurrents") || $("#showCurrents").checked;
    var portsOnly = $("#showPorts") && $("#showPorts").checked;
    var product = ($("#productFilter") && $("#productFilter").value) || "none";
    var q = (($("#searchInput") && $("#searchInput").value) || "").trim().toLowerCase();

    // When a product overlay is active, auto-include station types that carry that product
    // so the overlay is never empty just because checkboxes are off.
    if (product !== "none") {
      if (product === "currents") showCu = true;
      else if (product === "water_level" || product === "predictions" || product === "air_gap"
        || product === "water_temperature") showWl = true;
      else showWl = true; // met products often on water level platforms
    }

    var list = stations.filter(function (s) {
      if (st && s.state !== st) return false;
      if (portsOnly && !s.ports) return false;
      var t = stationType(s);
      if (ty === "waterlevels" && t !== "wl") return false;
      if (ty === "currents" && t !== "curr") return false;
      if (ty === "met" && t !== "met") return false;
      if (ty === "ports" && !s.ports) return false;
      if (!showWl && t === "wl") return false;
      if (!showCu && t === "curr") return false;
      // hide pure met if water levels off and not currents? keep met with showWl path above
      if (q && !/^\d{5}(-\d{4})?$/.test(q)) {
        var hay = (s.name + " " + s.id + " " + s.state).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

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

  var productOverlayTimer = null;
  var productOverlayToken = 0;

  function applyFilters() {
    renderMarkers();
    renderStationList();
    renderBuoys();
    scheduleProductOverlay();
    saveLayoutLocal();
  }

  function scheduleProductOverlay() {
    clearTimeout(productOverlayTimer);
    productOverlayTimer = setTimeout(runProductOverlay, 350);
  }

  function runProductOverlay() {
    var product = ($("#productFilter") && $("#productFilter").value) || "none";
    if (product === "none") {
      stations.forEach(function (s) { s._overlay = null; });
      renderMarkers();
      renderBuoys();
      return;
    }

    // Map UI product → CO-OPS datagetter product
    var apiProduct = product;
    if (product === "predictions") apiProduct = "predictions";
    if (product === "currents") apiProduct = "currents";

    var list = getFilteredStations();
    // Prefer stations currently in map view
    if (map) {
      var b = map.getBounds();
      var inView = list.filter(function (s) { return b.contains([s.lat, s.lng]); });
      if (inView.length) list = inView;
    }
    // Cap concurrent requests
    list = list.slice(0, 50);
    if (!list.length) {
      toast("No stations for this overlay — enable Water levels / Currents");
      return;
    }

    var token = ++productOverlayToken;
    toast("Loading " + product.replace(/_/g, " ") + " for " + list.length + " stations…", 2000);

    var done = 0;
    function fetchOne(s) {
      var url = DATAAPI + "?date=latest&station=" + encodeURIComponent(s.id)
        + "&product=" + encodeURIComponent(apiProduct)
        + "&datum=MLLW&units=english&time_zone=gmt&format=json";
      if (apiProduct === "predictions") {
        // latest prediction hour
        url = DATAAPI + "?date=latest&station=" + encodeURIComponent(s.id)
          + "&product=predictions&datum=MLLW&units=english&time_zone=gmt&interval=h&format=json";
      }
      return corsJson(url)
        .then(function (j) {
          if (token !== productOverlayToken) return;
          var row = null;
          if (j && j.data && j.data[0]) row = j.data[0];
          else if (j && j.predictions && j.predictions[0]) row = j.predictions[0];
          else if (j && j.currents && j.currents[0]) row = j.currents[0];
          if (row) {
            var v = row.v != null ? row.v : (row.s != null ? row.s : null);
            s._overlay = { product: product, v: v, t: row.t || "" };
          } else {
            s._overlay = { product: product, v: null, t: "" };
          }
        })
        .catch(function () {
          if (token === productOverlayToken) s._overlay = { product: product, v: null, t: "" };
        })
        .then(function () {
          done++;
          if (done >= list.length && token === productOverlayToken) {
            renderMarkers();
            renderBuoys();
            var ok = list.filter(function (s) { return s._overlay && s._overlay.v != null; }).length;
            toast("Overlay: " + ok + "/" + list.length + " stations with data", 2200);
          }
        });
    }

    // batch in groups of 8
    var i = 0;
    function nextBatch() {
      if (token !== productOverlayToken) return;
      var batch = list.slice(i, i + 8);
      i += 8;
      if (!batch.length) return;
      Promise.all(batch.map(fetchOne)).then(function () {
        if (i < list.length) nextBatch();
      });
    }
    nextBatch();
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
    return corsJson(url)
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
  // ---------- LEGEND CATEGORY FLOATING WINDOWS ----------
  function stationsByCategory(cat) {
    if (cat === "buoy") return buoyStations.slice();
    if (cat === "flood") return []; // alerts handled separately
    if (cat === "fresh") {
      return stations.filter(function (s) { return s._fresh; })
        .concat(buoyStations.filter(function (b) { return b._fresh; }));
    }
    return stations.filter(function (s) {
      var t = stationType(s);
      if (cat === "wl") return t === "wl";
      if (cat === "curr") return t === "curr";
      if (cat === "met") return t === "met";
      return false;
    });
  }

  function openCategoryWindow(cat) {
    var titles = {
      wl: "Water level stations",
      curr: "Currents / PORTS®",
      met: "Meteorological stations",
      buoy: "NDBC buoys",
      fresh: "Fresh data",
      flood: "Flood / coastal alerts"
    };
    var edges = {
      wl: "edge-wl", curr: "edge-curr", met: "edge-met",
      buoy: "edge-buoy", fresh: "edge-wl", flood: "edge-alert"
    };
    var sources = {
      wl: "NOAA CO-OPS water level stations · tidesandcurrents.noaa.gov",
      curr: "NOAA CO-OPS currents / PORTS® · tidesandcurrents.noaa.gov",
      met: "NOAA CO-OPS meteorological sensors · tidesandcurrents.noaa.gov",
      buoy: "NDBC latest_obs · ndbc.noaa.gov",
      fresh: "Stations refreshed in the last soft-update cycle",
      flood: "NWS Alerts API · api.weather.gov"
    };
    var key = "legend_" + cat;
    var title = titles[cat] || cat;
    var body = "";

    if (cat === "flood") {
      var alerts = nwsAlerts.slice();
      body += '<div class="cat-stats">'
        + '<div class="meta-card"><div class="ml">Active alerts</div><div class="mv accent">' + alerts.length + '</div></div>'
        + '<div class="meta-card"><div class="ml">Source</div><div class="mv" style="font-size:11px">NWS</div></div>'
        + '</div>';
      if (!alerts.length) {
        body += '<div class="empty-state">No active coastal / flood alerts</div>';
      } else {
        body += '<div class="cat-list">';
        alerts.slice(0, 80).forEach(function (a) {
          var sev = (a.severity || "").toLowerCase();
          body += '<div class="cat-row" data-alert-id="' + a.id.replace(/"/g, "") + '">'
            + '<div class="cn">' + (a.event || "Alert") + '</div>'
            + '<div class="cm">' + (a.area || "") + " · " + (a.severity || "") + '</div>'
            + '</div>';
        });
        body += '</div>';
      }
      body += '<div class="source-bar">' + sources.flood + '</div>';
      var win = openFloat(key, title, alerts.length + " active", body, {
        width: 420, edgeClass: edges.flood
      });
      if (win) {
        win.querySelectorAll(".cat-row[data-alert-id]").forEach(function (row) {
          row.onclick = function () {
            var a = nwsAlerts.find(function (x) { return x.id === row.getAttribute("data-alert-id"); });
            if (a) openAlertWindow(a);
          };
        });
      }
      return;
    }

    var list = stationsByCategory(cat);
    // Prefer filtered view when state filter is set
    var stFilter = ($("#stateFilter") && $("#stateFilter").value) || "";
    if (stFilter && cat !== "buoy") {
      list = list.filter(function (s) { return s.state === stFilter; });
    }

    body += '<div class="cat-stats">'
      + '<div class="meta-card"><div class="ml">Count</div><div class="mv accent">' + list.length + '</div></div>'
      + '<div class="meta-card"><div class="ml">Filter</div><div class="mv" style="font-size:11px">' + (stFilter || "All states") + '</div></div>'
      + '</div>';
    body += '<div class="btn-row">'
      + '<button type="button" class="action-btn primary" data-act="filter-map">Show only this type on map</button>'
      + '<button type="button" class="action-btn" data-act="fit">Fit bounds</button>'
      + '</div>';

    if (!list.length) {
      body += '<div class="empty-state">No items in this category'
        + (cat === "fresh" ? " (fresh markers appear after a soft refresh)" : "")
        + '</div>';
    } else {
      body += '<div class="cat-list">';
      list.slice(0, 120).forEach(function (s) {
        var isBuoy = s.type === "buoy" || cat === "buoy";
        var meta = isBuoy
          ? (s.id + " · NDBC")
          : (s.id + " · " + (s.state || "—") + " · " + stationType(s));
        var val = "";
        if (isBuoy) {
          var parts = [];
          if (s.wvht != null) parts.push("Hs " + s.wvht + " m");
          if (s.wind != null) parts.push("Wind " + s.wind + " kn");
          if (s.wtmp != null) parts.push("SST " + s.wtmp + " °C");
          val = parts.join(" · ");
        }
        body += '<div class="cat-row" data-sid="' + s.id + '" data-buoy="' + (isBuoy ? "1" : "0") + '">'
          + '<div class="cn">' + (s.name || s.id) + '</div>'
          + '<div class="cm">' + meta + '</div>'
          + (val ? '<div class="cv">' + val + '</div>' : '')
          + '</div>';
      });
      if (list.length > 120) {
        body += '<div class="muted" style="padding:8px">Showing 120 of ' + list.length + '</div>';
      }
      body += '</div>';
    }
    body += '<div class="source-bar">' + (sources[cat] || "") + '</div>';

    var win = openFloat(key, title, list.length + " items", body, {
      width: 440, edgeClass: edges[cat] || "edge-wl"
    });
    if (!win) return;

    win.querySelectorAll(".cat-row[data-sid]").forEach(function (row) {
      row.onclick = function () {
        var id = row.getAttribute("data-sid");
        var isBuoy = row.getAttribute("data-buoy") === "1";
        if (isBuoy) {
          var b = buoyStations.find(function (x) { return x.id === id; });
          if (b) {
            openBuoyWindow(b);
            if (map) map.setView([b.lat, b.lng], Math.max(map.getZoom(), 9));
          }
        } else {
          var s = stations.find(function (x) { return x.id === id; });
          if (s) {
            openStationWindow(s);
            if (map) map.setView([s.lat, s.lng], Math.max(map.getZoom(), 10));
          }
        }
      };
    });

    var fitBtn = win.querySelector('[data-act="fit"]');
    if (fitBtn) fitBtn.onclick = function () {
      if (!map || !list.length) return;
      var pts = list.filter(function (s) { return s.lat && s.lng; })
        .map(function (s) { return [s.lat, s.lng]; });
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.1));
    };

    var filterBtn = win.querySelector('[data-act="filter-map"]');
    if (filterBtn) filterBtn.onclick = function () {
      if (cat === "buoy") {
        if ($("#showBuoys")) $("#showBuoys").checked = true;
        if ($("#showWaterLevels")) $("#showWaterLevels").checked = false;
        if ($("#showCurrents")) $("#showCurrents").checked = false;
        if ($("#typeFilter")) $("#typeFilter").value = "";
      } else if (cat === "wl") {
        if ($("#typeFilter")) $("#typeFilter").value = "waterlevels";
        if ($("#showWaterLevels")) $("#showWaterLevels").checked = true;
      } else if (cat === "curr") {
        if ($("#typeFilter")) $("#typeFilter").value = "currents";
        if ($("#showCurrents")) $("#showCurrents").checked = true;
      } else if (cat === "met") {
        if ($("#typeFilter")) $("#typeFilter").value = "met";
      } else if (cat === "fresh") {
        toast("Fresh markers pulse after each soft refresh");
      }
      applyFilters();
      toast("Map filter applied");
    };
  }

  function initLegendClicks() {
    $$(".legend-item").forEach(function (li) {
      function go() {
        var cat = li.getAttribute("data-legend");
        if (cat) openCategoryWindow(cat);
      }
      li.addEventListener("click", go);
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });
    });
  }

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
      return corsJson(DATAAPI + "?date=latest&station=" + encodeURIComponent(s.id) +
        "&product=" + p + "&datum=MLLW&units=english&time_zone=gmt&format=json")
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

      corsJson(url)
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
    var key = "buoy_" + b.id;
    function cell(label, val, unit) {
      unit = unit || "";
      var display = (val != null && val !== "") ? (val + (unit ? " " + unit : "")) : "—";
      return '<div class="meta-card"><div class="ml">' + label + '</div><div class="mv' +
        (val != null && val !== "" ? " accent" : "") + '">' + display + "</div></div>";
    }

    var caps = [];
    if (b.hasMet) caps.push("Met");
    if (b.hasCurrents) caps.push("Currents");
    if (b.hasWaterQuality) caps.push("Water quality");
    if (b.hasDart) caps.push("DART");

    var body =
      '<div class="float-tabs">' +
        '<button type="button" class="float-tab active" data-pane="obs">Observations</button>' +
        '<button type="button" class="float-tab" data-pane="meta">Station info</button>' +
        '<button type="button" class="float-tab" data-pane="series">Recent series</button>' +
      "</div>" +
      '<div data-pane-content="obs">' +
        '<div class="meta-grid">' +
          cell("Wind dir", b.wdir, "°") +
          cell("Wind speed", b.wind, "m/s") +
          cell("Gust", b.gst, "m/s") +
          cell("Wave height", b.wvht, "m") +
          cell("Dom period", b.dpd, "s") +
          cell("Avg period", b.apd, "s") +
          cell("Wave dir", b.mwd, "°") +
          cell("Pressure", b.bar, "hPa") +
          cell("Air temp", b.atmp, "°C") +
          cell("Water temp", b.wtmp, "°C") +
          cell("Dew point", b.dewp, "°C") +
          cell("Visibility", b.vis, "nmi") +
          cell("Tide", b.tide, "ft") +
          cell("Observed", b.obsTime || (b.hasObs ? "yes" : "Station not in latest_obs (not currently reporting)"), "") +
        "</div>" +
        '<div class="btn-row">' +
          '<button type="button" class="action-btn primary" data-act="center">Center map</button>' +
          '<button type="button" class="action-btn" data-act="watch">★ Watch</button>' +
        "</div>" +
      "</div>" +
      '<div data-pane-content="meta" style="display:none">' +
        '<div class="meta-grid">' +
          cell("Station ID", b.id, "") +
          cell("Name", b.name || "—", "") +
          cell("Type", b.stationType || "buoy", "") +
          cell("Owner", b.owner || "—", "") +
          cell("Program", b.program || "—", "") +
          cell("Latitude", fmtNum(b.lat, 4), "°") +
          cell("Longitude", fmtNum(b.lng, 4), "°") +
          cell("Elevation", b.elev || "—", "m") +
          cell("Capabilities", caps.length ? caps.join(", ") : "—", "") +
        "</div>" +
      "</div>" +
      '<div data-pane-content="series" style="display:none">' +
        '<div id="buoySeries_' + b.id + '" class="muted">Loading recent realtime file…</div>' +
        '<div class="chart-box" style="margin-top:10px"><canvas id="buoyChart_' + b.id + '"></canvas></div>' +
      "</div>" +
      '<div class="source-bar">' +
        "Source: NDBC · data embedded in this app from " +
        '<span class="mono">activestations.xml</span> + <span class="mono">latest_obs.txt</span>' +
        " · <a href=\"https://www.ndbc.noaa.gov/station_page.php?station=" + encodeURIComponent(b.id) +
        "\" target=\"_blank\" rel=\"noopener\">Official station page ↗</a> (reference only)" +
      "</div>";

    var win = openFloat(key, b.name || ("NDBC " + b.id), "NDBC " + b.id + (b.hasObs ? " · live obs" : " · not reporting"), body, {
      width: 460, edgeClass: "edge-buoy"
    });
    if (!win) return;

    var c = win.querySelector('[data-act="center"]');
    if (c) c.onclick = function () { if (map) map.setView([b.lat, b.lng], 9); };
    var w = win.querySelector('[data-act="watch"]');
    if (w) w.onclick = function () { addWatch(b); toast("Watching " + (b.name || b.id)); };

    // Load realtime2 series in-app
    loadBuoyRealtimeSeries(b, win);
  }

  function loadBuoyRealtimeSeries(b, win) {
    var box = win.querySelector("#buoySeries_" + b.id);
    var canvas = win.querySelector("#buoyChart_" + b.id);
    if (!box) return;
    var rtUrl = "https://www.ndbc.noaa.gov/data/realtime2/" + encodeURIComponent(b.id) + ".txt";
    corsText(rtUrl)
      .then(function (text) {
        var lines = text.trim().split("\n").filter(function (ln) {
          return ln && ln.charAt(0) !== "#";
        });
        if (lines.length && /YY|year|yr/i.test(lines[0])) lines = lines.slice(1);
        if (lines.length && /mo|dy|mm/i.test(lines[0])) lines = lines.slice(1);
        var pts = [];
        lines.slice(-72).forEach(function (ln) {
          var p = ln.trim().split(/\s+/);
          if (p.length < 15) return;
          // YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP ...
          var wtmp = p[14];
          var wspd = p[6];
          if (wtmp === "MM" && wspd === "MM") return;
          pts.push({
            t: (p[3] || "") + ":" + (p[4] || ""),
            wtmp: wtmp !== "MM" ? +wtmp : null,
            wind: wspd !== "MM" ? +wspd : null,
            wvht: p[8] !== "MM" ? +p[8] : null
          });
        });
        if (!pts.length) {
          box.textContent = "No recent numeric samples in realtime file.";
          return;
        }
        box.innerHTML = "<strong>" + pts.length + "</strong> samples from NDBC realtime2/" + b.id + ".txt";
        if (canvas && typeof Chart !== "undefined") {
          var chartKey = "buoy_rt_" + b.id;
          if (chartInstances.has(chartKey)) {
            try { chartInstances.get(chartKey).destroy(); } catch (e) {}
          }
          var useWtmp = pts.some(function (p) { return p.wtmp != null; });
          var chart = new Chart(canvas, {
            type: "line",
            data: {
              labels: pts.map(function (p) { return p.t; }),
              datasets: [{
                label: useWtmp ? "Water temp °C" : "Wind m/s",
                data: pts.map(function (p) { return useWtmp ? p.wtmp : p.wind; }),
                borderColor: "#fb923c",
                backgroundColor: "rgba(251,146,60,0.12)",
                fill: true, tension: 0.25, pointRadius: 0, borderWidth: 1.5
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: true, labels: { color: "#8b9bb4", font: { size: 11 } } } },
              scales: {
                x: { ticks: { color: "#5c6b82", maxTicksLimit: 6, font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.04)" } },
                y: { ticks: { color: "#5c6b82", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.06)" } }
              }
            }
          });
          chartInstances.set(chartKey, chart);
        }
      })
      .catch(function () {
        box.textContent = "Recent series unavailable (CORS). Live obs still shown above.";
      });
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
  // ---------- nowCOAST-style overlays via ArcGIS *export* (bbox) ----------
  // Cached Esri *tiles* paint "Zoom Level Not Supported". Dynamic /export images do not.
  // Each overlay is an ImageOverlay refreshed on moveend/zoomend.

  const NC_SERVICES = {
    alerts_nc: {
      url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer",
      opacity: 0.55,
      label: "NWS watches & warnings"
    },
    waterlevels_nc: {
      url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer",
      opacity: 0.75,
      label: "River / coastal gauges"
    },
    sfc_currents: {
      url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer",
      opacity: 0.65,
      label: "Surface flow gauges"
    },
    sst_nc: {
      url: "https://mapservices.weather.noaa.gov/raster/rest/services/NDFD/NDFD_temp/MapServer",
      opacity: 0.5,
      label: "NDFD temperature"
    },
    satellite: {
      // handled by RainViewer infrared
      special: "satellite"
    },
    tropical_nc: {
      special: "tropical"
    },
    lightning: {
      url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer",
      opacity: 0.35,
      label: "Hazard zones (lightning proxy)"
    },
    precip_amt: {
      url: "https://mapservices.weather.noaa.gov/raster/rest/services/obs/rfc_qpe/MapServer",
      opacity: 0.6,
      label: "RFC precipitation"
    },
    inland_flood: {
      url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer",
      opacity: 0.7,
      label: "Flood-related gauges"
    },
    radar: {
      special: "radar"
    }
  };

  // id -> { overlay, onMove, opacity }
  let ncOverlays = {};

  function buildExportUrl(serviceUrl, bounds, size) {
    // Use Web Mercator so the PNG matches Leaflet's projection (fixes misalignment / stretch)
    var sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
    var ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
    var xmin = Math.min(sw.x, ne.x);
    var ymin = Math.min(sw.y, ne.y);
    var xmax = Math.max(sw.x, ne.x);
    var ymax = Math.max(sw.y, ne.y);
    var w = Math.max(64, Math.min(1920, Math.round(size.x)));
    var h = Math.max(64, Math.min(1080, Math.round(size.y)));
    return serviceUrl + "/export"
      + "?bbox=" + encodeURIComponent(xmin + "," + ymin + "," + xmax + "," + ymax)
      + "&bboxSR=3857&imageSR=3857"
      + "&size=" + w + "," + h
      + "&dpi=96&format=png32&transparent=true&f=image";
  }

  function refreshExportOverlay(id) {
    var entry = ncOverlays[id];
    if (!entry || !map) return;
    var def = NC_SERVICES[id];
    if (!def || !def.url) return;
    // Exact map bounds — no pad (pad caused overlap / drift)
    var bounds = map.getBounds();
    var size = map.getSize();
    var url = buildExportUrl(def.url, bounds, size) + "&_ts=" + Date.now();

    if (entry.overlay) {
      entry.overlay.setUrl(url);
      entry.overlay.setBounds(bounds);
      entry.overlay.setOpacity(entry.opacity);
    } else {
      entry.overlay = L.imageOverlay(url, bounds, {
        opacity: entry.opacity,
        interactive: false,
        className: "nc-export-overlay",
        zIndex: 350 + Object.keys(ncOverlays).length,
        crossOrigin: true
      });
      entry.overlay.addTo(map);
    }
  }

  function addExportOverlay(id) {
    var def = NC_SERVICES[id];
    if (!def || !def.url || !map) return;
    if (ncOverlays[id]) return;
    var opacity = def.opacity != null ? def.opacity : 0.6;
    ncOverlays[id] = { overlay: null, opacity: opacity, onMove: null };
    var refresh = function () { refreshExportOverlay(id); };
    ncOverlays[id].onMove = refresh;
    var tmr = null;
    var debounced = function () {
      clearTimeout(tmr);
      tmr = setTimeout(refresh, 400);
    };
    map.on("moveend", debounced);
    map.on("zoomend", debounced);
    ncOverlays[id].onMove = debounced;
    refresh();
    if (def.label) toast(def.label + " on", 1600);
  }

  function removeExportOverlay(id) {
    var entry = ncOverlays[id];
    if (!entry) return;
    if (entry.onMove && map) {
      map.off("moveend", entry.onMove);
      map.off("zoomend", entry.onMove);
    }
    if (entry.overlay && map) {
      try { map.removeLayer(entry.overlay); } catch (e) {}
    }
    delete ncOverlays[id];
  }

  function toggleNcLayer(id, on) {
    var def = NC_SERVICES[id];
    if (!def) return;

    if (def.special === "tropical") {
      if (on) {
        if (!tropicalStorms.length) loadTropicalStorms();
        else renderTropicalStorms();
      } else if (tropicalLayer) {
        tropicalLayer.clearLayers();
      }
      return;
    }
    if (def.special === "radar") {
      var box = $("#radarControls");
      if (box) box.classList.toggle("hidden", !on);
      if (on) startRadar("radar");
      else stopRadar();
      return;
    }
    if (def.special === "satellite") {
      var box2 = $("#radarControls");
      if (box2) box2.classList.toggle("hidden", !on);
      if (on) startRadar("satellite");
      else {
        var rad = $('input[data-nc="radar"]');
        if (rad && rad.checked) startRadar("radar");
        else stopRadar();
      }
      return;
    }

    if (on) addExportOverlay(id);
    else removeExportOverlay(id);

    // Keep NWS vector polygons in sync for alerts
    if (id === "alerts_nc") {
      if (on) {
        if ($("#showWarnings")) $("#showWarnings").checked = true;
        drawAlertZones();
      }
    }
  }

  function initNowCoast() {
    $$("input[data-nc]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        toggleNcLayer(cb.dataset.nc, cb.checked);
        saveLayoutLocal();
      });
      if (cb.checked) {
        (function (id) {
          setTimeout(function () { toggleNcLayer(id, true); }, 600);
        })(cb.dataset.nc);
      }
    });

    var play = $("#radarPlayBtn");
    var prev = $("#radarPrevBtn");
    var next = $("#radarNextBtn");
    var refr = $("#radarRefreshBtn");
    var opac = $("#radarOpacity");
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
      var v = (+opac.value) / 100;
      if (radarState.layer) radarState.layer.setOpacity(v);
    };
    if (refr) refr.onclick = function () {
      var sat = $('input[data-nc="satellite"]');
      startRadar(sat && sat.checked && (!$('input[data-nc="radar"]') || !$('input[data-nc="radar"]').checked) ? "satellite" : "radar");
    };
  }

  function transparentGif() {
    return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }

  function startRadar(mode) {
    mode = mode || "radar";
    stopRadar();
    radarState.mode = mode;
    fetch("https://api.rainviewer.com/public/weather-maps.json")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var frames = [];
        if (mode === "satellite" && j.satellite && j.satellite.infrared) {
          frames = (j.satellite.infrared || []).slice(-12);
        } else {
          var past = (j.radar && j.radar.past) || [];
          var nowc = (j.radar && j.radar.nowcast) || [];
          frames = past.concat(nowc).slice(-12);
        }
        radarState.frames = frames.map(function (f) {
          return {
            time: f.time,
            url: "https://tilecache.rainviewer.com" + f.path + "/256/{z}/{x}/{y}/2/1_1.png"
          };
        });
        if (!radarState.frames.length) {
          toast("No frames available");
          return;
        }
        radarState.idx = radarState.frames.length - 1;
        showRadarFrame();
        radarState.playing = true;
        if ($("#radarPlayBtn")) $("#radarPlayBtn").textContent = "⏸";
        var box = $("#radarControls");
        if (box) box.classList.remove("hidden");
        tickRadar();
      })
      .catch(function () { toast("Radar/satellite unavailable"); });
  }

  function showRadarFrame() {
    if (!map) return;
    var f = radarState.frames[radarState.idx];
    if (!f) return;
    if (radarState.layer) {
      try { map.removeLayer(radarState.layer); } catch (e) {}
    }
    var op = ($("#radarOpacity") && +$("#radarOpacity").value) || 70;
    radarState.layer = L.tileLayer(f.url, {
      opacity: op / 100,
      zIndex: 450,
      maxNativeZoom: 7,
      maxZoom: 19,
      tileSize: 256,
      errorTileUrl: transparentGif()
    });
    radarState.layer.on("tileerror", function (ev) {
      if (ev.tile) {
        ev.tile.src = transparentGif();
        ev.tile.style.opacity = "0";
      }
    });
    radarState.layer.addTo(map);
    var d = new Date(f.time * 1000);
    if ($("#radarFrameLabel")) {
      $("#radarFrameLabel").textContent = "Frame " + (radarState.idx + 1) + "/" + radarState.frames.length;
    }
    if ($("#radarTimeLabel")) {
      $("#radarTimeLabel").textContent = d.toISOString().slice(11, 16) + " UTC";
    }
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
      try { map.removeLayer(radarState.layer); } catch (e) {}
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
    Promise.all([refreshAllWatches(), loadNwsAlerts(), loadBuoys(), loadTropicalStorms()])
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
      initLegendClicks();

      const params = new URLSearchParams(location.search);
      const layoutUrl = params.get("layout");
      if (layoutUrl) loadLayoutFromUrl(layoutUrl);
      else loadLayoutLocal();

      // parallel data load — don't block UI
      loadStations();
      loadBuoys();
      loadTropicalStorms();
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
