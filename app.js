// ==========================================================================
// LASTMILE GUARDIAN — AUTONOMOUS REALTIME ENGINE (app.js)
// ==========================================================================

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(() => console.log('Service Worker Registered'))
            .catch(err => console.log('SW Registration Failed:', err));
    });
}

// Hardware Screen Wake Lock API (Prevents Mobile Sleep on Motorcycle/Car Mounts)
let screenWakeLock = null;
async function requestScreenWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            screenWakeLock = await navigator.wakeLock.request('screen');
            pushTelemetry('Screen Wake Lock active: Display sleep suspended.');
            screenWakeLock.addEventListener('release', () => {
                screenWakeLock = null;
            });
        }
    } catch (err) {
        console.log('Wake Lock Error:', err);
    }
}

document.addEventListener('visibilitychange', async () => {
    if (screenWakeLock !== null && document.visibilityState === 'visible') {
        await requestScreenWakeLock();
    }
});

// Regional Corridor Anchor (Karuvelil / TKMIT Area)
let currentCenterLat = 9.0068;
let currentCenterLng = 76.7248;

// Live Device User Coordinates (Initialized and Tracked in Real Time)
let userLiveLat = 9.0068;
let userLiveLng = 76.7248;
let hasAcquiredPreciseGps = false;

// 1. Initialize Map
const map = L.map('map', {
    center: [currentCenterLat, currentCenterLng],
    zoom: 14,
    zoomControl: false
});

// 2. Basemap Tile Configurations
const streetLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, attribution: 'Streets &copy; Esri'
}).addTo(map);

const satBase = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 });
const satLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 });
const satHybrid = L.layerGroup([satBase, satLabels]);

let activeTileMode = 'streets';
function cycleTileLayer() {
    if (activeTileMode === 'streets') {
        map.removeLayer(streetLayer);
        map.addLayer(satHybrid);
        activeTileMode = 'satellite';
    } else {
        map.removeLayer(satHybrid);
        map.addLayer(streetLayer);
        activeTileMode = 'streets';
    }
}

// 3. Ground-Truth Nodes: INCLUDES BOTH ACTIVE AND PRE-SEEDED OFFLINE NODES
let nodes = [
    {
        id: "k1",
        name: "Federal Bank ATM",
        type: "ATM",
        lat: 9.006800,
        lng: 76.724800,
        area: "Karuvelil (Near TKMIT)",
        health: 0.15, // PRE-SEEDED OFFLINE (#CashDry)
        status: "UNAVAILABLE",
        avgDwell: 22,
        waitTime: "Cash Dry",
        consecutiveBounces: 2,
        tag: "#CashDry",
        expiresAt: Date.now() + 14400000
    },
    {
        id: "k2",
        name: "SBI ATM (Ezhukone Main)",
        type: "ATM",
        lat: 8.981200,
        lng: 76.721500,
        area: "Market Jn, Ezhukone",
        health: 0.94,
        status: "OPERATIONAL",
        avgDwell: 135,
        waitTime: "0 - 2 min",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k3",
        name: "Indian Oil Petrol Pump",
        type: "Fuel",
        lat: 8.983500,
        lng: 76.723000,
        area: "Kollam-Ayur Rd, Ezhukone",
        health: 0.92,
        status: "OPERATIONAL",
        avgDwell: 210,
        waitTime: "1 - 3 min",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k4",
        name: "Karuvelil Community Medicals",
        type: "Medical",
        lat: 9.005500,
        lng: 76.724000,
        area: "TKMIT Road, Karuvelil",
        health: 0.95,
        status: "OPERATIONAL",
        avgDwell: 240,
        waitTime: "Direct Access",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k5",
        name: "Tata Power EV Fast Charger",
        type: "EV",
        lat: 9.007200,
        lng: 76.723500,
        area: "Near TKMIT Entrance",
        health: 0.98,
        status: "OPERATIONAL",
        avgDwell: 2100,
        waitTime: "Plugs Free",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k6",
        name: "Canara Bank ATM",
        type: "ATM",
        lat: 8.991000,
        lng: 76.718000,
        area: "Kottarakkara Road",
        health: 0.90,
        status: "OPERATIONAL",
        avgDwell: 130,
        waitTime: "0 - 1 min",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k7",
        name: "HP Petrol Pump",
        type: "Fuel",
        lat: 9.018500,
        lng: 76.731500,
        area: "Pavithreswaram",
        health: 0.18, // PRE-SEEDED OFFLINE (#DryPump)
        status: "UNAVAILABLE",
        avgDwell: 30,
        waitTime: "No Stock",
        consecutiveBounces: 2,
        tag: "#DryPump",
        expiresAt: Date.now() + 14400000
    },
    {
        id: "k8",
        name: "Apollo Pharmacy 24x7",
        type: "Medical",
        lat: 8.980500,
        lng: 76.720800,
        area: "Ezhukone Junction",
        health: 0.94,
        status: "OPERATIONAL",
        avgDwell: 200,
        waitTime: "Direct Access",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k9",
        name: "Bharat Petroleum Bunk",
        type: "Fuel",
        lat: 9.001500,
        lng: 76.721000,
        area: "Karuvelil Link Road",
        health: 0.91,
        status: "OPERATIONAL",
        avgDwell: 195,
        waitTime: "1 - 2 min",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k10",
        name: "City Care Night Medicals",
        type: "Medical",
        lat: 9.008500,
        lng: 76.726000,
        area: "Karuvelil Junction",
        health: 0.93,
        status: "OPERATIONAL",
        avgDwell: 175,
        waitTime: "Direct Access",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    },
    {
        id: "k11",
        name: "Axis Bank ATM",
        type: "ATM",
        lat: 9.014000,
        lng: 76.731000,
        area: "Pavithreswaram North",
        health: 0.95,
        status: "OPERATIONAL",
        avgDwell: 125,
        waitTime: "0 - 1 min",
        consecutiveBounces: 0,
        tag: null,
        expiresAt: null
    }
];

let mapMarkers = {};
let activeRerouteLine = null;
let currentSelectedNode = null;
let activeReroutePeer = null;
let activeCategory = 'All';
let sheetState = 'peek';

// 4. Multi-Device Real-Time WebSocket Channel (Supabase)
const SUPABASE_URL = 'https://tnqymxfkcvgkhflqtwvv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRucXlteGZrY3Zna2hmbHF0d3Z2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjU5NzgzMjcsImV4cCI6MjA0MTU1NDMyN30.K3oQp22o9U5WbH18f-o8o1gVn13j2y1pZtF6kH9_abc';

let supabaseClient = null;
let syncChannel = null;

try {
    if (window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        syncChannel = supabaseClient.channel('kerala-civic-grid', {
            config: { broadcast: { self: false } }
        });

        syncChannel
            .on('broadcast', { event: 'node-state-update' }, payload => {
                applyRemoteNodeUpdate(payload.payload);
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED') {
                    pushTelemetry('Multi-Device WebSockets active: Connected to cross-device corridor.');
                }
            });
    }
} catch (e) {
    console.log('Supabase sync initialized in standalone mode.');
}

function broadcastNodeUpdate(node) {
    if (syncChannel) {
        syncChannel.send({
            type: 'broadcast',
            event: 'node-state-update',
            payload: {
                id: node.id,
                health: node.health,
                status: node.status,
                tag: node.tag,
                avgDwell: node.avgDwell
            }
        });
    }
}

function applyRemoteNodeUpdate(data) {
    const node = nodes.find(n => n.id === data.id);
    if (!node) return;

    node.health = data.health;
    node.status = data.status;
    node.tag = data.tag;
    node.avgDwell = data.avgDwell;

    pushTelemetry(`REMOTE TELEMETRY: ${node.name} marked ${node.status} from peer device.`);
    triggerHapticFeedback([40]);

    if (node.status === 'UNAVAILABLE') {
        executeUserCentricReroute(node, false);
    }

    renderMapPins();
    if (currentSelectedNode && currentSelectedNode.id === node.id) {
        inspectFacilityNode(node);
    }
}

// 5. Precision Google Maps Navigation Link Builder (Always Originates From User GPS)
function buildPrecisionGoogleMapsUrl(destLat, destLng) {
    const d = `${Number(destLat).toFixed(6)},${Number(destLng).toFixed(6)}`;
    if (userLiveLat && userLiveLng) {
        const o = `${Number(userLiveLat).toFixed(6)},${Number(userLiveLng).toFixed(6)}`;
        return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=driving`;
    }
    return `https://www.google.com/maps/dir/?api=1&destination=${d}&travelmode=driving`;
}

// 6. Onboarding Portal Controls
function dismissPortal() {
    const portal = document.getElementById('onboarding-portal');
    if (portal) portal.classList.add('hidden');
}

function openPortal() {
    const portal = document.getElementById('onboarding-portal');
    if (portal) portal.classList.remove('hidden');
}

function launchWithIntent(category) {
    dismissPortal();
    setCategoryFilter(category);
    triggerHapticFeedback([40]);
    requestScreenWakeLock();
}

function triggerHapticFeedback(pattern = [40]) {
    if (navigator.vibrate) {
        navigator.vibrate(pattern);
    }
}

// 7. Dwell and Metric Resolvers
function getDwellDisplay(node) {
    if (node.type === 'EV') {
        return {
            dwellVal: "35 - 45 min",
            dwellLbl: "Session Time",
            waitVal: node.status === 'OPERATIONAL' ? "Plugs Free" : "Offline",
            waitLbl: "Plug Status"
        };
    } else if (node.type === 'Fuel') {
        return {
            dwellVal: `~${Math.round(node.avgDwell / 60)} min`,
            dwellLbl: "Avg Fuel Stop",
            waitVal: node.waitTime || "~2 min",
            waitLbl: "Pump Queue"
        };
    } else if (node.type === 'Medical') {
        return {
            dwellVal: `~${Math.round(node.avgDwell / 60)} min`,
            dwellLbl: "Counter Visit",
            waitVal: "Direct Access",
            waitLbl: "Queue Wait"
        };
    } else {
        return {
            dwellVal: `~${Math.round(node.avgDwell / 60)} min`,
            dwellLbl: "Typical Visit",
            waitVal: node.waitTime || "0 - 1 min",
            waitLbl: "Queue Wait"
        };
    }
}

function getStatusProfile(health) {
    if (health >= 0.70) {
        return { badge: "Verified Active", desc: "Service active. Normal visitor dwell confirmed.", css: "green" };
    } else if (health >= 0.35) {
        return { badge: "Likely Out of Service", desc: "Aborted departure detected. Check alternative stop.", css: "yellow" };
    } else {
        return { badge: "Temporarily Offline", desc: "Aborted visits (<35s) confirmed. Node unavailable.", css: "red" };
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const d = map.distance([lat1, lon1], [lat2, lon2]);
    return d > 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
}

// 8. User Live Location Engine (Always Visible with Sapphire Beacon)
let userLiveMarker = null;
let userLiveAccuracyRing = null;
let activeGpsWatcher = null;

function renderUserLocationBeacon(lat, lng, accuracy = 25) {
    userLiveLat = lat;
    userLiveLng = lng;

    if (userLiveMarker) {
        userLiveMarker.setLatLng([lat, lng]);
        if (userLiveAccuracyRing) {
            userLiveAccuracyRing.setLatLng([lat, lng]);
            userLiveAccuracyRing.setRadius(accuracy);
        }
        return;
    }

    const userBeaconIcon = L.divIcon({
        className: 'user-live-beacon',
        html: `
            <div class="user-pulsing-wave"></div>
            <div class="user-center-core"></div>
            <div class="user-floating-lbl">📍 YOU ARE HERE</div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });

    userLiveMarker = L.marker([lat, lng], { icon: userBeaconIcon, zIndexOffset: 1000 }).addTo(map);

    userLiveAccuracyRing = L.circle([lat, lng], {
        radius: accuracy,
        color: '#38bdf8',
        weight: 1,
        fillColor: '#38bdf8',
        fillOpacity: 0.08,
        dashArray: '4, 6'
    }).addTo(map);
}

function initLiveUserTracking() {
    pushTelemetry("Synchronizing device hardware GPS...");
    const btn = document.getElementById('gps-action-btn');

    if (!navigator.geolocation || window.location.protocol === 'file:') {
        pushTelemetry("Notice: Browser restricts hardware GPS on file://. Engaging network fallback...");
        fallbackIpLocation();
        return;
    }

    if (btn) btn.classList.add('active');

    activeGpsWatcher = navigator.geolocation.watchPosition(
        pos => {
            hasAcquiredPreciseGps = true;
            const { latitude, longitude, accuracy } = pos.coords;
            renderUserLocationBeacon(latitude, longitude, accuracy);

            const readout = document.getElementById('radar-readout-text');
            if (readout) readout.innerText = `GPS ACTIVE: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

            pushTelemetry(`GPS locked: ${latitude.toFixed(4)}, ${longitude.toFixed(4)} (Accuracy: ${Math.round(accuracy)}m).`);
            renderDirectoryPane();
        },
        err => {
            pushTelemetry(`Hardware GPS: ${err.message}. Engaging network fallback...`);
            fallbackIpLocation();
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
    );
}

function fallbackIpLocation() {
    fetch('https://ipapi.co/json/')
        .then(res => res.json())
        .then(data => {
            if (data && data.latitude && data.longitude) {
                renderUserLocationBeacon(data.latitude, data.longitude, 500);
                const readout = document.getElementById('radar-readout-text');
                if (readout) readout.innerText = `NETWORK GEO: ${data.city || 'Kerala'} Active`;
                pushTelemetry(`Location calibrated via network: ${data.city || 'Kerala'}.`);
                renderDirectoryPane();
            }
        })
        .catch(() => {
            renderUserLocationBeacon(currentCenterLat, currentCenterLng, 30);
            pushTelemetry("Calibrated to regional corridor (TKMIT Anchor).");
        });
}

function toggleHardwareGps() {
    if (userLiveLat && userLiveLng) {
        map.flyTo([userLiveLat, userLiveLng], 15.5, { duration: 1 });
        triggerHapticFeedback([40]);
    } else {
        initLiveUserTracking();
    }
}

// 9. Map Pin Rendering
function renderMapPins() {
    nodes.forEach(node => {
        if (mapMarkers[node.id]) map.removeLayer(mapMarkers[node.id]);

        if (activeCategory !== 'All' && node.type !== activeCategory) return;

        const profile = getStatusProfile(node.health);
        const glyph = node.type === 'ATM' ? '🏧' : (node.type === 'Fuel' ? '⛽' : (node.type === 'Medical' ? '💊' : '⚡'));

        const icon = L.divIcon({
            className: 'custom-radar-marker',
            html: `
                <div class="radar-pulsing-halo ${profile.css}-halo"></div>
                <div class="radar-pill-glyph ${profile.css}-fill">${glyph}</div>
            `,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });

        const marker = L.marker([node.lat, node.lng], { icon: icon }).addTo(map);
        marker.on('click', () => {
            triggerHapticFeedback([30]);
            inspectFacilityNode(node);
        });

        mapMarkers[node.id] = marker;
    });

    renderDirectoryPane();
}

// 10. Bottom Sheet Directory Rendering
function renderDirectoryPane() {
    const container = document.getElementById('facility-directory');
    if (!container) return;
    container.innerHTML = '';

    const filtered = activeCategory === 'All' ? nodes : nodes.filter(n => n.type === activeCategory);

    filtered.forEach(n => {
        const profile = getStatusProfile(n.health);
        const dist = calculateDistance(userLiveLat, userLiveLng, n.lat, n.lng);
        const dwell = getDwellDisplay(n);

        const card = document.createElement('div');
        card.className = 'facility-item-tile';
        card.onclick = () => {
            triggerHapticFeedback([30]);
            inspectFacilityNode(n);
        };
        card.innerHTML = `
            <div>
                <div class="facility-name-text" style="${n.status === 'UNAVAILABLE' ? 'color: #f87171;' : ''}">
                    ${n.name} ${n.status === 'UNAVAILABLE' ? '<span style="font-size:9px; background:rgba(239,68,68,0.2); border:1px solid #ef4444; border-radius:4px; padding:1px 4px; margin-left:4px;">OFFLINE</span>' : ''}
                </div>
                <div class="facility-meta-text">${n.area} &bull; ${n.type} &bull; <span style="color:${profile.css === 'red' ? '#f87171' : '#38bdf8'}">${dwell.waitVal}</span></div>
            </div>
            <div class="facility-tile-right">
                <span class="facility-status-badge text-${profile.css}">● ${profile.badge}</span>
                <span class="facility-distance-lbl">${dist} away</span>
            </div>
        `;
        container.appendChild(card);
    });

    const opCount = nodes.filter(n => n.status === 'OPERATIONAL').length;
    const sub = document.getElementById('sheet-sub');
    if (sub) sub.innerText = `${opCount}/${nodes.length} facilities verified operational`;
}

// 11. Node Inspection & Immediate Rerouting if Offline
function inspectFacilityNode(node) {
    currentSelectedNode = node;
    const profile = getStatusProfile(node.health);
    const dist = calculateDistance(userLiveLat, userLiveLng, node.lat, node.lng);
    const dwell = getDwellDisplay(node);

    document.getElementById('detail-name').innerText = node.name;
    document.getElementById('detail-sub').innerHTML = `${node.area} &bull; ${node.type}`;
    document.getElementById('detail-status-text').innerText = `${profile.desc} (${dwell.waitVal})`;

    document.getElementById('kpi-dwell').innerText = dwell.dwellVal;
    document.getElementById('kpi-dwell-label').innerText = dwell.dwellLbl;
    document.getElementById('kpi-dist').innerText = dist;
    document.getElementById('kpi-queue').innerText = dwell.waitVal;
    document.getElementById('kpi-queue-label').innerText = dwell.waitLbl;

    const badge = document.getElementById('detail-badge');
    badge.innerText = profile.badge;
    badge.className = `health-status-chip ${profile.css}`;

    document.getElementById('detail-nav-btn').href = buildPrecisionGoogleMapsUrl(node.lat, node.lng);

    // If an OFFLINE node is inspected, instantly calculate nearest operational alternative from USER GPS
    if (node.status === 'UNAVAILABLE') {
        executeUserCentricReroute(node);
    } else if (activeRerouteLine) {
        map.removeLayer(activeRerouteLine);
        activeRerouteLine = null;
        dismissRerouteBanner();
    }

    document.getElementById('directory-pane').style.display = 'none';
    document.getElementById('detail-pane').style.display = 'block';

    expandBottomSheet();
    map.flyTo([node.lat, node.lng], 15, { duration: 0.8 });
}

function showDirectoryPane() {
    document.getElementById('detail-pane').style.display = 'none';
    document.getElementById('directory-pane').style.display = 'block';
}

function toggleSheet() {
    sheetState === 'peek' ? expandBottomSheet() : collapseBottomSheet();
}

function expandBottomSheet() {
    const s = document.getElementById('bottom-sheet');
    s.classList.remove('peek');
    s.classList.add('expanded');
    document.getElementById('sheet-toggle-arrow').innerText = '▼';
    sheetState = 'expanded';
}

function collapseBottomSheet() {
    const s = document.getElementById('bottom-sheet');
    s.classList.remove('expanded');
    s.classList.add('peek');
    document.getElementById('sheet-toggle-arrow').innerText = '▲';
    sheetState = 'peek';
}

// ==========================================================================
// 12. DYNAMIC NEAREST OPERATIONAL ALTERNATIVE (CALCULATED FROM USER GPS)
// ==========================================================================
function findNearestWorkingPeerToUser(failedNode) {
    // Strictly search within the EXACT same category (e.g. ATM -> ATM, Fuel -> Fuel)
    const peers = nodes.filter(n =>
        n.type === failedNode.type &&
        n.status === 'OPERATIONAL' &&
        n.id !== failedNode.id
    );

    if (peers.length === 0) return null;

    // Measure distance from the USER'S LIVE POSITION to each operational peer
    let closest = peers[0];
    let minMeters = map.distance([userLiveLat, userLiveLng], [closest.lat, closest.lng]);

    for (let i = 1; i < peers.length; i++) {
        const d = map.distance([userLiveLat, userLiveLng], [peers[i].lat, peers[i].lng]);
        if (d < minMeters) {
            minMeters = d;
            closest = peers[i];
        }
    }
    return closest;
}

function executeUserCentricReroute(failedNode, shouldBroadcast = true) {
    const peer = findNearestWorkingPeerToUser(failedNode);
    if (!peer) {
        pushTelemetry(`ALERT: ${failedNode.name} down. No operational ${failedNode.type} alternatives nearby.`);
        return;
    }

    activeReroutePeer = peer;

    if (activeRerouteLine) map.removeLayer(activeRerouteLine);

    // Draw route vector connecting USER LIVE LOCATION -> NEAREST WORKING PEER
    activeRerouteLine = L.polyline([
        [userLiveLat, userLiveLng],
        [peer.lat, peer.lng]
    ], {
        className: 'directional-flow-line',
        color: '#38bdf8',
        weight: 5,
        opacity: 0.95
    }).addTo(map);

    map.flyToBounds(activeRerouteLine.getBounds(), { padding: [60, 60], duration: 1.2 });

    const card = document.getElementById('reroute-card');
    document.getElementById('reroute-from').innerText = `${failedNode.name} (OFFLINE)`;
    document.getElementById('reroute-to').innerText = `${peer.name} (${peer.type})`;

    const distM = Math.round(map.distance([userLiveLat, userLiveLng], [peer.lat, peer.lng]));
    const timeEst = Math.max(1, Math.round(distM / 400));

    document.getElementById('reroute-delta').innerHTML =
        `<b>${failedNode.name}</b> is down. Rerouted to nearest active ${peer.type}: <b>${peer.name}</b> (${distM > 1000 ? (distM/1000).toFixed(1)+'km' : distM+'m'} from your position, ~${timeEst} min drive).`;

    // Google Maps Navigation from USER LIVE GPS to the backup peer
    document.getElementById('reroute-nav-link').href = buildPrecisionGoogleMapsUrl(peer.lat, peer.lng);

    card.style.display = 'block';
    triggerHapticFeedback([80, 50, 80]);
    pushTelemetry(`REROUTE: Commuters diverted to nearest active ${peer.type} (${peer.name}).`);

    if (shouldBroadcast) {
        broadcastNodeUpdate(failedNode);
    }
}

function dismissRerouteBanner() {
    const card = document.getElementById('reroute-card');
    if (card) card.style.display = 'none';
}

function inspectReroutePeer() {
    if (activeReroutePeer) {
        inspectFacilityNode(activeReroutePeer);
    }
}

// ==========================================================================
// 13. MATHEMATICAL EMA CONFIDENCE ENGINE & ZERO-KNOWLEDGE TOKENIZER
// ==========================================================================
function generateEphemeralToken() {
    const chars = '0123456789abcdef';
    let hash = '';
    for (let i = 0; i < 8; i++) hash += chars[Math.floor(Math.random() * chars.length)];
    return `anon_${hash}`;
}

function calculateEmaHealth(currentHealth, dwellSec, thresholdSec) {
    const ALPHA = 0.65; // Weight given to most recent event
    const eventScore = dwellSec >= thresholdSec ? 0.95 : 0.10;
    const updated = (ALPHA * eventScore) + ((1 - ALPHA) * currentHealth);
    return parseFloat(Math.min(0.98, Math.max(0.12, updated)).toFixed(2));
}

function processPassiveDwellEvent(targetNode, dwellSec) {
    const token = generateEphemeralToken();
    const threshold = targetNode.type === 'EV' ? 180 : (targetNode.type === 'Fuel' ? 45 : 35);
    const isAbort = dwellSec < threshold;

    targetNode.health = calculateEmaHealth(targetNode.health, dwellSec, threshold);
    targetNode.avgDwell = dwellSec;

    if (isAbort) {
        targetNode.consecutiveBounces += 1;
        if (targetNode.consecutiveBounces === 1) {
            targetNode.status = 'UNCERTAIN';
            pushTelemetry(`[TOKEN: ${token}] Dwell: ${dwellSec}s (<${threshold}s). EMA confidence: ${Math.round(targetNode.health * 100)}%.`);
            broadcastNodeUpdate(targetNode);
        } else if (targetNode.consecutiveBounces >= 2) {
            targetNode.status = 'UNAVAILABLE';
            targetNode.tag = targetNode.type === 'EV' ? '#ChargerFault' : (targetNode.type === 'Fuel' ? '#FuelDry' : '#CashDry');
            targetNode.expiresAt = Date.now() + 14400000; // 4-Hour TTL
            pushTelemetry(`[CONSENSUS k=2] Fault confirmed at ${targetNode.name}. Node shut down.`);
            executeUserCentricReroute(targetNode, true);
        }
    } else {
        targetNode.consecutiveBounces = 0;
        targetNode.status = 'OPERATIONAL';
        targetNode.tag = null;
        pushTelemetry(`[TOKEN: ${token}] Verified dwell (${dwellSec}s). Health: ${Math.round(targetNode.health * 100)}%.`);
        broadcastNodeUpdate(targetNode);
    }

    renderMapPins();
    if (currentSelectedNode && currentSelectedNode.id === targetNode.id) {
        inspectFacilityNode(targetNode);
    }
}

function pushTelemetry(text) {
    const el = document.getElementById('telemetry-feed');
    if (el) el.innerText = text;
}

// ==========================================================================
// 14. DETERMINISTIC PITCH CONTROLLER (FOR HACKATHON JUDGING STAGE)
// ==========================================================================
function triggerPitchAbort() {
    const targetAtm = nodes.find(n => n.id === "k6" || n.id === "k1"); // Canara or Federal Bank
    if (targetAtm) {
        triggerHapticFeedback([100, 50, 100]);
        processPassiveDwellEvent(targetAtm, 18); // 18-second aborted bounce
    }
}

function triggerPitchSuccess() {
    const operationalAtm = nodes.find(n => n.status === 'OPERATIONAL' && n.type === 'ATM');
    if (operationalAtm) {
        triggerHapticFeedback([40]);
        processPassiveDwellEvent(operationalAtm, 145); // 145-second successful transaction
    }
}

function resetPitchCorridor() {
    nodes.forEach(n => {
        n.health = 0.95;
        n.status = 'OPERATIONAL';
        n.consecutiveBounces = 0;
        n.tag = null;
    });
    // Re-flag pre-seeded demo nodes
    nodes[0].status = 'UNAVAILABLE';
    nodes[0].health = 0.15;
    nodes[0].tag = '#CashDry';
    nodes[6].status = 'UNAVAILABLE';
    nodes[6].health = 0.18;
    nodes[6].tag = '#DryPump';

    if (activeRerouteLine) {
        map.removeLayer(activeRerouteLine);
        activeRerouteLine = null;
    }
    dismissRerouteBanner();
    renderMapPins();
    pushTelemetry("Grid reset: Nominal calibration restored.");
}

// 15. Search Engine
function handleSearch(query) {
    const dropdown = document.getElementById('search-dropdown');
    const q = query.trim().toLowerCase();

    if (!q) {
        dropdown.style.display = 'none';
        return;
    }

    const localMatches = nodes.filter(n =>
        n.name.toLowerCase().includes(q) ||
        n.area.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q)
    );

    let html = localMatches.slice(0, 5).map(m => {
        const prof = getStatusProfile(m.health);
        return `
            <div class="search-match-row" onclick="focusNode('${m.id}')">
                <div>
                    <div class="match-main-text">${m.name}</div>
                    <div class="match-sub-text">${m.area} &bull; ${m.type}</div>
                </div>
                <div class="match-badge text-${prof.css}">● ${prof.badge}</div>
            </div>
        `;
    }).join('');

    html += `
        <div class="search-match-row" style="border-top:1px dashed rgba(255,255,255,0.15);" onclick="geocodeExternalTown('${query}')">
            <div>
                <div class="match-main-text" style="color:#38bdf8;">📍 Search "${query}" in Kerala Map</div>
                <div class="match-sub-text">Fly to town &amp; scan grid</div>
            </div>
            <span>➔</span>
        </div>
    `;

    dropdown.innerHTML = html;
    dropdown.style.display = 'block';
}

function focusNode(id) {
    const target = nodes.find(n => n.id === id);
    if (!target) return;
    document.getElementById('search-dropdown').style.display = 'none';
    document.getElementById('global-service-search').value = target.name;
    inspectFacilityNode(target);
}

function geocodeExternalTown(placeName) {
    document.getElementById('search-dropdown').style.display = 'none';
    pushTelemetry(`Geocoding query: "${placeName}, Kerala"...`);

    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(placeName + ', Kerala')}`)
        .then(res => res.json())
        .then(data => {
            if (data && data.length > 0) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);
                map.flyTo([lat, lon], 14, { duration: 1.3 });
                pushTelemetry(`Map centered on ${data[0].display_name.split(',')[0]}.`);
            } else {
                pushTelemetry(`Location "${placeName}" not found.`);
            }
        })
        .catch(() => pushTelemetry(`Geocoding network error.`));
}

function setCategoryFilter(cat, btnElement) {
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));

    if (btnElement) {
        btnElement.classList.add('active');
    } else {
        const matching = document.querySelector(`.filter-pill[data-filter="${cat}"]`);
        if (matching) matching.classList.add('active');
    }

    activeCategory = cat;
    renderMapPins();
}

// Initial Launch & Continuous Beacon Tracking
renderMapPins();
initLiveUserTracking();
pushTelemetry("Autonomous sensing grid active. Live user beacon engaged.");