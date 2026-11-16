# Includes /bin/sh for the existing minio-setup command in docker-compose.yml.
FROM --platform=$BUILDPLATFORM golang:1.24.9-alpine@sha256:8f8959f38530d159bf71d0b3eb0c547dc61e7959d8225d1599cf762477384923 AS build
ARG TARGETARCH
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
WORKDIR /src
ADD --checksum=sha256:167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975 https://codeload.github.com/minio/mc/tar.gz/77f82e18b5401a65958f1619df6ebb994634bd88 /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src && rm /tmp/source.tar.gz
RUN --mount=type=cache,id=helpudoc-minio-go-mod,target=/go/pkg/mod \
    --mount=type=cache,id=helpudoc-mc-go-build,target=/root/.cache/go-build \
    mkdir -p /out && go mod download && \
    GOOS=linux GOARCH="${TARGETARCH}" go build -p 2 -mod=readonly -trimpath -buildvcs=false \
      -ldflags="-s -w -X github.com/minio/mc/cmd.Version=2025-11-06T16:25:29Z -X github.com/minio/mc/cmd.ReleaseTag=DEVELOPMENT.2025-11-06T16-25-29Z -X github.com/minio/mc/cmd.CommitID=77f82e18b5401a65958f1619df6ebb994634bd88 -X github.com/minio/mc/cmd.ShortCommitID=77f82e18b540 -X github.com/minio/mc/cmd.CopyrightYear=2025" \
      -o /out/mc . && \
    if [ "$(go env GOARCH)" = "${TARGETARCH}" ]; then /out/mc --version; fi

FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="77f82e18b5401a65958f1619df6ebb994634bd88" \
      org.opencontainers.image.title="HelpUDoc development MinIO client source build"
COPY --from=build /out/mc /usr/local/bin/mc
COPY --from=build /src/LICENSE /src/CREDITS /licenses/
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENTRYPOINT ["/usr/local/bin/mc"]
