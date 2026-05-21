// =============================================================================
// DWS Calendar Mode – Backend Proxy Server
//
// Authentication strategy (in priority order):
//   1. Cloud Run / GCE  → Workload Identity (automatic, no key file needed)
//   2. Local dev        → GOOGLE_APPLICATION_CREDENTIALS env var pointing to
//                         a service account JSON key
//   3. Local dev        → gcloud ADC  (`gcloud auth application-default login`)
//
// Environment variables (set in Cloud Run or .env for local dev):
//   GCP_PROJECT_ID        required – your GCP project ID
//   PORT                  optional – defaults to 8080
//   ALLOWED_ORIGIN        optional – CORS origin, defaults to * in production
// =============================================================================

require("dotenv").config();

const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const { GoogleAuth } = require("google-auth-library");

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Validate required config ─────────────────────────────────────────────────
const PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!PROJECT_ID) {
  console.error("❌  GCP_PROJECT_ID is not set.");
  process.exit(1);
}

// ── Google Auth (uses ADC — works on Cloud Run automatically) ────────────────
const auth = new GoogleAuth({
  // No keyFile needed on Cloud Run; GoogleAuth reads the metadata server.
  // Locally it reads GOOGLE_APPLICATION_CREDENTIALS or gcloud ADC.
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

let authClient = null;
async function getAccessToken() {
  if (!authClient) authClient = await auth.getClient();
  const { token } = await authClient.getAccessToken();
  return token;
}

// ── Middleware ────────────────────────────────────────────────────────────────
// In production (Cloud Run) you control access via IAP / Cloud Run IAM,
// so CORS can be permissive. Tighten ALLOWED_ORIGIN for extra safety.
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── API Routes ────────────────────────────────────────────────────────────────

// Accelerator catalog.
//  kind: "gpu" → request uses specificSkuResources.machineType (8-GPU shapes only)
//  kind: "tpu" → request uses aggregateResources.vmFamily
//  needsWorkloadType: true → TPU v5e requires BATCH or SERVING
//  note: shown in the UI; "⚠ unverified" = may not be supported by calendar mode
const ACCELERATORS = [
  // ── GPUs (calendar mode supports the 8-GPU shapes) ──
  { id: "a4-highgpu-8g",  kind: "gpu", label: "B200 180GB (A4)" },
  { id: "a3-ultragpu-8g", kind: "gpu", label: "H200 (A3 Ultra)" },
  { id: "a3-megagpu-8g",  kind: "gpu", label: "H100 Mega (A3 Mega)" },
  { id: "a3-highgpu-8g",  kind: "gpu", label: "H100 80GB (A3 High)" },
  { id: "a2-ultragpu-8g", kind: "gpu", label: "A100 80GB (A2 Ultra)" },
  { id: "a2-highgpu-8g",  kind: "gpu", label: "A100 40GB (A2 High)" },
  { id: "g4-standard-384",kind: "gpu", label: "RTX PRO 6000 ⚠", note: "Not supported by calendar mode yet" },
  { id: "g2-standard-96", kind: "gpu", label: "L4 ⚠", note: "Not supported by calendar mode yet" },
  // ── TPUs (different request structure) ──
  { id: "VM_FAMILY_CLOUD_TPU_LITE_POD_SLICE_CT5LP", kind: "tpu", label: "TPU v5e", needsWorkloadType: true },
  { id: "VM_FAMILY_CLOUD_TPU_POD_SLICE_CT5P",       kind: "tpu", label: "TPU v5p" },
  { id: "VM_FAMILY_CLOUD_TPU_LITE_POD_SLICE_CT6E",  kind: "tpu", label: "TPU v6e" },
  { id: "VM_FAMILY_CLOUD_TPU_POD_SLICE_TPU7X",       kind: "tpu", label: "TPU Ironwood", note: "Minimum is 4 Chips" },
];

// GET /api/config  – returns non-sensitive metadata for the UI
app.get("/api/config", (_req, res) => {
  res.json({ projectId: PROJECT_ID, accelerators: ACCELERATORS });
});

// GET /api/regions  – fetches all GCP regions for the project
app.get("/api/regions", async (_req, res) => {
  try {
    const token  = await getAccessToken();
    const gcpRes = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${PROJECT_ID}/regions?fields=items/name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await gcpRes.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    res.json({ regions: (data.items || []).map(i => i.name) });
  } catch (err) {
    console.error("Regions error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/check  – checks a single region for DWS calendar mode capacity
// Body: { region, acceleratorId, kind, nodes, startTime, endTime, duration, workloadType? }
//   kind = "gpu" → specificSkuResources.machineType  (nodes = instance count)
//   kind = "tpu" → aggregateResources.vmFamily       (nodes = TPU chip count)
app.post("/api/check", async (req, res) => {
  // Accept both acceleratorId (new frontend) and machineType (old frontend) for compatibility
  const { region, nodes, startTime, endTime, duration, workloadType } = req.body;
  const acceleratorId = req.body.acceleratorId || req.body.machineType;
  // Infer kind from acceleratorId if not supplied: TPU vmFamily strings start with VM_FAMILY_CLOUD_TPU
  const kind = req.body.kind || (acceleratorId?.startsWith("VM_FAMILY") ? "tpu" : "gpu");
  if (!region || !acceleratorId || !kind || !nodes || !startTime || !endTime || !duration) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  // Build the targetResources block based on accelerator kind
  let targetResources;
  if (kind === "tpu") {
    // TPUs are requested by chip count via aggregateResources.vmFamily.
    // TPU v5e additionally requires a workloadType (BATCH | SERVING).
    const aggregate = {
      vmFamily:       acceleratorId,
      acceleratorCount: String(nodes),
    };
    if (workloadType) aggregate.workloadType = workloadType;
    targetResources = { aggregateResources: aggregate };
  } else {
    // GPUs (and any specific-SKU VM) use machineType + instanceCount
    targetResources = {
      specificSkuResources: {
        machineType:   acceleratorId,
        instanceCount: String(nodes),
      },
    };
  }

  try {
    const token = await getAccessToken();

    const gcpRes = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${PROJECT_ID}/regions/${region}/advice/calendarMode`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          futureResourcesSpecs: {
            "capacity-request": {
              timeRangeSpec: {
                startTimeNotEarlierThan: startTime,
                startTimeNotLaterThan:   endTime,
                minDuration: duration,
                maxDuration: duration,
              },
              targetResources,
            },
          },
        }),
      }
    );

    const data = await gcpRes.json();

    if (data.error) {
      return res.json({ region, status: "error", message: data.error.message });
    }

    // Extract all spec objects from recommendationsPerSpec.
    // GPU response: recommendationsPerSpec is an array  -> [{startTime, location, ...}]
    // TPU response: recommendationsPerSpec is an object -> {spec: {startTime, location, otherLocations, ...}}
    const specs = (data.recommendations || []).flatMap(rec => {
      const rps = rec.recommendationsPerSpec;
      if (!rps) return [];
      return Array.isArray(rps) ? rps : Object.values(rps);
    });

    if (specs.length === 0) {
      return res.json({ region, status: "empty" });
    }

    // Earliest start time across all specs
    const earliest = specs
      .map(s => s.startTime)
      .filter(Boolean)
      .sort()[0] || null;

    // No startTime in any spec = API responded but found no capacity in this window
    if (!earliest) {
      return res.json({ region, status: "empty" });
    }

    // Collect zones with confirmed capacity:
    //   spec.location       -> primary recommended zone
    //   spec.otherLocations -> map of zone -> {status, details}; include RECOMMENDED ones
    const zoneSet = new Set();
    for (const spec of specs) {
      if (spec.location) {
        zoneSet.add(spec.location.replace("zones/", ""));
      }
      if (spec.otherLocations) {
        for (const [zonePath, info] of Object.entries(spec.otherLocations)) {
          if (info.status === "RECOMMENDED") {
            zoneSet.add(zonePath.replace("zones/", ""));
          }
        }
      }
    }
    const zones = [...zoneSet].sort();

    res.json({ region, status: "available", earliest, zones });
  } catch (err) {
    console.error(`Check error [${region}]:`, err.message);
    res.status(500).json({ region, status: "error", message: err.message });
  }
});

// ── Serve React build (static files) ─────────────────────────────────────────
// All non-API routes return the React app so client-side routing works.
const PUBLIC = path.join(__dirname, "public");
app.use(express.static(PUBLIC));
app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log(`  DWS Calendar Proxy  →  http://localhost:${PORT}`);
  console.log(`  GCP Project         →  ${PROJECT_ID}`);
  console.log(`  Auth                →  Application Default Credentials`);
  console.log("=".repeat(60));
});
