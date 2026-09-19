#!/usr/bin/env python3
"""
LastMile Guardian — Executive Civic Usability Backend (Python Edition)
Project B26122: Real-Time Usability & Fault Inference for Essential Public Services

Implements:
- Fault Inference State Engine (Bayesian-style scoring)
- 4-Hour Time-Based Tag Auto-Expiration Worker
- Passive Bounce Detection (<40s dwell)
- Autonomous k-NN Nearest Operational Peer Rerouting
- Full REST API + Static Asset Serving
"""

import http.server
import json
import math
import os
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", 8080))

class FacilityNode:
    def __init__(self, node_id, name, category, lat, lon, corridor, dwell, queue):
        self.id = node_id
        self.name = name
        self.category = category
        self.lat = lat
        self.lon = lon
        self.corridor = corridor
        self.dwell = dwell
        self.queue = queue
        self.base_score = 92
        self.health_score = 92
        self.status = "Operational"
        self.status_class = "green"
        self.status_text = "Verified active with regular visitor dwell times."
        self.recent_bounces = 0
        self.explicit_failures = 0
        self.verified_successes = 1
        self.active_tags = [] # list of {"tag": str, "timestamp": float}
        self.recalculate()

    def recalculate(self):
        score = self.base_score
        score -= self.recent_bounces * 24
        score -= self.explicit_failures * 36
        score += self.verified_successes * 14
        self.health_score = max(8, min(99, round(score)))

        if self.health_score >= 80:
            self.status = "Operational"
            self.status_class = "green"
            self.status_text = "Verified active with regular visitor dwell times."
        elif self.health_score >= 40:
            self.status = "Uncertain"
            self.status_class = "yellow"
            self.status_text = "Uncertain operational health: multiple rapid exits detected."
        else:
            self.status = "Unavailable"
            self.status_class = "red"
            self.status_text = "Service failure inferred: zero completed dwells & rapid bounces."

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "lat": self.lat,
            "lon": self.lon,
            "corridor": self.corridor,
            "dwell": self.dwell,
            "queue": self.queue,
            "healthScore": self.health_score,
            "status": self.status,
            "statusClass": self.status_class,
            "statusText": self.status_text,
            "recentBounces": self.recent_bounces,
            "explicitFailures": self.explicit_failures,
            "verifiedSuccesses": self.verified_successes,
            "activeTags": [t["tag"] for t in self.active_tags]
        }


# Global store
FACILITIES = {}
TELEMETRY_LOGS = []
USER_LAT = 8.9868
USER_LON = 76.7127
lock = threading.RLock()

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def log_telemetry(msg):
    t_str = time.strftime("%H:%M:%S")
    entry = f"[{t_str}] {msg}"
    with lock:
        TELEMETRY_LOGS.insert(0, entry)
        if len(TELEMETRY_LOGS) > 50:
            TELEMETRY_LOGS.pop()
    print(entry)

def seed_facilities(lat, lon, area="Karuvelil Corridor"):
    global FACILITIES
    with lock:
        FACILITIES.clear()
        is_kerala = abs(lat - 8.98) < 0.2
        if is_kerala:
            items = [
                ("node-1", "Federal Bank ATM", "ATM", 0.0032, 0.0041, "Karuvelil Jn", "2.1 min", "1-2 min"),
                ("node-2", "SBI ATM Ezhukone", "ATM", -0.0055, -0.0038, "Ezhukone Market", "2.4 min", "2-4 min"),
                ("node-3", "Indian Oil Petrol Bunk", "Fuel", 0.0084, -0.0062, "Kollam-Tenkasi Hwy", "4.8 min", "3 min"),
                ("node-4", "Bharat Petroleum Pump", "Fuel", -0.0091, 0.0075, "Chepra Road", "5.2 min", "1 min"),
                ("node-5", "Apollo 24/7 Pharmacy", "Medical", 0.0049, -0.0022, "Karuvelil Main", "3.5 min", "0 min"),
                ("node-6", "Neethi Medical Store", "Medical", -0.0068, 0.0039, "Ezhukone Hospital Rd", "4.0 min", "2 min"),
                ("node-7", "KSEB EV Fast Charger 60kW", "EV", 0.0071, 0.0088, "Substation Gate", "28 min", "CCS2 Ready"),
                ("node-8", "Zeon EV Charging Hub", "EV", -0.0112, -0.0072, "Highway Bypass", "35 min", "Dual Gun Ready"),
                ("node-9", "Taluk Emergency Health Clinic", "Clinic", 0.0118, 0.0031, "Govt Hospital Rd", "14 min", "Triage Open"),
                ("node-10", "HDFC Bank ATM & Cash Deposit", "ATM", -0.0021, 0.0095, "East Junction", "1.9 min", "0 min")
            ]
        else:
            items = [
                ("node-1", "HDFC Bank ATM", "ATM", 0.0028, 0.0035, area, "2.0 min", "0-1 min"),
                ("node-2", "State Bank of India ATM", "ATM", -0.0042, -0.0031, area, "2.3 min", "2-3 min"),
                ("node-3", "Indian Oil Fuel & CNG", "Fuel", 0.0072, -0.0051, f"{area} Main Rd", "4.5 min", "2 min"),
                ("node-4", "Bharat Petroleum Fuel Station", "Fuel", -0.0081, 0.0064, f"{area} Ring Rd", "5.0 min", "1 min"),
                ("node-5", "Apollo 24/7 Emergency Pharmacy", "Medical", 0.0039, -0.0018, f"{area} Central", "3.2 min", "0 min"),
                ("node-6", "MedPlus 24-Hour Chemist", "Medical", -0.0058, 0.0032, f"{area} Cross", "3.8 min", "1 min"),
                ("node-7", "Tata Power EV Fast Charger 60kW", "EV", 0.0064, 0.0075, f"{area} Commercial", "25 min", "CCS2 Online"),
                ("node-8", "Jio-bp Pulse EV Hub", "EV", -0.0095, -0.0065, f"{area} Bypass", "30 min", "Available"),
                ("node-9", "City Urgent Care Clinic", "Clinic", 0.0098, 0.0025, f"{area} Civic Centre", "12 min", "Triage Ready"),
                ("node-10", "ICICI Bank 24hr ATM", "ATM", -0.0019, 0.0082, f"{area} Market Rd", "1.8 min", "0 min")
            ]

        for nid, name, cat, dlat, dlon, cor, dwell, queue in items:
            FACILITIES[nid] = FacilityNode(nid, name, cat, lat + dlat, lon + dlon, cor, dwell, queue)

    log_telemetry(f"Python Backend: Seeded 10 civic utilities around {area} [{lat:.4f}, {lon:.4f}]")

def find_nearest_peer(source_node):
    best = None
    min_dist = float("inf")
    with lock:
        for f in FACILITIES.values():
            if f.id != source_node.id and f.category == source_node.category and f.status == "Operational":
                d = haversine(USER_LAT, USER_LON, f.lat, f.lon)
                if d < min_dist:
                    min_dist = d
                    best = f
    return best

def auto_decay_worker():
    while True:
        time.sleep(5)
        now = time.time()
        decay_logs = []
        with lock:
            for fac in list(FACILITIES.values()):
                remaining = []
                for t in fac.active_tags:
                    if now - t["timestamp"] < 60: # 60s demo window (4hr in production)
                        remaining.append(t)
                    else:
                        if fac.recent_bounces > 0: fac.recent_bounces -= 1
                        if fac.explicit_failures > 0: fac.explicit_failures -= 1
                        fac.recalculate()
                        decay_logs.append(f"Auto-decay: Tag [{t['tag']}] expired on {fac.name}. Health restored to {fac.health_score}%.")
                fac.active_tags = remaining
        for msg in decay_logs:
            log_telemetry(msg)

class LastMileHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def send_json(self, status_code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/api/health":
            self.send_json(200, {"status": "healthy", "server": "LastMile Guardian Python 3 Engine", "nodes": len(FACILITIES)})
        elif parsed.path == "/api/facilities":
            lat = float(qs.get("lat", [USER_LAT])[0])
            lon = float(qs.get("lon", [USER_LON])[0])
            area = qs.get("area", ["Local"])[0]
            if abs(lat - USER_LAT) > 0.05 or abs(lon - USER_LON) > 0.05:
                seed_facilities(lat, lon, area)
            with lock:
                res = [f.to_dict() for f in FACILITIES.values()]
            self.send_json(200, res)
        elif parsed.path == "/api/reroute":
            fac_id = qs.get("facilityId", [""])[0]
            fac = FACILITIES.get(fac_id)
            if not fac:
                self.send_json(404, {"error": "Not found"})
                return
            peer = find_nearest_peer(fac)
            if peer:
                dist = round(haversine(USER_LAT, USER_LON, peer.lat, peer.lon), 1)
                self.send_json(200, {"found": True, "from": fac.to_dict(), "to": peer.to_dict(), "distKm": dist})
            else:
                self.send_json(200, {"found": False})
        elif parsed.path == "/api/logs":
            with lock:
                self.send_json(200, TELEMETRY_LOGS)
        else:
            # Fall back to serving static files
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        if parsed.path == "/api/telemetry/visit":
            fac_id = payload.get("facilityId")
            with lock:
                if len(FACILITIES) == 0:
                    seed_facilities(USER_LAT, USER_LON)
                fac = FACILITIES.get(fac_id) or next(iter(FACILITIES.values()), None)
            if not fac:
                self.send_json(200, {"status": "ok"})
                return
            dwell = int(payload.get("dwellSeconds", 30))
            if dwell < 40:
                fac.recent_bounces += 1
                log_telemetry(f"Passive Bounce Detected (<40s dwell) at {fac.name} ({dwell}s)")
            else:
                fac.verified_successes += 1
                log_telemetry(f"Normal dwell ({dwell}s) verified at {fac.name}")
            fac.recalculate()
            peer = find_nearest_peer(fac) if fac.status == "Unavailable" else None
            self.send_json(200, {"facility": fac.to_dict(), "reroutePeer": peer.to_dict() if peer else None})

        elif parsed.path == "/api/telemetry/report":
            fac_id = payload.get("facilityId")
            with lock:
                if len(FACILITIES) == 0:
                    seed_facilities(USER_LAT, USER_LON)
                fac = FACILITIES.get(fac_id) or next(iter(FACILITIES.values()), None)
            if not fac:
                self.send_json(200, {"status": "ok"})
                return
            if payload.get("success", True):
                fac.verified_successes += 1
                log_telemetry(f"1-Tap Success confirmed for {fac.name}")
            else:
                fac.explicit_failures += 1
                fac.recent_bounces += 1
                tag = payload.get("faultTag", "")
                if tag:
                    fac.active_tags.append({"tag": tag, "timestamp": time.time()})
                log_telemetry(f"1-Tap Failure reported for {fac.name}: [{tag}]")
            fac.recalculate()
            peer = find_nearest_peer(fac) if fac.status == "Unavailable" else None
            self.send_json(200, {"facility": fac.to_dict(), "reroutePeer": peer.to_dict() if peer else None})

        elif parsed.path == "/api/simulation/abort":
            atm = next((f for f in FACILITIES.values() if f.category == "ATM"), None)
            if atm:
                atm.recent_bounces = 3
                atm.explicit_failures = 1
                atm.active_tags = [{"tag": "Cash Depleted", "timestamp": time.time()}]
                atm.dwell = "32 sec"
                atm.queue = "Empty (No Cash)"
                atm.recalculate()
                peer = find_nearest_peer(atm)
                dist = round(haversine(USER_LAT, USER_LON, peer.lat, peer.lon), 1) if peer else 0
                log_telemetry(f"PITCH DEMO: Force ATM Abort triggered at {atm.name} -> Diverting to {peer.name if peer else 'None'}")
                self.send_json(200, {"failedNode": atm.to_dict(), "peerNode": peer.to_dict() if peer else None, "distKm": dist})
            else:
                self.send_json(404, {"error": "No ATM found"})

        elif parsed.path == "/api/simulation/success":
            atm = next((f for f in FACILITIES.values() if f.category == "ATM"), None)
            if atm:
                atm.recent_bounces = 0
                atm.explicit_failures = 0
                atm.verified_successes = 3
                atm.active_tags = []
                atm.dwell = "2.1 min"
                atm.queue = "1 min"
                atm.recalculate()
                log_telemetry(f"PITCH DEMO: Success dwell confirmed for {atm.name}. Health restored.")
                self.send_json(200, atm.to_dict())
            else:
                self.send_json(404, {"error": "No ATM found"})

        elif parsed.path == "/api/simulation/reset":
            for f in FACILITIES.values():
                f.recent_bounces = 0
                f.explicit_failures = 0
                f.verified_successes = 1
                f.active_tags = []
                f.recalculate()
            log_telemetry("PITCH DEMO: All facilities reset to baseline operational status.")
            self.send_json(200, {"success": True})
        else:
            self.send_json(404, {"error": "Endpoint not found"})

if __name__ == "__main__":
    seed_facilities(USER_LAT, USER_LON)
    t = threading.Thread(target=auto_decay_worker, daemon=True)
    t.start()
    server = http.server.ThreadingHTTPServer(("", PORT), LastMileHandler)
    print("==================================================================")
    print(f"🚀 LASTMILE GUARDIAN CIVIC USABILITY PYTHON BACKEND RUNNING")
    print(f"   Port: {PORT}")
    print(f"   API Base: http://localhost:{PORT}/api/facilities")
    print(f"   Dashboard: http://localhost:{PORT}/")
    print(f"   4-Hour Tag Auto-Expiration Worker: ACTIVE")
    print("==================================================================")
    server.serve_forever()
