/* TIDES & CURRENTS XPLR
   NOAA CO-OPS powered dashboard — Martian ARM aesthetic
   Updated: full coastal states, richer station modal, Mid-Atlantic pin,
   2-min realtime, SOL chime, watch mode, product overlays on map
*/

const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi";
const DATAAPI = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

// State
let allStations = [];
let waterStations = [];
let currentStations = [];
let markersLayer = null;
let clusterGroup = null;
let map = null;
let currentBasemap = null;
let selectedStation = null;
let chartInstance = null;
let useClusters = true;
let watchedStation = null;
let lastDataHash = {};          // for detecting updates → chime
let overlayMode = "none";       // none | water_level | air_temperature | ... | all
let latestValues = {};          // stationId -> {product: value}
let buoyStations = [];          // NDBC buoys from latest_obs
let showBuoys = true;
let soundEnabled = true;
let watchedList = [];           // array of {id, name, type, data}
let buoyLayer = null;
let tidePredStations = [];
let showTidePred = true;
let tidePredLayer = null;
let nwsAlerts = [];
let nwsAlertLayer = null;
let showWarnings = true;
let freshIds = new Set();       // stations with recent data updates (for pulse)

// Priority Mid-Atlantic stations (pinned top of Active)
const MID_ATLANTIC_PRIORITY = [
  "8534720", // Atlantic City, NJ
  "8536110", // Cape May, NJ
  "8551910", // Reedy Point, DE
  "8557380", // Lewes, DE
  "8545240", // Philadelphia (Pier 11), PA
  "8545530", // Marcus Hook, PA
  "8574680", // Baltimore, MD
  "8575512", // Annapolis, MD
  "8571892", // Cambridge, MD
  "8577330", // Solomons Island, MD
  "8638610", // Sewells Point, VA (nearby)
  "8632200"  // Kiptopeke, VA
];

// Broader highlight pool
const HIGHLIGHT_IDS = [
  ...MID_ATLANTIC_PRIORITY,
  "9414290", "8518750", "8723214", "9447130", "8761724",
  "8452660", "1612340", "9414750", "8771450", "9410840",
  "8726520", "8665530", "8443970", "8729840", "8760922"
];

// All US coastal + Great Lakes + territories for Quick States
const COASTAL_STATES = [
  "AK","AL","CA","CT","DE","FL","GA","HI","LA","ME","MD","MA",
  "MS","NH","NJ","NY","NC","OR","PA","RI","SC","TX","VA","WA",
  "DC","PR","VI","GU","AS","MP"
];

// ========== INIT ==========
document.addEventListener("DOMContentLoaded", async () => {
  setInterval(() => { if (typeof loadNwsWarnings === 'function') loadNwsWarnings(); }, 5 * 60 * 1000);
  initClock();
  initMap();
  bindUI();
  if (typeof bindNowcoastUI === 'function') bindNowcoastUI();
  await loadStations();
  await loadBuoys();
  await loadTidePredStations();
  loadNwsWarnings();
  populateFilters();
  populateWatchDropdowns();
  renderMarkers();
  loadActivePanel();
  // Realtime refresh every 2 minutes
  setInterval(() => {
    loadActivePanel(true);
    refreshAllWatches();
    if (selectedStation) {
      const activeTab = document.querySelector(".tab.active");
      if (activeTab && activeTab.dataset.tab === "latest") loadTab("latest", true);
    }
  }, 2 * 60 * 1000);
});

// ========== CLOCK ==========
function initClock() {
  const el = document.getElementById("utcClock");
  function tick() {
    el.textContent = new Date().toISOString().substr(11, 8);
  }
  tick();
  setInterval(tick, 1000);
}

// ========== SOL CHIME (Web Audio approximation of The Martian Sol ping) ==========
function playSolChime() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;

    // Main bright ping
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(1240, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.18);
    gain1.gain.setValueAtTime(0.28, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);

    // Secondary higher harmonic (the "digital" edge)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(1760, now);
    gain2.gain.setValueAtTime(0.12, now);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now);
    osc2.stop(now + 0.3);

    // Soft low thump
    const osc3 = ctx.createOscillator();
    const gain3 = ctx.createGain();
    osc3.type = "sine";
    osc3.frequency.setValueAtTime(180, now);
    gain3.gain.setValueAtTime(0.15, now);
    gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc3.connect(gain3);
    gain3.connect(ctx.destination);
    osc3.start(now);
    osc3.stop(now + 0.22);
  } catch (e) {
    console.warn("Audio chime failed", e);
  }
}

// ========== MAP ==========
function initMap() {
  map = L.map("map", {
    center: [39.0, -75.5], // Mid-Atlantic default bias
    zoom: 6,
    zoomControl: false,
    attributionControl: true
  });

  // Zoom +/- top-right so they don't cover bottom/left data
  L.control.zoom({ position: "topright" }).addTo(map);

  setBasemap("dark");

  map.on("mousemove", (e) => {
    document.getElementById("mapCoords").textContent =
      `LAT ${e.latlng.lat.toFixed(4)}  LON ${e.latlng.lng.toFixed(4)}`;
  });
  map.on("zoomend", () => {
    document.getElementById("zoomLevel").textContent = `Z ${map.getZoom()}`;
  });
  document.getElementById("zoomLevel").textContent = `Z ${map.getZoom()}`;

  map.attributionControl.setPrefix("");
  map.attributionControl.addAttribution(
    "ESRI · TomTom · Garmin · FAO · NOAA · USGS | CO-OPS"
  );
}

function setBasemap(type) {
  if (currentBasemap) map.removeLayer(currentBasemap);

  const attributions = {
    dark: "Esri, TomTom, Garmin, FAO, NOAA, USGS",
    imagery: "Esri, Maxar, Earthstar Geographics",
    topo: "Esri, USGS, NOAA",
    streets: "Esri, TomTom, Garmin, FAO, NOAA, USGS",
    ocean: "Esri, GEBCO, NOAA, National Geographic, Garmin"
  };

  if (type === "dark") currentBasemap = L.esri.basemapLayer("DarkGray");
  else if (type === "imagery") currentBasemap = L.esri.basemapLayer("Imagery");
  else if (type === "topo") currentBasemap = L.esri.basemapLayer("Topographic");
  else if (type === "streets") currentBasemap = L.esri.basemapLayer("Streets");
  else if (type === "ocean") currentBasemap = L.esri.basemapLayer("Oceans");

  currentBasemap.addTo(map);

  document.querySelectorAll(".bm-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.bm === type);
  });
}

// ========== DATA LOADING ==========
async function loadStations() {
  showToast("Loading NOAA station inventory...");
  try {
    const [wlRes, curRes] = await Promise.all([
      fetch(`${MDAPI}/stations.json?type=waterlevels&status=active`).then((r) => r.json()),
      fetch(`${MDAPI}/stations.json?type=currents&status=active`).then((r) => r.json())
    ]);

    waterStations = (wlRes.stations || []).map((s) => ({
      ...s,
      type: "waterlevels",
      isPorts: !!(s.portscode || (s.affiliations && String(s.affiliations).includes("PORTS"))),
      lat: s.lat,
      lng: s.lng
    }));

    currentStations = (curRes.stations || []).map((s) => ({
      ...s,
      type: "currents",
      isPorts: true,
      lat: s.lat,
      lng: s.lng,
      state: s.state || inferState(s.lat, s.lng)
    }));

    allStations = [...waterStations, ...currentStations];

    const sc = document.getElementById("stationCount");
    if (sc) sc.textContent = allStations.length;
    const bc = document.getElementById("buoyCount");
    // buoy count set later by loadBuoys
    showToast(`Loaded ${waterStations.length} water + ${currentStations.length} current stations`);
  } catch (err) {
    console.error(err);
    showToast("Failed to load stations");
  }
}

function inferState(lat, lng) {
  if (lat > 38.5 && lat < 41.5 && lng > -75.6 && lng < -73.8) return "NJ";
  if (lat > 39.5 && lat < 41.5 && lng > -76.5 && lng < -74.5) return "PA";
  if (lat > 38.4 && lat < 39.9 && lng > -75.8 && lng < -74.9) return "DE";
  if (lat > 37.8 && lat < 39.8 && lng > -77.5 && lng < -75.0) return "MD";
  return "";
}

// ========== FILTERS & MARKERS ==========
function populateFilters() {
  const states = [...new Set(allStations.map((s) => s.state).filter(Boolean))].sort();
  const sel = document.getElementById("stateFilter");
  states.forEach((st) => {
    const opt = document.createElement("option");
    opt.value = st;
    opt.textContent = st;
    sel.appendChild(opt);
  });

  // Full coastal quick states
  const qs = document.getElementById("quickStates");
  qs.innerHTML = "";
  COASTAL_STATES.forEach((st) => {
    if (states.includes(st) || ["PA","DC","PR","VI","GU","AS","MP"].includes(st)) {
      const btn = document.createElement("button");
      btn.className = "qs-btn";
      btn.textContent = st;
      btn.onclick = () => {
        document.getElementById("stateFilter").value = st;
        applyFilters();
      };
      qs.appendChild(btn);
    }
  });
}

function getFilteredStations() {
  const state = document.getElementById("stateFilter").value;
  const type = document.getElementById("typeFilter").value;
  const showWL = document.getElementById("showWaterLevels").checked;
  const showCur = document.getElementById("showCurrents").checked;
  const portsOnly = document.getElementById("showPorts").checked;

  return allStations.filter((s) => {
    if (state && s.state !== state) return false;
    if (type === "waterlevels" && s.type !== "waterlevels") return false;
    if (type === "currents" && s.type !== "currents") return false;
    if (type === "ports" && !s.isPorts) return false;
    if (type === "met") return s.type === "waterlevels";
    if (!showWL && s.type === "waterlevels") return false;
    if (!showCur && s.type === "currents") return false;
    if (portsOnly && !s.isPorts) return false;
    return true;
  });
}

function colorForOverlay(station) {
  if (overlayMode === "none") {
    if (station.type === "currents") return "#00b894";
    if (station.isPorts) return "#e67e22";
    return "#3498db";
  }
  const vals = latestValues[station.id];
  if (!vals) return "#555";

  if (overlayMode === "all") {
    // multi-hue based on presence
    if (vals.water_level != null) return "#3498db";
    if (vals.currents != null) return "#00b894";
    if (vals.air_temperature != null) return "#e74c3c";
    return "#888";
  }

  const v = vals[overlayMode];
  if (v == null) return "#444";

  // simple sequential color scales
  if (overlayMode === "water_level") {
    // blue → cyan → yellow → red for higher water
    const t = Math.max(0, Math.min(1, (parseFloat(v) + 2) / 8));
    return lerpColor("#2980b9", "#f1c40f", t);
  }
  if (overlayMode === "air_temperature" || overlayMode === "water_temperature") {
    const t = Math.max(0, Math.min(1, (parseFloat(v) - 40) / 50));
    return lerpColor("#3498db", "#e74c3c", t);
  }
  if (overlayMode === "air_pressure") {
    const t = Math.max(0, Math.min(1, (parseFloat(v) - 980) / 50));
    return lerpColor("#9b59b6", "#2ecc71", t);
  }
  if (overlayMode === "wind") {
    const t = Math.max(0, Math.min(1, parseFloat(v) / 30));
    return lerpColor("#f1c40f", "#e74c3c", t);
  }
  return "#e67e22";
}

function lerpColor(a, b, t) {
  const ah = parseInt(a.replace("#", ""), 16);
  const bh = parseInt(b.replace("#", ""), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) + (rr << 16) + (rg << 8) + rb).toString(16).slice(1)}`;
}

function renderMarkers() {
  if (clusterGroup) { map.removeLayer(clusterGroup); clusterGroup = null; }
  if (markersLayer) { map.removeLayer(markersLayer); markersLayer = null; }

  const stations = getFilteredStations();
  const group = useClusters
    ? L.markerClusterGroup({ maxClusterRadius: 42, spiderfyOnMaxZoom: true, showCoverageOnHover: false })
    : L.layerGroup();

  stations.forEach((s) => {
    if (!s.lat || !s.lng) return;
    const col = colorForOverlay(s);
    const size = (overlayMode !== "none" && latestValues[s.id]) ? 16 : 13;

    const icon = L.divIcon({
      className: "",
      html: `<div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:${col};border:2px solid #fff;
        box-shadow:0 0 6px rgba(0,0,0,0.7);cursor:pointer;
      " title="${s.name}"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });

    const marker = L.marker([s.lat, s.lng], { icon });
    let tip = `<strong>${s.name}</strong><br/>${s.id} · ${s.state || ""} · ${s.type}`;
    if (latestValues[s.id]) {
      const lv = latestValues[s.id];
      if (lv.water_level != null) tip += `<br/>WL: ${lv.water_level} ft`;
      if (lv.air_temperature != null) tip += `<br/>Air: ${lv.air_temperature}°F`;
      if (lv.wind != null) tip += `<br/>Wind: ${lv.wind} kn`;
    }
    marker.bindTooltip(tip, { direction: "top", offset: [0, -8] });
    marker.on("click", () => openStation(s));
    group.addLayer(marker);
  });

  group.addTo(map);
  if (useClusters) clusterGroup = group;
  else markersLayer = group;

  document.getElementById("stationCount").textContent = stations.length;
}

function applyFilters() {
  renderMarkers();
  const stations = getFilteredStations();
  if (stations.length && stations.length < 100) {
    const bounds = L.latLngBounds(stations.map((s) => [s.lat, s.lng]));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
  }
}

// ========== ACTIVE / REALTIME PANEL ==========
async function loadActivePanel(isAuto = false) {
  const list = document.getElementById("activeList");
  if (!isAuto) list.innerHTML = `<div class="loading">FETCHING LATEST OBSERVATIONS...</div>`;

  // Build ordered list: Mid-Atlantic first, then others
  const mid = MID_ATLANTIC_PRIORITY
    .map((id) => allStations.find((s) => s.id === id))
    .filter(Boolean);

  const rest = HIGHLIGHT_IDS
    .filter((id) => !MID_ATLANTIC_PRIORITY.includes(id))
    .map((id) => allStations.find((s) => s.id === id))
    .filter(Boolean);

  const toFetch = [...mid, ...rest].slice(0, 18);
  if (!toFetch.length) {
    list.innerHTML = `<div class="loading">No stations loaded yet</div>`;
    return;
  }

  const results = await Promise.allSettled(
    toFetch.map(async (s) => {
      const data = await fetchLatest(s.id, "water_level");
      return { station: s, data };
    })
  );

  let anyUpdate = false;
  const frag = document.createDocumentFragment();

  // Section header for pinned
  const pinHeader = document.createElement("div");
  pinHeader.className = "active-section-header";
  pinHeader.textContent = "▸ MID-ATLANTIC (NJ · PA · DE · MD)";
  frag.appendChild(pinHeader);

  let midCount = 0;
  results.forEach((r, idx) => {
    if (r.status !== "fulfilled" || !r.value.data) return;
    const { station, data } = r.value;
    const isMid = MID_ATLANTIC_PRIORITY.includes(station.id);

    // Detect change for chime
    const key = station.id + "_wl";
    const newHash = `${data.v}|${data.t}`;
    if (lastDataHash[key] && lastDataHash[key] !== newHash) anyUpdate = true;
    lastDataHash[key] = newHash;

    // Cache for overlays
    if (!latestValues[station.id]) latestValues[station.id] = {};
    latestValues[station.id].water_level = data.v;

    if (isMid) midCount++;
    if (idx === mid.length && midCount > 0) {
      const otherHeader = document.createElement("div");
      otherHeader.className = "active-section-header";
      otherHeader.textContent = "▸ OTHER ACTIVE SITES";
      frag.appendChild(otherHeader);
    }

    const item = document.createElement("div");
    item.className = "active-item" + (isMid ? " pinned" : "");
    item.innerHTML = `
      <div class="name">${isMid ? "★ " : ""}${station.name}</div>
      <div class="meta">${station.id} · ${station.state || ""} · ${station.type}</div>
      <div class="val">${data.v != null ? data.v + " ft" : "—"}
        <span style="color:var(--text-muted);font-size:10px"> ${data.t || ""}</span>
      </div>
    `;
    item.onclick = () => openStation(station);
    frag.appendChild(item);
  });

  list.innerHTML = "";
  list.appendChild(frag);

  if (anyUpdate && isAuto) {
    playSolChime();
    showToast("Realtime data updated — SOL chime");
  }

  // If overlay is active, recolor markers
  if (overlayMode !== "none") renderMarkers();
}

async function fetchLatest(stationId, product = "water_level") {
  try {
    let url = `${DATAAPI}?date=latest&station=${stationId}&product=${product}&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
    if (product === "water_level") url += "&datum=MLLW";
    if (product === "currents") url += "&bin=1";
    const res = await fetch(url);
    const json = await res.json();
    if (json.data && json.data.length) return json.data[0];
    return null;
  } catch {
    return null;
  }
}

// ========== STATION MODAL ==========
async function openStation(station) {
  selectedStation = station;
  const modal = document.getElementById("stationModal");
  modal.classList.remove("hidden");

  document.getElementById("modalStationName").textContent = station.name || "UNKNOWN";
  document.getElementById("modalStationId").textContent = station.id;
  document.getElementById("officialLink").href =
    station.type === "currents"
      ? `https://tidesandcurrents.noaa.gov/cdata/StationInfo?id=${station.id}`
      : `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station.id}`;

  // Richer meta like official page
  const meta = document.getElementById("modalMeta");
  meta.innerHTML = `
    <div class="meta-item"><div class="mlabel">LATITUDE</div><div class="mval">${station.lat?.toFixed(5) ?? "—"}</div></div>
    <div class="meta-item"><div class="mlabel">LONGITUDE</div><div class="mval">${station.lng?.toFixed(5) ?? "—"}</div></div>
    <div class="meta-item"><div class="mlabel">STATE</div><div class="mval">${station.state || "—"}</div></div>
    <div class="meta-item"><div class="mlabel">TYPE</div><div class="mval">${station.type?.toUpperCase()}</div></div>
    <div class="meta-item"><div class="mlabel">PORTS®</div><div class="mval">${station.isPorts ? "YES · " + (station.portscode || "") : "NO"}</div></div>
    <div class="meta-item"><div class="mlabel">AFFILIATIONS</div><div class="mval">${station.affiliations || "—"}</div></div>
    <div class="meta-item"><div class="mlabel">TIMEZONE</div><div class="mval">${station.timezone || "—"}</div></div>
    <div class="meta-item"><div class="mlabel">TIDAL</div><div class="mval">${station.tidal ? "YES" : "NO"} · ${station.tideType || ""}</div></div>
  `;

  // Watch button — adds to bottom watch strip
  const watchBtn = document.getElementById("watchBtn");
  if (watchBtn) {
    const already = watchedList.some(w => w.id === station.id);
    watchBtn.textContent = already ? "★ ON WATCH" : "☆ WATCH";
    watchBtn.classList.toggle("active", already);
    watchBtn.onclick = () => {
      addToWatch(station.id);
      watchBtn.textContent = "★ ON WATCH";
      watchBtn.classList.add("active");
      showToast(`Added ${station.name} to watch panel`);
    };
  }

  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tab[data-tab="latest"]').classList.add("active");
  await loadTab("latest");
}

function closeModal() {
  document.getElementById("stationModal").classList.add("hidden");
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  selectedStation = null;
}

async function loadTab(tab, quiet = false) {
  const content = document.getElementById("tabContent");
  if (!quiet) content.innerHTML = `<div class="loading">FETCHING DATA...</div>`;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const s = selectedStation;
  if (!s) return;

  try {
    if (tab === "latest") await renderLatest(s, content);
    else if (tab === "water") await renderTimeSeries(s, content, "water_level", "Water Level (ft MLLW)");
    else if (tab === "met") await renderMet(s, content);
    else if (tab === "currents") await renderCurrents(s, content);
    else if (tab === "predictions") await renderPredictions(s, content);
    else if (tab === "datums") await renderDatums(s, content);
    else if (tab === "flood") await renderFlood(s, content);
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
  }
}

async function renderLatest(station, container) {
  const products = station.type === "currents"
    ? ["currents"]
    : [
        "water_level", "predictions", "air_temperature", "water_temperature",
        "air_pressure", "wind", "visibility", "humidity", "conductivity", "air_gap"
      ];

  const cards = [];
  for (const prod of products) {
    try {
      let url = `${DATAAPI}?date=latest&station=${station.id}&product=${prod}&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
      if (prod === "water_level" || prod === "predictions") url += "&datum=MLLW";
      if (prod === "currents") url += "&bin=1";
      if (prod === "predictions") url += "&interval=hilo";

      const res = await fetch(url);
      const json = await res.json();

      if (prod === "predictions" && json.predictions && json.predictions.length) {
        const next = json.predictions[0];
        cards.push(`
          <div class="data-card highlight">
            <div class="dlabel">NEXT TIDE (${next.type || ""})</div>
            <div class="dval">${next.v}<span class="dunit">ft</span></div>
            <div class="dtime">${next.t}</div>
          </div>
        `);
        continue;
      }

      if (json.data && json.data[0]) {
        const d = json.data[0];
        let label = prod.replace(/_/g, " ").toUpperCase();
        let val = d.v ?? d.s ?? "—";
        let unit = "";
        let extra = "";

        if (prod === "water_level") { unit = "ft MLLW"; label = "WATER LEVEL"; }
        else if (prod === "air_temperature" || prod === "water_temperature") unit = "°F";
        else if (prod === "air_pressure") unit = "mb";
        else if (prod === "wind") {
          val = d.s ?? "—"; unit = "kn";
          extra = d.d != null ? ` @ ${d.d}°` : "";
          if (d.g) extra += ` G${d.g}`;
        }
        else if (prod === "visibility") unit = "nm";
        else if (prod === "humidity") unit = "%";
        else if (prod === "conductivity") unit = "mS/cm";
        else if (prod === "air_gap") unit = "ft";
        else if (prod === "currents") {
          val = d.s ?? "—"; unit = "kn";
          extra = d.d != null ? ` @ ${d.d}°` : "";
        }

        // cache
        if (!latestValues[station.id]) latestValues[station.id] = {};
        latestValues[station.id][prod] = val;

        cards.push(`
          <div class="data-card">
            <div class="dlabel">${label}</div>
            <div class="dval">${val}<span class="dunit">${unit}${extra}</span></div>
            <div class="dtime">${d.t || ""}</div>
          </div>
        `);
      }
    } catch (_) {}
  }

  // Add residual / observed vs predicted if we have both
  try {
    const obs = await fetchLatest(station.id, "water_level");
    const predUrl = `${DATAAPI}?date=latest&station=${station.id}&product=predictions&datum=MLLW&time_zone=gmt&units=english&interval=h&format=json&application=tides-currents-xplr`;
    const predRes = await fetch(predUrl);
    const predJson = await predRes.json();
    if (obs && predJson.predictions && predJson.predictions.length) {
      const p = parseFloat(predJson.predictions[0].v);
      const o = parseFloat(obs.v);
      if (!isNaN(p) && !isNaN(o)) {
        const residual = (o - p).toFixed(2);
        cards.push(`
          <div class="data-card">
            <div class="dlabel">RESIDUAL (OBS − PRED)</div>
            <div class="dval">${residual}<span class="dunit">ft</span></div>
            <div class="dtime">Observed vs predicted</div>
          </div>
        `);
      }
    }
  } catch (_) {}

  if (!cards.length) {
    container.innerHTML = `<div class="loading">No latest observations available</div>`;
  } else {
    container.innerHTML = `<div class="data-grid">${cards.join("")}</div>`;
  }
  document.getElementById("modalUpdateTime").textContent =
    `Updated ${new Date().toISOString().substr(11, 8)} UTC`;
}

async function renderTimeSeries(station, container, product, title) {
  const end = new Date();
  const begin = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  let url = `${DATAAPI}?begin_date=${fmt(begin)}&end_date=${fmt(end)}&station=${station.id}&product=${product}&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
  if (product === "water_level") url += "&datum=MLLW";

  const res = await fetch(url);
  const json = await res.json();
  if (!json.data || !json.data.length) {
    container.innerHTML = `<div class="loading">No time series data available</div>`;
    return;
  }

  const labels = json.data.map((d) => d.t);
  const values = json.data.map((d) => parseFloat(d.v));

  container.innerHTML = `
    <div style="color:var(--text-dim);font-size:11px;margin-bottom:6px">${title} — last 24h</div>
    <div class="chart-wrap"><canvas id="tsChart"></canvas></div>
  `;

  const ctx = document.getElementById("tsChart").getContext("2d");
  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: (station?.name ? station.name + " — " : "") + title,
        data: values,
        borderColor: "#e67e22",
        backgroundColor: "rgba(230,126,34,0.12)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#5a6a7a", maxTicksLimit: 8, font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        y: { ticks: { color: "#5a6a7a", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.06)" } }
      }
    }
  });
}

async function renderMet(station, container) {
  const products = [
    { key: "air_temperature", label: "AIR TEMP (°F)" },
    { key: "water_temperature", label: "WATER TEMP (°F)" },
    { key: "air_pressure", label: "PRESSURE (mb)" },
    { key: "wind", label: "WIND" },
    { key: "visibility", label: "VISIBILITY (nm)" },
    { key: "humidity", label: "HUMIDITY (%)" },
    { key: "conductivity", label: "CONDUCTIVITY" }
  ];

  const cards = [];
  for (const p of products) {
    try {
      const url = `${DATAAPI}?date=latest&station=${station.id}&product=${p.key}&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.data && json.data[0]) {
        const d = json.data[0];
        let val = d.v ?? d.s ?? "—";
        let extra = "";
        if (p.key === "wind") {
          extra = d.d != null ? ` ${d.d}°` : "";
          if (d.g) extra += ` G${d.g}`;
        }
        cards.push(`
          <div class="data-card">
            <div class="dlabel">${p.label}</div>
            <div class="dval">${val}<span class="dunit">${extra}</span></div>
            <div class="dtime">${d.t || ""}</div>
          </div>
        `);
      }
    } catch (_) {}
  }

  container.innerHTML = cards.length
    ? `<div class="data-grid">${cards.join("")}</div>`
    : `<div class="loading">No meteorological sensors / data at this station</div>`;
}

async function renderCurrents(station, container) {
  // Observed currents (PORTS meters) OR predicted currents if available
  const isCurrentMeter = station.type === "currents";
  container.innerHTML = `<div class="loading">LOADING CURRENTS OVER TIME...</div>`;

  try {
    const end = new Date();
    const begin = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const fmt = (d) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

    let series = null;
    let latest = null;

    if (isCurrentMeter) {
      // Observed currents last 24h
      let url = `${DATAAPI}?begin_date=${fmt(begin)}&end_date=${fmt(end)}&station=${station.id}&product=currents&bin=1&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.data && json.data.length) {
        series = json.data.map(d => ({ t: d.t, s: parseFloat(d.s), d: parseFloat(d.d) })).filter(x => !isNaN(x.s));
        latest = json.data[json.data.length - 1];
      }
    }

    // Also try currents_predictions for stations that support it
    if (!series || series.length < 2) {
      try {
        const url2 = `${DATAAPI}?begin_date=${fmt(begin)}&range=24&station=${station.id}&product=currents_predictions&time_zone=gmt&units=english&interval=h&format=json&application=tides-currents-xplr`;
        const res2 = await fetch(url2);
        const json2 = await res2.json();
        const rows = json2.current_predictions || json2.predictions || json2.data;
        if (rows && rows.length) {
          series = rows.map(d => ({
            t: d.t || d.Time,
            s: parseFloat(d.s ?? d.Speed ?? d.Velocity_Major),
            d: parseFloat(d.d ?? d.Direction)
          })).filter(x => !isNaN(x.s));
          if (!latest && series.length) latest = { s: series[series.length-1].s, d: series[series.length-1].d, t: series[series.length-1].t };
        }
      } catch (_) {}
    }

    if (!series || !series.length) {
      container.innerHTML = `<div class="loading">No current observations or predictions available for this station.<br/>Try a PORTS current meter (teal markers) or a station with current predictions.</div>`;
      return;
    }

    let cards = "";
    if (latest) {
      cards = `
        <div class="data-grid" style="margin-bottom:12px">
          <div class="data-card highlight"><div class="dlabel">SPEED</div><div class="dval">${latest.s ?? series[series.length-1].s}<span class="dunit">kn</span></div><div class="dtime">${latest.t || ""}</div></div>
          <div class="data-card"><div class="dlabel">DIRECTION</div><div class="dval">${latest.d ?? series[series.length-1].d ?? "—"}<span class="dunit">°</span></div></div>
          <div class="data-card"><div class="dlabel">POINTS</div><div class="dval">${series.length}</div><div class="dtime">last ~24h</div></div>
        </div>`;
    }

    container.innerHTML = `
      ${cards}
      <div style="color:var(--text-dim);font-size:11px;margin-bottom:6px">CURRENT SPEED OVER TIME</div>
      <div class="chart-wrap"><canvas id="currChart"></canvas></div>
    `;

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const ctx = document.getElementById("currChart").getContext("2d");
    chartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels: series.map(x => x.t),
        datasets: [{
          label: (station?.name ? station.name + " — " : "") + "Speed (kn)",
          data: series.map(x => x.s),
          borderColor: "#00b894",
          backgroundColor: "rgba(0,184,148,0.12)",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.25,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#5a6a7a", maxTicksLimit: 8, font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.04)" } },
          y: { ticks: { color: "#5a6a7a", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.06)" }, title: { display: true, text: "kn", color: "#5a6a7a" } }
        }
      }
    });
  } catch (err) {
    container.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
  }
}

async function renderPredictions(station, container) {
  if (station.type === "currents") {
    container.innerHTML = `<div class="loading">Tide predictions apply to water level stations.</div>`;
    return;
  }
  const today = new Date();
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  const url = `${DATAAPI}?begin_date=${fmt(today)}&range=72&station=${station.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json&application=tides-currents-xplr`;
  const res = await fetch(url);
  const json = await res.json();

  if (!json.predictions || !json.predictions.length) {
    container.innerHTML = `<div class="loading">No tide predictions available</div>`;
    return;
  }

  const rows = json.predictions.slice(0, 16).map((p) => `
    <div class="data-card">
      <div class="dlabel">${p.type || "TIDE"}</div>
      <div class="dval">${p.v}<span class="dunit">ft</span></div>
      <div class="dtime">${p.t}</div>
    </div>
  `).join("");

  container.innerHTML = `
    <div style="color:var(--text-dim);font-size:11px;margin-bottom:8px">HIGH / LOW PREDICTIONS (next ~72h)</div>
    <div class="data-grid">${rows}</div>
  `;
}

async function renderDatums(station, container) {
  try {
    const res = await fetch(`${MDAPI}/stations/${station.id}/datums.json?units=english`);
    const json = await res.json();
    if (!json.datums || !json.datums.length) {
      container.innerHTML = `<div class="loading">No datum information available</div>`;
      return;
    }
    const cards = json.datums.map((d) => `
      <div class="data-card">
        <div class="dlabel">${d.name || d.abbr}</div>
        <div class="dval">${d.value}<span class="dunit">ft</span></div>
        <div class="dtime">${d.description || ""}</div>
      </div>
    `).join("");
    container.innerHTML = `<div class="data-grid">${cards}</div>`;
  } catch {
    container.innerHTML = `<div class="loading">Could not load datums</div>`;
  }
}

// ========== WATCH MODE ==========
function toggleWatch() {
  if (!selectedStation) return;
  if (watchedStation?.id === selectedStation.id) {
    watchedStation = null;
    document.getElementById("watchPanel")?.classList.add("hidden");
    document.getElementById("watchBtn").textContent = "☆ WATCH";
    document.getElementById("watchBtn").classList.remove("active");
    showToast("Stopped watching station");
  } else {
    watchedStation = selectedStation;
    document.getElementById("watchBtn").textContent = "★ WATCHING";
    document.getElementById("watchBtn").classList.add("active");
    document.getElementById("watchPanel")?.classList.remove("hidden");
    const wsn = document.getElementById("watchStationName"); if (wsn) wsn.textContent = watchedStation.name;
    refreshWatch();
    showToast(`Now watching ${watchedStation.name} — updates every 2 min`);
  }
}

async function refreshWatch() {
  if (!watchedStation) return;
  const box = document.getElementById("watchContent");
  const data = await fetchLatest(watchedStation.id, "water_level");
  const air = await fetchLatest(watchedStation.id, "air_temperature");
  const wind = await fetchLatest(watchedStation.id, "wind");

  let html = "";
  if (data) {
    html += `<div class="watch-val">WL <strong>${data.v} ft</strong> <span>${data.t}</span></div>`;
    // detect change
    const key = watchedStation.id + "_watch";
    const h = `${data.v}|${data.t}`;
    if (lastDataHash[key] && lastDataHash[key] !== h) playSolChime();
    lastDataHash[key] = h;
  }
  if (air) html += `<div class="watch-val">Air <strong>${air.v}°F</strong></div>`;
  if (wind) html += `<div class="watch-val">Wind <strong>${wind.s} kn</strong> ${wind.d || ""}°</div>`;
  box.innerHTML = html || "No data";
  document.getElementById("watchUpdated").textContent = new Date().toISOString().substr(11, 8) + " UTC";
}

// ========== OVERLAYS ==========
async function applyOverlay(mode) {
  overlayMode = mode;
  document.getElementById("productFilter").value = mode;

  if (mode === "none") {
    renderMarkers();
    return;
  }

  showToast(`Loading ${mode === "all" ? "all" : mode} overlay data...`);
  const stations = getFilteredStations().slice(0, 80); // limit concurrent

  await Promise.allSettled(stations.map(async (s) => {
    if (!latestValues[s.id]) latestValues[s.id] = {};
    if (mode === "all" || mode === "water_level") {
      const d = await fetchLatest(s.id, "water_level");
      if (d) latestValues[s.id].water_level = d.v;
    }
    if (mode === "all" || mode === "air_temperature") {
      const d = await fetchLatest(s.id, "air_temperature");
      if (d) latestValues[s.id].air_temperature = d.v;
    }
    if (mode === "all" || mode === "wind") {
      const d = await fetchLatest(s.id, "wind");
      if (d) latestValues[s.id].wind = d.s;
    }
    if (mode === "currents" && s.type === "currents") {
      const d = await fetchLatest(s.id, "currents");
      if (d) latestValues[s.id].currents = d.s;
    }
    if (mode === "predictions" || mode === "all") {
      // ensure tide pred layer visible when overlay is predictions
      showTidePred = true;
      const tpBtn = document.getElementById("toggleTidePred");
      if (tpBtn) tpBtn.classList.add("active");
      renderTidePredMarkers();
    }
  }));

  renderMarkers();
  showToast("Overlay applied — marker colors updated");
}

// ========== UI BINDINGS ==========
function bindUI() {
  document.getElementById("closeModal").onclick = closeModal;
  document.getElementById("stationModal").addEventListener("click", (e) => {
    if (e.target.id === "stationModal") closeModal();
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      loadTab(tab.dataset.tab);
    });
  });

  document.getElementById("stateFilter").onchange = applyFilters;
  document.getElementById("typeFilter").onchange = applyFilters;
  document.getElementById("showWaterLevels").onchange = applyFilters;
  document.getElementById("showCurrents").onchange = applyFilters;
  document.getElementById("showPorts").onchange = applyFilters;

  document.getElementById("productFilter").onchange = (e) => {
    applyOverlay(e.target.value);
  };

  document.getElementById("resetFilters").onclick = () => {
    document.getElementById("stateFilter").value = "";
    document.getElementById("typeFilter").value = "";
    document.getElementById("productFilter").value = "none";
    overlayMode = "none";
    document.getElementById("showWaterLevels").checked = true;
    document.getElementById("showCurrents").checked = true;
    document.getElementById("showPorts").checked = false;
    applyFilters();
    map.setView([39.0, -75.5], 6);
  };

  document.getElementById("searchBtn").onclick = doSearch;
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  document.getElementById("fitUSA")?.addEventListener("click", () => map.setView([39.5, -98.35], 4));
  document.getElementById("resetViewBtn")?.addEventListener("click", resetView);
  document.getElementById("softRefreshBtn")?.addEventListener("click", softRefresh);
  document.getElementById("toggleClusters")?.addEventListener("click", () => {
    useClusters = !useClusters;
    renderMarkers();
    showToast(useClusters ? "Clustering ON" : "Clustering OFF");
  });

  document.getElementById("refreshActive").onclick = () => loadActivePanel(false);

  document.querySelectorAll(".bm-btn").forEach((btn) => {
    btn.addEventListener("click", () => setBasemap(btn.dataset.bm));
  });

  // Watch button (injected in modal footer area via HTML update)
  const watchBtn = document.getElementById("watchBtn");
  /* watchBtn bound in openStation to addToWatch */

  document.getElementById("clearWatch")?.addEventListener("click", () => {
    watchedStation = null;
    document.getElementById("watchPanel")?.classList.add("hidden");
  });
}

function doSearch() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  if (!q) return;

  const matches = allStations.filter(
    (s) =>
      (s.name && s.name.toLowerCase().includes(q)) ||
      (s.id && s.id.toLowerCase().includes(q)) ||
      (s.state && s.state.toLowerCase() === q)
  );

  if (!matches.length) {
    showToast("No stations match that query");
    return;
  }

  if (matches.length === 1) {
    openStation(matches[0]);
    map.setView([matches[0].lat, matches[0].lng], 10);
  } else {
    if (clusterGroup) map.removeLayer(clusterGroup);
    if (markersLayer) map.removeLayer(markersLayer);

    const group = L.featureGroup();
    matches.forEach((s) => {
      const col = colorForOverlay(s);
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:14px;height:14px;border-radius:50%;background:${col};border:2px solid #fff;"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      const m = L.marker([s.lat, s.lng], { icon });
      m.bindTooltip(`${s.name} (${s.id})`);
      m.on("click", () => openStation(s));
      group.addLayer(m);
    });
    group.addTo(map);
    markersLayer = group;
    map.fitBounds(group.getBounds().pad(0.2));
    document.getElementById("stationCount").textContent = matches.length;
    showToast(`${matches.length} stations found`);
  }
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3400);
}


// ========== NDBC BUOYS ==========
async function loadBuoys() {
  try {
    // NDBC does not send CORS headers; use public CORS proxies as fallback chain
    const sources = [
      "https://corsproxy.io/?" + encodeURIComponent("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"),
      "https://api.allorigins.win/raw?url=" + encodeURIComponent("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"),
      "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
    ];
    let text = null;
    let lastErr = null;
    for (const url of sources) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        text = await res.text();
        if (text && text.includes("LAT") || text.includes("STN") || text.split("\n").length > 10) break;
        text = null;
      } catch (e) {
        lastErr = e;
        text = null;
      }
    }
    if (!text) throw lastErr || new Error("All buoy sources failed");
    const lines = text.trim().split("\n").filter(l => l && !l.startsWith("#"));
    buoyStations = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const id = parts[0];
      const lat = parseFloat(parts[1]);
      const lon = parseFloat(parts[2]);
      if (isNaN(lat) || isNaN(lon)) continue;
      // Only US-ish bounding box + territories roughly
      if (lat < 15 || lat > 72 || lon < -180 || lon > -60) continue;
      const year = parts[3], mon = parts[4], day = parts[5], hr = parts[6], min = parts[7];
      const t = `${year}-${mon}-${day} ${hr}:${min}`;
      const wdir = parts[8] !== "MM" ? parts[8] : null;
      const wspd = parts[9] !== "MM" ? parts[9] : null;
      const gst = parts[10] !== "MM" ? parts[10] : null;
      const wvht = parts[11] !== "MM" ? parts[11] : null;
      const dpd = parts[12] !== "MM" ? parts[12] : null;
      const pres = parts[15] !== "MM" ? parts[15] : null;
      const atmp = parts[17] !== "MM" ? parts[17] : null;
      const wtmp = parts[18] !== "MM" ? parts[18] : null;
      buoyStations.push({
        id, lat, lng: lon, type: "buoy", name: `NDBC ${id}`,
        state: inferState(lat, lon) || "",
        data: { t, wdir, wspd, gst, wvht, dpd, pres, atmp, wtmp }
      });
    }
    const el = document.getElementById("buoyCount");
    if (el) el.textContent = String(buoyStations.length);
    console.log("Loaded", buoyStations.length, "NDBC buoys (US filter)");
    renderBuoyMarkers();
  } catch (e) {
    console.warn("Buoy load failed", e);
    const el = document.getElementById("buoyCount");
    if (el) el.textContent = "err";
  }
}

function renderBuoyMarkers() {
  if (buoyLayer) { map.removeLayer(buoyLayer); buoyLayer = null; }
  if (!showBuoys || !buoyStations.length) return;
  const group = L.layerGroup();
  buoyStations.forEach(b => {
    const icon = L.divIcon({
      className: "",
      html: `<div style="width:11px;height:11px;border-radius:2px;background:#00cec9;border:1px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.5);"></div>`,
      iconSize: [11, 11],
      iconAnchor: [5, 5]
    });
    const m = L.marker([b.lat, b.lng], { icon });
    let tip = `<strong>${b.name}</strong><br/>${b.id}`;
    if (b.data.wspd) tip += `<br/>Wind ${b.data.wspd} m/s`;
    if (b.data.wvht) tip += `<br/>Waves ${b.data.wvht} m`;
    if (b.data.atmp) tip += `<br/>Air ${b.data.atmp}°C`;
    if (b.data.wtmp) tip += `<br/>Water ${b.data.wtmp}°C`;
    m.bindTooltip(tip, { direction: "top", offset: [0, -6] });
    m.on("click", () => openBuoy(b));
    group.addLayer(m);
  });
  group.addTo(map);
  buoyLayer = group;
}

function openBuoy(b) {
  // Reuse modal for buoy summary
  selectedStation = { id: b.id, name: b.name, lat: b.lat, lng: b.lng, type: "buoy", state: b.state };
  const modal = document.getElementById("stationModal");
  modal.classList.remove("hidden");
  document.getElementById("modalStationName").textContent = b.name;
  document.getElementById("modalStationId").textContent = b.id;
  document.getElementById("officialLink").href = `https://www.ndbc.noaa.gov/station_page.php?station=${b.id}`;
  const meta = document.getElementById("modalMeta");
  meta.innerHTML = `
    <div class="meta-item"><div class="mlabel">LAT</div><div class="mval">${b.lat.toFixed(4)}</div></div>
    <div class="meta-item"><div class="mlabel">LON</div><div class="mval">${b.lng.toFixed(4)}</div></div>
    <div class="meta-item"><div class="mlabel">TYPE</div><div class="mval">NDBC BUOY</div></div>
    <div class="meta-item"><div class="mlabel">STATE ~</div><div class="mval">${b.state || "—"}</div></div>
  `;
  const d = b.data;
  const cards = [];
  if (d.wspd) cards.push(`<div class="data-card"><div class="dlabel">WIND SPEED</div><div class="dval">${d.wspd}<span class="dunit">m/s</span></div><div class="dtime">${d.t}</div></div>`);
  if (d.wdir) cards.push(`<div class="data-card"><div class="dlabel">WIND DIR</div><div class="dval">${d.wdir}<span class="dunit">°</span></div></div>`);
  if (d.gst) cards.push(`<div class="data-card"><div class="dlabel">GUST</div><div class="dval">${d.gst}<span class="dunit">m/s</span></div></div>`);
  if (d.wvht) cards.push(`<div class="data-card"><div class="dlabel">WAVE HEIGHT</div><div class="dval">${d.wvht}<span class="dunit">m</span></div></div>`);
  if (d.dpd) cards.push(`<div class="data-card"><div class="dlabel">DOM PERIOD</div><div class="dval">${d.dpd}<span class="dunit">s</span></div></div>`);
  if (d.pres) cards.push(`<div class="data-card"><div class="dlabel">PRESSURE</div><div class="dval">${d.pres}<span class="dunit">hPa</span></div></div>`);
  if (d.atmp) cards.push(`<div class="data-card"><div class="dlabel">AIR TEMP</div><div class="dval">${d.atmp}<span class="dunit">°C</span></div></div>`);
  if (d.wtmp) cards.push(`<div class="data-card"><div class="dlabel">WATER TEMP</div><div class="dval">${d.wtmp}<span class="dunit">°C</span></div></div>`);
  document.getElementById("tabContent").innerHTML = cards.length ? `<div class="data-grid">${cards.join("")}</div>` : `<div class="loading">No recent buoy data</div>`;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelector('.tab[data-tab="latest"]')?.classList.add("active");
}

// ========== WATCH STRIP ==========
function addToWatch(idOrName) {
  const q = (idOrName || "").trim().toLowerCase();
  if (!q) return;
  let st = allStations.find(s => s.id.toLowerCase() === q || (s.name && s.name.toLowerCase().includes(q)));
  if (!st) {
    st = tidePredStations.find(s => s.id.toLowerCase() === q || (s.name && s.name.toLowerCase().includes(q)));
  }
  if (!st) {
    const b = buoyStations.find(x => x.id.toLowerCase() === q);
    if (b) st = { id: b.id, name: b.name, type: "buoy", lat: b.lat, lng: b.lng };
  }
  if (!st) { showToast("Station / buoy not found"); return; }
  if (watchedList.some(w => w.id === st.id)) { showToast("Already watching"); return; }
  watchedList.push({ id: st.id, name: st.name, type: st.type || "waterlevels", data: null });
  renderWatchSlots();
  refreshAllWatches();
  showToast(`Watching ${st.name}`);
}

function renderWatchSlots() {
  const box = document.getElementById("watchSlots");
  if (!box) return;
  if (!watchedList.length) {
    box.innerHTML = `<div class="watch-empty">Select a state/territory then a station (or type an ID) to monitor in realtime — click a card for full data & tide graph</div>`;
    return;
  }
  box.innerHTML = watchedList.map((w, i) => {
    const d = w.data || {};
    const exp = w.expanded ? "expanded" : "";
    let vals = "—";
    let more = "";
    let floodHtml = "";
    if (w.type === "buoy") {
      vals = `Wind ${d.wspd || "—"} m/s · Waves ${d.wvht || "—"} m`;
      more = `Air ${d.atmp || "—"}°C · Water ${d.wtmp || "—"}°C · ${d.pres || "—"} hPa`;
    } else if (w.type === "currents") {
      vals = `${d.s != null ? d.s + " kn" : "—"} @ ${d.d != null ? d.d + "°" : "—"}`;
    } else {
      vals = d.v != null ? `${d.v} ft MLLW` : "—";
      if (w.extra) {
        const e = w.extra;
        more = [
          e.air != null ? `Air ${e.air}°F` : null,
          e.wtmp != null ? `WTemp ${e.wtmp}°F` : null,
          e.wind != null ? `Wind ${e.wind} kn` : null,
          e.nextTide ? `Next ${e.nextTide}` : null
        ].filter(Boolean).join(" · ");
      }
      if (w.flood) {
        floodHtml = `<div class="flood-badge ${w.flood.level}">${w.flood.label}</div>`;
        if (w.floodLevels) {
          const fl = w.floodLevels;
          const parts = [];
          if (fl.nws_minor != null) parts.push(`Min ${Number(fl.nws_minor).toFixed(1)}`);
          if (fl.nws_moderate != null) parts.push(`Mod ${Number(fl.nws_moderate).toFixed(1)}`);
          if (fl.nws_major != null) parts.push(`Maj ${Number(fl.nws_major).toFixed(1)}`);
          if (parts.length) floodHtml += `<div class="flood-thresholds">Thresholds ft: ${parts.join(" · ")}</div>`;
        }
      }
    }
    const chartId = `watchChart_${w.id.replace(/[^a-zA-Z0-9]/g, "")}`;
    return `<div class="watch-card ${exp}" data-id="${w.id}" data-idx="${i}">
      <div class="wc-name">${w.name}</div>
      <div class="wc-id">${w.id} · ${(w.type || "").toUpperCase()} · ${w.state || ""}</div>
      <div class="wc-vals">${vals}</div>
      ${more ? `<div class="wc-more">${more}</div>` : ""}
      <div class="wc-time">${d.t || w.updated || ""}</div>
      ${floodHtml}
      ${w.expanded ? `<div class="wc-chart"><canvas id="${chartId}"></canvas></div>
        <div class="wc-actions">
          <button data-act="modal">OPEN FULL</button>
          <button data-act="collapse">COLLAPSE</button>
          <button data-act="remove">REMOVE</button>
        </div>` : `<div class="wc-actions"><button data-act="expand">EXPAND + GRAPH</button><button data-act="remove">×</button></div>`}
    </div>`;
  }).join("");

  box.querySelectorAll(".watch-card").forEach(card => {
    const id = card.dataset.id;
    const idx = parseInt(card.dataset.idx, 10);
    card.querySelectorAll("button").forEach(btn => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === "remove") {
          watchedList = watchedList.filter(w => w.id !== id);
          renderWatchSlots();
        } else if (act === "collapse") {
          watchedList[idx].expanded = false;
          renderWatchSlots();
        } else if (act === "expand") {
          watchedList[idx].expanded = true;
          renderWatchSlots();
          setTimeout(() => drawWatchChart(watchedList[idx]), 50);
        } else if (act === "modal") {
          openWatchStation(id);
        }
      };
    });
    card.onclick = (ev) => {
      if (ev.target.tagName === "BUTTON" || ev.target.tagName === "CANVAS") return;
      const w = watchedList[idx];
      if (!w.expanded) {
        w.expanded = true;
        renderWatchSlots();
        setTimeout(() => drawWatchChart(w), 50);
      } else {
        openWatchStation(id);
      }
    };
  });

  // redraw charts for already expanded
  watchedList.forEach(w => {
    if (w.expanded) setTimeout(() => drawWatchChart(w), 80);
  });
}

async function drawWatchChart(w) {
  if (!w) return;
  const chartId = `watchChart_${w.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  const canvas = document.getElementById(chartId);
  if (!canvas) return;

  // Destroy previous chart on this canvas if any
  if (w._chart) {
    try { w._chart.destroy(); } catch (_) {}
    w._chart = null;
  }

  const today = new Date();
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  let labels = [], values = [], hilo = [];

  // Prefer hourly predictions (harmonic); fall back to hilo
  try {
    const urlH = `${DATAAPI}?begin_date=${fmt(today)}&range=48&station=${w.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=h&units=english&format=json&application=tides-currents-xplr`;
    const resH = await fetch(urlH);
    const jsonH = await resH.json();
    if (jsonH.predictions && jsonH.predictions.length) {
      labels = jsonH.predictions.map(p => p.t);
      values = jsonH.predictions.map(p => parseFloat(p.v));
    }
  } catch (_) {}

  try {
    const urlL = `${DATAAPI}?begin_date=${fmt(today)}&range=72&station=${w.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json&application=tides-currents-xplr`;
    const resL = await fetch(urlL);
    const jsonL = await resL.json();
    if (jsonL.predictions && jsonL.predictions.length) {
      hilo = jsonL.predictions;
    }
  } catch (_) {}

  // If no hourly, synthesize stepped series from hilo for display
  if (!values.length && hilo.length) {
    labels = hilo.map(p => p.t);
    values = hilo.map(p => parseFloat(p.v));
  }

  // Also try observed water level if available
  let obsLabels = [], obsValues = [];
  try {
    const end = new Date();
    const begin = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const urlO = `${DATAAPI}?begin_date=${fmt(begin)}&end_date=${fmt(end)}&station=${w.id}&product=water_level&datum=MLLW&time_zone=lst_ldt&units=english&format=json&application=tides-currents-xplr`;
    const resO = await fetch(urlO);
    const jsonO = await resO.json();
    if (jsonO.data && jsonO.data.length) {
      // subsample for chart density
      const step = Math.max(1, Math.floor(jsonO.data.length / 80));
      jsonO.data.forEach((d, i) => {
        if (i % step === 0) {
          obsLabels.push(d.t);
          obsValues.push(parseFloat(d.v));
        }
      });
    }
  } catch (_) {}

  if (!values.length && !obsValues.length) {
    canvas.parentElement.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:20px 0;text-align:center">No prediction / water level series available</div>`;
    return;
  }

  const datasets = [];
  if (values.length) {
    datasets.push({
      label: "Predicted (ft MLLW)",
      data: values,
      borderColor: "#a29bfe",
      backgroundColor: "rgba(162,155,254,0.12)",
      borderWidth: 1.5,
      pointRadius: values.length < 20 ? 3 : 0,
      tension: 0.3,
      fill: true
    });
  }
  if (obsValues.length) {
    // separate chart labels issue - if only obs, use obs labels
    if (!values.length) {
      labels = obsLabels;
      datasets.push({
        label: "Observed (ft MLLW)",
        data: obsValues,
        borderColor: "#e67e22",
        backgroundColor: "rgba(230,126,34,0.1)",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: true
      });
    }
  }

  const ctx = canvas.getContext("2d");
  w._chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: "#8b9aab", font: { size: 10 } } },
        title: {
          display: true,
          text: (w.name ? w.name + " — " : "") + (hilo.length ? `Next: ${hilo.slice(0,3).map(p => `${p.type} ${p.v}ft`).join(" · ")}` : "Tide curve (NOAA)"),
          color: "#e8ecef",
          font: { size: 11 }
        }
      },
      scales: {
        x: { ticks: { color: "#5a6a7a", maxTicksLimit: 6, font: { size: 8 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        y: { ticks: { color: "#5a6a7a", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.06)" }, title: { display: true, text: "ft", color: "#5a6a7a", font: { size: 9 } } }
      }
    }
  });
}

function openWatchStation(id) {
  const st = allStations.find(s => s.id === id)
    || tidePredStations.find(s => s.id === id)
    || buoyStations.find(b => b.id === id);
  if (!st) return;
  if (st.type === "buoy" || buoyStations.some(b => b.id === id)) openBuoy(st);
  else if (st.type === "tidepredictions" || tidePredStations.some(t => t.id === id)) openTidePred(st);
  else openStation(st);
}


async function refreshAllWatches() {
  if (!watchedList.length) return;
  let anyChange = false;
  for (const w of watchedList) {
    if (w.type === "buoy") {
      const b = buoyStations.find(x => x.id === w.id);
      if (b) {
        const prev = w.data ? JSON.stringify(w.data) : "";
        w.data = b.data;
        if (prev && prev !== JSON.stringify(w.data)) anyChange = true;
      }
    } else {
      const d = await fetchLatest(w.id, "water_level");
      if (d) {
        const prev = w.data ? `${w.data.v}|${w.data.t}` : "";
        const now = `${d.v}|${d.t}`;
        if (prev && prev !== now) {
          anyChange = true;
          freshIds.add(w.id);
        }
        w.data = d;
      }
      // enrich with met + next tide
      const extra = {};
      try {
        const air = await fetchLatest(w.id, "air_temperature");
        if (air) extra.air = air.v;
      } catch (_) {}
      try {
        const wt = await fetchLatest(w.id, "water_temperature");
        if (wt) extra.wtmp = wt.v;
      } catch (_) {}
      try {
        const wind = await fetchLatest(w.id, "wind");
        if (wind) extra.wind = wind.s;
      } catch (_) {}
      try {
        const today = new Date();
        const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
        const url = `${DATAAPI}?begin_date=${fmt(today)}&range=48&station=${w.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json&application=tides-currents-xplr`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.predictions && json.predictions[0]) {
          const p = json.predictions[0];
          extra.nextTide = `${p.type} ${p.v}ft ${p.t}`;
          w.hilo = json.predictions;
        }
      } catch (_) {}
      // Flood risk
      try {
        const fl = await fetchFloodLevels(w.id);
        w.floodLevels = fl;
        if (fl && w.data?.v != null) {
          w.flood = floodStatus(w.data.v, fl);
        }
      } catch (_) {}
      w.extra = extra;
      w.updated = new Date().toISOString().substr(11, 8) + " UTC";
    }
  }
  renderWatchSlots();
  if (anyChange) {
    playSolChime();
    renderMarkers();
  }
}

// Extend bindUI for new controls (called after DOM ready already bound some)
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    const st = document.getElementById("soundToggle");
    if (st) {
      st.onclick = () => {
        soundEnabled = !soundEnabled;
        st.textContent = soundEnabled ? "🔊 SOUND ON" : "🔇 SOUND OFF";
        st.classList.toggle("on", soundEnabled);
        showToast(soundEnabled ? "SOL chime enabled" : "SOL chime muted");
      };
      st.classList.add("on");
    }
    const tb = document.getElementById("toggleBuoys");
    if (tb) {
      tb.onclick = () => {
        showBuoys = !showBuoys;
        tb.classList.toggle("active", showBuoys);
        renderBuoyMarkers();
        showToast(showBuoys ? "Buoys visible" : "Buoys hidden");
      };
    }
    const tp = document.getElementById("toggleTidePred");
    if (tp) {
      tp.onclick = () => {
        showTidePred = !showTidePred;
        tp.classList.toggle("active", showTidePred);
        renderTidePredMarkers();
        showToast(showTidePred ? "Tide prediction stations ON map" : "Tide prediction stations hidden");
      };
    }
    map?.on("zoomend", () => {
      if (showTidePred) renderTidePredMarkers();
    });
    const tw = document.getElementById("toggleWarnings");
    if (tw) {
      tw.onclick = () => {
        showWarnings = !showWarnings;
        tw.classList.toggle("active", showWarnings);
        renderNwsAlertPolygons();
        showToast(showWarnings ? "NWS alert zones ON map" : "NWS alert zones hidden");
      };
    }
    document.getElementById("refreshWarningsBtn")?.addEventListener("click", () => {
      loadNwsWarnings();
      showToast("Refreshing NWS coastal flood alerts…");
    });
    document.getElementById("addWatchBtn")?.addEventListener("click", () => {
      const typed = document.getElementById("watchInput")?.value?.trim();
      const fromSel = document.getElementById("watchStationSelect")?.value;
      addToWatch(typed || fromSel);
      const inp = document.getElementById("watchInput");
      if (inp) inp.value = "";
    });
    document.getElementById("watchInput")?.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        addToWatch(e.target.value);
        e.target.value = "";
      }
    });
    document.getElementById("clearWatchBtn")?.addEventListener("click", () => {
      watchedList = [];
      renderWatchSlots();
    });
  }, 500);
});


// ========== WATCH STATE → STATION DROPDOWNS ==========
function populateWatchDropdowns() {
  const stateSel = document.getElementById("watchStateSelect");
  const stnSel = document.getElementById("watchStationSelect");
  if (!stateSel || !stnSel) return;

  const states = [...new Set(allStations.map(s => s.state).filter(Boolean))].sort();
  // Also include territories that may appear
  const extra = ["PR","VI","GU","AS","MP","DC"];
  extra.forEach(e => { if (!states.includes(e) && allStations.some(s => s.state === e)) states.push(e); });
  states.sort();

  stateSel.innerHTML = '<option value="">STATE / TERRITORY</option>';
  states.forEach(st => {
    const o = document.createElement("option");
    o.value = st;
    o.textContent = st;
    stateSel.appendChild(o);
  });

  stateSel.onchange = () => {
    const st = stateSel.value;
    stnSel.innerHTML = '<option value="">STATION</option>';
    stnSel.disabled = !st;
    if (!st) return;
    const merged = [...allStations, ...tidePredStations];
    const seen = new Set();
    const list = merged
      .filter(s => s.state === st && !seen.has(s.id) && (seen.add(s.id) || true))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    list.forEach(s => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = `${s.name} (${s.id})`;
      stnSel.appendChild(o);
    });
  };

  stnSel.onchange = () => {
    if (stnSel.value) {
      addToWatch(stnSel.value);
      // keep selection visible
    }
  };
}


// ========== SOFT REFRESH & RESET VIEW ==========
function softRefresh() {
  showToast("Soft refresh — fetching latest data...");
  loadActivePanel(true);
  refreshAllWatches();
  if (showBuoys) loadBuoys();
  if (selectedStation) {
    const activeTab = document.querySelector(".tab.active");
    if (activeTab) loadTab(activeTab.dataset.tab, true);
  }
  // recolor markers if overlay active
  if (overlayMode !== "none") renderMarkers();
  if (showTidePred) renderTidePredMarkers();
  loadNwsWarnings();
  showToast("Soft refresh complete — watches & selection kept");
}

function resetView() {
  map.setView([39.5, -98.35], 4);
  document.getElementById("stateFilter").value = "";
  document.getElementById("typeFilter").value = "";
  document.getElementById("productFilter").value = "none";
  overlayMode = "none";
  document.getElementById("showWaterLevels").checked = true;
  document.getElementById("showCurrents").checked = true;
  document.getElementById("showPorts").checked = false;
  applyFilters();
  showToast("View reset — map & filters restored (watches kept)");
}


// ========== TIDE PREDICTION STATIONS (NOAA Tide Predictions) ==========
async function loadTidePredStations() {
  try {
    const res = await fetch(`${MDAPI}/stations.json?type=tidepredictions`);
    const json = await res.json();
    tidePredStations = (json.stations || []).map(s => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      state: s.state || "",
      type: "tidepredictions",
      tidal: s.tidal,
      tideType: s.tideType || "",
      affiliations: s.affiliations || ""
    })).filter(s => s.lat && s.lng);
    console.log("Tide prediction stations:", tidePredStations.length);
    const el = document.getElementById("tidePredCount");
    if (el) el.textContent = String(tidePredStations.length);
    // Always try render if toggle on (default true)
    renderTidePredMarkers();
    const tpBtn = document.getElementById("toggleTidePred");
    if (tpBtn) tpBtn.classList.toggle("active", showTidePred);
  } catch (e) {
    console.warn("Tide pred stations load failed", e);
  }
}

function renderTidePredMarkers() {
  if (tidePredLayer) { map.removeLayer(tidePredLayer); tidePredLayer = null; }
  if (!showTidePred || !tidePredStations.length || !map) return;

  const z = map.getZoom();
  // Progressive density
  let step = 1;
  if (z < 5) step = 8;
  else if (z < 7) step = 3;
  else if (z < 9) step = 2;
  const list = step === 1 ? tidePredStations : tidePredStations.filter((_, i) => i % step === 0);

  const group = L.layerGroup();
  list.forEach(s => {
    if (s.lat == null || s.lng == null) return;
    const icon = L.divIcon({
      className: "",
      html: `<div class="tide-pred-dot" title="${s.name}"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
    const m = L.marker([s.lat, s.lng], { icon, interactive: true });
    m.bindTooltip(`<strong>${s.name}</strong><br/>${s.id} · ${s.state || ""} · TIDE PRED`, { direction: "top", offset: [0, -6] });
    m.on("click", () => openTidePred(s));
    group.addLayer(m);
  });
  group.addTo(map);
  tidePredLayer = group;
  console.log("Rendered tide pred markers:", list.length, "of", tidePredStations.length);
}

async function openTidePred(s) {
  selectedStation = s;
  const modal = document.getElementById("stationModal");
  modal.classList.remove("hidden");
  document.getElementById("modalStationName").textContent = s.name || "TIDE PREDICTION";
  document.getElementById("modalStationId").textContent = s.id;
  document.getElementById("officialLink").href =
    `https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${s.id}`;

  document.getElementById("modalMeta").innerHTML = `
    <div class="meta-item"><div class="mlabel">LAT</div><div class="mval">${s.lat?.toFixed(4) ?? "—"}</div></div>
    <div class="meta-item"><div class="mlabel">LON</div><div class="mval">${s.lng?.toFixed(4) ?? "—"}</div></div>
    <div class="meta-item"><div class="mlabel">STATE</div><div class="mval">${s.state || "—"}</div></div>
    <div class="meta-item"><div class="mlabel">TYPE</div><div class="mval">TIDE PREDICTIONS</div></div>
    <div class="meta-item"><div class="mlabel">TIDE</div><div class="mval">${s.tideType || "—"}</div></div>
  `;

  const content = document.getElementById("tabContent");
  content.innerHTML = `<div class="loading">LOADING HIGH/LOW PREDICTIONS...</div>`;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelector('.tab[data-tab="predictions"]')?.classList.add("active");

  // Fetch next ~72h hilo predictions
  try {
    const today = new Date();
    const fmt = (d) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const url = `${DATAAPI}?begin_date=${fmt(today)}&range=72&station=${s.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json&application=tides-currents-xplr`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.predictions || !json.predictions.length) {
      content.innerHTML = `<div class="loading">No predictions available for this station</div>`;
      return;
    }
    const rows = json.predictions.slice(0, 16).map(p => `
      <div class="data-card ${p.type === "H" || (p.type||"").toLowerCase().includes("high") ? "highlight" : ""}">
        <div class="dlabel">${p.type || "TIDE"}</div>
        <div class="dval">${p.v}<span class="dunit">ft MLLW</span></div>
        <div class="dtime">${p.t}</div>
      </div>
    `).join("");
    content.innerHTML = `
      <div style="color:var(--text-dim);font-size:11px;margin-bottom:8px">
        HIGH / LOW TIDE PREDICTIONS (next ~72h) · 
        <a href="https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=${s.id}" target="_blank" style="color:var(--orange)">Full NOAA Tide Predictions ↗</a>
      </div>
      <div class="data-grid">${rows}</div>
      <div style="color:var(--text-dim);font-size:11px;margin:12px 0 6px">PREDICTED TIDE CURVE (48h)</div>
      <div class="chart-wrap"><canvas id="tidePredChart"></canvas></div>
      <div style="margin-top:12px">
        <button id="addTideToMapBtn" class="watch-btn" style="margin-right:8px">☆ WATCH THIS STATION</button>
        <button id="showOnMapBtn" class="watch-btn">CENTER ON MAP</button>
      </div>
    `;
    // Draw hourly curve when available
    (async () => {
      try {
        const urlH = `${DATAAPI}?begin_date=${fmt(today)}&range=48&station=${s.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=h&units=english&format=json&application=tides-currents-xplr`;
        const resH = await fetch(urlH);
        const jsonH = await resH.json();
        let labs = [], vals = [];
        if (jsonH.predictions && jsonH.predictions.length) {
          labs = jsonH.predictions.map(p => p.t);
          vals = jsonH.predictions.map(p => parseFloat(p.v));
        } else {
          labs = json.predictions.map(p => p.t);
          vals = json.predictions.map(p => parseFloat(p.v));
        }
        const canvas = document.getElementById("tidePredChart");
        if (!canvas || !vals.length) return;
        if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
        chartInstance = new Chart(canvas.getContext("2d"), {
          type: "line",
          data: {
            labels: labs,
            datasets: [{
              label: (s.name || s.id) + " — Predicted tide (ft MLLW)",
              data: vals,
              borderColor: "#a29bfe",
              backgroundColor: "rgba(162,155,254,0.15)",
              borderWidth: 2,
              pointRadius: vals.length < 24 ? 3 : 0,
              tension: 0.35,
              fill: true
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: "#5a6a7a", maxTicksLimit: 8, font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.04)" } },
              y: { ticks: { color: "#5a6a7a", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.06)" }, title: { display: true, text: "ft MLLW", color: "#5a6a7a" } }
            }
          }
        });
      } catch (e) { console.warn("tide chart", e); }
    })();
    document.getElementById("addTideToMapBtn")?.addEventListener("click", () => {
      addToWatch(s.id);
      showToast(`Added ${s.name} to watch panel`);
    });
    document.getElementById("showOnMapBtn")?.addEventListener("click", () => {
      map.setView([s.lat, s.lng], 10);
      closeModal();
    });
  } catch (e) {
    content.innerHTML = `<div class="loading">Error loading predictions: ${e.message}</div>`;
  }

  // Watch button in footer
  const watchBtn = document.getElementById("watchBtn");
  if (watchBtn) {
    const already = watchedList.some(w => w.id === s.id);
    watchBtn.textContent = already ? "★ ON WATCH" : "☆ WATCH";
    watchBtn.classList.toggle("active", already);
    watchBtn.onclick = () => {
      addToWatch(s.id);
      watchBtn.textContent = "★ ON WATCH";
      watchBtn.classList.add("active");
    };
  }
}


// ========== COASTAL FLOOD RISK ==========
async function fetchFloodLevels(stationId) {
  try {
    const res = await fetch(`${MDAPI}/stations/${stationId}/floodlevels.json?units=english`);
    const json = await res.json();
    if (json.error) return null;
    return {
      nos_minor: json.nos_minor,
      nos_moderate: json.nos_moderate,
      nos_major: json.nos_major,
      nws_minor: json.nws_minor,
      nws_moderate: json.nws_moderate,
      nws_major: json.nws_major,
      action: json.action
    };
  } catch {
    return null;
  }
}

function floodStatus(wl, fl) {
  if (wl == null || !fl) return { level: "unknown", label: "NO THRESHOLD DATA" };
  const v = parseFloat(wl);
  // Prefer NWS if available, else NOS
  const major = fl.nws_major ?? fl.nos_major;
  const moderate = fl.nws_moderate ?? fl.nos_moderate;
  const minor = fl.nws_minor ?? fl.nos_minor;
  const action = fl.action;
  if (major != null && v >= major) return { level: "major", label: "MAJOR FLOOD" };
  if (moderate != null && v >= moderate) return { level: "moderate", label: "MODERATE FLOOD" };
  if (minor != null && v >= minor) return { level: "minor", label: "MINOR FLOOD" };
  if (action != null && v >= action) return { level: "action", label: "ACTION STAGE" };
  return { level: "ok", label: "BELOW FLOOD" };
}

async function renderFlood(station, container) {
  container.innerHTML = `<div class="loading">LOADING FLOOD THRESHOLDS...</div>`;
  const fl = await fetchFloodLevels(station.id);
  const wlData = await fetchLatest(station.id, "water_level");
  const wl = wlData?.v != null ? parseFloat(wlData.v) : null;
  const status = floodStatus(wl, fl);

  if (!fl) {
    container.innerHTML = `<div class="loading">No coastal flood threshold data for this station.<br/>
      <a href="https://tidesandcurrents.noaa.gov/inundationdb/" target="_blank" style="color:var(--orange)">Coastal Inundation Dashboard ↗</a></div>`;
    return;
  }

  const cards = [];
  if (wl != null) {
    cards.push(`<div class="data-card highlight"><div class="dlabel">CURRENT WATER LEVEL</div><div class="dval">${wl.toFixed(2)}<span class="dunit">ft MLLW</span></div><div class="dtime">${wlData?.t || ""}</div></div>`);
  }
  cards.push(`<div class="data-card"><div class="dlabel">FLOOD STATUS</div><div class="dval"><span class="flood-badge ${status.level}">${status.label}</span></div></div>`);

  const thresh = [
    ["ACTION", fl.action],
    ["NWS MINOR", fl.nws_minor],
    ["NWS MODERATE", fl.nws_moderate],
    ["NWS MAJOR", fl.nws_major],
    ["NOS MINOR", fl.nos_minor],
    ["NOS MODERATE", fl.nos_moderate],
    ["NOS MAJOR", fl.nos_major]
  ];
  thresh.forEach(([lab, val]) => {
    if (val != null) {
      const above = wl != null && wl >= val;
      cards.push(`<div class="data-card"><div class="dlabel">${lab}</div><div class="dval">${Number(val).toFixed(2)}<span class="dunit">ft</span></div><div class="dtime">${above ? "▲ EXCEEDED" : "below"}</div></div>`);
    }
  });

  container.innerHTML = `
    <div style="color:var(--text-dim);font-size:11px;margin-bottom:8px">
      Coastal flood thresholds (NOAA CO-OPS) · 
      <a href="https://tidesandcurrents.noaa.gov/stationhome.html?id=${station.id}" target="_blank" style="color:var(--orange)">Station page ↗</a> · 
      <a href="https://tidesandcurrents.noaa.gov/inundationdb/" target="_blank" style="color:var(--orange)">Inundation Dashboard ↗</a>
    </div>
    <div class="data-grid">${cards.join("")}</div>
  `;
}


// ========== NWS COASTAL FLOOD WARNINGS ==========
async function loadNwsWarnings() {
  const listEl = document.getElementById("warningsList");
  const countEl = document.getElementById("warningsCount");
  try {
    const events = [
      "Coastal Flood Warning",
      "Coastal Flood Watch",
      "Coastal Flood Advisory",
      "Coastal Flood Statement"
    ].map(e => encodeURIComponent(e)).join(",");
    const url = `https://api.weather.gov/alerts/active?event=${events}`;
    const res = await fetch(url, {
      headers: {
        "Accept": "application/geo+json",
        "User-Agent": "TIDES-CURRENTS-XPLR (github.io dashboard)"
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    nwsAlerts = (json.features || []).map(f => {
      const p = f.properties || {};
      return {
        id: p.id || f.id,
        event: p.event,
        severity: (p.severity || "Unknown").toLowerCase(),
        urgency: p.urgency,
        headline: p.headline,
        description: p.description,
        instruction: p.instruction,
        areaDesc: p.areaDesc,
        senderName: p.senderName,
        sent: p.sent,
        effective: p.effective,
        expires: p.expires,
        ends: p.ends,
        geometry: f.geometry,
        url: p["@id"] || (p.id ? `https://api.weather.gov/alerts/${encodeURIComponent(p.id)}` : null)
      };
    });
    // Sort: Warning > Watch > Advisory > Statement
    const rank = { warning: 0, watch: 1, advisory: 2, statement: 3 };
    nwsAlerts.sort((a, b) => {
      const ra = rank[(a.event || "").toLowerCase().split(" ").pop()] ?? 9;
      const rb = rank[(b.event || "").toLowerCase().split(" ").pop()] ?? 9;
      return ra - rb;
    });

    if (countEl) {
      countEl.textContent = nwsAlerts.length
        ? `${nwsAlerts.length} ACTIVE · ${new Date().toISOString().substr(11, 8)} UTC`
        : "No active coastal flood alerts";
    }
    renderWarningsList();
    renderNwsAlertPolygons();
  } catch (e) {
    console.warn("NWS alerts failed", e);
    if (countEl) countEl.textContent = "Alerts unavailable";
    if (listEl) listEl.innerHTML = `<div class="loading">Could not load NWS alerts: ${e.message}</div>`;
  }
}

function renderWarningsList() {
  const listEl = document.getElementById("warningsList");
  if (!listEl) return;
  if (!nwsAlerts.length) {
    listEl.innerHTML = `<div class="loading">No active Coastal Flood Warning / Watch / Advisory / Statement</div>`;
    return;
  }
  listEl.innerHTML = nwsAlerts.map((a, i) => {
    const exp = a.expires ? new Date(a.expires).toLocaleString() : "—";
    return `<div class="warning-card severity-${a.severity}" data-idx="${i}">
      <div class="w-event">${a.event || "ALERT"} · ${a.severity.toUpperCase()}</div>
      <div class="w-area">${a.areaDesc || "—"}</div>
      <div class="w-headline">${a.headline || ""}</div>
      <div class="w-meta">${a.senderName || ""} · Exp ${exp}</div>
    </div>`;
  }).join("");

  listEl.querySelectorAll(".warning-card").forEach(card => {
    card.onclick = () => {
      const a = nwsAlerts[parseInt(card.dataset.idx, 10)];
      if (!a) return;
      focusNwsAlert(a);
    };
  });
}

function renderNwsAlertPolygons() {
  if (nwsAlertLayer) {
    map.removeLayer(nwsAlertLayer);
    nwsAlertLayer = null;
  }
  if (!showWarnings || !map || !nwsAlerts.length) return;

  const group = L.layerGroup();
  const colors = {
    warning: "#c0392b",
    watch: "#e74c3c",
    advisory: "#e67e22",
    statement: "#f1c40f"
  };

  nwsAlerts.forEach((a, i) => {
    if (!a.geometry) return;
    const key = (a.event || "").toLowerCase();
    let color = "#e67e22";
    if (key.includes("warning")) color = colors.warning;
    else if (key.includes("watch")) color = colors.watch;
    else if (key.includes("advisory")) color = colors.advisory;
    else if (key.includes("statement")) color = colors.statement;

    try {
      const layer = L.geoJSON(a.geometry, {
        style: {
          color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.18,
          opacity: 0.85
        },
        onEachFeature: (feat, lyr) => {
          lyr.bindTooltip(
            `<strong>${a.event}</strong><br/>${(a.areaDesc || "").slice(0, 80)}`,
            { sticky: true }
          );
          lyr.on("click", () => focusNwsAlert(a));
        }
      });
      group.addLayer(layer);
    } catch (e) {
      console.warn("alert geometry", e);
    }
  });

  group.addTo(map);
  nwsAlertLayer = group;
}

function focusNwsAlert(a) {
  if (!a) return;
  // Zoom to geometry if present
  if (a.geometry) {
    try {
      const tmp = L.geoJSON(a.geometry);
      map.fitBounds(tmp.getBounds().pad(0.2));
    } catch (_) {}
  }
  // Floating window
  const modal = document.getElementById("alertModal");
  if (!modal) return;
  document.getElementById("alertModalEvent").textContent = a.event || "NWS ALERT";
  document.getElementById("alertModalSeverity").textContent =
    `${(a.severity || "").toUpperCase()} · ${(a.urgency || "")} · ${a.senderName || ""}`;
  document.getElementById("alertModalArea").textContent = a.areaDesc || "";
  document.getElementById("alertModalHeadline").textContent = a.headline || "";
  document.getElementById("alertModalDesc").textContent = a.description || "No description available.";
  document.getElementById("alertModalInstr").textContent = a.instruction || "";
  const exp = a.expires ? new Date(a.expires).toLocaleString() : "—";
  const eff = a.effective ? new Date(a.effective).toLocaleString() : "—";
  document.getElementById("alertModalMeta").innerHTML =
    `Effective ${eff} · Expires ${exp}<br/><a href="https://www.weather.gov" target="_blank" style="color:var(--orange)">weather.gov</a>`;
  modal.classList.remove("hidden");
  showToast(`${a.event}: ${(a.areaDesc || "").split(";")[0]}`);
}

function closeAlertModal() {
  document.getElementById("alertModal")?.classList.add("hidden");
}




// ========== nowCOAST / NOAA MAP LAYERS (WMS + Esri + click identify) ==========
const NC_WMS = "https://nowcoast.noaa.gov/geoserver/ows";
const NC_WMS_MAP = {
  alerts_nc: "alerts:watches_warnings_advisories",
  bluetopo: "bluetopo:bathymetry",
  geopotential: "geopotential:sgeoid2022",
  gridded_wx: "ndfd_temperature:air_temperature",
  inland_flood: "stofs3d:stofs3d_atlc_water_disturbance",
  lightning: "lightning_detection:ldn_lightning_strike_density",
  marine_pathogen: "marine_pathogen:chesbay_vibrio_vulnificus",
  precip_amt: "ndfd_precipitation:6hr_precipitation_amount",
  s100: "s100:s100_interoperable_coverage",
  sst_nc: "sea_surface_temperature:global_sea_surface_temperature",
  sfc_currents: "wcofs:wcofs_sfc_currents",
  tropical_nc: "tropical_cyclones:active_tropical_cyclones",
  vlm: "vertical_land_motion:vlm_velocity",
  waterlevels_nc: "stofs2d:stofs2d_cwl_max_contours",
  radar: "weather_radar:base_reflectivity_mosaic",
  satellite: "satellite:goes_longwave_imagery",
  sst: "sea_surface_temperature:global_sea_surface_temperature",
  precip: "ndfd_precipitation:6hr_precipitation_amount",
  s102: "s100:s102_coverage",
  s104: "s100:s104_coverage",
  s111: "s100:s111_coverage",
  waterlevels: "stofs3d:stofs3d_cwl_stations",
  federal: "boundaries:military_boundaries"
};
const ncLayerState = {};
let rainViewerHost = "https://tilecache.rainviewer.com";
let rainViewerRadarPath = null;
let ncIdentifyBound = false;

function makeWmsLayer(layers, opts = {}) {
  return L.tileLayer.wms(NC_WMS, {
    layers,
    format: "image/png",
    transparent: true,
    version: "1.1.1",
    opacity: opts.opacity ?? 0.75,
    zIndex: opts.zIndex ?? 360,
    attribution: opts.attribution || "NOAA nowCOAST",
    uppercase: true,
    tileSize: 256,
    updateWhenIdle: false
  });
}

function setNcOpacity(pct) {
  const o = (pct || 70) / 100;
  Object.values(ncLayerState).forEach(lyr => {
    if (!lyr) return;
    if (lyr.setOpacity) lyr.setOpacity(o);
    else if (lyr.eachLayer) lyr.eachLayer(l => { if (l.setOpacity) l.setOpacity(o); });
  });
}

function removeNc(key) {
  if (!ncLayerState[key]) return;
  try {
    if (ncLayerState[key]._redrawHandler) map.off("moveend", ncLayerState[key]._redrawHandler);
    map.removeLayer(ncLayerState[key]);
  } catch (_) {}
  ncLayerState[key] = null;
}

async function initRainViewer() {
  try {
    const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    const data = await res.json();
    rainViewerHost = data.host || rainViewerHost;
    const past = data.radar?.past || [];
    if (past.length) rainViewerRadarPath = past[past.length - 1].path;
  } catch (_) {}
}

function openLayerDetail(title, html) {
  const modal = document.getElementById("alertModal");
  if (!modal) {
    showToast(title);
    return;
  }
  document.getElementById("alertModalEvent").textContent = title;
  document.getElementById("alertModalSeverity").textContent = "LAYER DETAIL";
  document.getElementById("alertModalArea").textContent = "";
  document.getElementById("alertModalHeadline").textContent = "";
  document.getElementById("alertModalDesc").textContent = "";
  document.getElementById("alertModalInstr").innerHTML = html;
  document.getElementById("alertModalMeta").textContent = "";
  modal.classList.remove("hidden");
}

function gaugeStatusColor(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("major")) return "#c0392b";
  if (s.includes("moderate")) return "#e67e22";
  if (s.includes("flood") || s.includes("minor")) return "#f1c40f";
  if (s.includes("action")) return "#3498db";
  return "#27ae60";
}

function bindRiverGaugePopups(layer) {
  layer.on("click", (e) => {
    const f = e.layer?.feature || e.propagatedFrom?.feature;
    const p = f?.properties || e.layer?.feature?.properties;
    // esri featureLayer click
  });
  if (layer.bindPopup) {
    layer.bindPopup((layer) => {
      const p = layer.feature?.properties || {};
      const status = p.status || p.flood || "unknown";
      const color = gaugeStatusColor(status);
      const obs = p.observed != null ? p.observed : "—";
      const units = p.units || "ft";
      const name = p.location || p.gaugelid || "River Gauge";
      const waterbody = p.waterbody || "";
      const time = p.obstime || "";
      const action = p.action != null ? p.action : "—";
      const flood = p.flood != null ? p.flood : "—";
      const mod = p.moderate != null ? p.moderate : "—";
      const maj = p.major != null ? p.major : "—";
      const url = p.url || "";
      return `<div style="min-width:220px;font-family:monospace;font-size:11px">
        <strong style="color:#e67e22">${name}</strong><br/>
        <span style="color:${color}">● ${status}</span><br/>
        ${waterbody}<br/>
        <hr style="border-color:#333"/>
        Observed: <b>${obs} ${units}</b><br/>
        Time: ${time}<br/>
        Action: ${action} · Flood: ${flood}<br/>
        Moderate: ${mod} · Major: ${maj}<br/>
        Gauge: ${p.gaugelid || ""} · ${p.state || ""} ${p.wfo || ""}<br/>
        ${url ? `<a href="${url}" target="_blank" style="color:#e67e22">Hydrograph / AHPS ↗</a>` : ""}
      </div>`;
    });
  }
}

async function wmsIdentify(latlng, layerName) {
  if (!map || !layerName) return null;
  const size = map.getSize();
  const bounds = map.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  // Project to 3857-ish bbox for WMS 1.1.1 with EPSG:3857 is complex; use 4326
  const bbox = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
  const point = map.latLngToContainerPoint(latlng);
  const url = `${NC_WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&LAYERS=${encodeURIComponent(layerName)}&QUERY_LAYERS=${encodeURIComponent(layerName)}&STYLES=&SRS=EPSG:4326&BBOX=${bbox}&WIDTH=${size.x}&HEIGHT=${size.y}&X=${Math.round(point.x)}&Y=${Math.round(point.y)}&INFO_FORMAT=application/json&FEATURE_COUNT=5`;
  try {
    const res = await fetch(url);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) {
      const json = await res.json();
      return json;
    }
    const text = await res.text();
    return { raw: text.slice(0, 2000) };
  } catch (e) {
    return null;
  }
}

function bindNcIdentify() {
  if (ncIdentifyBound || !map) return;
  ncIdentifyBound = true;
  map.on("click", async (e) => {
    // Find first active WMS layer to identify
    const active = Object.entries(ncLayerState).filter(([k, v]) => v && NC_WMS_MAP[k]);
    if (!active.length) return;
    // Prefer bluetopo / waterlevels / radar for identify
    const prefer = ["bluetopo", "waterlevels_nc", "vlm", "sfc_currents", "sst_nc", "radar"];
    let key = prefer.find(k => ncLayerState[k]) || active[0][0];
    const layerName = NC_WMS_MAP[key];
    if (!layerName) return;
    const info = await wmsIdentify(e.latlng, layerName);
    if (!info) return;
    let html = "";
    if (info.features && info.features.length) {
      html = info.features.map(f => {
        const props = f.properties || {};
        return Object.entries(props).map(([k, v]) => `<b>${k}</b>: ${v}`).join("<br/>");
      }).join("<hr/>");
    } else if (info.raw) {
      html = `<pre style="white-space:pre-wrap;font-size:10px">${info.raw}</pre>`;
    } else {
      return; // nothing
    }
    L.popup({ maxWidth: 320 })
      .setLatLng(e.latlng)
      .setContent(`<div style="font-size:11px"><strong>${key}</strong><br/>${html}</div>`)
      .openOn(map);
  });
}

function toggleNcLayer(key, on) {
  if (!map) return;

  if (key === "alerts") {
    showWarnings = on;
    document.getElementById("toggleWarnings")?.classList.toggle("active", on);
    renderNwsAlertPolygons();
    return;
  }

  removeNc(key);
  if (!on) {
    showToast(`${key} OFF`);
    return;
  }

  const op = (parseInt(document.getElementById("ncOpacity")?.value || "70", 10)) / 100;
  bindNcIdentify();

  // Generic nowCOAST WMS
  if (NC_WMS_MAP[key]) {
    ncLayerState[key] = makeWmsLayer(NC_WMS_MAP[key], {
      opacity: op,
      zIndex: 350 + Object.keys(ncLayerState).length
    });
    ncLayerState[key].addTo(map);
    setTimeout(() => {
      try { map.invalidateSize(); ncLayerState[key]?.redraw(); } catch (_) {}
    }, 150);
    showToast(`${key.replace(/_/g, " ")} ON — click map for values`);
    return;
  }

  if (key === "tropical") {
    // nowCOAST tropical WMS + NHC MapServer
    ncLayerState.tropical = makeWmsLayer("tropical_cyclones:active_tropical_cyclones", { opacity: op, zIndex: 420 });
    ncLayerState.tropical.addTo(map);
    if (typeof L.esri !== "undefined" && L.esri.dynamicMapLayer) {
      try {
        const nhc = L.esri.dynamicMapLayer({
          url: "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer",
          opacity: 0.9,
          f: "image"
        });
        nhc.addTo(map);
        // store secondary on same key via layer group
        map.removeLayer(ncLayerState.tropical);
        const g = L.layerGroup([ncLayerState.tropical, nhc]);
        g.addTo(map);
        ncLayerState.tropical = g;
      } catch (_) {}
    }
    showToast("Tropical Cyclones ON (empty if no active storms)");
    return;
  }

  if (key === "nautical") {
    // Reliable chart stack (NO MCS/footprints — those drew red misaligned grids):
    // 1) Esri Ocean base (bathymetry shading)
    // 2) Esri Ocean reference (depth contours, labels)
    // 3) OpenSeaMap seamarks (buoys, lights, marks)
    // 4) BlueTopo WMS for high-res NOAA bathymetry where available
    const oceanBase = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 16, opacity: 1, attribution: "Esri Ocean", zIndex: 200 }
    );
    const oceanRef = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 16, opacity: 0.95, attribution: "Esri Ocean Ref", zIndex: 201 }
    );
    const seamark = L.tileLayer(
      "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
      { maxZoom: 18, minZoom: 7, opacity: 1, attribution: "OpenSeaMap", zIndex: 452 }
    );
    const bathy = makeWmsLayer("bluetopo:bathymetry", {
      opacity: 0.45,
      zIndex: 320,
      attribution: "NOAA BlueTopo"
    });
    const group = L.layerGroup([oceanBase, oceanRef, bathy, seamark]);
    group.addTo(map);
    ncLayerState.nautical = group;
    // Pull dark basemap down so ocean charts read clearly
    try {
      document.querySelectorAll(".basemap-btn").forEach(b => b.classList.remove("active"));
    } catch (_) {}
    if (map.getZoom() < 8) map.setZoom(9);
    try { setBasemap("ocean"); } catch (_) {}
    showToast("Nautical Charts ON — Ocean depth + seamarks + BlueTopo");
    return;
  }

  if (key === "convective") {
    if (typeof L.esri !== "undefined" && L.esri.dynamicMapLayer) {
      ncLayerState.convective = L.esri.dynamicMapLayer({
        url: "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer",
        layers: [0, 1, 8, 9, 16, 17],
        opacity: op,
        f: "image"
      });
      ncLayerState.convective.addTo(map);
      showToast("SPC Convective Outlooks ON (Day 1–3)");
    } else showToast("Convective outlooks unavailable");
    return;
  }

  if (key === "river") {
    if (typeof L.esri !== "undefined" && L.esri.featureLayer) {
      const fl = L.esri.featureLayer({
        url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0",
        pointToLayer: (geojson, latlng) => {
          const st = (geojson.properties?.status || "").toLowerCase();
          const color = gaugeStatusColor(st);
          return L.circleMarker(latlng, {
            radius: 5,
            color: "#111",
            weight: 1,
            fillColor: color,
            fillOpacity: 0.9
          });
        }
      });
      fl.on("click", (e) => {
        const p = e.layer?.feature?.properties || {};
        if (!p.gaugelid && !p.location) return;
        openRiverGaugeDetail(p);
      });
      fl.addTo(map);
      ncLayerState.river = fl;
      showToast("River Gauges ON — click for hydrograph & thresholds");
    } else showToast("River gauges need Esri Leaflet");
    return;
  }

  if (key === "zoneForecast") {
    if (typeof L.esri !== "undefined" && L.esri.dynamicMapLayer) {
      ncLayerState.zoneForecast = L.esri.dynamicMapLayer({
        url: "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer",
        layers: [4, 5, 6, 7, 8],
        opacity: op,
        f: "image"
      });
      ncLayerState.zoneForecast.addTo(map);
      showToast("Zone Weather Forecasts ON (marine + public zones)");
    } else showToast("Zone forecasts unavailable");
    return;
  }

  if (key === "usgs") {
    if (on) {
      loadUsgsGaugesForView();
      if (usgsMoveHandler) map.off("moveend", usgsMoveHandler);
      usgsMoveHandler = () => {
        if (document.querySelector('#nowcoastLayers input[data-nc="usgs"]')?.checked) {
          loadUsgsGaugesForView();
        }
      };
      map.on("moveend", usgsMoveHandler);
    } else {
      removeNc("usgs");
      if (usgsMoveHandler) {
        map.off("moveend", usgsMoveHandler);
        usgsMoveHandler = null;
      }
      showToast("USGS gauges OFF");
    }
    return;
  }

  if (key === "surface_obs") {
    showToast("Surface obs: use station markers + Weather Radar for live conditions");
    return;
  }

  showToast(`No service mapped for ${key}`);
}

async function loadTropicalCyclones() {
  toggleNcLayer("tropical", true);
}


async function openRiverGaugeDetail(p) {
  const lid = (p.gaugelid || "").trim();
  const lidLower = lid.toLowerCase();
  const name = p.location || lid || "River Gauge";
  const status = p.status || "—";
  const color = gaugeStatusColor(status);
  const pageUrl = p.url || (lidLower ? `https://water.noaa.gov/gauges/${lidLower}` : "");
  const hgImg = lidLower ? `https://water.noaa.gov/resources/hydrographs/${lidLower}_hg.png` : "";

  // Shell UI immediately
  let html = `
    <div style="font-size:12px;line-height:1.5;color:var(--text)">
      <div style="font-size:14px;color:var(--orange);margin-bottom:6px">${name}</div>
      <div>Water body: ${p.waterbody || "—"} · ${p.state || ""} · WFO ${p.wfo || ""}</div>
      <div>Status: <b style="color:${color}">${status}</b></div>
      <div>Observed: <b>${p.observed ?? "—"} ${p.units || "ft"}</b> @ ${p.obstime || ""}</div>
      <div style="margin:8px 0;padding:8px;background:#0a0d12;border:1px solid var(--panel-border)">
        <div style="font-size:10px;color:var(--text-muted)">THRESHOLDS (${p.units || "ft"})</div>
        Action <b>${p.action ?? "—"}</b> · Flood <b>${p.flood ?? "—"}</b> ·
        Moderate <b>${p.moderate ?? "—"}</b> · Major <b>${p.major ?? "—"}</b>
      </div>
      <div id="gaugeChartWrap" style="height:180px;margin:8px 0;background:#0a0d12;border:1px solid var(--panel-border);position:relative">
        <div class="loading" style="padding:40px;text-align:center">Loading hydrograph…</div>
      </div>
      ${hgImg ? `<img id="gaugeHgImg" src="${hgImg}" alt="Hydrograph" style="width:100%;max-height:200px;object-fit:contain;background:#0a0d12;border:1px solid var(--panel-border);margin-bottom:8px" onerror="this.style.display='none'"/>` : ""}
      ${pageUrl ? `<a href="${pageUrl}" target="_blank" style="color:var(--orange)">Open full gauge page on water.noaa.gov ↗</a>` : ""}
    </div>`;
  openLayerDetail(`RIVER GAUGE // ${lid}`, html);

  // Fetch stage time series from NWPS API and chart it
  if (!lidLower) return;
  try {
    const res = await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${lidLower}/stageflow`);
    if (!res.ok) throw new Error("NWPS " + res.status);
    const data = await res.json();
    const series = data.observed?.data || data.data || [];
    const pts = series
      .filter(d => d.primary != null && d.primary > -900)
      .slice(-120); // last ~points
    const wrap = document.getElementById("gaugeChartWrap");
    if (!wrap || !pts.length) {
      if (wrap) wrap.innerHTML = `<div style="padding:20px;color:var(--text-muted);font-size:11px">No recent stage series — see image/link below</div>`;
      return;
    }
    wrap.innerHTML = `<canvas id="gaugeStageChart"></canvas>`;
    const ctx = document.getElementById("gaugeStageChart")?.getContext("2d");
    if (!ctx || typeof Chart === "undefined") return;
    const action = parseFloat(p.action);
    const flood = parseFloat(p.flood);
    new Chart(ctx, {
      type: "line",
      data: {
        labels: pts.map(d => (d.validTime || "").replace("T", " ").slice(5, 16)),
        datasets: [{
          label: `Stage (${p.units || "ft"})`,
          data: pts.map(d => d.primary),
          borderColor: "#3498db",
          backgroundColor: "rgba(52,152,219,0.12)",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.2,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          annotation: undefined,
          title: {
            display: true,
            text: `${name} — observed stage`,
            color: "#e8ecef",
            font: { size: 11 }
          }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 6, color: "#5a6a7a", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.04)" } },
          y: {
            ticks: { color: "#5a6a7a", font: { size: 9 } },
            grid: { color: "rgba(255,255,255,0.06)" },
            title: { display: true, text: p.units || "ft", color: "#5a6a7a" }
          }
        }
      }
    });
  } catch (e) {
    const wrap = document.getElementById("gaugeChartWrap");
    if (wrap) wrap.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:11px">Live series unavailable — hydrograph image below if available</div>`;
  }
}



// ----- USGS Stream Gauges (NWIS) -----
let usgsMoveHandler = null;

function parseUsgsRdb(text) {
  const lines = text.split("\n").filter(l => l && !l.startsWith("#"));
  if (lines.length < 2) return [];
  // skip header + format line
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const c = lines[i].split("\t");
    if (c.length < 6) continue;
    const lat = parseFloat(c[4]), lon = parseFloat(c[5]);
    if (isNaN(lat) || isNaN(lon)) continue;
    rows.push({
      agency: c[0],
      site_no: c[1],
      name: c[2],
      site_type: c[3],
      lat, lon
    });
  }
  return rows;
}

async function loadUsgsGaugesForView() {
  if (!map) return;
  const b = map.getBounds();
  // limit bbox size
  const west = b.getWest(), south = b.getSouth(), east = b.getEast(), north = b.getNorth();
  if (east - west > 12 || north - south > 12) {
    showToast("Zoom in to load USGS gauges (max ~12° span)");
    return;
  }
  const bbox = [west, south, east, north].map(v => v.toFixed(5)).join(",");
  const url = `https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=${bbox}&siteType=ST&siteStatus=active&hasDataTypeCd=iv`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    const sites = parseUsgsRdb(text);
    removeNc("usgs");
    const group = L.layerGroup();
    sites.forEach(s => {
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 5,
        color: "#0a0d12",
        weight: 1,
        fillColor: "#1abc9c",
        fillOpacity: 0.9
      });
      m.bindTooltip(`${s.site_no} — ${s.name}`, { direction: "top", offset: [0, -4] });
      m.on("click", () => openUsgsGaugeDetail(s));
      group.addLayer(m);
    });
    group.addTo(map);
    ncLayerState.usgs = group;
    showToast(`USGS gauges: ${sites.length} sites in view`);
  } catch (e) {
    console.warn("USGS load", e);
    showToast("USGS gauge load failed");
  }
}

async function openUsgsGaugeDetail(s) {
  const siteNo = s.site_no;
  const mlId = `USGS-${siteNo}`;
  const statsUrl = `https://waterdata.usgs.gov/monitoring-location/${mlId}/statistical-graphs`;
  const locUrl = `https://waterdata.usgs.gov/monitoring-location/${mlId}/#parameterCode=00065&period=P7D`;
  const gwisUrl = `https://dashboard.waterdata.usgs.gov/api/gwis/2.1.1/service/site?sitenumber=${siteNo}&period=p7d&pad=false`;
  const nwdUrl = `https://dashboard.waterdata.usgs.gov/app/nwd/en/?site_no=${siteNo}`;

  let html = `
    <div style="font-size:12px;line-height:1.45;color:var(--text)">
      <div style="font-size:14px;color:#1abc9c;margin-bottom:4px">${s.name || siteNo}</div>
      <div style="color:var(--text-muted)">USGS ${siteNo} · ${s.site_type || "ST"} · ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</div>
      <div id="usgsIvStats" style="margin:10px 0;padding:8px;background:#0a0d12;border:1px solid var(--panel-border)">Loading latest values…</div>
      <div style="margin:8px 0;height:280px;border:1px solid var(--panel-border);background:#0a0d12">
        <iframe src="${gwisUrl}" style="width:100%;height:100%;border:0;background:#fff" title="USGS hydrograph"></iframe>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
        <a href="${statsUrl}" target="_blank" rel="noopener" style="color:var(--orange)">Statistical graphs ↗</a>
        <a href="${locUrl}" target="_blank" rel="noopener" style="color:var(--orange)">Monitoring location ↗</a>
        <a href="${nwdUrl}" target="_blank" rel="noopener" style="color:var(--orange)">National Water Dashboard ↗</a>
      </div>
    </div>`;
  openLayerDetail(`USGS // ${siteNo}`, html);

  // Fetch latest stage + discharge
  try {
    const ivUrl = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteNo}&parameterCd=00060,00065,00010&siteStatus=all`;
    const res = await fetch(ivUrl);
    const data = await res.json();
    const series = data?.value?.timeSeries || [];
    const bits = series.map(ts => {
      const p = ts.variable?.variableName || ts.variable?.variableCode?.[0]?.value || "param";
      const unit = ts.variable?.unit?.unitCode || "";
      const vals = ts.values?.[0]?.value || [];
      const last = vals[vals.length - 1];
      if (!last) return null;
      return `<div><b>${p}</b>: ${last.value} ${unit} <span style="color:var(--text-muted)">@ ${last.dateTime}</span></div>`;
    }).filter(Boolean);
    const el = document.getElementById("usgsIvStats");
    if (el) el.innerHTML = bits.length ? bits.join("") : "No recent instantaneous values";
  } catch (e) {
    const el = document.getElementById("usgsIvStats");
    if (el) el.textContent = "Could not load instantaneous values";
  }
}


function bindNowcoastUI() {
  document.querySelectorAll("#nowcoastLayers input[data-nc]").forEach(cb => {
    cb.addEventListener("change", () => toggleNcLayer(cb.dataset.nc, cb.checked));
  });
  document.getElementById("ncOpacity")?.addEventListener("input", (e) => {
    setNcOpacity(parseInt(e.target.value, 10));
  });
  document.getElementById("closeAlertModal")?.addEventListener("click", closeAlertModal);
  document.getElementById("alertModal")?.addEventListener("click", (e) => {
    if (e.target.id === "alertModal") closeAlertModal();
  });
  const alertsCb = document.querySelector('#nowcoastLayers input[data-nc="alerts"]');
  if (alertsCb) alertsCb.checked = !!showWarnings;
  initRainViewer();
}
