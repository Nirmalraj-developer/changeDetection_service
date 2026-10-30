# Change Detection & DB Diff Service (Microservice 3)

Dual-layer entity verification & micro-batch database flusher (Stage 3 of the 3-stage pipeline).
- Consumes structured records from `db_queue` in Redis.
- Evaluates 32 profile fields and 5 scraped content staging fields in memory.
- Uses semantic stop-word token Jaccard similarity and legal suffix stripping to eliminate false-positive diffs.
- Accumulates records into 50-item micro-batches (or flushes every 1s).
- Deterministically sorts batches by `domain_name` to eliminate transaction deadlocks.
- Executes atomic dual-table upserts to PostgreSQL (`company_profile_global` and `domain_content_staging`).

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy and fill in `.env`:
```bash
cp .env.example .env
```
Ensure PostgreSQL and Redis connection credentials are configured.

### 3. Start Worker
```bash
npm start
```

### Docker
```bash
docker build -t change-detection-service .
docker run -d --name change-detection-service --network host --env-file .env change-detection-service
```
