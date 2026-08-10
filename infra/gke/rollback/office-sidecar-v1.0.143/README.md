# Office sidecar rollback bundle (OfficeCLI 1.0.143)

This bundle preserves the last checked-in same-pod Office HTTP layout before
direct OfficeCLI execution moved into the agent image. At release time, record
the immutable images actually running before removal:

```sh
kubectl -n helpudoc get deploy/helpudoc-app \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{"="}{.image}{"\n"}{end}' \
  | tee images.txt
git tag office-sidecar-pre-removal-1.0.143
```

To roll back, apply the preserved manifest, replace its `:latest` agent and
office-service images with the digests recorded in `images.txt`, and verify both
the agent and Office readiness endpoints:

```sh
kubectl apply -f infra/gke/rollback/office-sidecar-v1.0.143/50-app.yaml
kubectl -n helpudoc rollout status deploy/helpudoc-app --timeout=20m
kubectl -n helpudoc exec deploy/helpudoc-app -c agent -- \
  python -c "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:8001/health').status == 200"
kubectl -n helpudoc exec deploy/helpudoc-app -c office-service -- \
  python -c "import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:8002/readyz').status == 200"
```

The preserved manifest includes `OFFICE_SERVICE_URL=http://localhost:8002`,
the shared workspace mount, and the sidecar's private temporary volume. It is a
rollback artifact, not part of the active manifest set.
