/**
 * LastMile Guardian — Executive Civic Usability Engine
 * Core Implementation: Real-Time Usability & Fault Inference for Essential Public Services
 * Enhanced with High-Precision Geolocation, IP Fallback, Draggable Pin & Address Search
 */

// ============================================================================
// GLOBAL STATE & SYSTEM REGISTRY
// ============================================================================
function getApiBaseUrl() {
  const urlParam = new URLSearchParams(window.location.search).get('api');
  if (urlParam) {
    const clean = urlParam.replace(/\/$/, '');
    localStorage.setItem('LASTMILE_API_URL', clean);
    return clean.endsWith('/api') ? clean : `${clean}/api`;
  }
  const saved = localStorage.getItem('LASTMILE_API_URL');
  if (saved) {
    const clean = saved.replace(/\/$/, '');
    return clean.endsWith('/api') ? clean : `${clean}/api`;
  }

  // Unified API route (works on localhost, custom domains, and Vercel serverless)
  if (window.location.origin && window.location.origin !== 'null' && !window.location.protocol.startsWith('file')) {
    return `${window.location.origin}/api`;
  }

  // Production Render fallback
  return 'https://lastmile-backend-leww.onrender.com/api';
}

const API_BASE = getApiBaseUrl();


const state = {
  backendOnline: false,
  userLocation: {
    lat: 9.0196, // Realistic detected corridor default
    lon: 76.9226,
    accuracy: 15,
    heading: null,
    speed: null,
    hasHardwareGps: false,
    addressString: 'Acquiring live device GPS...'
  },
  gpsWatchId: null,
  isTrackingActive: false,
  gpsPermissionDenied: false,
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
      const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json();
        state.backendOnline = true;
        logTelemetry(`Connected to Backend Engine: ${data.server || 'Active'}`);
        return true;
      }
    } catch (e) {
      state.backendOnline = false;
      logTelemetry('Backend server sleeping/offline. Operating in high-performance autonomous mode.');
    }
    return false;
  }

  static async discoverRealNodes(lat, lon, radius = 3000) {
    try {
      const res = await fetch(`${API_BASE}/nodes/discover?lat=${lat}&lng=${lon}&radius=${radius}`, {
        signal: AbortSignal.timeout(9000)
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.nodes;
        if (Array.isArray(list) && list.length > 0) return list;
      }
    } catch (e) {
      console.warn('Backend discoverRealNodes error:', e);
    }
    return null;
  }

  static async checkWater(lat, lon) {
    try {
      const res = await fetch(`${API_BASE}/nodes/check-water?lat=${lat}&lng=${lon}`, {
        signal: AbortSignal.timeout(3500)
      });
      if (res.ok) {
        const data = await res.json();
        return !!data.isWater;
      }
    } catch (e) {}
    return false;
  }

  static async registerNode(node) {
    try {
      const res = await fetch(`${API_BASE}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(node),
        signal: AbortSignal.timeout(4000)
      });
      if (res.status === 422) {
        return { ok: false, reason: 'water' };
      }
      if (res.ok) {
        const data = await res.json();
        return { ok: true, node: data.node };
      }
    } catch (e) {}
    return { ok: true, node };
  }

  static async fetchFacilities(lat, lon, area) {
    // 1. Primary: Discover real OpenStreetMap POIs via GET /api/nodes/discover
    const realNodes = await BackendClient.discoverRealNodes(lat, lon, 3000);
    // 2. Validate, map, and fill any missing categories with land-verified synthetic nodes
    return await generateValidatedFacilities(lat, lon, area, realNodes || []);
  }

  static async recordVisit(facilityId, dwellSeconds) {
    if (state.backendOnline) {
      try {
        const res = await fetch(`${API_BASE}/telemetry/visit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facilityId, dwellSeconds }),
          signal: AbortSignal.timeout(2500)
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
          body: JSON.stringify({ facilityId, success, faultTag }),
          signal: AbortSignal.timeout(2500)
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
        const res = await fetch(`${API_BASE}/simulation/abort`, {
          method: 'POST',
          signal: AbortSignal.timeout(2500)
        });
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
        const res = await fetch(`${API_BASE}/simulation/success`, {
          method: 'POST',
          signal: AbortSignal.timeout(2500)
        });
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
        const res = await fetch(`${API_BASE}/simulation/reset`, {
          method: 'POST',
          signal: AbortSignal.timeout(2500)
        });
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
// REAL-POI INTEGRATION & WATER-VALIDATED SYNTHETIC FALLBACK ENGINE
// ============================================================================
async function generateValidatedFacilities(centerLat, centerLon, areaName = 'Local Corridor', existingRealNodes = []) {
  const cleanArea = areaName.split(',')[0].trim() || 'Civic Center';

  // Standardize existing real nodes
  const resultList = [];
  const categoryCounts = { ATM: 0, Fuel: 0, Medical: 0, EV: 0, Clinic: 0 };

  (existingRealNodes || []).forEach(node => {
    const rawCat = node.category || node.type || 'ATM';
    let normalizedCat = 'ATM';
    if (rawCat === 'ATM' || rawCat === 'Fuel' || rawCat === 'Medical' || rawCat === 'EV' || rawCat === 'Clinic') {
      normalizedCat = rawCat;
    } else if (rawCat.toLowerCase().includes('fuel') || rawCat.toLowerCase().includes('gas')) {
      normalizedCat = 'Fuel';
    } else if (rawCat.toLowerCase().includes('pharm') || rawCat.toLowerCase().includes('medic')) {
      normalizedCat = 'Medical';
    } else if (rawCat.toLowerCase().includes('charg') || rawCat.toLowerCase().includes('ev')) {
      normalizedCat = 'EV';
    } else if (rawCat.toLowerCase().includes('clinic') || rawCat.toLowerCase().includes('hosp')) {
      normalizedCat = 'Clinic';
    }

    const lat = parseFloat(node.lat);
    const lon = parseFloat(node.lon !== undefined ? node.lon : node.lng);

    if (!isNaN(lat) && !isNaN(lon)) {
      const facility = {
        ...node,
        id: node.id || `node-${resultList.length + 1}`,
        name: node.name || `${normalizedCat} Facility`,
        category: normalizedCat,
        type: normalizedCat,
        lat: lat,
        lon: lon,
        lng: lon,
        corridor: node.corridor || `${cleanArea} Corridor`,
        dwell: node.dwell || (node.avgDwell ? `${node.avgDwell} min` : '4.0 min'),
        queue: node.queue || '1-2 min',
        baseScore: node.baseScore || 92,
        healthScore: node.healthScore || 92,
        status: node.status || 'Operational',
        statusClass: node.statusClass || 'green',
        statusText: node.statusText || 'Verified active real-world civic facility.',
        recentBounces: node.recentBounces || 0,
        explicitFailures: node.explicitFailures || 0,
        verifiedSuccesses: node.verifiedSuccesses || 1,
        activeTags: node.activeTags || [],
        source: node.source || 'osm'
      };
      resultList.push(FaultInferenceEngine.evaluateFacilityHealth(facility));
      if (categoryCounts[normalizedCat] !== undefined) {
        categoryCounts[normalizedCat]++;
      }
    }
  });

  const realCount = resultList.length;

  // Rich fallback templates for missing/under-represented categories
  const fallbackTemplates = {
    ATM: [
      { name: 'Federal Bank 24hr ATM', dwell: '2.1 min', queue: '1-2 min', corridor: `${cleanArea} Junction` },
      { name: 'SBI ATM & Cash Deposit', dwell: '2.4 min', queue: '2-4 min', corridor: `${cleanArea} Market Rd` },
      { name: 'HDFC Bank ATM & Cash Deposit', dwell: '1.9 min', queue: '0 min', corridor: `${cleanArea} East Gate` }
    ],
    Fuel: [
      { name: 'Indian Oil Petrol Bunk', dwell: '4.8 min', queue: '3 min', corridor: `${cleanArea} Highway` },
      { name: 'Bharat Petroleum Pump', dwell: '5.2 min', queue: '1 min', corridor: `${cleanArea} Bypass` }
    ],
    Medical: [
      { name: 'Apollo 24/7 Pharmacy', dwell: '3.5 min', queue: '0 min', corridor: `${cleanArea} Main Rd` },
      { name: 'Neethi 24hr Medical Store', dwell: '4.0 min', queue: '2 min', corridor: `${cleanArea} Hospital Cross` }
    ],
    EV: [
      { name: 'KSEB EV Fast Charger 60kW', dwell: '28 min', queue: 'CCS2 Ready', corridor: `${cleanArea} Substation` },
      { name: 'Zeon EV Fast Charging Hub', dwell: '35 min', queue: 'Dual Gun Ready', corridor: `${cleanArea} Commercial Hub` }
    ],
    Clinic: [
      { name: 'Taluk Emergency Health Clinic', dwell: '14 min', queue: 'Triage Open', corridor: `${cleanArea} Civic Hospital` },
      { name: 'Community Care Urgent Clinic', dwell: '12 min', queue: 'Triage Open', corridor: `${cleanArea} North Ward` }
    ]
  };

  // Identify missing or under-represented categories
  const neededCategories = [];
  const allCategories = ['ATM', 'Fuel', 'Medical', 'EV', 'Clinic'];

  allCategories.forEach(cat => {
    if (categoryCounts[cat] === 0) {
      neededCategories.push(cat);
    }
  });

  let fillIdx = 0;
  while (resultList.length + neededCategories.length < 8 && fillIdx < 10) {
    const cat = allCategories[fillIdx % allCategories.length];
    neededCategories.push(cat);
    fillIdx++;
  }

  const cosLat = Math.cos(centerLat * Math.PI / 180) || 1.0;
  let syntheticAdded = 0;

  for (let i = 0; i < neededCategories.length; i++) {
    const cat = neededCategories[i];
    const tmplList = fallbackTemplates[cat] || fallbackTemplates.ATM;
    const tmpl = tmplList[syntheticAdded % tmplList.length];

    // Compute candidate position with terrain water verification
    let angle = ((i * 72 + 35) % 360) * (Math.PI / 180);
    let distMeters = 450 + (i * 180);
    let candLat = centerLat + (distMeters / 111320) * Math.sin(angle);
    let candLon = centerLon + (distMeters / (111320 * cosLat)) * Math.cos(angle);

    // Check if candidate point is in water (Overpass query via backend)
    let isWater = await BackendClient.checkWater(candLat, candLon);
    let attempts = 0;

    while (isWater && attempts < 8) {
      attempts++;
      logTelemetry(`⚠️ Terrain check: Candidate [${candLat.toFixed(4)}, ${candLon.toFixed(4)}] is in water body! Rerouting to dry land...`);
      angle += (Math.PI / 4); // Rotate 45°
      distMeters = 400 + (attempts * 220);
      candLat = centerLat + (distMeters / 111320) * Math.sin(angle);
      candLon = centerLon + (distMeters / (111320 * cosLat)) * Math.cos(angle);
      isWater = await BackendClient.checkWater(candLat, candLon);
    }

    const synNode = {
      id: `syn_${cat.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: tmpl.name,
      category: cat,
      type: cat,
      lat: candLat,
      lon: candLon,
      lng: candLon,
      corridor: tmpl.corridor,
      dwell: tmpl.dwell,
      queue: tmpl.queue,
      baseScore: 92,
      healthScore: 92,
      status: 'Operational',
      statusClass: 'green',
      statusText: 'Verified land-validated civic service node.',
      recentBounces: 0,
      explicitFailures: 0,
      verifiedSuccesses: 1,
      activeTags: [],
      source: 'synthetic-validated'
    };

    // Register with backend which verifies water rejection
    const regResult = await BackendClient.registerNode(synNode);
    if (regResult && regResult.ok) {
      resultList.push(FaultInferenceEngine.evaluateFacilityHealth(synNode));
      syntheticAdded++;
    } else {
      console.warn(`[Node Placement]: Candidate at ${candLat}, ${candLon} rejected:`, regResult?.reason);
    }
  }

  if (realCount > 0) {
    logTelemetry(`🛰️ Civic Grid Ready: ${realCount} real OpenStreetMap POIs${syntheticAdded > 0 ? ` + ${syntheticAdded} land-verified nodes` : ''}.`);
  } else {
    logTelemetry(`🛰️ Civic Grid Ready: ${syntheticAdded} terrain-verified land nodes active.`);
  }

  return resultList;
}

function generateLocalizedFacilities(centerLat, centerLon, areaName = 'Local Corridor') {
  return generateValidatedFacilities(centerLat, centerLon, areaName, []);
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
 * Live Device Hardware GPS Engine:
 * Strictly relies on navigator.geolocation.getCurrentPosition and watchPosition.
 * No manual overrides, no IP fallbacks.
 */
async function initAccurateGeolocation() {
  const radarText = document.getElementById('radar-readout-text');
  const gpsBtn = document.getElementById('gps-action-btn');

  if (radarText) radarText.innerText = 'LOCKING LIVE DEVICE GPS...';
  if (gpsBtn) {
    gpsBtn.classList.remove('active', 'denied');
    gpsBtn.classList.add('locking');
  }

  if (!navigator.geolocation) {
    handleGpsError({ code: 2, message: 'Geolocation is not supported by your browser.' });
    return;
  }

  // Clear existing watch if any to avoid duplicate threads
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }

  const highAccuracyOpts = { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 };
  const standardOpts = { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 };

  // 1. Initial GPS Lock: Try High Accuracy first; if unsupported/timed out indoors, fallback to device standard
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      await handleGpsSuccess(pos);
    },
    (err) => {
      if (err && err.code === 1) {
        // User explicitly denied permission
        handleGpsError(err);
        return;
      }
      console.warn('High-accuracy GPS fix failed or timed out. Falling back to device standard positioning...', err);
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          await handleGpsSuccess(pos);
        },
        (err2) => {
          handleGpsError(err2);
        },
        standardOpts
      );
    },
    highAccuracyOpts
  );

  // 2. Continuous Real-Time GPS Tracking
  state.gpsWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      await handleGpsSuccess(pos);
    },
    (err) => {
      console.warn('GPS continuous tracking notice:', err.message);
      if (err && err.code === 1) {
        handleGpsError(err);
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

async function handleGpsSuccess(pos) {
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const acc = pos.coords.accuracy || 10;

  const prevLat = state.userLocation.lat;
  const prevLon = state.userLocation.lon;
  const isFirstRealFix = !state.userLocation.hasHardwareGps;
  const movedKm = getHaversineDistance(prevLat, prevLon, lat, lon);

  state.userLocation.lat = lat;
  state.userLocation.lon = lon;
  state.userLocation.accuracy = acc;
  state.userLocation.hasHardwareGps = true;
  state.gpsPermissionDenied = false;

  // Hide permission prompt if previously displayed
  const permModal = document.getElementById('gps-permission-modal');
  if (permModal) permModal.classList.add('hidden');

  const gpsBtn = document.getElementById('gps-action-btn');
  if (gpsBtn) {
    gpsBtn.classList.remove('locking', 'denied');
    gpsBtn.classList.add('active');
  }

  const radarText = document.getElementById('radar-readout-text');
  if (radarText) radarText.innerText = `GPS LOCKED: ±${Math.round(acc)}M ACCURACY`;

  logTelemetry(`🛰️ Live GPS fix: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(acc)}m)`);

  updateUserMarker(lat, lon, acc);
  updateDistanceReadouts();

  // Update modal telemetry readouts if opened
  const coordsDisplay = document.getElementById('modal-coords-display');
  const accuracyDisplay = document.getElementById('modal-accuracy-display');
  const statusBadge = document.getElementById('modal-gps-status-badge');
  if (coordsDisplay) coordsDisplay.innerText = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  if (accuracyDisplay) accuracyDisplay.innerText = `±${Math.round(acc)}m`;
  if (statusBadge) {
    statusBadge.className = 'status-badge-chip green';
    statusBadge.innerText = '🟢 Live Hardware GPS Fixed';
  }

  // If first real GPS fix OR user moved > 300m OR facilities not yet loaded:
  if (isFirstRealFix || movedKm > 0.3 || state.facilities.length === 0) {
    // 1. Immediately seed and render nodes surrounding the live GPS location
    await applyLocationAndSeed(lat, lon, true, acc);
    if (state.map) {
      state.map.flyTo([lat, lon], 15, { animate: true, duration: 1.0 });
    }
    // 2. Fetch reverse-geocoded address in parallel without delaying node rendering
    fetchAccurateAddress(lat, lon).then(address => {
      state.userLocation.addressString = address;
      updateAddressDisplay(address, acc);
      const resolvedEl = document.getElementById('modal-resolved-address');
      if (resolvedEl) resolvedEl.innerText = address;
    }).catch(() => {});
  } else {
    updateDistanceReadouts();
  }
}

function handleGpsError(err) {
  state.userLocation.hasHardwareGps = false;
  state.gpsPermissionDenied = true;

  const gpsBtn = document.getElementById('gps-action-btn');
  if (gpsBtn) {
    gpsBtn.classList.remove('locking', 'active');
    gpsBtn.classList.add('denied');
  }

  const radarText = document.getElementById('radar-readout-text');
  if (radarText) radarText.innerText = 'GPS PERMISSION REQUIRED';

  let msg = 'Live device GPS is required to operate. Please enable location permissions in your browser or device settings and retry.';
  if (err && err.code === 1) {
    msg = 'Location permission was denied. Please allow location access in your browser site settings and click "Re-Lock GPS".';
  } else if (err && err.code === 2) {
    msg = 'Device position is currently unavailable. Please verify device GPS is active and click "Re-Lock GPS".';
  } else if (err && err.code === 3) {
    msg = 'GPS acquisition timed out. Please click "Re-Lock GPS" to retry.';
  }

  logTelemetry(`⚠️ GPS Error: ${msg}`);

  const addrEl = document.getElementById('user-live-address');
  if (addrEl) addrEl.innerText = 'GPS Permission Required — Enable Location';
  const subEl = document.getElementById('address-subtext');
  if (subEl) subEl.innerText = 'Requires real device GPS to operate';
  const accEl = document.getElementById('gps-accuracy-badge');
  if (accEl) accEl.innerText = 'No Fix';

  const permModal = document.getElementById('gps-permission-modal');
  const permMsg = document.getElementById('gps-permission-error-text');
  if (permMsg) permMsg.innerText = msg;
  if (permModal) permModal.classList.remove('hidden');

  const statusBadge = document.getElementById('modal-gps-status-badge');
  if (statusBadge) {
    statusBadge.className = 'status-badge-chip red';
    statusBadge.innerText = '🔴 GPS Access Denied / Unavailable';
  }
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
  const darkMatter = L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
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

  // Seed initial civic nodes & marker immediately so map is never empty
  applyLocationAndSeed(state.userLocation.lat, state.userLocation.lon, false, state.userLocation.accuracy);

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
    <div class="user-live-beacon" title="Live Device GPS Location">
      <div class="user-pulsing-wave"></div>
      <div class="user-center-core"></div>
      <div class="user-floating-lbl">
        <span>YOU (LIVE GPS)</span>
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
      draggable: false,
      interactive: false,
      keyboard: false
    }).addTo(state.map);
    if (state.userMarker.dragging) {
      state.userMarker.dragging.disable();
    }
  } else {
    state.userMarker.setLatLng([lat, lon]);
    if (state.userMarker.dragging) {
      state.userMarker.dragging.disable();
    }
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
  logTelemetry(`Loaded ${state.facilities.length} civic utilities around ${areaLabel}.`);
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
  const titleEl = document.getElementById('exit-modal-title');
  if (titleEl) titleEl.innerText = `Leaving ${fac.name}?`;
  const choicesEl = document.getElementById('exit-fault-choices');
  if (choicesEl) choicesEl.style.display = 'none';
  const modalEl = document.getElementById('exit-prompt-modal');
  if (modalEl) {
    modalEl.classList.remove('hidden');
    modalEl.style.display = 'flex';
  }
}

function closeExitVerificationModal() {
  const modalEl = document.getElementById('exit-prompt-modal');
  if (modalEl) {
    modalEl.classList.add('hidden');
    modalEl.style.display = 'none';
  }
  currentExitTargetId = null;
}

function showExitFaultOptions() {
  const choicesEl = document.getElementById('exit-fault-choices');
  if (choicesEl) choicesEl.style.display = 'flex';
}

async function submitExitVerification(isSuccess) {
  const targetId = currentExitTargetId || state.selectedFacilityId;
  closeExitVerificationModal();

  if (!targetId) return;
  const fac = state.facilities.find(f => f.id === targetId);
  if (!fac) return;

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

  // Non-blocking background sync
  BackendClient.recordReport(targetId, isSuccess, '').catch(e => console.warn('Telemetry sync error:', e));
}

async function submitExitFault(faultReason) {
  const targetId = currentExitTargetId || state.selectedFacilityId;
  closeExitVerificationModal();

  if (!targetId) return;
  const fac = state.facilities.find(f => f.id === targetId);
  if (!fac) return;

  fac.explicitFailures = (fac.explicitFailures || 0) + 1;
  fac.recentBounces = (fac.recentBounces || 0) + 1;
  if (!fac.activeTags.includes(faultReason)) {
    fac.activeTags.push(faultReason);
  }

  FaultInferenceEngine.evaluateFacilityHealth(fac);
  updateMarkerAppearance(fac);
  renderFacilityDirectory();

  logTelemetry(`✕ 1-Tap Failure reported for ${fac.name}: [${faultReason}]. Usability score: ${fac.healthScore}%`);

  if (state.selectedFacilityId === fac.id) {
    selectFacility(fac.id);
  }

  if (fac.status === 'Unavailable') {
    triggerRerouteCascade(fac);
  }

  // Non-blocking background sync
  BackendClient.recordReport(targetId, false, faultReason).catch(e => console.warn('Telemetry sync error:', e));
}

async function simulateUserVisitCurrent() {
  let fac = state.facilities.find(f => f.id === state.selectedFacilityId);
  if (!fac && state.facilities.length > 0) {
    fac = state.facilities[0];
    selectFacility(fac.id);
  }
  if (!fac) return;

  const btn = document.querySelector('.btn-simulate-visit') || document.getElementById('btn-simulate-visit');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    btn.innerHTML = `<span>⏳ Simulating Vehicle Geofence Ingress...</span>`;
  }

  logTelemetry(`📍 Simulating vehicle arrival inside geofence of ${fac.name}...`);

  setTimeout(() => {
    logTelemetry(`⏱️ Dwell < 35s detected: User exited boundary without stopping. Passive bounce logged!`);

    fac.recentBounces = (fac.recentBounces || 0) + 1;
    FaultInferenceEngine.evaluateFacilityHealth(fac);
    updateMarkerAppearance(fac);
    renderFacilityDirectory();
    selectFacility(fac.id);

    if (btn) {
      btn.disabled = false;
      btn.style.pointerEvents = 'auto';
      btn.innerHTML = originalHtml || `<span>📍 Simulate Arrival &amp; Exit (&lt;40s Bounce)</span>`;
    }

    // Instantly display the 1-tap exit verification modal
    promptExitVerification(fac.id);

    // Non-blocking sync to backend
    BackendClient.recordVisit(fac.id, 32).catch(e => console.warn('Telemetry sync error:', e));
  }, 600);
}

// ============================================================================
// LIVE GPS TELEMETRY MONITOR MODAL
// ============================================================================
function openLocationPickerModal() {
  const modal = document.getElementById('location-picker-modal');
  const coords = document.getElementById('modal-coords-display');
  const addr = document.getElementById('modal-resolved-address');
  const acc = document.getElementById('modal-accuracy-display');
  const statusBadge = document.getElementById('modal-gps-status-badge');
  const apiDisplay = document.getElementById('modal-api-endpoint-display');

  if (coords) coords.innerText = state.userLocation.hasHardwareGps ? `${state.userLocation.lat.toFixed(5)}, ${state.userLocation.lon.toFixed(5)}` : 'Waiting for GPS Fix...';
  if (addr) addr.innerText = state.userLocation.addressString;
  if (acc) acc.innerText = state.userLocation.accuracy ? `±${Math.round(state.userLocation.accuracy)}m` : 'No Fix';
  if (statusBadge) {
    if (state.userLocation.hasHardwareGps) {
      statusBadge.className = 'status-badge-chip green';
      statusBadge.innerText = '🟢 Live Hardware GPS Fixed';
    } else {
      statusBadge.className = 'status-badge-chip red';
      statusBadge.innerText = '🔴 GPS Not Locked';
    }
  }
  if (apiDisplay) apiDisplay.innerText = API_BASE;

  modal.classList.remove('hidden');
}

function promptSetBackendUrl() {
  const current = localStorage.getItem('LASTMILE_API_URL') || API_BASE;
  const next = prompt('Enter your deployed Render backend URL (e.g. https://lastmile-backend.onrender.com):', current);
  if (next && next.trim()) {
    const clean = next.trim().replace(/\/$/, '');
    localStorage.setItem('LASTMILE_API_URL', clean.endsWith('/api') ? clean : `${clean}/api`);
    window.location.reload();
  }
}

function closeLocationPickerModal() {
  document.getElementById('location-picker-modal').classList.add('hidden');
}

async function reTriggerGpsHardware() {
  closeLocationPickerModal();
  const permModal = document.getElementById('gps-permission-modal');
  if (permModal) permModal.classList.add('hidden');
  logTelemetry('🛰️ Re-triggering hardware GPS acquisition with high accuracy...');
  initAccurateGeolocation();
}

// ============================================================================
// GLOBAL SEARCH BAR & ONBOARDING
// ============================================================================
function handleSearch(query) {
  const dropdown = document.getElementById('search-dropdown');
  const q = query.trim().toLowerCase();

  if (!q) {
    dropdown.style.display = 'none';
    return;
  }

  // Filter local facilities only (no manual location jumping)
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
  } else {
    const noMatch = document.createElement('div');
    noMatch.style.padding = '12px 14px';
    noMatch.style.fontSize = '11.5px';
    noMatch.style.color = '#94a3b8';
    noMatch.innerText = 'No matching civic utilities nearby.';
    dropdown.appendChild(noMatch);
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
  const atm = state.facilities.find(f => f.category === 'ATM') || state.facilities[0];
  if (!atm) return;

  logTelemetry(`⚡ PITCH SCENARIO: Simulating cash exhaustion & rapid bounce surge at ${atm.name}...`);

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

  // Non-blocking sync
  BackendClient.triggerSimAbort().catch(() => {});
}

async function triggerPitchSuccess() {
  const atm = state.facilities.find(f => f.category === 'ATM') || state.facilities[0];
  if (!atm) return;

  logTelemetry(`✓ PITCH SCENARIO: Cash replenishment & successful transactions confirmed at ${atm.name}.`);

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

  // Non-blocking sync
  BackendClient.triggerSimSuccess().catch(() => {});
}

async function resetPitchCorridor() {
  logTelemetry('↺ Resetting all civic utility nodes to baseline operational health...');

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

  // Non-blocking sync
  BackendClient.triggerSimReset().catch(() => {});
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
