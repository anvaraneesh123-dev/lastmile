# LastMile Guardian 🛡️
> **Real-Time Usability & Fault Inference for Essential Public Services**  
> *Team ID: B26122 | Social Innovation & Community Development*

[![Java](https://img.shields.io/badge/Java-21%20LTS-ED8B00?style=for-the-badge&logo=openjdk&logoColor=white)](https://openjdk.org/)
[![Python](https://img.shields.io/badge/Python-3.9+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org/)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9.4-199900?style=for-the-badge&logo=leaflet&logoColor=white)](https://leafletjs.com/)
[![OpenStreetMap](https://img.shields.io/badge/OpenStreetMap-Nominatim-7EBC6F?style=for-the-badge&logo=openstreetmap&logoColor=white)](https://www.openstreetmap.org/)

---

## 📌 Problem Statement

Navigation maps tell us where an ATM, fuel station, clinic, or pharmacy is, and whether it is scheduled as "open". **What they never tell us is whether the service actually works right now.**
People regularly ride or drive kilometers only to find an ATM with no cash, a fuel pump dry, a broken EV charger plug, or a pharmacy without a pharmacist. Current maps only track whether a location exists geographically, leaving citizens stranded during sudden outages or late-night emergencies.

---

## 💡 The LastMile Guardian Solution

LastMile Guardian constructs an autonomous **"Usability Layer"** on top of existing civic infrastructure:

1. **Zero-Friction Reporting (Passive Signal Inference)**:
   - Tracks passive dwell times inside geofences. If multiple commuters enter a service boundary and leave in $<40\text{ seconds}$ without stopping, the system infers a likely operational failure.
   - Exiting users receive a 1-tap prompt: *"Were you able to get what you needed? [Yes / No]"*.
2. **Smart Fault-Inference State Engine**:
   - Scores usability dynamically:
     - **🟢 Operational (80% - 100%)**: Verified active with normal transaction dwell durations.
     - **🟡 Uncertain (40% - 79%)**: Anomaly detected; high bounce rate or conflicting reports.
     - **🔴 Unavailable (0% - 39%)**: Verified failure; zero dwell time and consecutive bounces.
3. **Autonomous $k$-NN Reroute Engine**:
   - Automatically detects service failure and calculates the nearest active, verified peer of the same category.
   - Renders a real-time marching-ants route vector and provides one-tap turn-by-turn navigation via Google Maps.
4. **4-Hour Tag Auto-Expiration (No Bloated DBs)**:
   - Holds short-lived, transient shortage tags (e.g., *Cash Out*, *Pump Dry*, *Machine Broken*) that auto-expire and restore baseline scores naturally.
5. **High-Precision Geolocation & Reverse Geocoding**:
   - Hardware GPS tracking (`enableHighAccuracy: true`) with multi-tier IP Geolocation fallback.
   - OpenStreetMap Nominatim reverse geocoding to resolve street names, landmarks, and city corridors.
   - Interactive draggable pin and location search to place the usability radar anywhere.

---

## 🏗️ Architecture

```
                                  [ User Device / Browser ]
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      ▼                                               ▼
          [ High-Accuracy Geolocation ]                [ Reverse Geocoding Engine ]
          - watchPosition (GPS)                        - OpenStreetMap Nominatim
          - ±Accuracy (meters)                         - BigDataCloud Fallback
          - Lat/Lon coordinates                       - Formatted Street Address
                      │                                               │
                      └───────────────────────┬───────────────────────┘
                                              ▼
                             [ LastMile Guardian UI ]
                             - Aerospace Radar Telemetry Boot Screen
                             - Top Command Island with Live Address Chip
                             - Leaflet Dark Matter / Satellite Map
                             - Slide-Up Bottom Sheet Directory & KPI Drawer
                             - Pitch Demo Deck Controller
                                              │
                                              ▼ (REST API / JSON)
                ┌─────────────────────────────────────────────────────────────┐
                │          Backend Microservice (Java 21 & Python 3)          │
                ├─────────────────────────────────────────────────────────────┤
                │ 1. Bayesian Fault Inference Engine                          │
                │    - Baseline score: 92%                                    │
                │    - Bounce penalty (<40s dwell): -24%                      │
                │    - Explicit 1-tap failure penalty: -36%                   │
                │    - Verified success reward (>60s dwell): +14%             │
                │    - Status: Operational (≥80%), Uncertain (40-79%),        │
                │              Unavailable (<40%)                             │
                ├─────────────────────────────────────────────────────────────┤
                │ 2. 4-Hour Time-Based Tag Auto-Expiration Worker             │
                │    - Periodic scheduler decays transient fault tags         │
                │    - Restores operational health back to baseline           │
                ├─────────────────────────────────────────────────────────────┤
                │ 3. Autonomous $k$-NN Reroute Engine                         │
                │    - Detects service failure & computes nearest active peer │
                │    - Emits marching-ants vector & Google Maps turn-by-turn  │
                └─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
- **Java 21 LTS** (or Python 3.9+)
- Any modern web browser

### Running with Java (Default)
```bash
# Compile and run Java 21 backend microservice
javac LastMileServer.java
java LastMileServer
```
Open **`http://localhost:8080/`** in your browser.

### Running with Python
```bash
# Run Python 3 backend
python server.py
```
Open **`http://localhost:8080/`** in your browser.

---

## 🔌 REST API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health check and active node count |
| `GET` | `/api/facilities?lat=...&lon=...&area=...` | Returns 10 civic utility nodes seeded around coordinates |
| `POST` | `/api/telemetry/visit` | Ingests passive dwell telemetry (`dwellSeconds < 40` triggers bounce) |
| `POST` | `/api/telemetry/report` | Records 1-tap exit verification responses |
| `GET` | `/api/reroute?facilityId=...` | Computes nearest operational peer via Haversine formula |
| `POST` | `/api/simulation/abort` | Simulates ATM cash runout, score degradation, and reroute trigger |
| `POST` | `/api/simulation/success` | Simulates cash replenishment, restoring health score to 99% |
| `POST` | `/api/simulation/reset` | Resets all regional nodes to operational baseline |
| `GET` | `/api/logs` | Real-time geofence telemetry stream logs |

---

## 🎮 Live Demonstration & Pitch Controls

Use the **PITCH DEMO DECK** in the bottom-right corner of the web interface:
1. **⚡ Force ATM Abort**: Simulates an ATM running dry with 3 rapid bounces ($<40\text{s}$). The score collapses to $8\%$, marker turns red, and the autonomous reroute banner instantly guides the user to the nearest working alternative.
2. **✓ Success Dwell**: Simulates cash replenishment and successful transactions, returning the node to Green ($99\%$).
3. **↺ Reset**: Resets all regional nodes to baseline health.
4. **📍 Precision Location**: Click the `✏️ Edit` button on the address banner to search any street/city, click anywhere on the map, or drag the blue beacon to pinpoint your exact doorstep.

---

## 📄 License
Open source for civic impact and hackathon demonstration under MIT License.
