# Deploy Bonsai to Google Cloud (Cloud Run + Cloud SQL)

This guide walks through deploying Bonsai to Google Cloud Platform using **Cloud Run** for the backend and **Cloud SQL** for PostgreSQL. This creates a **development/staging deployment** suitable for testing, demos, and early-stage projects.

**Estimated cost**: ~$10–15/month at low traffic (Cloud SQL db-f1-micro is the cost floor).

> **Note**: This guide optimizes for cost and simplicity, not production hardness. See [Production Hardening](#production-hardening) at the end for what to change before going live with real traffic.

## Prerequisites

- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A GCP billing account
- Docker installed locally (for building the image)

## 1. Create a GCP Project

```bash
gcloud projects create YOUR_PROJECT_ID --name="Your Project Name"
gcloud billing projects link YOUR_PROJECT_ID --billing-account=YOUR_BILLING_ACCOUNT_ID
gcloud config set project YOUR_PROJECT_ID
```

## 2. Enable Required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

## 3. Set Variables

Pick a region. `us-central1` is the cheapest for both Cloud Run and Cloud SQL.

```bash
export REGION=us-central1
export PROJECT_ID=$(gcloud config get-value project)
export SQL_INSTANCE_NAME=bonsai-postgres
export DB_NAME=bonsai
export DB_USER=bonsai
export DB_PASSWORD=$(openssl rand -base64 24)
```

> **Important**: Save credentials to `.env.local` (already gitignored) so they aren't lost.
>
> If your password contains special characters (`/`, `@`, `#`, etc.), URL-encode them when used in the connection string. For example, `/` becomes `%2F`.

## 4. Create Cloud SQL PostgreSQL Instance

```bash
gcloud sql instances create $SQL_INSTANCE_NAME \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=$REGION \
  --storage-type=HDD \
  --storage-size=10
```

> This creates the cheapest PostgreSQL instance (~$9/month). Uses HDD instead of SSD for cost savings. The instance gets a public IP by default.

This takes ~5 minutes. While it runs, continue with Steps 5 and 6.

Create the database and user:

```bash
gcloud sql databases create $DB_NAME --instance=$SQL_INSTANCE_NAME

gcloud sql users create $DB_USER \
  --instance=$SQL_INSTANCE_NAME \
  --password=$DB_PASSWORD
```

## 5. Store Secrets

```bash
echo -n "$DB_PASSWORD" | gcloud secrets create bonsai-db-password \
  --data-file=- --replication-policy=automatic

JWT_SECRET=$(openssl rand -base64 32)
echo -n "$JWT_SECRET" | gcloud secrets create bonsai-jwt-secret \
  --data-file=- --replication-policy=automatic
```

Grant the Cloud Run service account access to secrets:

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 6. Create Artifact Registry Repository

```bash
gcloud artifacts repositories create bonsai \
  --repository-format=docker \
  --location=$REGION
```

## 7. Build and Push the Docker Image

> **Important**: Cloud Run requires `linux/amd64` images. If you're building on Apple Silicon (M1/M2/M3) or another ARM machine, you **must** specify `--platform=linux/amd64` or the container will fail with `exec format error`.

```bash
# Configure Docker for Artifact Registry
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# Build for amd64 (required for Cloud Run) and push
docker build --platform=linux/amd64 \
  -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest .
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest
```

Alternatively, use Cloud Build to build remotely (always builds amd64):

```bash
gcloud builds submit --tag ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest
```

## 8. Deploy to Cloud Run

Use Cloud Run's **built-in Cloud SQL connector** (`--add-cloudsql-instances`) to connect to the database through Google's internal network. This is free, secure, and doesn't require a VPC connector or authorized networks.

```bash
SQL_CONNECTION_NAME=${PROJECT_ID}:${REGION}:${SQL_INSTANCE_NAME}

gcloud run deploy bonsai \
  --image=${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --port=3000 \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --add-cloudsql-instances=${SQL_CONNECTION_NAME} \
  --set-env-vars="NODE_ENV=production,DB_SSL=false" \
  --set-env-vars="DB_CONNECTION_STRING=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}?host=/cloudsql/${SQL_CONNECTION_NAME}" \
  --set-env-vars="CORS_ORIGIN=*" \
  --set-secrets="JWT_SECRET=bonsai-jwt-secret:latest" \
  --session-affinity
```

> **Notes**:
> - `--add-cloudsql-instances` creates a Unix socket at `/cloudsql/...` that connects to Cloud SQL through Google's internal network. No public IP access or VPC connector needed.
> - `--session-affinity` helps keep WebSocket connections routed to the same instance.
> - Set `CORS_ORIGIN` to your actual domains before going to production (e.g., `https://yourdomain.com|https://app.yourdomain.com`).
> - If `DB_PASSWORD` contains URL-special characters (`/`, `@`, `#`), URL-encode them (e.g., `/` → `%2F`).

## 9. Secure Cloud SQL

With the Cloud SQL connector approach, you can remove all authorized networks — Cloud Run connects internally:

```bash
gcloud sql instances patch $SQL_INSTANCE_NAME --clear-authorized-networks
```

No VPC connector needed. No public IP access needed. The connection goes through Google's internal network for free.

## 10. Verify Deployment

```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe bonsai --region=$REGION --format="value(status.url)")

# Health check
curl ${SERVICE_URL}/health
```

## 11. Initial Setup

Create the first operator account:

```bash
curl -X POST ${SERVICE_URL}/api/setup/initial-operator \
  -H "Content-Type: application/json" \
  -d '{"id": "your-email@example.com", "name": "Your Name", "password": "your-secure-password"}'
```

> The `id` field is the unique identifier (typically your email). This endpoint **auto-locks** after the first operator is created — it cannot be called again. The created operator gets `super_admin` role and receives JWT tokens for immediate API access.

## 12. Custom Domain (Optional)

To map a custom domain to your Cloud Run service:

```bash
gcloud run domain-mappings create \
  --service=bonsai \
  --domain=bonsai.yourdomain.com \
  --region=$REGION
```

Then add the DNS records shown in the output to your domain registrar.

## Cost Breakdown

### Minimum (scale to zero, cold starts ~5s)

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| Cloud SQL | db-f1-micro, HDD, 10GB | ~$9.37 |
| Cloud Run (backend) | 0 min instances, 512Mi | ~$0–5 (free tier) |
| Cloud Run (console) | 0 min instances, 256Mi | ~$0 (admin-only, rare use) |
| Artifact Registry | Image storage | ~$0.10 |
| Secret Manager | 2 secrets | ~$0 |
| **Total** | | **~$10–15/month** |

### Recommended (no cold starts on backend)

If your backend serves a chat widget or real-time users, set `--min-instances=1` on the **backend only** to eliminate cold starts. The console is admin-only and can stay at 0.

```bash
gcloud run services update bonsai --region=$REGION --min-instances=1
```

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| Cloud SQL | db-f1-micro, HDD, 10GB | ~$9.37 |
| Cloud Run (backend) | **1 min instance**, 512Mi | ~$5–8 |
| Cloud Run (console) | 0 min instances, 256Mi | ~$0 |
| Artifact Registry | Image storage | ~$0.10 |
| **Total** | | **~$15–18/month** |

> **Note**: Avoid using a VPC Connector for Cloud SQL connectivity — it provisions always-on VMs that add ~$12/month. The built-in Cloud SQL connector (`--add-cloudsql-instances`) is free and more secure.

## Upgrading

When traffic grows:
- **Cloud SQL**: Upgrade to `db-g1-small` (~$25/month) for dedicated CPU
- **Cloud Run**: Increase backend `--min-instances` further for more warm capacity
- **Cloud SQL storage**: Switch from HDD to SSD for better performance

## Troubleshooting

### exec format error
If the container fails immediately with this error, you built the Docker image for the wrong CPU architecture. Rebuild with `--platform=linux/amd64`.

### Secret Manager permission denied
Grant the Cloud Run service account the `secretmanager.secretAccessor` role (see Step 5).

### Cold starts
If the first chat message is slow (~5s), set `--min-instances=1` on Cloud Run. This keeps one instance warm.

### WebSocket timeouts
Cloud Run supports WebSocket connections up to 3600 seconds (1 hour). For chat sessions this is more than sufficient. The client should implement reconnection logic for longer sessions.

### Console login fails (CORS error)
If the console can't log in, check the backend's `CORS_ORIGIN` env var. It must be set to the exact console URL (e.g., `https://bonsai-console-xxx.us-central1.run.app`). Two common pitfalls: (1) `CORS_ORIGIN=*` doesn't work because the backend sets `credentials: true`, and browsers reject `*` with credentials; (2) pipe-separated origins like `https://a.com|https://b.com` are passed as a single string, not parsed as multiple origins.

### Database connections
Cloud Run scales to multiple instances. If you see connection errors, check `DB_POOL_SIZE` (default 10). With `--max-instances=3`, that's up to 30 connections — well within db-f1-micro limits.

## 13. Deploy Bonsai Console (Admin UI)

The [Bonsai Console](https://github.com/utter-one/bonsai-console) is a Vue 3 SPA that provides a web UI for managing projects, agents, stages, knowledge, conversations, and more.

```bash
# Clone the console repo
git clone https://github.com/utter-one/bonsai-console.git
cd bonsai-console

# Set the backend URL — the console bakes this in at build time via Vite
# IMPORTANT: Use .env.production, NOT .env (which is in .dockerignore)
# --build-arg also does NOT work — the Dockerfile doesn't accept ARGs
BACKEND_URL=$(gcloud run services describe bonsai --region=$REGION --format="value(status.url)")
echo "VITE_API_BASE_URL=${BACKEND_URL}" > .env.production

# Build for amd64
docker build --platform=linux/amd64 \
  -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/console:latest .

# Push to Artifact Registry
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/console:latest

# Deploy to Cloud Run
gcloud run deploy bonsai-console \
  --image=${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/console:latest \
  --region=$REGION \
  --platform=managed \
  --port=80 \
  --min-instances=0 \
  --max-instances=2 \
  --memory=256Mi \
  --cpu=1
```

> The console is a static SPA served by nginx — very lightweight. Consider restricting access with `--no-allow-unauthenticated` and using IAM or Cloud IAP to gate access to operators only.

After deploying the console, **update the backend's `CORS_ORIGIN`** to allow requests from the console URL:

```bash
CONSOLE_URL=$(gcloud run services describe bonsai-console --region=$REGION --format="value(status.url)")

gcloud run services update bonsai \
  --region=$REGION \
  --update-env-vars="CORS_ORIGIN=${CONSOLE_URL}"
```

> **Important**: `CORS_ORIGIN` accepts a **single origin**, not a comma or pipe-separated list. If you need multiple origins (e.g., console + a frontend app), you'll need to modify the CORS configuration in `src/server.ts` to accept an array or use a function. Using `*` (wildcard) does **not** work when `credentials: true` is set — browsers will reject the response.

## Production Hardening

This guide creates a dev/staging deployment. Before serving real traffic, consider these upgrades:

| Area | Dev (this guide) | Production |
|------|-----------------|------------|
| **Cloud SQL tier** | db-f1-micro (shared vCPU, 614MB) | db-g1-small+ (~$25/month) with dedicated CPU |
| **Cloud SQL HA** | Single zone | Enable high availability (automatic failover) |
| **Cloud SQL backups** | None configured | Enable automated backups and point-in-time recovery |
| **DB connection** | Cloud SQL connector (built-in) | Cloud SQL Auth Proxy sidecar for connection pooling |
| **Cloud Run instances** | min=0 (cold starts ~5s) | min=1+ to eliminate cold starts |
| **Cloud Run CPU** | Shared (CPU throttled) | `--cpu-boost` or `--no-cpu-throttling` for consistent latency |
| **Console access** | `--allow-unauthenticated` | `--no-allow-unauthenticated` + Cloud IAP or IAM |
| **Custom domain** | Cloud Run default URL | Custom domain with managed SSL |
| **CORS** | `*` (open) | Locked to specific domains |
| **Monitoring** | None | Cloud Monitoring alerts on error rate, latency, DB connections |
| **Secrets** | In env vars | Rotate JWT_SECRET and DB password periodically |
