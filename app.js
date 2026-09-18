/**
 * LastMile Guardian — Executive Civic Usability Engine
 * Core Implementation: Real-Time Usability & Fault Inference for Essential Public Services
 * Enhanced with High-Precision Geolocation, IP Fallback, Draggable Pin & Address Search
 */

// ============================================================================
// GLOBAL STATE & SYSTEM REGISTRY
// ============================================================================
const API_BASE = 'http://localhost:8080/api';

const state = {
  backendOnline: false,
  userLocation: {
    lat: 9.0196, // Realistic detected corridor default
    lon: 76.9226,
    accuracy: 15,
    heading: null,
    speed: null,
    hasHardwareGps: false,
    addressString: 'Detecting your live address...'
  },
  gpsWatchId: null,
  isTrackingActive: false,
  isPinpointMode: false,
  activeCategory: 'All',
  selectedFacilityId: null,
  activeReroute: null,
  activeTileLayerIndex: 0,
  facilities: [],
  reroutePolyline: null,
  map: null,
  userMarker: null,
  userAccuracyCircle: null,
  facilityMarkers: {},
  tileLayers: []
};

// Facility Category Definitions with Glyphs & Defaults
const CATEGORY_META = {
  ATM: { label: 'ATM', glyph: '🏧', color: '#38bdf8' },
  Fuel: { label: 'Fuel & CNG', glyph: '⛽', color: '#f59e0b' },
  Medical: { label: '24/7 Pharmacy', glyph: '💊', color: '#10b981' },
  EV: { label: 'EV Fast Charger', glyph: '⚡', color: '#818cf8' },
  Clinic: { label: 'Emergency Clinic', glyph: '🏥', color: '#ec4899' }
};

// ============================================================================
// BACKEND API CLIENT & FAULT INFERENCE ENGINE
// ============================================================================
class BackendClient {
  static async checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        state.backendOnline = true;
        logTelemetry(`Connected to Backend Engine: ${data.server || 'Active'}`);
        return true;
      }
    } catch (e) {
      state.backendOnline = false;
      logTelemetry('Backend server offline. Operating in autonomous client-side mode.');
    }
    return false;
  }

  static async fetchFacilities(lat, lon, area) {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/facilities?lat=${lat}&lon=${lon}&area=${encodeURIComponent(area)}`, {
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
          return await res.json();
        }
      } catch (e) {
        console.warn('Backend facilities fetch failed, using local model:', e);
      }
    }
    return generateLocalizedFacilities(lat, lon, area);
  }

  static async recordVisit(facilityId, dwellSeconds) {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/telemetry/visit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facilityId, dwellSeconds })
        });
        if (res.ok) return await res.json();
      } catch (e) {
        console.warn('Backend recordVisit failed:', e);
      }
    }
    return null;
  }

  static async recordReport(facilityId, success, faultTag) {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/telemetry/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facilityId, success, faultTag })
        });
        if (res.ok) return await res.json();
      } catch (e) {
        console.warn('Backend recordReport failed:', e);
      }
    }
    return null;
  }

  static async triggerSimAbort() {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/simulation/abort`, { method: 'POST' });
        if (res.ok) return await res.json();
      } catch (e) {
        console.warn('Backend sim abort failed:', e);
      }
    }
    return null;
  }

  static async triggerSimSuccess() {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/simulation/success`, { method: 'POST' });
        if (res.ok) return await res.json();
      } catch (e) {
        console.warn('Backend sim success failed:', e);
      }
    }
    return null;
  }

  static async triggerSimReset() {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/simulation/reset`, { method: 'POST' });
        if (res.ok) return await res.json();
      } catch (e) {
        console.warn('Backend sim reset failed:', e);
      }
    }
    return null;
  }
}

class FaultInferenceEngine {
  static evaluateFacilityHealth(facility) {
    let score = facility.baseScore || 92;
    const bounceCount = facility.recentBounces || 0;
    score -= bounceCount * 24;

    const failureReports = facility.explicitFailures || 0;
    score -= failureReports * 36;

    const successDwells = facility.verifiedSuccesses || 0;
    score += successDwells * 14;

    score = Math.max(8, Math.min(99, Math.round(score)));
    facility.healthScore = score;

    if (score >= 80) {
      facility.status = 'Operational';
      facility.statusClass = 'green';
      facility.statusText = 'Verified active with regular visitor dwell times.';
    } else if (score >= 40) {
      facility.status = 'Uncertain';
      facility.statusClass = 'yellow';
      facility.statusText = 'Uncertain operational health: multiple rapid exits detected.';
    } else {
      facility.status = 'Unavailable';
      facility.statusClass = 'red';
      facility.statusText = 'Service failure inferred: zero completed dwells & rapid bounces.';
    }

    return facility;
  }

  static findNearestOperationalPeer(sourceNode, allNodes, userLat, userLon) {
    const validPeers = allNodes.filter(n =>
      n.id !== sourceNode.id &&
      n.category === sourceNode.category &&
      n.status === 'Operational'
    );

    if (validPeers.length === 0) return null;

    validPeers.sort((a, b) => {
      const distA = getHaversineDistance(userLat, userLon, a.lat, a.lon);
      const distB = getHaversineDistance(userLat, userLon, b.lat, b.lon);
      return distA - distB;
    });

    return validPeers[0];
  }
}

function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// DYNAMIC LOCALIZED FACILITY SEEDING ENGINE
// ============================================================================
function generateLocalizedFacilities(centerLat, centerLon, areaName = 'Local Corridor') {
  const cleanArea = areaName.split(',')[0].trim() || 'Civic Center';

  const templates = [
    { name: 'Federal Bank 24hr ATM', category: 'ATM', dLat: 0.0032, dLon: 0.0038, dwell: '2.1 min', queue: '1-2 min', corridor: `${cleanArea} Junction` },
    { name: 'SBI ATM & Cash Deposit', category: 'ATM', dLat: -0.0048, dLon: -0.0035, dwell: '2.4 min', queue: '2-4 min', corridor: `${cleanArea} Market Rd` },
    { name: 'Indian Oil Petrol Bunk', category: 'Fuel', dLat: 0.0076, dLon: -0.0055, dwell: '4.8 min', queue: '3 min', corridor: `${cleanArea} Highway` },
    { name: 'Bharat Petroleum Pump', category: 'Fuel', dLat: -0.0084, dLon: 0.0068, dwell: '5.2 min', queue: '1 min', corridor: `${cleanArea} Bypass` },
    { name: 'Apollo 24/7 Pharmacy', category: 'Medical', dLat: 0.0042, dLon: -0.0021, dwell: '3.5 min', queue: '0 min', corridor: `${cleanArea} Main Rd` },
    { name: 'Neethi 24hr Medical Store', category: 'Medical', dLat: -0.0061, dLon: 0.0034, dwell: '4.0 min', queue: '2 min', corridor: `${cleanArea} Hospital Cross` },
    { name: 'KSEB EV Fast Charger 60kW', category: 'EV', dLat: 0.0065, dLon: 0.0079, dwell: '28 min', queue: 'CCS2 Ready', corridor: `${cleanArea} Substation` },
    { name: 'Zeon EV Fast Charging Hub', category: 'EV', dLat: -0.0098, dLon: -0.0068, dwell: '35 min', queue: 'Dual Gun Ready', corridor: `${cleanArea} Commercial Hub` },
    { name: 'Taluk Emergency Health Clinic', category: 'Clinic', dLat: 0.0105, dLon: 0.0028, dwell: '14 min', queue: 'Triage Open', corridor: `${cleanArea} Civic Hospital` },
    { name: 'HDFC Bank ATM & Cash Deposit', category: 'ATM', dLat: -0.0018, dLon: 0.0084, dwell: '1.9 min', queue: '0 min', corridor: `${cleanArea} East Gate` }
  ];

  return templates.map((t, idx) => {
    const lat = centerLat + t.dLat;
    const lon = centerLon + t.dLon;
    const initialFacility = {
      id: `node-${idx + 1}`,
      name: t.name,
      category: t.category,
      lat: lat,
      lon: lon,
      corridor: t.corridor,
      dwell: t.dwell,
      queue: t.queue,
      baseScore: 92,
      healthScore: 92,
      status: 'Operational',
      statusClass: 'green',
      statusText: 'Normal visitor transaction durations confirmed.',
      recentBounces: 0,
      explicitFailures: 0,
      verifiedSuccesses: 1,
      activeTags: []
    };
    return FaultInferenceEngine.evaluateFacilityHealth(initialFacility);
  });
}

// ============================================================================
// MULTI-TIER ACCURATE GEOLOCATION & REVERSE GEOCODING
// ============================================================================

/**
 * High-accuracy reverse geocoder using Nominatim + BigDataCloud fallback
 */
async function fetchAccurateAddress(lat, lon) {
  // Provider 1: OpenStreetMap Nominatim with proper User-Agent
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      {
        headers: { 'Accept': 'application/json', 'User-Agent': 'LastMileGuardian-CivicGrid/2.0' },
        signal: AbortSignal.timeout(6000)
      }
    );

    if (response.ok) {
      const data = await response.json();
      if (data && data.address) {
        const addr = data.address;
        const street = addr.road || addr.pedestrian || addr.residential || addr.suburb || addr.neighbourhood || '';
        const place = addr.city || addr.town || addr.village || addr.municipality || addr.county || addr.state_district || '';
        const stateName = addr.state || '';
        const postcode = addr.postcode ? ` - ${addr.postcode}` : '';

        const parts = [street, place, stateName].filter(Boolean);
        if (parts.length > 0) {
          return parts.join(', ') + postcode;
        }
      }
      if (data && data.display_name) {
        return data.display_name.split(',').slice(0, 4).join(', ');
      }
    }
  } catch (err) {
    console.warn('Nominatim reverse geocode fallback...', err);
  }

  // Provider 2: BigDataCloud Reverse Geocoding Client API
  try {
    const fallbackRes = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (fallbackRes.ok) {
      const data = await fallbackRes.json();
      const locality = data.locality || data.localityInfo?.administrative?.[3]?.name || '';
      const city = data.city || data.principalSubdivision || '';
      const stateName = data.principalSubdivision || '';
      const parts = [locality, city, stateName].filter(Boolean);
      if (parts.length > 0) return parts.join(', ');
    }
  } catch (err2) {
    console.warn('Fallback geocoder failed:', err2);
  }

  return `GPS [${lat.toFixed(5)}, ${lon.toFixed(5)}]`;
}

/**
 * IP-based geolocation fallback when browser GPS is blocked, timed out, or inaccurate
 */
async function fetchNetworkIpLocation() {
  try {
    const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.latitude && data.longitude) {
        return {
          lat: data.latitude,
          lon: data.longitude,
          city: data.city || data.region || 'Local',
          region: data.region || '',
          country: data.country || ''
        };
      }
    }
  } catch (err) {
    console.warn('ipwho.is lookup failed, trying freeipapi...', err);
  }

  try {
    const res2 = await fetch('https://freeipapi.com/api/json', { signal: AbortSignal.timeout(4000) });
    if (res2.ok) {
      const data = await res2.json();
      if (data && data.latitude && data.longitude) {
        return {
          lat: data.latitude,
          lon: data.longitude,
          city: data.cityName || data.regionName || 'Local',
          region: data.regionName || '',
          country: data.countryName || ''
        };
      }
    }
  } catch (err2) {
    console.warn('freeipapi lookup failed:', err2);
  }

  return null;
}

/**
 * Master Geolocation Bootstrapper:
 * 1. Checks IP network location in parallel so user's true area is known immediately
 * 2. Tries browser GPS with high accuracy
 * 3. Applies the best available coordinates and reverse geocodes the exact street address
 */
async function initAccurateGeolocation() {
  const radarText = document.getElementById('radar-readout-text');
  const gpsBtn = document.getElementById('gps-action-btn');

  if (radarText) radarText.innerText = 'LOCKING YOUR EXACT LIVE LOCATION...';
  if (gpsBtn) gpsBtn.classList.add('locking');

  let resolved = false;

  // Start IP detection in background immediately
  const ipPromise = fetchNetworkIpLocation();

  // Try Browser High-Accuracy GPS
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        resolved = true;
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const acc = pos.coords.accuracy || 12;

        state.userLocation.lat = lat;
        state.userLocation.lon = lon;
        state.userLocation.accuracy = acc;
        state.userLocation.hasHardwareGps = true;

        if (gpsBtn) {
          gpsBtn.classList.remove('locking');
          gpsBtn.classList.add('active');
        }

        logTelemetry(`GPS lock acquired: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(acc)}m)`);
        if (radarText) radarText.innerText = `GPS LOCKED: ±${Math.round(acc)}M ACCURACY`;

        const address = await fetchAccurateAddress(lat, lon);
        state.userLocation.addressString = address;
        updateAddressDisplay(address, acc);
        await applyLocationAndSeed(lat, lon, true, acc);
      },
      async (err) => {
        console.warn('Browser GPS unavailable or timed out:', err.message);
        if (!resolved) {
          // Fall back to IP network location
          const ipLoc = await ipPromise;
          if (ipLoc) {
            logTelemetry(`Using verified Network Location: ${ipLoc.city}, ${ipLoc.region} (${ipLoc.lat.toFixed(4)}, ${ipLoc.lon.toFixed(4)})`);
            await applyManualCoordinates(ipLoc.lat, ipLoc.lon, 250, `${ipLoc.city}, ${ipLoc.region}`);
          } else {
            logTelemetry(`GPS error: ${err.message}. Using active corridor.`);
            const address = await fetchAccurateAddress(state.userLocation.lat, state.userLocation.lon);
            updateAddressDisplay(address, 25);
            await applyLocationAndSeed(state.userLocation.lat, state.userLocation.lon, false, 25);
          }
          if (gpsBtn) gpsBtn.classList.remove('locking');
          if (radarText) radarText.innerText = 'CIVIC GRID ACTIVE';
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  } else {
    const ipLoc = await ipPromise;
    if (ipLoc) {
      await applyManualCoordinates(ipLoc.lat, ipLoc.lon, 250, `${ipLoc.city}, ${ipLoc.region}`);
    }
  }

  // Watch position for live movements
  if (navigator.geolocation) {
    state.gpsWatchId = navigator.geolocation.watchPosition(
      async (pos) => {
        // Only auto-update if not manually pinned
        if (!state.isPinpointMode) {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const acc = pos.coords.accuracy || 10;
          state.userLocation.lat = lat;
          state.userLocation.lon = lon;
          state.userLocation.accuracy = acc;
          updateUserMarker(lat, lon, acc);
          updateDistanceReadouts();
        }
      },
      (err) => console.debug('watchPosition tick error:', err.message),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }
}

/**
 * Directly updates location to specific coordinates (e.g. from search, drag, or click)
 */
async function applyManualCoordinates(lat, lon, accuracy = 10, customName = null) {
  state.userLocation.lat = lat;
  state.userLocation.lon = lon;
  state.userLocation.accuracy = accuracy;

  const address = customName || await fetchAccurateAddress(lat, lon);
  state.userLocation.addressString = address;

  updateAddressDisplay(address, accuracy);
  await applyLocationAndSeed(lat, lon, true, accuracy);

  const coordsDisplay = document.getElementById('modal-coords-display');
  const modalAddr = document.getElementById('modal-resolved-address');
  if (coordsDisplay) coordsDisplay.innerText = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  if (modalAddr) modalAddr.innerText = address;

  logTelemetry(`📍 Location updated to: ${address} [${lat.toFixed(5)}, ${lon.toFixed(5)}]`);
}

function updateAddressDisplay(addressStr, accuracyMeters) {
  const addrEl = document.getElementById('user-live-address');
  const accEl = document.getElementById('gps-accuracy-badge');
  if (addrEl) addrEl.innerText = addressStr;
  if (accEl) {
    accEl.innerText = accuracyMeters > 50 ? `±${Math.round(accuracyMeters)}m` : `±${Math.round(accuracyMeters)}m`;
  }
}

function toggleHardwareGps() {
  reTriggerGpsHardware();
}

function recenterOnUser() {
  if (state.map && state.userLocation.lat && state.userLocation.lon) {
    state.map.flyTo([state.userLocation.lat, state.userLocation.lon], 15, {
      animate: true,
      duration: 1.0
    });
  }
}

// ============================================================================
// MAP & LEAFLET RENDERING ENGINE (DRAGGABLE USER BEACON)
// ============================================================================
function initMapEngine() {
  const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap & CartoDB',
    subdomains: 'abcd',
    maxZoom: 19
  });

  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri & OpenStreetMap',
    maxZoom: 18
  });

  state.tileLayers = [darkMatter, satelliteLayer];

  state.map = L.map('map', {
    center: [state.userLocation.lat, state.userLocation.lon],
    zoom: 15,
    zoomControl: false,
    layers: [darkMatter]
  });

  L.control.zoom({ position: 'bottomleft' }).addTo(state.map);

  // Click on map to set location handler
  state.map.on('click', async (e) => {
    if (state.isPinpointMode) {
      const { lat, lng } = e.latlng;
      await applyManualCoordinates(lat, lng, 8);
      disablePinpointMode();
      logTelemetry(`🎯 Pinpoint placed at: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    }
  });

  BackendClient.checkHealth();
  initAccurateGeolocation();
}

function cycleTileLayer() {
  const nextIdx = (state.activeTileLayerIndex + 1) % state.tileLayers.length;
  state.map.removeLayer(state.tileLayers[state.activeTileLayerIndex]);
  state.map.addLayer(state.tileLayers[nextIdx]);
  state.activeTileLayerIndex = nextIdx;
  logTelemetry(`Map tile layer: ${nextIdx === 0 ? 'Dark Matter Radar' : 'Satellite Imagery'}`);
}

function updateUserMarker(lat, lon, accuracy) {
  if (!state.map) return;

  const beaconHtml = `
    <div class="user-live-beacon" title="Drag to adjust exact location">
      <div class="user-pulsing-wave"></div>
      <div class="user-center-core"></div>
      <div class="user-floating-lbl">
        <span>YOU</span>
        <span style="font-size:7px; opacity:0.8;">(DRAG ME)</span>
      </div>
    </div>
  `;

  const customUserIcon = L.divIcon({
    html: beaconHtml,
    className: 'leaflet-user-live-marker',
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });

  if (!state.userMarker) {
    state.userMarker = L.marker([lat, lon], {
      icon: customUserIcon,
      zIndexOffset: 1000,
      draggable: true
    }).addTo(state.map);

    // Draggable Pin Event
    state.userMarker.on('dragend', async (e) => {
      const pos = e.target.getLatLng();
      logTelemetry(`📍 Marker dragged to: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}. Resolving address...`);
      await applyManualCoordinates(pos.lat, pos.lng, 5);
    });
  } else {
    state.userMarker.setLatLng([lat, lon]);
  }

  if (!state.userAccuracyCircle) {
    state.userAccuracyCircle = L.circle([lat, lon], {
      radius: Math.max(accuracy, 20),
      color: '#38bdf8',
      fillColor: '#38bdf8',
      fillOpacity: 0.12,
      weight: 1,
      interactive: false
    }).addTo(state.map);
  } else {
    state.userAccuracyCircle.setLatLng([lat, lon]);
    state.userAccuracyCircle.setRadius(Math.max(accuracy, 20));
  }
}

async function applyLocationAndSeed(lat, lon, isRealGps, accuracy) {
  updateUserMarker(lat, lon, accuracy);

  if (state.map) {
    state.map.setView([lat, lon], 15);
  }

  const areaLabel = state.userLocation.addressString.split(',')[0] || 'Local';
  state.facilities = await BackendClient.fetchFacilities(lat, lon, areaLabel);

  renderFacilityMarkers();
  renderFacilityDirectory();
  logTelemetry(`Loaded 10 civic utilities around ${areaLabel}.`);
}

function renderFacilityMarkers() {
  Object.values(state.facilityMarkers).forEach(m => state.map.removeLayer(m));
  state.facilityMarkers = {};

  state.facilities.forEach(fac => {
    if (state.activeCategory !== 'All' && fac.category !== state.activeCategory) {
      return;
    }

    const meta = CATEGORY_META[fac.category] || { glyph: '📍' };
    const markerHtml = `
      <div class="custom-radar-marker" id="marker-${fac.id}">
        <div class="radar-pulsing-halo ${fac.statusClass}-halo"></div>
        <div class="radar-pill-glyph ${fac.statusClass}-fill">${meta.glyph}</div>
      </div>
    `;

    const markerIcon = L.divIcon({
      html: markerHtml,
      className: 'leaflet-civic-marker',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const marker = L.marker([fac.lat, fac.lon], { icon: markerIcon })
      .addTo(state.map)
      .on('click', () => {
        selectFacility(fac.id);
      });

    state.facilityMarkers[fac.id] = marker;
  });
}

function updateMarkerAppearance(fac) {
  const marker = state.facilityMarkers[fac.id];
  if (!marker) return;

  const meta = CATEGORY_META[fac.category] || { glyph: '📍' };
  const markerHtml = `
    <div class="custom-radar-marker" id="marker-${fac.id}">
      <div class="radar-pulsing-halo ${fac.statusClass}-halo"></div>
      <div class="radar-pill-glyph ${fac.statusClass}-fill">${meta.glyph}</div>
    </div>
  `;

  const newIcon = L.divIcon({
    html: markerHtml,
    className: 'leaflet-civic-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });

  marker.setIcon(newIcon);
}

// ============================================================================
// DIRECTORY & DETAIL DRAWER SUBSYSTEM
// ============================================================================
function renderFacilityDirectory() {
  const container = document.getElementById('facility-directory');
  if (!container) return;

  const filtered = state.facilities.filter(f =>
    state.activeCategory === 'All' || f.category === state.activeCategory
  );

  filtered.sort((a, b) => {
    const distA = getHaversineDistance(state.userLocation.lat, state.userLocation.lon, a.lat, a.lon);
    const distB = getHaversineDistance(state.userLocation.lat, state.userLocation.lon, b.lat, b.lon);
    return distA - distB;
  });

  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 18px; text-align: center; color: #64748b; font-size: 12px;">No facilities found in this category.</div>`;
    return;
  }

  filtered.forEach(fac => {
    const distKm = getHaversineDistance(state.userLocation.lat, state.userLocation.lon, fac.lat, fac.lon).toFixed(1);
    const meta = CATEGORY_META[fac.category] || { glyph: '📍' };

    const tile = document.createElement('div');
    tile.className = 'facility-item-tile';
    tile.onclick = () => selectFacility(fac.id);

    tile.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 18px;">${meta.glyph}</span>
        <div>
          <div class="facility-name-text">${fac.name}</div>
          <div class="facility-meta-text">${fac.corridor} &bull; Score ${fac.healthScore}%</div>
        </div>
      </div>
      <div class="facility-tile-right">
        <span class="facility-status-badge text-${fac.statusClass}">● ${fac.status}</span>
        <span class="facility-distance-lbl">${distKm} km</span>
      </div>
    `;

    container.appendChild(tile);
  });
}

function updateDistanceReadouts() {
  renderFacilityDirectory();
  if (state.selectedFacilityId) {
    const fac = state.facilities.find(f => f.id === state.selectedFacilityId);
    if (fac) {
      const dist = getHaversineDistance(state.userLocation.lat, state.userLocation.lon, fac.lat, fac.lon).toFixed(1);
      const kpiDist = document.getElementById('kpi-dist');
      if (kpiDist) kpiDist.innerText = `${dist} km`;
    }
  }
}

function selectFacility(facilityId) {
  const fac = state.facilities.find(f => f.id === facilityId);
  if (!fac) return;

  state.selectedFacilityId = facilityId;
  state.map.flyTo([fac.lat, fac.lon], 16, { animate: true, duration: 0.8 });

  document.getElementById('directory-pane').style.display = 'none';
  const detailPane = document.getElementById('detail-pane');
  detailPane.style.display = 'block';

  const sheet = document.getElementById('bottom-sheet');
  sheet.classList.remove('peek');
  sheet.classList.add('expanded');
  document.getElementById('sheet-toggle-arrow').innerText = '▼';

  document.getElementById('detail-name').innerText = fac.name;
  document.getElementById('detail-sub').innerText = `${fac.corridor} • ${fac.category}`;
  document.getElementById('detail-status-text').innerText = fac.statusText;

  const badge = document.getElementById('detail-badge');
  badge.className = `health-status-chip ${fac.statusClass}`;
  badge.innerText = `${fac.status} (${fac.healthScore}%)`;

  document.getElementById('kpi-dwell').innerText = fac.dwell;
  document.getElementById('kpi-queue').innerText = fac.queue;
  document.getElementById('kpi-queue').className = `kpi-num-val text-${fac.statusClass}`;

  const distKm = getHaversineDistance(state.userLocation.lat, state.userLocation.lon, fac.lat, fac.lon).toFixed(1);
  document.getElementById('kpi-dist').innerText = `${distKm} km`;

  const navBtn = document.getElementById('detail-nav-btn');
  navBtn.href = `https://www.google.com/maps/dir/?api=1&origin=${state.userLocation.lat},${state.userLocation.lon}&destination=${fac.lat},${fac.lon}&travelmode=driving`;

  logTelemetry(`Inspecting node: ${fac.name} [Health: ${fac.healthScore}% - ${fac.status}]`);
}

function showDirectoryPane() {
  document.getElementById('detail-pane').style.display = 'none';
  document.getElementById('directory-pane').style.display = 'block';
  state.selectedFacilityId = null;
}

function toggleSheet() {
  const sheet = document.getElementById('bottom-sheet');
  const arrow = document.getElementById('sheet-toggle-arrow');
  if (sheet.classList.contains('peek')) {
    sheet.classList.remove('peek');
    sheet.classList.add('expanded');
    arrow.innerText = '▼';
  } else {
    sheet.classList.remove('expanded');
    sheet.classList.add('peek');
    arrow.innerText = '▲';
  }
}

// ============================================================================
// AUTONOMOUS REROUTE SUBSYSTEM
// ============================================================================
function triggerRerouteCascade(failedNode) {
  const peer = FaultInferenceEngine.findNearestOperationalPeer(
    failedNode,
    state.facilities,
    state.userLocation.lat,
    state.userLocation.lon
  );

  if (!peer) {
    logTelemetry(`⚠️ No operational ${failedNode.category} peer found within 10km grid!`);
    return;
  }

  state.activeReroute = { from: failedNode, to: peer };

  if (state.reroutePolyline) {
    state.map.removeLayer(state.reroutePolyline);
  }

  state.reroutePolyline = L.polyline(
    [[failedNode.lat, failedNode.lon], [peer.lat, peer.lon]],
    {
      color: '#38bdf8',
      weight: 3.5,
      opacity: 0.9,
      className: 'directional-flow-line',
      dashArray: '8, 14'
    }
  ).addTo(state.map);

  const distToPeer = getHaversineDistance(state.userLocation.lat, state.userLocation.lon, peer.lat, peer.lon).toFixed(1);

  document.getElementById('reroute-from').innerText = failedNode.name;
  document.getElementById('reroute-to').innerText = peer.name;
  document.getElementById('reroute-delta').innerText =
    `Target node offline (Score ${failedNode.healthScore}%). Diverted to nearest working peer (${distToPeer} km away relative to your live GPS).`;

  const navLink = document.getElementById('reroute-nav-link');
  navLink.href = `https://www.google.com/maps/dir/?api=1&origin=${state.userLocation.lat},${state.userLocation.lon}&destination=${peer.lat},${peer.lon}&travelmode=driving`;

  const rerouteCard = document.getElementById('reroute-card');
  rerouteCard.style.display = 'block';

  const bounds = L.latLngBounds(
    [failedNode.lat, failedNode.lon],
    [peer.lat, peer.lon]
  );
  state.map.fitBounds(bounds, { padding: [100, 100], maxZoom: 16 });

  logTelemetry(`🚨 AUTONOMOUS REROUTE ACTIVE: Diverting from ${failedNode.name} -> ${peer.name} (${distToPeer} km)`);
}

function dismissRerouteBanner() {
  document.getElementById('reroute-card').style.display = 'none';
  if (state.reroutePolyline) {
    state.map.removeLayer(state.reroutePolyline);
    state.reroutePolyline = null;
  }
}

function inspectReroutePeer() {
  if (state.activeReroute && state.activeReroute.to) {
    selectFacility(state.activeReroute.to.id);
  }
}

// ============================================================================
// ZERO-FRICTION 1-TAP EXIT VERIFICATION MODAL
// ============================================================================
let currentExitTargetId = null;

function promptExitVerification(facilityId) {
  const fac = state.facilities.find(f => f.id === facilityId);
  if (!fac) return;

  currentExitTargetId = facilityId;
  document.getElementById('exit-modal-title').innerText = `Leaving ${fac.name}?`;
  document.getElementById('exit-fault-choices').style.display = 'none';
  document.getElementById('exit-prompt-modal').classList.remove('hidden');
}

function showExitFaultOptions() {
  document.getElementById('exit-fault-choices').style.display = 'flex';
}

async function submitExitVerification(isSuccess) {
  if (!currentExitTargetId) return;
  const fac = state.facilities.find(f => f.id === currentExitTargetId);
  if (!fac) return;

  await BackendClient.recordReport(fac.id, isSuccess, '');

  if (isSuccess) {
    fac.verifiedSuccesses = (fac.verifiedSuccesses || 0) + 1;
    logTelemetry(`✓ 1-Tap Success reported for ${fac.name}. Health reinforced.`);
  }

  FaultInferenceEngine.evaluateFacilityHealth(fac);
  updateMarkerAppearance(fac);
  renderFacilityDirectory();

  if (state.selectedFacilityId === fac.id) {
    selectFacility(fac.id);
  }

  document.getElementById('exit-prompt-modal').classList.add('hidden');
  currentExitTargetId = null;
}

async function submitExitFault(faultReason) {
  if (!currentExitTargetId) return;
  const fac = state.facilities.find(f => f.id === currentExitTargetId);
  if (!fac) return;

  await BackendClient.recordReport(fac.id, false, faultReason);

  fac.explicitFailures = (fac.explicitFailures || 0) + 1;
  fac.recentBounces = (fac.recentBounces || 0) + 1;
  if (!fac.activeTags.includes(faultReason)) {
    fac.activeTags.push(faultReason);
  }

  FaultInferenceEngine.evaluateFacilityHealth(fac);
  updateMarkerAppearance(fac);
  renderFacilityDirectory();

  logTelemetry(`✕ 1-Tap Failure reported for ${fac.name}: [${faultReason}]. Usability score: ${fac.healthScore}%`);

  if (fac.status === 'Unavailable') {
    triggerRerouteCascade(fac);
  }

  if (state.selectedFacilityId === fac.id) {
    selectFacility(fac.id);
  }

  document.getElementById('exit-prompt-modal').classList.add('hidden');
  currentExitTargetId = null;
}

async function simulateUserVisitCurrent() {
  if (!state.selectedFacilityId) return;
  const fac = state.facilities.find(f => f.id === state.selectedFacilityId);
  if (!fac) return;

  logTelemetry(`📍 Simulating vehicle arrival inside geofence of ${fac.name}...`);
  setTimeout(async () => {
    logTelemetry(`⏱️ Dwell < 35s detected: User exited boundary without stopping. Passive bounce logged!`);
    await BackendClient.recordVisit(fac.id, 32);

    fac.recentBounces = (fac.recentBounces || 0) + 1;
    FaultInferenceEngine.evaluateFacilityHealth(fac);
    updateMarkerAppearance(fac);
    renderFacilityDirectory();
    selectFacility(fac.id);

    promptExitVerification(fac.id);
  }, 1000);
}

// ============================================================================
// LOCATION PICKER & PRECISION ADJUSTER MODAL
// ============================================================================
function openLocationPickerModal() {
  const modal = document.getElementById('location-picker-modal');
  const coords = document.getElementById('modal-coords-display');
  const addr = document.getElementById('modal-resolved-address');

  if (coords) coords.innerText = `${state.userLocation.lat.toFixed(5)}, ${state.userLocation.lon.toFixed(5)}`;
  if (addr) addr.innerText = state.userLocation.addressString;

  modal.classList.remove('hidden');
}

function closeLocationPickerModal() {
  document.getElementById('location-picker-modal').classList.add('hidden');
}

let addressSearchTimer = null;
function handleAddressSearch(query) {
  clearTimeout(addressSearchTimer);
  const resultsBox = document.getElementById('modal-address-results');
  const q = query.trim();

  if (q.length < 2) {
    resultsBox.style.display = 'none';
    return;
  }

  addressSearchTimer = setTimeout(async () => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'LastMileGuardian-CivicGrid/2.0' } }
      );
      if (res.ok) {
        const places = await res.json();
        resultsBox.innerHTML = '';
        if (places.length === 0) {
          resultsBox.innerHTML = `<div style="padding:10px; font-size:11px; color:#94a3b8;">No locations found. Try city or area name.</div>`;
        } else {
          places.forEach(p => {
            const item = document.createElement('div');
            item.className = 'location-result-item';
            item.innerHTML = `<span>📍</span> <span>${p.display_name}</span>`;
            item.onclick = async () => {
              const lat = parseFloat(p.lat);
              const lon = parseFloat(p.lon);
              resultsBox.style.display = 'none';
              closeLocationPickerModal();
              await applyManualCoordinates(lat, lon, 10, p.display_name);
              recenterOnUser();
            };
            resultsBox.appendChild(item);
          });
        }
        resultsBox.style.display = 'block';
      }
    } catch (e) {
      console.warn('Address autocomplete search failed:', e);
    }
  }, 350);
}

function enablePinpointMode() {
  closeLocationPickerModal();
  state.isPinpointMode = true;
  const banner = document.getElementById('map-pinpoint-banner');
  if (banner) banner.style.display = 'flex';
  logTelemetry('🎯 Pinpoint Mode Activated: Click anywhere on the map to set your location.');
}

function disablePinpointMode() {
  state.isPinpointMode = false;
  const banner = document.getElementById('map-pinpoint-banner');
  if (banner) banner.style.display = 'none';
}

async function useNetworkIpLocation() {
  closeLocationPickerModal();
  logTelemetry('🌐 Fetching network IP location...');
  const loc = await fetchNetworkIpLocation();
  if (loc) {
    await applyManualCoordinates(loc.lat, loc.lon, 250, `${loc.city}, ${loc.region}`);
    recenterOnUser();
  } else {
    alert('Unable to retrieve network IP location. Please try searching your city or dragging the pin.');
  }
}

async function reTriggerGpsHardware() {
  closeLocationPickerModal();
  logTelemetry('🛰️ Re-triggering hardware GPS acquisition with high accuracy...');
  initAccurateGeolocation();
}

// ============================================================================
// GLOBAL SEARCH BAR & ONBOARDING
// ============================================================================
let globalSearchTimer = null;
function handleSearch(query) {
  const dropdown = document.getElementById('search-dropdown');
  const q = query.trim().toLowerCase();

  if (!q) {
    dropdown.style.display = 'none';
    return;
  }

  // 1. Check local facilities
  const facilityMatches = state.facilities.filter(f =>
    f.name.toLowerCase().includes(q) ||
    f.corridor.toLowerCase().includes(q) ||
    f.category.toLowerCase().includes(q)
  );

  dropdown.innerHTML = '';

  if (facilityMatches.length > 0) {
    const sec1 = document.createElement('div');
    sec1.className = 'search-section-header';
    sec1.innerText = 'Nearby Public Utilities';
    dropdown.appendChild(sec1);

    facilityMatches.forEach(m => {
      const row = document.createElement('div');
      row.className = 'search-match-row';
      row.onclick = () => {
        selectFacility(m.id);
        dropdown.style.display = 'none';
        document.getElementById('global-service-search').value = m.name;
      };
      row.innerHTML = `
        <div>
          <div class="match-main-text">${m.name}</div>
          <div class="match-sub-text">${m.corridor} &bull; ${m.category}</div>
        </div>
        <span class="match-badge text-${m.statusClass}">● ${m.status}</span>
      `;
      dropdown.appendChild(row);
    });
  }

  // 2. Also offer to jump to location if query is longer than 2 chars
  if (q.length >= 3) {
    clearTimeout(globalSearchTimer);
    globalSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=3`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'LastMileGuardian-CivicGrid/2.0' } }
        );
        if (res.ok) {
          const places = await res.json();
          if (places.length > 0) {
            const sec2 = document.createElement('div');
            sec2.className = 'search-section-header';
            sec2.innerText = 'Jump Radar To City / Area';
            dropdown.appendChild(sec2);

            places.forEach(p => {
              const jumpRow = document.createElement('div');
              jumpRow.className = 'search-match-row search-place-jump';
              jumpRow.innerHTML = `
                <div>
                  <div class="match-main-text">📍 Move Radar Here</div>
                  <div class="match-sub-text">${p.display_name}</div>
                </div>
                <span style="font-size:11px; color:#38bdf8; font-weight:800;">JUMP ➔</span>
              `;
              jumpRow.onclick = async () => {
                dropdown.style.display = 'none';
                document.getElementById('global-service-search').value = '';
                await applyManualCoordinates(parseFloat(p.lat), parseFloat(p.lon), 10, p.display_name);
                recenterOnUser();
              };
              dropdown.appendChild(jumpRow);
            });
          }
        }
      } catch (e) {}
    }, 300);
  }

  dropdown.style.display = 'block';
}

function setCategoryFilter(category, pillEl) {
  state.activeCategory = category;

  document.querySelectorAll('.filter-pill').forEach(btn => {
    if (btn !== pillEl && !btn.classList.contains('satellite-toggle')) {
      btn.classList.remove('active');
    }
  });
  if (pillEl) pillEl.classList.add('active');

  renderFacilityMarkers();
  renderFacilityDirectory();
  logTelemetry(`Category filter applied: ${category}`);
}

function openPortal() {
  document.getElementById('onboarding-portal').classList.remove('hidden');
}

function launchWithIntent(intent) {
  document.getElementById('onboarding-portal').classList.add('hidden');
  if (intent !== 'All') {
    const targetPill = document.querySelector(`.filter-pill[data-filter="${intent}"]`);
    setCategoryFilter(intent, targetPill);
  } else {
    const allPill = document.querySelector('.filter-pill[data-filter="All"]');
    setCategoryFilter('All', allPill);
  }
  recenterOnUser();
  logTelemetry(`Engaged radar with intent: ${intent}`);
}

// ============================================================================
// PITCH DEMO DECK CONTROLLER
// ============================================================================
async function triggerPitchAbort() {
  const atm = state.facilities.find(f => f.category === 'ATM');
  if (!atm) return;

  logTelemetry(`⚡ PITCH SCENARIO: Simulating cash exhaustion & rapid bounce surge at ${atm.name}...`);

  await BackendClient.triggerSimAbort();

  atm.recentBounces = 3;
  atm.explicitFailures = 1;
  atm.activeTags = ['Cash Depleted', 'ATM Terminal Offline'];
  atm.dwell = '32 sec';
  atm.queue = 'Empty (No Cash)';

  FaultInferenceEngine.evaluateFacilityHealth(atm);
  updateMarkerAppearance(atm);
  renderFacilityDirectory();

  selectFacility(atm.id);
  triggerRerouteCascade(atm);
}

async function triggerPitchSuccess() {
  const atm = state.facilities.find(f => f.category === 'ATM');
  if (!atm) return;

  logTelemetry(`✓ PITCH SCENARIO: Cash replenishment & successful transactions confirmed at ${atm.name}.`);

  await BackendClient.triggerSimSuccess();

  atm.recentBounces = 0;
  atm.explicitFailures = 0;
  atm.verifiedSuccesses = 3;
  atm.activeTags = [];
  atm.dwell = '2.1 min';
  atm.queue = '1 min';

  FaultInferenceEngine.evaluateFacilityHealth(atm);
  updateMarkerAppearance(atm);
  renderFacilityDirectory();
  dismissRerouteBanner();

  selectFacility(atm.id);
}

async function resetPitchCorridor() {
  logTelemetry('↺ Resetting all civic utility nodes to baseline operational health...');
  await BackendClient.triggerSimReset();

  state.facilities.forEach(fac => {
    fac.recentBounces = 0;
    fac.explicitFailures = 0;
    fac.verifiedSuccesses = 1;
    fac.activeTags = [];
    FaultInferenceEngine.evaluateFacilityHealth(fac);
    updateMarkerAppearance(fac);
  });
  renderFacilityDirectory();
  dismissRerouteBanner();
  showDirectoryPane();
}

function logTelemetry(msg) {
  const feed = document.getElementById('telemetry-feed');
  if (!feed) return;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = `[${time}] ${msg}`;
  feed.innerHTML = `<div>${line}</div>` + feed.innerHTML;
}

// ============================================================================
// BOOTSTRAP UPON LOAD
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initMapEngine();
});
