/* TIDES & CURRENTS XPLR
   NOAA CO-OPS powered dashboard — Martian ARM aesthetic
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

// Popular / high-activity stations for realtime panel
const HIGHLIGHT_IDS = [
  "9414290", // San Francisco
  "8518750", // The Battery, NY
  "8723214", // Virginia Key, FL
  "9447130", // Seattle
  "8761724", // Grand Isle
  "8574680", // Baltimore
  "8452660", // Newport
  "1612340", // Honolulu
  "9414750", // Alameda
  "8638610", // Sewells Point
  "8771450", // Galveston
  "9410840", // Santa Monica
  "8726520", // St Petersburg
  "8665530", // Charleston
  "8534720"  // Atlantic City
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
  setInterval(loadActivePanel, 5 * 60 * 1000); // refresh active every 5 min
});

// ========== CLOCK ==========
function initClock() {
  const el = document.getElementById("utcClock");
  function tick() {
    const now = new Date();
    el.textContent = now.toISOString().substr(11, 8);
  }
  tick();
  setInterval(tick, 1000);
}

// ========== MAP ==========
function initMap() {
  map = L.map("map", {
    center: [39.5, -98.35],
    zoom: 4,
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

  // Attribution sources
  map.attributionControl.setPrefix("");
  map.attributionControl.addAttribution(
    'ESRI · TomTom · Garmin · FAO · NOAA · USGS | CO-OPS'
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

  if (type === "dark") {
    currentBasemap = L.esri.basemapLayer("DarkGray");
  } else if (type === "imagery") {
    currentBasemap = L.esri.basemapLayer("Imagery");
  } else if (type === "topo") {
    currentBasemap = L.esri.basemapLayer("Topographic");
  } else if (type === "streets") {
    currentBasemap = L.esri.basemapLayer("Streets");
  } else if (type === "ocean") {
    currentBasemap = L.esri.basemapLayer("Oceans");
  }

  currentBasemap.addTo(map);
  currentBasemap.attribution = attributions[type] || "";

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
      isPorts: !!(s.portscode || (s.affiliations && s.affiliations.includes("PORTS"))),
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
    showToast(`Loaded ${waterStations.length} water level + ${currentStations.length} current stations`);
  } catch (err) {
    console.error(err);
    showToast("Failed to load stations — check console / network");
  }
}

function inferState(lat, lng) {
  // Rough fallback; most current stations lack state in MDAPI
  if (lat > 40 && lng < -70) return "MA";
  if (lat > 36 && lat < 40 && lng > -77 && lng < -74) return "MD";
  if (lat > 36 && lat < 39 && lng > -77 && lng < -75) return "VA";
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

  // Quick state buttons
  const popular = ["CA", "FL", "TX", "NY", "WA", "VA", "MD", "LA", "HI", "AK", "NJ", "NC"];
  const qs = document.getElementById("quickStates");
  popular.forEach((st) => {
    if (states.includes(st)) {
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
    if (type === "met") return s.type === "waterlevels"; // met usually co-located
    if (!showWL && s.type === "waterlevels") return false;
    if (!showCur && s.type === "currents") return false;
    if (portsOnly && !s.isPorts) return false;
    return true;
  });
}

function renderMarkers() {
  if (clusterGroup) {
    map.removeLayer(clusterGroup);
    clusterGroup = null;
  }
  if (markersLayer) {
    map.removeLayer(markersLayer);
    markersLayer = null;
  }

  const stations = getFilteredStations();
  const group = useClusters
    ? L.markerClusterGroup({
        maxClusterRadius: 40,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false
      })
    : L.layerGroup();

  stations.forEach((s) => {
    if (!s.lat || !s.lng) return;
    const colorClass =
      s.type === "currents" ? "current" : s.isPorts ? "ports" : "water";

    const icon = L.divIcon({
      className: "",
      html: `<div class="station-marker ${colorClass}" title="${s.name}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });

    const marker = L.marker([s.lat, s.lng], { icon });
    marker.bindTooltip(
      `<strong>${s.name}</strong><br/>${s.id} · ${s.state || ""} · ${s.type}`,
      { direction: "top", offset: [0, -8] }
    );
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
  if (stations.length && stations.length < 80) {
    const bounds = L.latLngBounds(stations.map((s) => [s.lat, s.lng]));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15));
  }
}

// ========== ACTIVE / REALTIME PANEL ==========
async function loadActivePanel() {
  const list = document.getElementById("activeList");
  list.innerHTML = `<div class="loading">FETCHING LATEST OBSERVATIONS...</div>`;

  const targets = HIGHLIGHT_IDS.map((id) =>
    allStations.find((s) => s.id === id)
  ).filter(Boolean);

  // Prefer stations that actually exist in our list
  const toFetch = targets.length ? targets : allStations.filter((s) => s.isPorts).slice(0, 12);

  const results = await Promise.allSettled(
    toFetch.map(async (s) => {
      const data = await fetchLatestWaterLevel(s.id);
      return { station: s, data };
    })
  );

  list.innerHTML = "";
  results.forEach((r) => {
    if (r.status !== "fulfilled" || !r.value.data) return;
    const { station, data } = r.value;
    const item = document.createElement("div");
    item.className = "active-item";
    item.innerHTML = `
      <div class="name">${station.name}</div>
      <div class="meta">${station.id} · ${station.state || ""} · ${station.type}</div>
      <div class="val">${data.v != null ? data.v + " ft" : "—"} <span style="color:var(--text-muted);font-size:10px">${data.t || ""}</span></div>
    `;
    item.onclick = () => openStation(station);
    list.appendChild(item);
  });

  if (!list.children.length) {
    list.innerHTML = `<div class="loading">No realtime samples available right now</div>`;
  }
}

async function fetchLatestWaterLevel(stationId) {
  try {
    const url = `${DATAAPI}?date=latest&station=${stationId}&product=water_level&datum=MLLW&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
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

  const meta = document.getElementById("modalMeta");
  meta.innerHTML = `
    <div class="meta-item"><div class="mlabel">LATITUDE</div><div class="mval">${station.lat?.toFixed(5) ?? "—"}</div></div>
    <div class="meta-item"><div class="mlabel">LONGITUDE</div><div class="mval">${station.lng?.toFixed(5) ?? "—"}</div></div>
    <div class="meta-item"><div class="mlabel">STATE</div><div class="mval">${station.state || "—"}</div></div>
    <div class="meta-item"><div class="mlabel">TYPE</div><div class="mval">${station.type?.toUpperCase()}</div></div>
    <div class="meta-item"><div class="mlabel">PORTS®</div><div class="mval">${station.isPorts ? "YES" : "NO"}</div></div>
    <div class="meta-item"><div class="mlabel">AFFILIATIONS</div><div class="mval">${station.affiliations || station.portscode || "—"}</div></div>
  `;

  // Reset tabs
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tab[data-tab="latest"]').classList.add("active");
  await loadTab("latest");
}

function closeModal() {
  document.getElementById("stationModal").classList.add("hidden");
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  selectedStation = null;
}

async function loadTab(tab) {
  const content = document.getElementById("tabContent");
  content.innerHTML = `<div class="loading">FETCHING DATA...</div>`;
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  const s = selectedStation;
  if (!s) return;

  try {
    if (tab === "latest") {
      await renderLatest(s, content);
    } else if (tab === "water") {
      await renderTimeSeries(s, content, "water_level", "Water Level (ft MLLW)");
    } else if (tab === "met") {
      await renderMet(s, content);
    } else if (tab === "currents") {
      await renderCurrents(s, content);
    } else if (tab === "predictions") {
      await renderPredictions(s, content);
    }
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="loading">Error loading data: ${err.message}</div>`;
  }
}

async function renderLatest(station, container) {
  const products = station.type === "currents"
    ? ["currents"]
    : ["water_level", "air_temperature", "water_temperature", "air_pressure", "wind", "visibility", "humidity"];

  const cards = [];
  for (const prod of products) {
    try {
      let url = `${DATAAPI}?date=latest&station=${station.id}&product=${prod}&time_zone=gmt&units=english&format=json&application=tides-currents-xplr`;
      if (prod === "water_level") url += "&datum=MLLW";
      if (prod === "currents") url += "&bin=1";

      const res = await fetch(url);
      const json = await res.json();
      if (json.data && json.data[0]) {
        const d = json.data[0];
        let label = prod.replace(/_/g, " ").toUpperCase();
        let val = d.v ?? d.s ?? "—";
        let unit = "";
        let extra = "";

        if (prod === "water_level") { unit = "ft"; }
        else if (prod === "air_temperature" || prod === "water_temperature") { unit = "°F"; }
        else if (prod === "air_pressure") { unit = "mb"; }
        else if (prod === "wind") {
          val = d.s ?? "—";
          unit = "kn";
          extra = d.d != null ? ` @ ${d.d}°` : "";
          if (d.g) extra += ` G${d.g}`;
        } else if (prod === "visibility") { unit = "nm"; }
        else if (prod === "humidity") { unit = "%"; }
        else if (prod === "currents") {
          val = d.s ?? "—";
          unit = "kn";
          extra = d.d != null ? ` @ ${d.d}°` : "";
        }

        cards.push(`
          <div class="data-card">
            <div class="dlabel">${label}</div>
            <div class="dval">${val}<span class="dunit">${unit}${extra}</span></div>
            <div class="dtime">${d.t || ""}</div>
          </div>
        `);
      }
    } catch (_) { /* skip missing products */ }
  }

  if (!cards.length) {
    container.innerHTML = `<div class="loading">No latest observations available for this station</div>`;
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
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { color: "#5a6a7a", maxTicksLimit: 8, font: { size: 9 } },
          grid: { color: "rgba(255,255,255,0.04)" }
        },
        y: {
          ticks: { color: "#5a6a7a", font: { size: 9 } },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
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
    { key: "humidity", label: "HUMIDITY (%)" }
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
    container.innerHTML = `<div class="loading">This is not a currents station. Try a PORTS current meter.</div>`;
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
          <div class="data-card">
            <div class="dlabel">SPEED</div>
            <div class="dval">${d.s ?? "—"}<span class="dunit">kn</span></div>
            <div class="dtime">${d.t || ""}</div>
          </div>
          <div class="data-card">
            <div class="dlabel">DIRECTION</div>
            <div class="dval">${d.d ?? "—"}<span class="dunit">°</span></div>
            <div class="dtime">${d.t || ""}</div>
          </div>
        </div>
      `;
    } else {
      container.innerHTML = `<div class="loading">No current data returned</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
  }
}

async function renderPredictions(station, container) {
  if (station.type === "currents") {
    container.innerHTML = `<div class="loading">Tide predictions not applicable to pure current meters. Use water level stations.</div>`;
    return;
  }

  const today = new Date();
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  const url = `${DATAAPI}?begin_date=${fmt(today)}&range=48&station=${station.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json&application=tides-currents-xplr`;
  const res = await fetch(url);
  const json = await res.json();

  if (!json.predictions || !json.predictions.length) {
    container.innerHTML = `<div class="loading">No tide predictions available</div>`;
    return;
  }

  const rows = json.predictions.slice(0, 12).map((p) => `
    <div class="data-card">
      <div class="dlabel">${p.type || "TIDE"}</div>
      <div class="dval">${p.v}<span class="dunit">ft</span></div>
      <div class="dtime">${p.t}</div>
    </div>
  `).join("");

  container.innerHTML = `
    <div style="color:var(--text-dim);font-size:11px;margin-bottom:8px">HIGH / LOW PREDICTIONS (next ~48h)</div>
    <div class="data-grid">${rows}</div>
  `;
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

  document.getElementById("resetFilters").onclick = () => {
    document.getElementById("stateFilter").value = "";
    document.getElementById("typeFilter").value = "";
    document.getElementById("productFilter").value = "none";
    document.getElementById("showWaterLevels").checked = true;
    document.getElementById("showCurrents").checked = true;
    document.getElementById("showPorts").checked = false;
    applyFilters();
    map.setView([39.5, -98.35], 4);
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

  document.getElementById("refreshActive").onclick = loadActivePanel;

  document.querySelectorAll(".bm-btn").forEach((btn) => {
    btn.addEventListener("click", () => setBasemap(btn.dataset.bm));
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
    // Filter map to matches
    document.getElementById("stateFilter").value = "";
    // Temporary filter via search
    if (clusterGroup) map.removeLayer(clusterGroup);
    if (markersLayer) map.removeLayer(markersLayer);

    const group = L.featureGroup();
    matches.forEach((s) => {
      const colorClass = s.type === "currents" ? "current" : s.isPorts ? "ports" : "water";
      const icon = L.divIcon({
        className: "",
        html: `<div class="station-marker ${colorClass}"></div>`,
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
  setTimeout(() => t.classList.add("hidden"), 3200);
}
