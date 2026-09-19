const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const baseDir = fs.existsSync(path.join(__dirname, 'dist')) ? path.join(__dirname, 'dist') : __dirname;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// ============================================================================
// IN-MEMORY DATABASE & CACHE STORES
// ============================================================================
const nodesDb = new Map();
const discoverCache = new Map(); // Key: `${lat.toFixed(3)}_${lng.toFixed(3)}_${radius}` -> { timestamp, data }
const waterCache = new Map();    // Key: `${lat.toFixed(4)}_${lng.toFixed(4)}` -> { timestamp, isWater }

const DISCOVER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const WATER_CACHE_TTL = 60 * 60 * 1000;    // 1 hour

// Distance calculation (Haversine formula in km)
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

// Map OSM tags to application node category
function mapOsmAmenity(tags) {
  if (!tags) return 'ATM';
  const amenity = (tags.amenity || '').toLowerCase();
  if (amenity === 'atm' || amenity === 'bank') return 'ATM';
  if (amenity === 'fuel') return 'Fuel';
  if (amenity === 'pharmacy') return 'Medical';
  if (amenity === 'charging_station') return 'EV';
  if (amenity === 'clinic' || amenity === 'hospital' || amenity === 'doctors') return 'Clinic';
  return 'ATM';
}

// Get standard dwell & queue metadata per node type
function getNodeTypeDefaults(type) {
  switch (type) {
    case 'ATM':
      return { avgDwell: 5, dwell: '2.1 min', queue: '1-2 min' };
    case 'Fuel':
      return { avgDwell: 3, dwell: '4.8 min', queue: '3 min' };
    case 'Medical':
      return { avgDwell: 4, dwell: '3.5 min', queue: '0 min' };
    case 'EV':
      return { avgDwell: 15, dwell: '28 min', queue: 'CCS2 Ready' };
    case 'Clinic':
      return { avgDwell: 12, dwell: '14 min', queue: 'Triage Open' };
    default:
      return { avgDwell: 5, dwell: '3 min', queue: '1 min' };
  }
}

// ============================================================================
// OVERPASS API CLIENT & QUERY RUNNER
// ============================================================================
function queryOverpass(qlQuery, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const postData = 'data=' + encodeURIComponent(qlQuery);
    const req = https.request('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'LastMileGuardian-CivicEngine/2.0'
      },
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const json = JSON.parse(body);
            resolve(json);
          } else {
            reject(new Error(`Overpass returned HTTP ${res.statusCode}: ${body.substring(0, 120)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Overpass API query timed out'));
    });
    req.write(postData);
    req.end();
  });
}

// Helper to check if a location falls within a water body (rivers, lakes, bays, reservoirs)
async function isLikelyWater(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return false;
  }
  const cacheKey = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
  const cached = waterCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < WATER_CACHE_TTL)) {
    return cached.isWater;
  }

  const query = `
[out:json][timeout:10];
(
  node["natural"~"^(water|bay|coastline)$"](around:35,${lat},${lng});
  way["natural"~"^(water|bay|coastline)$"](around:35,${lat},${lng});
  relation["natural"~"^(water|bay|coastline)$"](around:35,${lat},${lng});
  node["waterway"~"^(river|stream|canal|dock)$"](around:35,${lat},${lng});
  way["waterway"~"^(river|stream|canal|dock)$"](around:35,${lat},${lng});
  way["landuse"~"^(reservoir|basin)$"](around:35,${lat},${lng});
);
out ids 1;
`;

  try {
    const data = await queryOverpass(query, 8000);
    const isWater = !!(data && data.elements && data.elements.length > 0);
    waterCache.set(cacheKey, { timestamp: Date.now(), isWater });
    return isWater;
  } catch (err) {
    console.warn(`[Water Check Warning at ${lat}, ${lng}]:`, err.message);
    return false;
  }
}

// Retrieve nodes from local DB within radius in km
function getNodesWithinRadius(lat, lng, radiusKm) {
  const list = [];
  for (const node of nodesDb.values()) {
    const d = haversineKm(lat, lng, node.lat, node.lng || node.lon);
    if (d <= radiusKm) {
      list.push(node);
    }
  }
  return list;
}

// Discover real POIs from Overpass with caching & DB integration
async function discoverRealPOIs(lat, lng, radius = 2500) {
  const cacheKey = `${lat.toFixed(3)}_${lng.toFixed(3)}_${radius}`;
  const cached = discoverCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < DISCOVER_CACHE_TTL)) {
    return cached.data;
  }

  const query = `
[out:json][timeout:15];
(
  node["amenity"~"^(atm|bank|fuel|pharmacy|charging_station|clinic|hospital)$"](around:${radius},${lat},${lng});
  way["amenity"~"^(atm|bank|fuel|pharmacy|charging_station|clinic|hospital)$"](around:${radius},${lat},${lng});
);
out center 40;
`;

  try {
    const result = await queryOverpass(query, 12000);
    const elements = result.elements || [];
    const discovered = [];

    for (const el of elements) {
      const type = mapOsmAmenity(el.tags);
      const defaults = getNodeTypeDefaults(type);
      const nodeLat = el.lat || el.center?.lat;
      const nodeLon = el.lon || el.center?.lon;
      if (!nodeLat || !nodeLon) continue;

      const name = el.tags?.name || el.tags?.brand || el.tags?.operator || `Unnamed ${type}`;
      const corridor = el.tags?.['addr:street'] || el.tags?.['addr:suburb'] || el.tags?.['addr:city'] || `${name} Corridor`;

      const nodeObj = {
        id: `osm_${el.id}`,
        name: name,
        type: type,
        category: type,
        lat: nodeLat,
        lng: nodeLon,
        lon: nodeLon,
        corridor: corridor,
        dwell: defaults.dwell,
        avgDwell: defaults.avgDwell,
        queue: defaults.queue,
        baseScore: 92,
        healthScore: 92,
        status: 'Operational',
        statusClass: 'green',
        statusText: 'Verified active real-world civic facility.',
        recentBounces: 0,
        explicitFailures: 0,
        verifiedSuccesses: 1,
        activeTags: [],
        source: 'osm'
      };

      // De-duplication: insert if not present
      if (!nodesDb.has(nodeObj.id)) {
        nodesDb.set(nodeObj.id, nodeObj);
      }
      discovered.push(nodeObj);
    }

    // Return combined nodes in radius (existing DB nodes + newly discovered)
    const combined = getNodesWithinRadius(lat, lng, radius / 1000);
    const returnList = combined.length > 0 ? combined : discovered;

    discoverCache.set(cacheKey, { timestamp: Date.now(), data: returnList });
    return returnList;
  } catch (err) {
    console.warn(`[Overpass POI Discovery Warning at ${lat}, ${lng}]:`, err.message);
    // Return existing nodes in DB near that location
    return getNodesWithinRadius(lat, lng, radius / 1000);
  }
}

// Parse request body as JSON
function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// ============================================================================
// HTTP REQUEST ROUTER & API SERVER
// ============================================================================
async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname.replace(/\/$/, '') || '/';

  // Standard CORS & No-Cache response headers
  const jsonHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, jsonHeaders);
    res.end();
    return;
  }

  // --- API ROUTE: Health check ---
  if (pathname === '/api/health') {
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ status: 'ok', server: 'LastMile Real-POI Civic Engine', port: PORT }));
    return;
  }

  // --- API ROUTE: PART A - Discover Real POIs from OSM ---
  if (pathname === '/api/nodes/discover' && req.method === 'GET') {
    const lat = parseFloat(parsedUrl.query.lat);
    const lng = parseFloat(parsedUrl.query.lng || parsedUrl.query.lon);
    const radius = parseInt(parsedUrl.query.radius || '2500', 10);

    if (isNaN(lat) || isNaN(lng)) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ error: 'lat and lng/lon query parameters are required and must be valid numbers' }));
      return;
    }

    try {
      const nodes = await discoverRealPOIs(lat, lng, radius);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ status: 'ok', count: nodes.length, nodes }));
    } catch (err) {
      console.warn('[Discovery Endpoint Error]:', err.message);
      const fallbackNodes = getNodesWithinRadius(lat, lng, radius / 1000);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify({ status: 'ok', fallback: true, count: fallbackNodes.length, nodes: fallbackNodes }));
    }
    return;
  }

  // --- API ROUTE: PART B - Check if coordinate is in water ---
  if (pathname === '/api/nodes/check-water' && req.method === 'GET') {
    const lat = parseFloat(parsedUrl.query.lat);
    const lng = parseFloat(parsedUrl.query.lng || parsedUrl.query.lon);
    if (isNaN(lat) || isNaN(lng)) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ error: 'lat and lng parameters are required' }));
      return;
    }
    const isWater = await isLikelyWater(lat, lng);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ lat, lng, isWater }));
    return;
  }

  // --- API ROUTE: PART B - Add new node with water body check & de-duplication ---
  if (pathname === '/api/nodes' && req.method === 'POST') {
    const nodeData = await parseJsonBody(req);
    const lat = parseFloat(nodeData.lat);
    const lng = parseFloat(nodeData.lng || nodeData.lon);

    if (isNaN(lat) || isNaN(lng)) {
      res.writeHead(400, jsonHeaders);
      res.end(JSON.stringify({ error: 'Node must have valid lat and lng/lon coordinates' }));
      return;
    }

    // Water Body Safety Check
    const isWater = await isLikelyWater(lat, lng);
    if (isWater) {
      res.writeHead(422, jsonHeaders);
      res.end(JSON.stringify({
        rejected: true,
        reason: 'water',
        message: 'Candidate node rejected: coordinates fall within a water body'
      }));
      return;
    }

    const type = nodeData.type || nodeData.category || 'ATM';
    const defaults = getNodeTypeDefaults(type);
    const id = nodeData.id || `node_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const nodeObj = {
      ...nodeData,
      id: id,
      name: nodeData.name || `Unnamed ${type}`,
      type: type,
      category: type,
      lat: lat,
      lng: lng,
      lon: lng,
      corridor: nodeData.corridor || 'Local Corridor',
      dwell: nodeData.dwell || defaults.dwell,
      avgDwell: nodeData.avgDwell || defaults.avgDwell,
      queue: nodeData.queue || defaults.queue,
      baseScore: nodeData.baseScore || 92,
      healthScore: nodeData.healthScore || 92,
      status: nodeData.status || 'Operational',
      statusClass: nodeData.statusClass || 'green',
      statusText: nodeData.statusText || 'Normal visitor transaction durations confirmed.',
      recentBounces: nodeData.recentBounces || 0,
      explicitFailures: nodeData.explicitFailures || 0,
      verifiedSuccesses: nodeData.verifiedSuccesses || 1,
      activeTags: nodeData.activeTags || []
    };

    // Insert or ignore into local DB
    if (!nodesDb.has(id)) {
      nodesDb.set(id, nodeObj);
    }

    res.writeHead(201, jsonHeaders);
    res.end(JSON.stringify({ success: true, node: nodeObj }));
    return;
  }

  // --- API ROUTE: List all nodes or filter by coordinates ---
  if (pathname === '/api/nodes' && req.method === 'GET') {
    const lat = parseFloat(parsedUrl.query.lat);
    const lng = parseFloat(parsedUrl.query.lng || parsedUrl.query.lon);
    const radius = parseFloat(parsedUrl.query.radius || '10'); // km

    if (!isNaN(lat) && !isNaN(lng)) {
      const nearby = getNodesWithinRadius(lat, lng, radius);
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(nearby));
      return;
    }

    const all = Array.from(nodesDb.values());
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(all));
    return;
  }

  // --- API ROUTE: /api/facilities (Legacy & frontend compatibility) ---
  if (pathname === '/api/facilities' && req.method === 'GET') {
    const lat = parseFloat(parsedUrl.query.lat);
    const lon = parseFloat(parsedUrl.query.lon || parsedUrl.query.lng);
    const radius = 3000;

    if (!isNaN(lat) && !isNaN(lon)) {
      try {
        const realNodes = await discoverRealPOIs(lat, lon, radius);
        if (realNodes && realNodes.length > 0) {
          res.writeHead(200, jsonHeaders);
          res.end(JSON.stringify(realNodes));
          return;
        }
      } catch (e) {
        console.warn('Facilities discover fallback:', e.message);
      }
    }

    const all = Array.from(nodesDb.values());
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(all));
    return;
  }

  // --- API ROUTE: Telemetry & Simulation actions ---
  if (pathname === '/api/telemetry/visit' && req.method === 'POST') {
    const data = await parseJsonBody(req);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ status: 'ok', visitRecorded: true, data }));
    return;
  }

  if (pathname === '/api/telemetry/report' && req.method === 'POST') {
    const data = await parseJsonBody(req);
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ status: 'ok', reportRecorded: true, data }));
    return;
  }

  if (pathname === '/api/simulation/abort' && req.method === 'POST') {
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ status: 'ok', simulation: 'abort' }));
    return;
  }

  if (pathname === '/api/simulation/success' && req.method === 'POST') {
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ status: 'ok', simulation: 'success' }));
    return;
  }

  if (pathname === '/api/simulation/reset' && req.method === 'POST') {
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify({ status: 'ok', simulation: 'reset' }));
    return;
  }

  // ==========================================================================
  // STATIC FILE SERVING WITH STRICT NO-CACHE HEADERS
  // ==========================================================================
  let reqPath = parsedUrl.pathname;
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  let filePath = path.join(baseDir, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(baseDir, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 LastMile Guardian Web App running at:`);
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    console.log(`   ➜ Network: http://127.0.0.1:${PORT}/`);
  });
}

module.exports = handleRequest;
