# OSS clean-install baseline

This is the **data-plane slice** of [#108](https://github.com/plc1220/HelpUDoc/issues/108): PostgreSQL, Redis, and RustFS with independent Compose-managed volumes and idempotent bucket setup. It requires Docker Compose v2. It does not replace either legacy developer Compose file or the GKE deployment. It does not migrate existing data, boot the application, or validate inference.

```sh
cd infra/oss
cp .env.example .env.local
# Set the three unique local credentials in .env.local.
docker compose --env-file .env.local config --images
docker compose --env-file .env.local up -d --wait postgres redis rustfs
docker compose --env-file .env.local run --rm bucket-init
```

| Contract | Local value |
|---|---|
| Database and migrations | `127.0.0.1:15432`, database/user `helpudoc` by default; use the app's existing migration path. The bundled Postgres init script provisions only the extra Langfuse database. |
| Queue and checkpoints | `redis://127.0.0.1:16379` with append-only persistence; queue names and checkpoint behavior remain app-owned. |
| Object store | `http://127.0.0.1:19100`, path-style S3, region `us-east-1`, buckets `helpudoc` (configurable) and `langfuse`. Use matching S3 credentials in the backend and agent. Apps on the Compose network instead use `http://rustfs:9000`. |
| Identity, application images, sandbox, model serving | Not supplied by this dependency target. Keep application identity, image selection and sandbox/inference configuration explicit; document and validate a supported full-stack profile before release. |

`docker compose --env-file .env.local down` stops the isolated stack without deleting named volumes. Use a unique `-p` project name and override all three host ports to run more than one instance. Never point this configuration at a legacy MinIO data directory. For the separate migration, follow the existing RustFS migration runbook.

Run `./check-compose.sh` to validate the resolved images without starting containers. On a disposable Docker environment, run `./smoke.sh` to check clean boot and data persistence across container recreation; it uses throwaway credentials, ephemeral host ports, and removes the smoke project volumes on exit. Full-stack image locks and inference, two-user review, durable-agent and application restart tests, and backup/restore and rollback drills remain part of #108. Workflow gating belongs with #104; cloud-specific targets should reuse this contract and the existing GKE work.
