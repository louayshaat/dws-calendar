# DWS Calendar Mode Search — Cloud Run Deployment Guide

## Architecture

```
Browser → Cloud Run Service
              ├── GET  /            → React app (static build)
              ├── GET  /api/config  → project ID + machine types
              ├── GET  /api/regions → GCP region list
              └── POST /api/check   → calendarMode API call
                       ↕
              Google Compute Engine API
              (authenticated via Workload Identity — no key file)
```

A single Cloud Run container serves both the React frontend and the Express backend.
Authentication to GCP is handled automatically via the service account attached to
the Cloud Run service. **No credentials are ever exposed to users.**

---

## Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Docker installed (only needed if building locally; Cloud Build is recommended)
- A GCP project with billing enabled
- The following APIs enabled in your project:
  - Cloud Run API
  - Artifact Registry API
  - Compute Engine API

Enable them all at once:
```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com
```

---

## Step 1 — Set your project and region

```bash
export PROJECT_ID="your-project-id"          # ← change this
export REGION="us-central1"                   # Cloud Run region (not GPU search region)
export SERVICE_NAME="dws-calendar"
export REPO_NAME="dws-calendar-repo"

gcloud config set project $PROJECT_ID
```

---

## Step 2 — Create an Artifact Registry repository

This is where your Docker image will be stored.

```bash
gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION \
  --description="DWS Calendar Mode Search"

# Authorise Docker to push to Artifact Registry
gcloud auth configure-docker ${REGION}-docker.pkg.dev
```

---

## Step 3 — Create a dedicated service account

Never run Cloud Run workloads as the default compute service account.
Create a least-privilege service account that can only call the Compute Engine API.

```bash
export SA_NAME="dws-calendar-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Create the service account
gcloud iam service-accounts create $SA_NAME \
  --display-name="DWS Calendar Mode Search"

# Grant it permission to read Compute Engine resources
# (needed for regions list + advice/calendarMode)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/compute.admin"
```

> **Why `compute.viewer`?**  
> The `advice/calendarMode` endpoint requires `compute.regions.get` and
> `compute.futureReservations.list` permissions. `roles/compute.viewer` covers
> both with read-only access — no write permissions granted.

---

## Step 4 — Build and push the Docker image

**Option A — Cloud Build (recommended, no local Docker needed)**

```bash
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"

gcloud builds submit \
  --tag $IMAGE \
  --project $PROJECT_ID
```

Cloud Build reads your `Dockerfile` from the current directory, builds the image
(including the React frontend), and pushes it to Artifact Registry automatically.

**Option B — Local Docker build**

```bash
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"

docker build -t $IMAGE .
docker push $IMAGE
```

---

## Step 5 — Deploy to Cloud Run

```bash
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE \
  --region $REGION \
  --platform managed \
  --service-account $SA_EMAIL \
  --set-env-vars GCP_PROJECT_ID=$PROJECT_ID \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 300 \
  --no-allow-unauthenticated
```

Key flags explained:

| Flag | Why |
|------|-----|
| `--service-account` | Attaches your least-privilege SA; Cloud Run uses it for Workload Identity automatically |
| `--set-env-vars GCP_PROJECT_ID` | Injects the project ID into the container; `server.js` reads it from `process.env` |
| `--timeout 300` | A full scan of all 40+ regions can take 2–3 minutes; default 60s would time out |
| `--no-allow-unauthenticated` | Keeps the URL private; see Step 6 for granting access |
| `--min-instances 0` | Scale to zero when idle (cost-effective) |

---

## Step 6 — Grant access to your users

Because you deployed with `--no-allow-unauthenticated`, only identities you
explicitly grant can access the URL.

**Option A — Grant access to specific Google accounts**

```bash
# A single user
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region $REGION \
  --member="user:alice@example.com" \
  --role="roles/run.invoker"

# Everyone in a Google Workspace domain
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region $REGION \
  --member="domain:example.com" \
  --role="roles/run.invoker"
```

Users will be prompted to sign in with their Google account when they visit the URL.

**Option B — Google Cloud IAP (Identity-Aware Proxy) — recommended for teams**

IAP sits in front of Cloud Run and handles SSO, so you can control access from
the Google Cloud Console without touching IAM policies in code.

1. Go to **Security → Identity-Aware Proxy** in the Cloud Console
2. Enable IAP on your Cloud Run service
3. Add users/groups under **IAP-secured Web App User**

**Option C — Make it fully public** (only if the URL itself is the access control)

```bash
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region $REGION \
  --member="allUsers" \
  --role="roles/run.invoker"
```

---

## Step 7 — Retrieve the service URL

```bash
gcloud run services describe $SERVICE_NAME \
  --region $REGION \
  --format="value(status.url)"
```

Open that URL in your browser — you'll see the DWS search UI with no auth fields.
The project ID is displayed in the header (read from `/api/config`).

---

## Step 8 — Verify it works end-to-end

```bash
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --region $REGION --format="value(status.url)")

# Get an identity token for yourself to call the private endpoint
TOKEN=$(gcloud auth print-identity-token)

# Test /api/config
curl -s -H "Authorization: Bearer $TOKEN" ${SERVICE_URL}/api/config | jq .

# Test /api/regions (should return 40+ regions)
curl -s -H "Authorization: Bearer $TOKEN" ${SERVICE_URL}/api/regions | jq '.regions | length'
```

---

## Updating the deployment

After changing any source file, rebuild and redeploy with:

```bash
gcloud builds submit --tag $IMAGE --project $PROJECT_ID

gcloud run deploy $SERVICE_NAME \
  --image $IMAGE \
  --region $REGION \
  --platform managed
```

Cloud Run performs a zero-downtime rollout automatically.

---

## Local development

Run the backend and frontend separately with hot-reload:

```bash
# Terminal 1 — backend (needs gcloud ADC or a key file)
gcloud auth application-default login
GCP_PROJECT_ID=your-project-id node server.js

# Terminal 2 — frontend (proxies /api to localhost:3001 via vite.config.js)
cd client
npm install
npm run dev
# Opens http://localhost:5173
```

---

## Environment variables reference

| Variable | Where to set | Description |
|----------|-------------|-------------|
| `GCP_PROJECT_ID` | Cloud Run env var or `.env` | **Required.** Your GCP project ID |
| `PORT` | Set by Cloud Run automatically | Defaults to 8080 |
| `GOOGLE_APPLICATION_CREDENTIALS` | Local `.env` only | Path to service account JSON key (local dev only; not needed on Cloud Run) |
| `ALLOWED_ORIGIN` | Optional | CORS origin restriction; defaults to `*` |

---

## Cost estimate

Cloud Run with `--min-instances 0` scales to zero when not in use.

| Usage | Estimated cost |
|-------|---------------|
| 100 searches/month, ~2 min each | < $0.10/month |
| Always-on (min-instances 1) | ~$15/month (512 MB, 1 CPU) |

The GCP `advice/calendarMode` API calls themselves are free.

---

## Troubleshooting

**"Permission denied" on calendarMode API**  
→ Verify the service account has `roles/compute.viewer`:
```bash
gcloud projects get-iam-policy $PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA_EMAIL}"
```

**Scan times out (> 5 minutes)**  
→ Use the Region Filter to scan a subset (e.g., "US only") or increase `--timeout`:
```bash
gcloud run services update $SERVICE_NAME --region $REGION --timeout 600
```

**Frontend shows "Cannot reach backend"**  
→ The `/api/config` call is failing. Check Cloud Run logs:
```bash
gcloud run services logs read $SERVICE_NAME --region $REGION --limit 50
```

**`GCP_PROJECT_ID is not set` in logs**  
→ The env var wasn't passed at deploy time. Update it:
```bash
gcloud run services update $SERVICE_NAME \
  --region $REGION \
  --set-env-vars GCP_PROJECT_ID=$PROJECT_ID
```
