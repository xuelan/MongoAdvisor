# Setup reference

Full Atlas bootstrap, database users, environment variables, and credential
encryption. The [README](../README.md#quick-start) has a 5-minute Quick Start
for users who already have credentials provisioned; this document covers the
**from-scratch** path on Atlas plus the reference tables for each role and
HTTP endpoint.

- [Prerequisites](#prerequisites)
- [Bootstrap (Atlas) — six steps](#bootstrap-atlas)
- [Environment variables](#environment-variables)
- [MongoDB users and roles (reference)](#mongodb-users-and-roles-reference)
- [Atlas database users — CLI and HTTP API](#atlas-database-users--cli-and-http-api)
- [Credential encryption](#credential-encryption)
- [Decrypt a stored credential](#decrypt-a-stored-credential)

## Prerequisites

- Node.js 18+ and `npm install` in this repo.
- Atlas project IDs for the **backend** project (where the MongoAdvisor app DB
  lives) and each **monitored** workload project.
- The backend Atlas cluster reachable for `MONGO_URI`.
- **Two different Atlas programmatic API key pairs:**

| Key                       | Typical Atlas roles                                                                                                      | Used for                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Bootstrap / admin key** | Enough privilege to **create database users** on a project (e.g. **Project Owner** or **Project Database Access Admin**) | `npm run atlas:create-user` (steps 1 and 3), or `POST /api/atlas/database-users`                    |
| **Monitoring key**        | **Project Read Only** + **Project Data Access Read Only** → API values `GROUP_READ_ONLY`, `GROUP_DATA_ACCESS_READ_ONLY`  | Stored in MongoAdvisor per cluster for [Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/) slow-query logs |

Create the bootstrap key in Atlas **Access Manager** if you do not already
have one. The monitoring key is created in step 2 and is **not** the same as
the bootstrap key (read-only keys cannot create users). See
[Atlas programmatic access](https://www.mongodb.com/docs/atlas/configure-api-access/)
for current role names.

## Bootstrap (Atlas)

Use this sequence for a **new** deployment.

### 1. Create the backend application user (SCRAM)

Creates `readWrite` on `mongoadvisor` plus `readAnyDatabase` on `admin`
(SCRAM auth against `admin` — Atlas requirement). Pass the **bootstrap**
public/private keys (not the monitoring key).

```bash
# databaseName (auth): admin | roles: readWrite @ mongoadvisor, readAnyDatabase @ admin
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset backend \
  --project-id "<BACKEND_ATLAS_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username mongoadvisor_app
```

Optional: `--cluster-name "<backend Atlas cluster name>"` scopes the user to
one cluster.

Alternatives: Atlas UI **Database Access**, or the HTTP API documented under
[Atlas database users — CLI and HTTP API](#atlas-database-users--cli-and-http-api)
(same payloads as `npm run atlas:create-user`).

Example `MONGO_URI`: `mongodb+srv://mongoadvisor_app:<password>@<host>/mongoadvisor?authSource=admin`

### 2. Create the monitoring programmatic API key (read-only)

For each **monitored** Atlas project, create a key MongoAdvisor will store
for the Performance Advisor API. The **HTTP caller** must have **Project
Owner** or **Project Access Manager** on that project (often your personal
Atlas login via `curl --digest`, or the bootstrap key if it has that role on
the monitored project).

**Atlas UI (recommended):** Organization (or project) **Access Manager** →
**Applications** / programmatic keys → create with **Project Read Only** and
**Project Data Access Read Only** → assign to the workload project → copy
**public** and **private** once.

**REST** —
[Create and Assign One Organization API Key to One Project](https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/operation/operation-creategroupapikey/)
(`POST /api/atlas/v2/groups/{groupId}/apiKeys`). Response is **HTTP 200**
and includes `publicKey` and `privateKey` only at creation time:

```bash
curl --user "<CALLER_PUBLIC_KEY>:<CALLER_PRIVATE_KEY>" \
  --digest \
  --header "Content-Type: application/vnd.atlas.2023-01-01+json" \
  --header "Accept: application/vnd.atlas.2023-01-01+json" \
  -X POST "https://cloud.mongodb.com/api/atlas/v2/groups/<MONITORED_PROJECT_ID>/apiKeys" \
  --data '{
    "desc": "MongoAdvisor Performance Advisor read key",
    "roles": [
      "GROUP_READ_ONLY",
      "GROUP_DATA_ACCESS_READ_ONLY"
    ]
  }'
```

If slow-query ingestion later returns **403**, confirm role names against
current
[Atlas programmatic access](https://www.mongodb.com/docs/atlas/configure-api-access/)
docs (Atlas occasionally renames roles).

### 3. Create the monitored cluster database user (SCRAM)

The collector connects with this **MongoDB** user (`metrics_reader`
pattern). Use `--preset metrics` on the **monitored** project;
`--cluster-name` must match the **Atlas cluster name**.

```bash
export ATLAS_NEW_USER_PASSWORD='...'
npm run atlas:create-user -- --preset metrics \
  --project-id "<MONITORED_PROJECT_ID>" \
  --public-key "<BOOTSTRAP_PUBLIC_KEY>" \
  --private-key "<BOOTSTRAP_PRIVATE_KEY>" \
  --username metrics_reader \
  --cluster-name "<Atlas cluster name>"
```

**MongoDB roles for `--preset metrics`** (see
[`src/atlas-db-users.js`](../src/atlas-db-users.js)): the user is created
with `databaseName: admin` (SCRAM / `authSource=admin`) and these
[built-in roles](https://www.mongodb.com/docs/manual/reference/built-in-roles/):

| Role              | Database | Purpose                                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `clusterMonitor`  | `admin`  | Server stats, topology, `$queryStats`, `dbStats`, replica set / process info used by the collector       |
| `readAnyDatabase` | `admin`  | Read user collections across databases for `$indexStats`, storage / fragmentation walks, namespace lists |
| `read`            | `local`  | Read `local.oplog.rs` for oplog window sampling (`readAnyDatabase` does not cover `local`)               |

When you pass `--cluster-name`, Atlas also attaches a **cluster scope**
(`CLUSTER`) so the user applies only to that deployment; omit
`--cluster-name` only if you intentionally want a **project-wide** database
user (all clusters in the project).

Example connection string: `mongodb+srv://metrics_reader:<password>@<host>/?authSource=admin`

To run `airbnb-expand-listings-big.js` (`$out`) or other sample **writes**
from this repo, create a separate `mongoadvisor_workload` user with
`--preset workload` (`readWriteAnyDatabase`) — see
[Workload database user](workloads.md#workload-database-user-mongoadvisor_workload)
in the workloads doc.

### 4. Configure environment variables

Do **not** commit secrets. Locally, copy `.env.example` to `.env`. In
production, set the same variable **names** via your platform (Kubernetes
secrets, PaaS env, systemd, etc.). See
[Environment variables](#environment-variables) for the full table.

Generate `ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Start the application

```bash
npm start
```

Dashboard: `http://localhost:3000` (or your `PORT`). If the application
database is unreachable, the banner explains it; `/api/health` drives the
header badge.

### 6. Register the monitored cluster in the UI

Under **Monitored Clusters**:

- **Cluster name** — use the same string as the Atlas cluster name (scopes
  Atlas user creation and console links).
- **Connection string** — URI for `metrics_reader` from step 3.
- **Atlas Project ID** — monitored project (`MONITORED_PROJECT_ID`).
- **Atlas Public API Key** / **Atlas Private API Key** — the **monitoring**
  key from step 2 (not the bootstrap key).

Without Atlas keys, `$queryStats` and other DB-backed collectors still run;
[Atlas Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)
slow-query enrichment is skipped.

Registering a cluster in the UI is always a **new** row (no upsert by name).
To **change** the connection string or Atlas fields, click **Edit
connection** next to **Add Cluster**, pick the cluster, edit fields, then
**Save changes** (or run `scripts/update-cluster-uri.js` and **restart** the
server if you use the script — the UI `PATCH` clears pools in-process).

## Environment variables

`.env` in the repo root (or platform-equivalent secrets in production):

| Variable                       | Required | Purpose                                                                                                                                                                                                                |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`                    | yes      | Connection string for the **MongoAdvisor application** database (stores `clusters`, metrics, encrypted secrets). On Atlas, must include `authSource=admin`.                                                            |
| `MONGO_DB`                     | no       | Application database name (default `mongoadvisor`).                                                                                                                                                                    |
| `ENCRYPTION_KEY`               | yes      | 64 hex chars — encrypts stored cluster URIs and Atlas private keys in the app DB. See [Credential encryption](#credential-encryption).                                                                                 |
| `PORT`                         | no       | HTTP port (default `3000`).                                                                                                                                                                                            |
| `WORKLOAD_MONGO_URI`           | no       | Override `MONGO_URI` for `scripts/workload*.js` and `airbnb-expand-listings-big.js` when sample data lives on a different cluster. See [Workloads](workloads.md#workload-connection-string).                           |
| `SLOW_QUERY_SAFETY_LAG_MS`     | no       | Per-host watermark overlap for the slow-query collector (default `60000`). See [Collector reference](collector.md#slow-query-window-per-host-watermark).                                                               |
| `SLOW_QUERY_MAX_LOOKBACK_MS`   | no       | Hard cap on the slow-query request window (default `1800000`).                                                                                                                                                         |
| `RETENTION_ENABLED`            | no       | `true` (default) enables hourly rollups + TTL. See [Retention](retention.md).                                                                                                                                          |
| `RETENTION_RAW_DAYS`           | no       | TTL on raw collections = `(RETENTION_RAW_DAYS + 1) × 86400` s (default `7`).                                                                                                                                           |
| `RETENTION_HOURLY_DAYS`        | no       | `0` (default) keeps rollups forever; `>0` also TTLs them.                                                                                                                                                              |
| `ROLLUP_INTERVAL_MS`           | no       | Cadence of rollup job (default `3600000`, hourly).                                                                                                                                                                     |
| `ROLLUP_SAFETY_BUFFER_HOURS`   | no       | Skip the most recent N hours during rollup (default `2`).                                                                                                                                                              |
| `ATLAS_BACKEND_PROJECT_ID`     | no       | Exposed via `GET /api/atlas/database-users/defaults` to prefill scripts. **Non-secret only** — never put a private API key in `.env`.                                                                                  |
| `ATLAS_BACKEND_PUBLIC_KEY`     | no       | Same — non-secret prefill hint.                                                                                                                                                                                        |

## MongoDB users and roles (reference)

You need **two different identities** in normal operation, plus an optional
third for the workload scripts:

| Identity                  | Where it's used                                          | Preset      | Roles (Atlas)                                                                                              |
| ------------------------- | -------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| **Backend app user**      | `MONGO_URI` — app DB read/write                          | `backend`   | `readWrite@mongoadvisor`, `readAnyDatabase@admin` (SCRAM `authSource=admin`)                              |
| **Metrics reader**        | Per-cluster URI registered in the UI                     | `metrics`   | `clusterMonitor@admin`, `readAnyDatabase@admin`, `read@local`                                              |
| **Workload user** (opt.)  | `WORKLOAD_MONGO_URI` for `scripts/workload*.js`          | `workload`  | `readWriteAnyDatabase@admin` — see [Workloads](workloads.md#workload-database-user-mongoadvisor_workload)  |

**Atlas:** You must create database users with the
[Atlas UI](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/),
[Atlas CLI](https://www.mongodb.com/docs/atlas/cli/stable/command/atlas-dbusers-create/),
[Atlas Administration API](https://www.mongodb.com/docs/atlas/reference/api-resources-spec/v2/#tag/Database-Users),
or another supported integration. Changes made only with `mongosh` /
`db.createUser` on the cluster can be **rolled back** by Atlas.

**Self-managed** (not Atlas): you can create the same roles with
`db.createUser` in `mongosh` as usual.

**Atlas notes:** Slow-query log ingestion uses the **Atlas Admin API**
(project ID + API keys in the form), not the database user. `$queryStats`
requires MongoDB **7.1+** — on 7.0 clusters it's gated off automatically by
discovery (see [Collector reference](collector.md#querystats-collector)).

## Atlas database users — CLI and HTTP API

SCRAM users are **not** created from the web UI. Use
`npm run atlas:create-user` (see [Bootstrap (Atlas)](#bootstrap-atlas)) or
call the routes below (same presets as
[`src/atlas-db-users.js`](../src/atlas-db-users.js)). Optional server env
`ATLAS_BACKEND_PROJECT_ID` and `ATLAS_BACKEND_PUBLIC_KEY` are exposed via
`GET /api/atlas/database-users/defaults` so scripts or `curl` can prefill
non-secrets only (never put a private API key in `.env` for a browser).

| Method | Path                                     | Purpose                                                                                                                                                                                                                |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/atlas/database-users/presets`      | Preset ids and descriptions (`backend`, `metrics`, `workload`).                                                                                                                                                        |
| `GET`  | `/api/atlas/database-users/defaults`     | JSON `{ projectId, publicKey }` from optional env (non-secrets only).                                                                                                                                                  |
| `POST` | `/api/atlas/database-users`              | Body: `preset`, `projectId`, `publicKey`, `privateKey`, `username`, `password`, optional `clusterName` (Atlas cluster name for scope).                                                                                 |
| `POST` | `/api/clusters/:id/atlas-database-users` | Uses **stored** Atlas Project ID + API keys on that cluster. Body: `username`, `password`, optional `preset` (default `metrics`), optional `scopeToCluster` (default `true` → scope to the cluster's registered name). |

The stock server does **not** add HTTP authentication to these routes; treat
them like the rest of the admin API and protect them at the network or proxy
layer.

## Credential encryption

Source cluster URIs and Atlas private API keys go through
**application-level encryption** (AES-256-GCM) in the Node backend
**before** they reach the app DB. Implementation:
[`src/crypto.js`](../src/crypto.js); unit tests in
[`tests/crypto.test.js`](../tests/crypto.test.js).

### What this is — and isn't

| Pattern                                                                                                                                            | Where encryption happens               | Who holds the key                          | Used here? |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ | ---------- |
| **Application-level encryption** (this project)                                                                                                    | Node backend, before the wire          | Application env (`ENCRYPTION_KEY`)         | **Yes**    |
| [MongoDB Encryption at Rest](https://www.mongodb.com/docs/manual/core/security-encryption-at-rest/)                                                | Storage engine (transparent to app)    | KMIP / cloud KMS / local key file          | Orthogonal (Atlas enables it by default at the disk layer; not part of this code) |
| [Client-Side / Queryable Encryption](https://www.mongodb.com/docs/manual/core/queryable-encryption/)                                              | MongoDB driver (CSFLE / QE)            | Key-vault collection + KMS provider        | No         |

So: the MongoDB server in the app DB only ever sees opaque
`iv:authTag:ciphertext` strings for these two fields, and that ciphertext
sits on top of whatever disk-level encryption your hosting provider
applies — but the encryption is performed by the application, not by the
database.

### Field flow

| Layer                | `uri`                         | `atlasPrivateKey`     |
| -------------------- | ----------------------------- | --------------------- |
| `POST /api/clusters` | Plain text in request         | Plain text in request |
| Database             | `iv:authTag:ciphertext` (hex) | Same format           |
| `GET /api/clusters`  | Masked                        | Partially masked      |

- **Key**: 256-bit hex in `ENCRYPTION_KEY` (never commit `.env`).
- **Per-value IV**: random 12 bytes per encrypt (GCM requires unique IVs per key).
- **Auth tag**: 16 bytes — tamper detection; `decrypt()` throws on mismatch.
- Rotating `ENCRYPTION_KEY` requires re-encrypting stored values (no in-place rotation helper yet).

## Decrypt a stored credential

MongoAdvisor stores sensitive cluster fields (`uri`, `atlasPrivateKey`) in
the application database as AES-256-GCM ciphertext. The API and UI never
return the full plaintext URI.

If you **operate** the deployment and still have the same `ENCRYPTION_KEY`
as when the value was written, you can decrypt a copied field locally for
recovery or verification. **Do not** commit ciphertext or plaintext; treat
script output like any other secret.

**Prerequisites:** `.env` in the repo root with `ENCRYPTION_KEY` (64 hex
characters — same as the running app).

**Get the ciphertext:** In MongoDB Compass, `mongosh`, or any client
connected to the **application** database, read `mongoadvisor.clusters`
(or your `MONGO_DB`) and copy the **string value** of `uri` or
`atlasPrivateKey` (three colon-separated hex segments: IV, auth tag,
ciphertext).

**Run:**

```bash
# Pass the packed string as one argument (quote it in the shell — it contains colons)
npm run decrypt:field -- '<ivHex:tagHex:cipherHex>'

# Equivalent
node scripts/decrypt-field.js '<ivHex:tagHex:cipherHex>'

# Or pipe (useful if the string is very long)
echo '<ivHex:tagHex:cipherHex>' | node scripts/decrypt-field.js --stdin
```

The script prints a **stderr** warning, then writes the **plaintext** to
**stdout** (for example a full `mongodb+srv://…` connection string). If the
input is not in MongoAdvisor encrypted format, or the key is wrong, it exits
with an error.
