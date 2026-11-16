# Optional local MinIO source build

The default Compose stack currently references `minio/minio:latest` and `minio/mc:latest`. Those pulls failed during Calendar verification. MinIO's official Community Edition README describes source-only distribution and documents source compilation; its current Dockerfile itself still depends on the unavailable server image. This opt-in override compiles the official server and client source instead. It does not change the default Compose file, production configuration, service ports, credentials, commands or volume definitions.

The fallback is for development. It includes upstream `LICENSE` and `CREDITS` files. These pinned builds are not a claim of current vendor production support or a replacement for production dependency review.

## Verified source and build inputs

Checked against official GitHub and Docker Official Images metadata on 7 November 2026:

| Input | Pin |
| --- | --- |
| MinIO server source | [`7aac2a2c5b7c882e68c1ce017d8256be2feea27f`](https://github.com/minio/minio/commit/7aac2a2c5b7c882e68c1ce017d8256be2feea27f), committed 12 February 2026 |
| Server archive SHA-256 | `71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6` |
| MinIO client source | [`77f82e18b5401a65958f1619df6ebb994634bd88`](https://github.com/minio/mc/commit/77f82e18b5401a65958f1619df6ebb994634bd88), committed 6 November 2025 |
| Client archive SHA-256 | `167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975` |
| Go builder | `golang:1.24.9-alpine@sha256:8f8959f38530d159bf71d0b3eb0c547dc61e7959d8225d1599cf762477384923` |
| Runtime base | `alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412` |

The server source requires Go 1.24.0/toolchain 1.24.8; the client requires Go 1.24.0/toolchain 1.24.9. The builder uses the latter explicitly with automatic toolchain downloads disabled. Dependencies come from the source's `go.mod`/`go.sum` via the public Go module proxy and checksum database. Source archives are checksum-verified before extraction. Compilation uses static linking, fixed version/commit metadata, trimmed paths and two Go build workers. The pins make inputs reproducible; identical OCI image digests across different BuildKit versions are not asserted.

The runtime uses Alpine to retain `/bin/sh`, required by the existing `minio-setup` script. No server container or existing data volume is started or modified by a build command. Go module/build cache mounts consume local Docker storage.

## Commands

Check storage before building:

```sh
df -h .
docker system df
```

Validate the merged configuration without printing secrets:

```sh
docker compose --env-file env/local/dev.env \
  -f infra/docker-compose.yml -f infra/docker-compose.minio-source.yml config --quiet
```

Build only the two images:

```sh
docker compose --env-file env/local/dev.env \
  -f infra/docker-compose.yml -f infra/docker-compose.minio-source.yml \
  build minio minio-setup
```

When ready to use the development stack, the same override can be supplied to the normal `up` command. Existing direct backend/Vite processes must release their ports first. Starting the stack is separate from image preparation and was not performed during this task.

## Verification status and present blocker

Both official commit SHAs were resolved with `git ls-remote`; corresponding GitHub commit metadata and source archive checksums were verified. Builder/runtime manifest digests were resolved from Docker Official Images. Merged Compose `config --quiet` validation passed, and BuildKit `--check` passed for both Dockerfiles with no warnings. Those checks do not compile the source or prove runtime acceptance.

The current host had only 6.3 GiB free at 97% filesystem capacity, with roughly 23.5 GB of Docker images and 20.3 GB of build cache. Docker had four CPUs and 8.3 GB RAM. A fresh MinIO compilation can add substantial module/compiler cache and image layers, so a heavy build was not started. No unrelated images, cache or volumes were deleted to make space. Full image compilation and object-store runtime acceptance remain unverified until sufficient disk capacity is available.

## Official references

- [MinIO Community Edition source build instructions](https://github.com/minio/minio/blob/7aac2a2c5b7c882e68c1ce017d8256be2feea27f/README.md)
- [MinIO client source build instructions](https://github.com/minio/mc/blob/77f82e18b5401a65958f1619df6ebb994634bd88/README.md)
- [Server toolchain declaration](https://github.com/minio/minio/blob/7aac2a2c5b7c882e68c1ce017d8256be2feea27f/go.mod)
- [Client toolchain declaration](https://github.com/minio/mc/blob/77f82e18b5401a65958f1619df6ebb994634bd88/go.mod)
- [Upstream server version flags](https://github.com/minio/minio/blob/7aac2a2c5b7c882e68c1ce017d8256be2feea27f/buildscripts/gen-ldflags.go)
- [Upstream client version flags](https://github.com/minio/mc/blob/77f82e18b5401a65958f1619df6ebb994634bd88/buildscripts/gen-ldflags.go)
