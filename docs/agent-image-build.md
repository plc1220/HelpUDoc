# Agent image builds

The Agent deployment image supports **Linux AMD64** (GKE deployment) and **Linux ARM64** (native Apple Silicon local development). CI builds and runs both on native hosted runners whenever Agent image inputs change. Other CPU architectures are rejected by the Dockerfile. The GCP cost helper and OfficeCLI are downloaded for the target architecture and verified with committed SHA-256 checksums.

## Dependency resolution

The former open-ended pip install could backtrack to matplotlib 3.4.3 and attempt an incompatible Python 3.12 source build (`configparser.SafeConfigParser` was removed). The reporting input now requires matplotlib 3.8 or newer. More importantly, the image installs the committed `agent/requirements-runtime.lock`: all runtime dependencies and their transitive dependencies are pinned and hash checked. Installation is wheel-only, so an old or unavailable wheel cannot silently turn into a source build. `pip check` runs during the image build and again in CI.

The Python 3.12.16 base is pinned to its multi-architecture image digest. The same Python dependency lock is verified for both CPython 3.12 Linux AMD64 and ARM64, using a manylinux 2.28 baseline compatible with Bookworm. This fixes dependency resolution; it does not claim byte-identical system images across time. Debian apt packages still receive repository updates, so system package updates can require a rebuild and another smoke run.

To update Python dependencies:

```sh
python -m pip install uv==0.11.2
# Edit agent/requirements-{api,documents,reporting}.txt, then:
python agent/scripts/update_runtime_lock.py
python agent/scripts/update_runtime_lock.py --check
```

The update resolves both target architectures with the pinned resolver and refuses to write a shared lock if their resolutions differ. Review version/hash changes and commit the inputs and lock together. The check uses the committed versions as constraints, resolves the complete declared inputs, and detects a stale lock. Do not hand-edit the lock or remove hash/wheel checks to make an incompatible update pass. Refresh the base digest and downloaded binary version/checksum pairs separately and run both native image jobs after changes.

## Build and smoke locally

From the repository root, on Apple Silicon:

```sh
docker build --platform linux/arm64 -f agent/Dockerfile.gke -t helpudoc-agent:smoke .
docker run --rm --network none helpudoc-agent:smoke python -m pip check
docker run --rm --network none helpudoc-agent:smoke python /app/agent/scripts/smoke_import.py
docker run --rm --network none helpudoc-agent:smoke python /app/agent/scripts/smoke_image.py
docker run --rm --network none helpudoc-agent:smoke python /app/agent/scripts/smoke_officecli.py
docker run --rm --network none helpudoc-agent:smoke python /app/agent/scripts/smoke_office_preview.py
```

Use `--platform linux/amd64` on an AMD64 host. Cross-platform emulation is optional for local diagnosis; the required CI jobs run on native runners. No credentials are passed to these containers and outbound networking is disabled. The startup smoke launches the real Uvicorn entry point with a temporary minimal configuration and in-memory store, verifies HTTP `/health` and `/ready` including OfficeCLI integrity, then shuts it down. Startup is bounded to 90 seconds and shutdown to 15 seconds before forced termination. This verifies image startup and health independently of PostgreSQL and cloud services; production connections and model calls need their own acceptance tests.

## CI enforcement

The Agent image matrix is required on PRs that change Agent code or manifests, skills, plugins, the build context exclusion list, relevant test/smoke inputs, build/deploy workflows or environment configuration. Each architecture runs the dependency/import, startup/health/readiness, OfficeCLI document, preview/edit and license integrity smokes inside its built image.

The aggregate `CI status` fails when path detection fails or produces invalid outputs, when a required job is missing/skipped/failed/cancelled, or when any executed job fails. Unrelated PRs may skip Agent jobs and still pass. Regression tests exercise intentional required-build failure and legitimate unrelated skips.

Repository rulesets are separate from this code. Issue #104 additionally calls for requiring `CI status` and `gitleaks` in the `master` ruleset and proving enforcement with a test PR. Those administrative checks are not established by the local gate tests or by this image fix and must be recorded before closing that part of #104.
