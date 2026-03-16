---
name: deploy-gcp
description: Deploy Bonsai to Google Cloud Platform using Cloud Run + Cloud SQL. Walks through the full setup interactively.
user_invocable: true
---

# Deploy Bonsai to GCP (Cloud Run + Cloud SQL)

You are guiding the user through deploying Bonsai to Google Cloud Platform. This is an interactive deployment — confirm each step before proceeding and report results.

Reference the full deployment guide at `docs/guide/deployment-gcp.md` for details.

## Prerequisites Check

Before starting, verify:
1. `gcloud` CLI is installed and authenticated (`gcloud auth list`)
2. Docker is installed and running (`docker info`)
3. User has a GCP billing account (`gcloud billing accounts list`)

If anything is missing, help the user install/configure it before proceeding.

## Step 1: Create GCP Project

Ask the user for their desired project ID and name (e.g., `mycompany-bonsai`).

```bash
gcloud projects create PROJECT_ID --name="Project Name"
gcloud billing projects link PROJECT_ID --billing-account=BILLING_ACCOUNT_ID
gcloud config set project PROJECT_ID
```

## Step 2: Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

## Step 3: Set Variables & Save Credentials

Ask the user which region they prefer. Default recommendation: `us-central1` (cheapest).

Generate secure credentials and save to `.env.local` (already gitignored):

```bash
DB_PASSWORD=$(openssl rand -base64 24)
JWT_SECRET=$(openssl rand -base64 32)
```

**IMPORTANT**: If the generated password contains `/`, `@`, `#`, or other URL-special characters, URL-encode them when building the connection string (e.g., `/` → `%2F`). This is a common gotcha that causes `ERR_INVALID_URL` at startup.

Save all variables to `.env.local`:
```
GCP_PROJECT_ID=...
GCP_REGION=...
SQL_INSTANCE_NAME=bonsai-postgres
DB_NAME=bonsai
DB_USER=bonsai
DB_PASSWORD=...
JWT_SECRET=...
SQL_IP=...  (filled in after Cloud SQL is created)
DOCKER_REPO=${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend
```

## Step 4: Create Cloud SQL PostgreSQL Instance

This takes ~5 minutes. Run in background and continue with other steps.

```bash
gcloud sql instances create bonsai-postgres \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=$REGION \
  --storage-type=HDD \
  --storage-size=10
```

Then create the database and user:
```bash
gcloud sql databases create bonsai --instance=bonsai-postgres
gcloud sql users create bonsai --instance=bonsai-postgres --password=$DB_PASSWORD
```

Get and save the SQL IP:
```bash
gcloud sql instances describe bonsai-postgres --format="value(ipAddresses[0].ipAddress)"
```

## Step 5: Store Secrets & Grant Permissions

```bash
echo -n "$DB_PASSWORD" | gcloud secrets create bonsai-db-password \
  --data-file=- --replication-policy=automatic
echo -n "$JWT_SECRET" | gcloud secrets create bonsai-jwt-secret \
  --data-file=- --replication-policy=automatic
```

**IMPORTANT**: Grant the Cloud Run service account access to secrets or deployment will fail:
```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Step 6: Create Artifact Registry & Build Image

**IMPORTANT**: Use `--platform=linux/amd64` when building on Apple Silicon (M1/M2/M3/M4). Without this, Cloud Run will fail with `exec format error`.

```bash
gcloud artifacts repositories create bonsai \
  --repository-format=docker --location=$REGION

gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

docker build --platform=linux/amd64 \
  -t ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest .
docker push ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest
```

Alternatively, use Cloud Build to build remotely (always builds amd64):
```bash
gcloud builds submit --tag ${REGION}-docker.pkg.dev/${PROJECT_ID}/bonsai/backend:latest
```

## Step 7: Deploy to Cloud Run

Use Cloud Run's **built-in Cloud SQL connector** (`--add-cloudsql-instances`). This is free, secure, and doesn't require a VPC connector or authorized networks.

**Do NOT use a VPC Connector** — it provisions always-on VMs (~$12/month).

URL-encode any special characters in the password for the connection string (e.g., `/` → `%2F`).

```bash
SQL_CONNECTION_NAME=${PROJECT_ID}:${REGION}:bonsai-postgres

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
  --set-env-vars="DB_CONNECTION_STRING=postgresql://bonsai:${URL_ENCODED_DB_PASSWORD}@localhost:5432/bonsai?host=/cloudsql/${SQL_CONNECTION_NAME}" \
  --set-env-vars="CORS_ORIGIN=*" \
  --set-secrets="JWT_SECRET=bonsai-jwt-secret:latest" \
  --session-affinity
```

Ask the user what CORS_ORIGIN domains they want (pipe separated). Default `*` for initial testing, lock down for production.

## Step 8: Secure Cloud SQL

Clear any authorized networks — Cloud Run connects internally via the connector:
```bash
gcloud sql instances patch bonsai-postgres --clear-authorized-networks
```

## Step 9: Verify

```bash
SERVICE_URL=$(gcloud run services describe bonsai --region=$REGION --format="value(status.url)")
curl ${SERVICE_URL}/health
```

Should return `{"status":"healthy",...}`.

## Step 10: Create Initial Operator

```bash
curl -X POST ${SERVICE_URL}/api/setup/initial-operator \
  -H "Content-Type: application/json" \
  -d '{"id": "USER_EMAIL", "name": "User Name", "password": "USER_CHOSEN_PASSWORD"}'
```

Ask the user for their email (used as `id`), name, and desired admin password. This endpoint **auto-locks** after the first operator is created — it cannot be called again. The operator gets `super_admin` role.

Explain the auth model:
- **Operators** use JWT (login → access token) for the Console/REST API
- **Chat clients** use project-scoped **API keys** (`bonsai_...`) for WebSocket connections
- These are separate — API keys can't access the REST API, JWTs aren't needed for chat

## Step 12: Custom Domain (Optional)

Ask if they want to map a custom domain:
```bash
gcloud run domain-mappings create --service=bonsai --domain=CUSTOM_DOMAIN --region=$REGION
```

Then provide the DNS records they need to add.

## After Deployment

Remind the user:
- Cloud SQL costs ~$9/month even when idle
- Cloud Run scales to zero at low traffic (free tier covers ~2M requests/month)
- To eliminate cold starts (~5s), set `--min-instances=1` (adds ~$5-8/month)
- The Bonsai Console (admin UI) is a separate deployment — see utter-one/bonsai-console
- Save the `.env.local` file — it has all credentials
- Set CORS_ORIGIN to actual domains before going to production

## Cost Summary

| Component | Monthly Cost |
|-----------|-------------|
| Cloud SQL db-f1-micro (HDD) | ~$9.37 |
| Cloud Run (scale to zero) | ~$0-5 |
| Artifact Registry | ~$0.10 |
| Secret Manager | ~$0 |
| **Total** | **~$10-15** |
