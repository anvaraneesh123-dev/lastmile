import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/**
 * LastMile Guardian — Executive Civic Usability Backend
 * Project B26122: Real-Time Usability & Fault Inference for Essential Public Services
 *
 * Implements:
 * 1. Mathematical Bayesian-style Fault Inference State Scoring
 * 2. Passive Geofence Dwell/Bounce Detection (<40s dwell)
 * 3. 4-Hour Automatic Time-Based Expiration & Score Recovery Worker
 * 4. Autonomous k-NN Nearest Operational Peer Rerouting
 * 5. Full REST API with CORS support + Static Frontend Serving
 */
public class LastMileServer {

    private static final int PORT = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    private static final Map<String, FacilityNode> facilities = new ConcurrentHashMap<>();
    private static final List<String> telemetryLogs = new CopyOnWriteArrayList<>();
    private static double userCenterLat = 8.9868; // Default corridor
    private static double userCenterLon = 76.7127;
    private static String currentAreaName = "Karuvelil Corridor";

    public static void main(String[] args) throws IOException {
        seedInitialFacilities(userCenterLat, userCenterLon, currentAreaName);

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        // API Endpoints
        server.createContext("/api/health", new HealthHandler());
        server.createContext("/api/facilities", new FacilitiesHandler());
        server.createContext("/api/telemetry/visit", new VisitTelemetryHandler());
        server.createContext("/api/telemetry/report", new ExitReportHandler());
        server.createContext("/api/reroute", new RerouteHandler());
        server.createContext("/api/simulation/abort", new SimAbortHandler());
        server.createContext("/api/simulation/success", new SimSuccessHandler());
        server.createContext("/api/simulation/reset", new SimResetHandler());
        server.createContext("/api/logs", new LogsHandler());

        // Static Asset Serving
        server.createContext("/", new StaticFileHandler());

        // Background 4-hour tag auto-decay worker (simulated decay cycle)
        ScheduledExecutorService decayWorker = Executors.newSingleThreadScheduledExecutor();
        decayWorker.scheduleAtFixedRate(LastMileServer::runAutoDecayCycle, 5, 5, TimeUnit.SECONDS);

        server.start();
        System.out.println("==================================================================");
        System.out.println("🚀 LASTMILE GUARDIAN CIVIC USABILITY BACKEND RUNNING");
        System.out.println("   Port: " + PORT);
        System.out.println("   API Base: http://localhost:" + PORT + "/api/facilities");
        System.out.println("   Dashboard: http://localhost:" + PORT + "/");
        System.out.println("   Java Version: " + System.getProperty("java.version"));
        System.out.println("   4-Hour Tag Auto-Expiration Worker: ACTIVE");
        System.out.println("==================================================================");
    }

    // =========================================================================
    // DOMAIN MODEL & STATE SCORING ALGORITHM
    // =========================================================================
    public static class FacilityNode {
        public String id;
        public String name;
        public String category;
        public double lat;
        public double lon;
        public String corridor;
        public String dwell;
        public String queue;
        public int baseScore = 92;
        public int healthScore = 92;
        public String status = "Operational";
        public String statusClass = "green";
        public String statusText = "Normal visitor transaction durations confirmed.";
        public int recentBounces = 0;
        public int explicitFailures = 0;
        public int verifiedSuccesses = 1;
        public List<FaultTag> activeTags = new CopyOnWriteArrayList<>();

        public void recalculateHealth() {
            int score = baseScore;
            score -= recentBounces * 24;
            score -= explicitFailures * 36;
            score += verifiedSuccesses * 14;

            this.healthScore = Math.max(8, Math.min(99, score));

            if (this.healthScore >= 80) {
                this.status = "Operational";
                this.statusClass = "green";
                this.statusText = "Verified active with regular visitor dwell times.";
            } else if (this.healthScore >= 40) {
                this.status = "Uncertain";
                this.statusClass = "yellow";
                this.statusText = "Uncertain operational health: multiple rapid exits detected.";
            } else {
                this.status = "Unavailable";
                this.statusClass = "red";
                this.statusText = "Service failure inferred: zero completed dwells & rapid bounces.";
            }
        }

        public String toJson() {
            StringBuilder sb = new StringBuilder();
            sb.append("{");
            sb.append("\"id\":\"").append(id).append("\",");
            sb.append("\"name\":\"").append(escapeJson(name)).append("\",");
            sb.append("\"category\":\"").append(category).append("\",");
            sb.append("\"lat\":").append(lat).append(",");
            sb.append("\"lon\":").append(lon).append(",");
            sb.append("\"corridor\":\"").append(escapeJson(corridor)).append("\",");
            sb.append("\"dwell\":\"").append(escapeJson(dwell)).append("\",");
            sb.append("\"queue\":\"").append(escapeJson(queue)).append("\",");
            sb.append("\"healthScore\":").append(healthScore).append(",");
            sb.append("\"status\":\"").append(status).append("\",");
            sb.append("\"statusClass\":\"").append(statusClass).append("\",");
            sb.append("\"statusText\":\"").append(escapeJson(statusText)).append("\",");
            sb.append("\"recentBounces\":").append(recentBounces).append(",");
            sb.append("\"explicitFailures\":").append(explicitFailures).append(",");
            sb.append("\"verifiedSuccesses\":").append(verifiedSuccesses).append(",");
            sb.append("\"activeTags\":[");
            for (int i = 0; i < activeTags.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(activeTags.get(i).tagName)).append("\"");
            }
            sb.append("]}");
            return sb.toString();
        }
    }

    public static class FaultTag {
        public String tagName;
        public Instant timestamp;

        public FaultTag(String tagName) {
            this.tagName = tagName;
            this.timestamp = Instant.now();
        }
    }

    // =========================================================================
    // TIME DECAY WORKER (4-Hour Auto-Expiration)
    // =========================================================================
    private static void runAutoDecayCycle() {
        boolean changed = false;
        Instant now = Instant.now();
        // In real system: 4 hours (14400s). In demo/prototype runtime: tag decays after 60s of inactivity
        long decayWindowSeconds = 60;

        for (FacilityNode node : facilities.values()) {
            Iterator<FaultTag> it = node.activeTags.iterator();
            while (it.hasNext()) {
                FaultTag tag = it.next();
                if (now.getEpochSecond() - tag.timestamp.getEpochSecond() > decayWindowSeconds) {
                    node.activeTags.remove(tag);
                    if (node.recentBounces > 0) node.recentBounces--;
                    if (node.explicitFailures > 0) node.explicitFailures--;
                    node.recalculateHealth();
                    changed = true;
                    logTelemetry("Auto-decay: Tag [" + tag.tagName + "] expired on " + node.name + ". Health restored to " + node.healthScore + "%.");
                }
            }
        }
    }

    // =========================================================================
    // SEEDING FACILITIES AROUND USER
    // =========================================================================
    private static void seedInitialFacilities(double centerLat, double centerLon, String areaName) {
        facilities.clear();
        boolean isKerala = Math.abs(centerLat - 8.98) < 0.2;

        String[][] templates = isKerala ? new String[][]{
                {"node-1", "Federal Bank ATM", "ATM", "0.0032", "0.0041", "2.1 min", "1-2 min", "Karuvelil Jn"},
                {"node-2", "SBI ATM Ezhukone", "ATM", "-0.0055", "-0.0038", "2.4 min", "2-4 min", "Ezhukone Market"},
                {"node-3", "Indian Oil Petrol Bunk", "Fuel", "0.0084", "-0.0062", "4.8 min", "3 min", "Kollam-Tenkasi Hwy"},
                {"node-4", "Bharat Petroleum Pump", "Fuel", "-0.0091", "0.0075", "5.2 min", "1 min", "Chepra Road"},
                {"node-5", "Apollo 24/7 Pharmacy", "Medical", "0.0049", "-0.0022", "3.5 min", "0 min", "Karuvelil Main"},
                {"node-6", "Neethi Medical Store", "Medical", "-0.0068", "0.0039", "4.0 min", "2 min", "Ezhukone Hospital Rd"},
                {"node-7", "KSEB EV Fast Charger 60kW", "EV", "0.0071", "0.0088", "28 min", "CCS2 Ready", "Substation Gate"},
                {"node-8", "Zeon EV Charging Hub", "EV", "-0.0112", "-0.0072", "35 min", "Dual Gun Ready", "Highway Bypass"},
                {"node-9", "Taluk Emergency Health Clinic", "Clinic", "0.0118", "0.0031", "14 min", "Triage Open", "Govt Hospital Rd"},
                {"node-10", "HDFC Bank ATM & Cash Deposit", "ATM", "-0.0021", "0.0095", "1.9 min", "0 min", "East Junction"}
        } : new String[][]{
                {"node-1", "HDFC Bank ATM", "ATM", "0.0028", "0.0035", "2.0 min", "0-1 min", areaName},
                {"node-2", "State Bank of India ATM", "ATM", "-0.0042", "-0.0031", "2.3 min", "2-3 min", areaName},
                {"node-3", "Indian Oil Fuel & CNG", "Fuel", "0.0072", "-0.0051", "4.5 min", "2 min", areaName + " Main Rd"},
                {"node-4", "Bharat Petroleum Fuel Station", "Fuel", "-0.0081", "0.0064", "5.0 min", "1 min", areaName + " Ring Rd"},
                {"node-5", "Apollo 24/7 Emergency Pharmacy", "Medical", "0.0039", "-0.0018", "3.2 min", "0 min", areaName + " Central"},
                {"node-6", "MedPlus 24-Hour Chemist", "Medical", "-0.0058", "0.0032", "3.8 min", "1 min", areaName + " Cross"},
                {"node-7", "Tata Power EV Fast Charger 60kW", "EV", "0.0064", "0.0075", "25 min", "CCS2 Online", areaName + " Commercial"},
                {"node-8", "Jio-bp Pulse EV Hub", "EV", "-0.0095", "-0.0065", "30 min", "Available", areaName + " Bypass"},
                {"node-9", "City Urgent Care Clinic", "Clinic", "0.0098", "0.0025", "12 min", "Triage Ready", areaName + " Civic Centre"},
                {"node-10", "ICICI Bank 24hr ATM", "ATM", "-0.0019", "0.0082", "1.8 min", "0 min", areaName + " Market Rd"}
        };

        for (String[] t : templates) {
            FacilityNode node = new FacilityNode();
            node.id = t[0];
            node.name = t[1];
            node.category = t[2];
            node.lat = centerLat + Double.parseDouble(t[3]);
            node.lon = centerLon + Double.parseDouble(t[4]);
            node.dwell = t[5];
            node.queue = t[6];
            node.corridor = t[7];
            node.recalculateHealth();
            facilities.put(node.id, node);
        }
        logTelemetry("Seeded 10 civic utility nodes around " + areaName + " [" + centerLat + ", " + centerLon + "]");
    }

    private static double haversine(double lat1, double lon1, double lat2, double lon2) {
        double R = 6371; // Earth radius in km
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static FacilityNode findNearestPeer(FacilityNode source, double uLat, double uLon) {
        FacilityNode best = null;
        double minDst = Double.MAX_VALUE;
        for (FacilityNode f : facilities.values()) {
            if (!f.id.equals(source.id) && f.category.equals(source.category) && "Operational".equals(f.status)) {
                double d = haversine(uLat, uLon, f.lat, f.lon);
                if (d < minDst) {
                    minDst = d;
                    best = f;
                }
            }
        }
        return best;
    }

    private static void logTelemetry(String msg) {
        String entry = "[" + Instant.now().toString().substring(11, 19) + "] " + msg;
        telemetryLogs.add(0, entry);
        if (telemetryLogs.size() > 50) telemetryLogs.remove(telemetryLogs.size() - 1);
        System.out.println(entry);
    }

    // =========================================================================
    // HTTP HANDLERS
    // =========================================================================

    private static void setCorsHeaders(HttpExchange exchange) {
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
    }

    private static void sendJsonResponse(HttpExchange exchange, int statusCode, String json) throws IOException {
        setCorsHeaders(exchange);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(statusCode, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            String resp = "{\"status\":\"healthy\",\"server\":\"LastMile Guardian Java 21 Engine\",\"activeNodes\":" + facilities.size() + "}";
            sendJsonResponse(exchange, 200, resp);
        }
    }

    static class FacilitiesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            // Check query params: lat, lon, area
            String query = exchange.getRequestURI().getQuery();
            if (query != null) {
                Map<String, String> params = parseQuery(query);
                if (params.containsKey("lat") && params.containsKey("lon")) {
                    double lat = Double.parseDouble(params.get("lat"));
                    double lon = Double.parseDouble(params.get("lon"));
                    String area = params.getOrDefault("area", "Local");
                    if (Math.abs(lat - userCenterLat) > 0.05 || Math.abs(lon - userCenterLon) > 0.05) {
                        userCenterLat = lat;
                        userCenterLon = lon;
                        currentAreaName = area;
                        seedInitialFacilities(lat, lon, area);
                    }
                }
            }

            StringBuilder sb = new StringBuilder("[");
            int i = 0;
            for (FacilityNode node : facilities.values()) {
                if (i > 0) sb.append(",");
                sb.append(node.toJson());
                i++;
            }
            sb.append("]");
            sendJsonResponse(exchange, 200, sb.toString());
        }
    }

    static class VisitTelemetryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> json = parseSimpleJson(body);

            String facId = json.get("facilityId");
            int dwellSec = Integer.parseInt(json.getOrDefault("dwellSeconds", "30"));

            FacilityNode fac = facilities.get(facId);
            if (fac == null) {
                sendJsonResponse(exchange, 404, "{\"error\":\"Facility not found\"}");
                return;
            }

            if (dwellSec < 40) {
                fac.recentBounces++;
                logTelemetry("Passive Bounce Detected (<40s dwell) at " + fac.name + " (" + dwellSec + "s)");
            } else {
                fac.verifiedSuccesses++;
                logTelemetry("Normal transaction dwell (" + dwellSec + "s) verified at " + fac.name);
            }
            fac.recalculateHealth();

            FacilityNode peer = null;
            if ("Unavailable".equals(fac.status)) {
                peer = findNearestPeer(fac, userCenterLat, userCenterLon);
            }

            StringBuilder sb = new StringBuilder();
            sb.append("{\"facility\":").append(fac.toJson());
            if (peer != null) {
                sb.append(",\"reroutePeer\":").append(peer.toJson());
            }
            sb.append("}");
            sendJsonResponse(exchange, 200, sb.toString());
        }
    }

    static class ExitReportHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> json = parseSimpleJson(body);

            String facId = json.get("facilityId");
            boolean success = Boolean.parseBoolean(json.getOrDefault("success", "true"));
            String tag = json.getOrDefault("faultTag", "");

            FacilityNode fac = facilities.get(facId);
            if (fac == null) {
                sendJsonResponse(exchange, 404, "{\"error\":\"Facility not found\"}");
                return;
            }

            if (success) {
                fac.verifiedSuccesses++;
                logTelemetry("1-Tap Success confirmed for " + fac.name);
            } else {
                fac.explicitFailures++;
                fac.recentBounces++;
                if (!tag.isEmpty()) {
                    fac.activeTags.add(new FaultTag(tag));
                }
                logTelemetry("1-Tap Failure reported for " + fac.name + ": [" + tag + "]");
            }
            fac.recalculateHealth();

            FacilityNode peer = null;
            if ("Unavailable".equals(fac.status)) {
                peer = findNearestPeer(fac, userCenterLat, userCenterLon);
            }

            StringBuilder sb = new StringBuilder();
            sb.append("{\"facility\":").append(fac.toJson());
            if (peer != null) {
                sb.append(",\"reroutePeer\":").append(peer.toJson());
            }
            sb.append("}");
            sendJsonResponse(exchange, 200, sb.toString());
        }
    }

    static class RerouteHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            String query = exchange.getRequestURI().getQuery();
            Map<String, String> params = parseQuery(query);
            String facId = params.get("facilityId");
            FacilityNode fac = facilities.get(facId);

            if (fac == null) {
                sendJsonResponse(exchange, 404, "{\"error\":\"Node not found\"}");
                return;
            }

            FacilityNode peer = findNearestPeer(fac, userCenterLat, userCenterLon);
            if (peer == null) {
                sendJsonResponse(exchange, 200, "{\"found\":false}");
            } else {
                double dist = haversine(userCenterLat, userCenterLon, peer.lat, peer.lon);
                String resp = "{\"found\":true,\"from\":" + fac.toJson() + ",\"to\":" + peer.toJson() + ",\"distKm\":" + Math.round(dist * 10.0) / 10.0 + "}";
                sendJsonResponse(exchange, 200, resp);
            }
        }
    }

    static class SimAbortHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            FacilityNode atm = null;
            for (FacilityNode f : facilities.values()) {
                if ("ATM".equals(f.category)) {
                    atm = f;
                    break;
                }
            }

            if (atm != null) {
                atm.recentBounces = 3;
                atm.explicitFailures = 1;
                atm.activeTags.clear();
                atm.activeTags.add(new FaultTag("Cash Depleted"));
                atm.activeTags.add(new FaultTag("Machine Offline"));
                atm.dwell = "32 sec";
                atm.queue = "Empty (No Cash)";
                atm.recalculateHealth();

                FacilityNode peer = findNearestPeer(atm, userCenterLat, userCenterLon);
                logTelemetry("PITCH DEMO: Force ATM Abort triggered at " + atm.name + " (Score " + atm.healthScore + "%). Diverting to " + (peer != null ? peer.name : "None"));

                StringBuilder sb = new StringBuilder();
                sb.append("{\"failedNode\":").append(atm.toJson());
                if (peer != null) {
                    sb.append(",\"peerNode\":").append(peer.toJson());
                    double dist = haversine(userCenterLat, userCenterLon, peer.lat, peer.lon);
                    sb.append(",\"distKm\":").append(Math.round(dist * 10.0) / 10.0);
                }
                sb.append("}");
                sendJsonResponse(exchange, 200, sb.toString());
            } else {
                sendJsonResponse(exchange, 404, "{\"error\":\"No ATM found\"}");
            }
        }
    }

    static class SimSuccessHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            FacilityNode atm = null;
            for (FacilityNode f : facilities.values()) {
                if ("ATM".equals(f.category)) {
                    atm = f;
                    break;
                }
            }

            if (atm != null) {
                atm.recentBounces = 0;
                atm.explicitFailures = 0;
                atm.verifiedSuccesses = 3;
                atm.activeTags.clear();
                atm.dwell = "2.1 min";
                atm.queue = "1 min";
                atm.recalculateHealth();
                logTelemetry("PITCH DEMO: Success dwell confirmed for " + atm.name + ". Health restored.");
                sendJsonResponse(exchange, 200, atm.toJson());
            } else {
                sendJsonResponse(exchange, 404, "{\"error\":\"No ATM found\"}");
            }
        }
    }

    static class SimResetHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            for (FacilityNode f : facilities.values()) {
                f.recentBounces = 0;
                f.explicitFailures = 0;
                f.verifiedSuccesses = 1;
                f.activeTags.clear();
                f.recalculateHealth();
            }
            logTelemetry("PITCH DEMO: All facilities reset to baseline operational status.");
            sendJsonResponse(exchange, 200, "{\"success\":true,\"message\":\"All nodes reset to healthy.\"}");
        }
    }

    static class LogsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                setCorsHeaders(exchange);
                exchange.sendResponseHeaders(204, -1);
                return;
            }

            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < telemetryLogs.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(escapeJson(telemetryLogs.get(i))).append("\"");
            }
            sb.append("]");
            sendJsonResponse(exchange, 200, sb.toString());
        }
    }

    static class StaticFileHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/") || path.isEmpty()) {
                path = "/index.html";
            }

            Path filePath = Paths.get("." + path).normalize();
            if (!Files.exists(filePath) || Files.isDirectory(filePath)) {
                String notFound = "404 Not Found";
                exchange.sendResponseHeaders(404, notFound.length());
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(notFound.getBytes());
                }
                return;
            }

            String contentType = "text/plain";
            if (path.endsWith(".html")) contentType = "text/html; charset=UTF-8";
            else if (path.endsWith(".js")) contentType = "application/javascript; charset=UTF-8";
            else if (path.endsWith(".css")) contentType = "text/css; charset=UTF-8";
            else if (path.endsWith(".json")) contentType = "application/json; charset=UTF-8";
            else if (path.endsWith(".svg")) contentType = "image/svg+xml";

            exchange.getResponseHeaders().set("Content-Type", contentType);
            exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
            byte[] fileBytes = Files.readAllBytes(filePath);
            exchange.sendResponseHeaders(200, fileBytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(fileBytes);
            }
        }
    }

    // =========================================================================
    // UTILITIES
    // =========================================================================
    private static Map<String, String> parseQuery(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null) return map;
        for (String param : query.split("&")) {
            String[] pair = param.split("=");
            if (pair.length > 1) {
                map.put(URLDecoder.decode(pair[0], StandardCharsets.UTF_8),
                        URLDecoder.decode(pair[1], StandardCharsets.UTF_8));
            }
        }
        return map;
    }

    private static Map<String, String> parseSimpleJson(String json) {
        Map<String, String> map = new HashMap<>();
        if (json == null) return map;
        String trimmed = json.trim().replaceAll("[{}\"]", "");
        for (String pair : trimmed.split(",")) {
            String[] kv = pair.split(":");
            if (kv.length >= 2) {
                map.put(kv[0].trim(), kv[1].trim());
            }
        }
        return map;
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\b", "\\b")
                .replace("\f", "\\f")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
