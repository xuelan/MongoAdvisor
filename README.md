# MongoMonitor

Observability tool for MongoDB clusters. Collects monitoring data from one or more MongoDB clusters (via database commands or Atlas API), stores it in a central backend cluster, and provides analytics.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your MongoDB connection string and generate an encryption key

# Start the server
npm run dev
```

The app runs at `http://localhost:3000`.

## Configuration

| Variable | Description |
|---|---|
| `MONGO_URI` | Connection string for the MongoMonitor backend cluster |
| `MONGO_DB` | Database name (default: `mongomonitor`) |
| `PORT` | HTTP port (default: `3000`) |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored credentials |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Backend connectivity check |
| `GET` | `/api/clusters` | List registered source clusters |
| `POST` | `/api/clusters` | Register a source cluster |
| `GET` | `/api/clusters/:id` | Get a single cluster |
| `DELETE` | `/api/clusters/:id` | Remove a cluster |

## Project Structure

```
src/
├── server.js          # Express entry point
├── db.js              # MongoDB connection (pooled, single client)
├── crypto.js          # AES-256-GCM encryption for stored credentials
├── public/
│   └── index.html     # Dashboard UI
└── routes/
    ├── health.js      # Health check endpoint
    └── clusters.js    # Cluster CRUD endpoints
```

## Workload Generation

Scripts in `scripts/` generate some testing load against sample datasets for testing and populating server usage statistics.

```bash
node scripts/workload.js          # Run all workloads in parallel (3 scripts x 10 iterations)
node scripts/workload-agg.js      # Airbnb 10-stage analytics (lookup, map, group)
node scripts/workload-agg2.js     # Airbnb seasonal pricing (unwind reviews, double group)
node scripts/workload-mflix.js    # Mflix 3 pipelines (actor collab, genre evolution, director career)
node scripts/workload-mflix.js 2  # Run a single mflix pipeline by number
```

Each script sets `appName` and `comment` on its connections/queries for traceability in Atlas logs and `db.currentOp()`.

## Security — Credential Encryption

Source cluster connection strings contain sensitive credentials. They are **encrypted at rest** before being stored in the backend MongoDB database.

### How it works

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: 256-bit (32 bytes), stored as a 64-character hex string in `ENCRYPTION_KEY`
- **Per-value IV**: A random 12-byte initialization vector is generated for each encryption, ensuring identical plaintext values produce different ciphertext
- **Storage format**: `iv:authTag:ciphertext` (all hex-encoded) — stored in the `uri` field of the `clusters` collection

### Data flow

| Layer | Content |
|---|---|
| API request (`POST /api/clusters`) | Plain-text connection string |
| Database (at rest) | `a1b2c3…:d4e5f6…:789abc…` (encrypted) |
| API response (`GET /api/clusters`) | Decrypted back to plain text |
| Direct database access (e.g. Compass, mongosh) | Only ciphertext visible |

### Key management

- The `ENCRYPTION_KEY` is stored in `.env` which is gitignored
- Without the key, stored URIs are unreadable
- Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Rotating the key requires re-encrypting all stored URIs
