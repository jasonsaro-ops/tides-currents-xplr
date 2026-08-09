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
  initClock();
  initMap();
  bindUI();
  await loadStations();
  populateFilters();
  renderMarkers();
  loadActivePanel();
  // Realtime refresh every 2 minutes
  setInterval(() => {
    loadActivePanel(true);
    if (watchedStation) refreshWatch();
    if (selectedStation) {
      // soft refresh of open modal latest tab if open
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
    zoomControl: true,
    attributionControl: true
  });

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

    document.getElementById("stationCount").textContent = allStations.length;
    document.getElementById("activeCount").textContent = allStations.filter((s) => s.isPorts).length;
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

  // Watch button state
  const watchBtn = document.getElementById("watchBtn");
  if (watchBtn) {
    watchBtn.textContent = watchedStation?.id === station.id ? "★ WATCHING" : "☆ WATCH";
    watchBtn.classList.toggle("active", watchedStation?.id === station.id);
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
        label: title,
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
  if (station.type !== "currents") {
    container.innerHTML = `<div class="loading">Not a currents station. Select a PORTS current meter.</div>`;
    return;
  }
  try {
    const url = `${DATAAPI}?date=latest&station=${station.id}&product=currents&bin=1&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.data && json.data[0]) {
      const d = json.data[0];
      container.innerHTML = `
        <div class="data-grid">
          <div class="data-card"><div class="dlabel">SPEED</div><div class="dval">${d.s ?? "—"}<span class="dunit">kn</span></div><div class="dtime">${d.t || ""}</div></div>
          <div class="data-card"><div class="dlabel">DIRECTION</div><div class="dval">${d.d ?? "—"}<span class="dunit">°</span></div><div class="dtime">${d.t || ""}</div></div>
        </div>`;
    } else {
      container.innerHTML = `<div class="loading">No current data returned</div>`;
    }
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
    document.getElementById("watchPanel").classList.add("hidden");
    document.getElementById("watchBtn").textContent = "☆ WATCH";
    document.getElementById("watchBtn").classList.remove("active");
    showToast("Stopped watching station");
  } else {
    watchedStation = selectedStation;
    document.getElementById("watchBtn").textContent = "★ WATCHING";
    document.getElementById("watchBtn").classList.add("active");
    document.getElementById("watchPanel").classList.remove("hidden");
    document.getElementById("watchStationName").textContent = watchedStation.name;
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

  document.getElementById("fitUSA").onclick = () => map.setView([39.5, -98.35], 4);
  document.getElementById("toggleClusters").onclick = () => {
    useClusters = !useClusters;
    renderMarkers();
    showToast(useClusters ? "Clustering ON" : "Clustering OFF");
  };

  document.getElementById("refreshActive").onclick = () => loadActivePanel(false);

  document.querySelectorAll(".bm-btn").forEach((btn) => {
    btn.addEventListener("click", () => setBasemap(btn.dataset.bm));
  });

  // Watch button (injected in modal footer area via HTML update)
  const watchBtn = document.getElementById("watchBtn");
  if (watchBtn) watchBtn.onclick = toggleWatch;

  document.getElementById("clearWatch")?.addEventListener("click", () => {
    watchedStation = null;
    document.getElementById("watchPanel").classList.add("hidden");
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
