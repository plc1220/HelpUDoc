"""Render real Helm templates and check deployment wiring without a cluster."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

CHART = Path(__file__).resolve().parents[1] / "helpudoc"
HELM = os.environ.get("HELM", "helm")


def render(overrides=None, release="helpudoc", namespace="pcai-test", fail=False):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml") as values:
        yaml.safe_dump(overrides or {}, values)
        values.flush()
        result = subprocess.run([HELM, "template", release, str(CHART), "--namespace", namespace,
            "--values", values.name], capture_output=True, text=True)
    if fail:
        return result
    if result.returncode:
        raise AssertionError(result.stderr)
    return [obj for obj in yaml.safe_load_all(result.stdout) if obj]


class ChartTests(unittest.TestCase):
    def test_default_wiring_and_local_runtime(self):
        objects = render()
        index = {(obj["kind"], obj["metadata"]["name"]): obj for obj in objects}
        self.assertFalse(any(obj["kind"] == "Secret" for obj in objects))
        self.assertFalse(any(obj["kind"] in {"ClusterRole", "ClusterPolicy", "Namespace"} for obj in objects))
        app = index["Deployment", "helpudoc-app"]
        self.assertEqual(app["spec"]["strategy"]["type"], "Recreate")
        self.assertEqual(app["spec"]["replicas"], 1)
        pod = app["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual([c["name"] for c in pod["containers"]], ["backend", "worker", "agent"])
        runtime = yaml.safe_load(index["ConfigMap", "helpudoc-runtime-default"]["data"]["runtime.yaml"])
        self.assertEqual(runtime["model"]["provider"], "openai-compatible")
        self.assertFalse(runtime["model"]["use_vertex_ai"])
        self.assertTrue(all(srv["transport"] == "stdio" for srv in runtime["mcp_servers"]))
        self.assertFalse({"google_search", "image_generation", "url_context"} & {t["name"] for t in runtime["tools"]})
        for obj in objects:
            if obj["kind"] == "Service":
                self.assertEqual(obj["spec"]["type"], "ClusterIP")
                self.assertTrue(any(d["kind"] == "Deployment" and all(
                    d["spec"]["template"]["metadata"]["labels"].get(k) == v
                    for k, v in obj["spec"]["selector"].items()) for d in objects))
            if obj["kind"] == "PersistentVolumeClaim":
                self.assertEqual(obj["metadata"]["annotations"]["helm.sh/resource-policy"], "keep")
            if obj["kind"] == "Deployment":
                for vol in obj["spec"]["template"]["spec"].get("volumes", []):
                    if "persistentVolumeClaim" in vol:
                        self.assertIn(("PersistentVolumeClaim", vol["persistentVolumeClaim"]["claimName"]), index)

    def test_pcai_routes_labels_and_cron(self):
        values = yaml.safe_load((CHART / "values-pcai.example.yaml").read_text())
        values["dailyReflection"] = {"enabled": True}
        objects = render(values, release="tenant-a", namespace="tenant-one")
        vs = next(o for o in objects if o["kind"] == "VirtualService")
        self.assertEqual(vs["spec"]["hosts"], [values["ezua"]["virtualService"]["endpoint"]])
        destination = vs["spec"]["http"][0]["route"][0]["destination"]["host"]
        self.assertEqual(destination, "tenant-a-helpudoc-gateway.tenant-one.svc.cluster.local")
        policy = next(o for o in objects if o["kind"] == "AuthorizationPolicy")
        self.assertEqual(policy["spec"]["action"], "CUSTOM")
        self.assertEqual(policy["metadata"]["namespace"], "istio-system")
        for obj in objects:
            if obj["kind"] == "Deployment":
                self.assertEqual(obj["spec"]["template"]["metadata"]["labels"]["hpe-ezua/type"], "vendor-service")
        self.assertTrue(any(o["kind"] == "CronJob" for o in objects))

    def test_external_dependencies_and_existing_claims(self):
        objects = render({"postgres": {"enabled": False, "externalHost": "pg.internal"},
            "redis": {"enabled": False}, "objectStore": {"enabled": False,
                "externalEndpoint": "https://s3.internal", "externalPublicEndpoint": "https://s3.example.com"},
            "persistence": {"claims": {"workspace": {"existingClaim": "existing-workspace"}}}})
        self.assertEqual(len([o for o in objects if o["kind"] == "PersistentVolumeClaim"]), 3)
        self.assertEqual(len([o for o in objects if o["kind"] == "Deployment"]), 3)
        env = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"].endswith("-env"))["data"]
        self.assertNotIn("REDIS_URL", env)
        self.assertEqual(env["S3_ENDPOINT"], "https://s3.internal")

    def test_site_runtime_ca_and_static_storage(self):
        objects = render({"runtimeConfigMap": "site-runtime", "trust": {"configMap": "site-ca"},
            "persistence": {"storageClass": "-"}, "ingress": {"enabled": True}})
        self.assertTrue(any(o["kind"] == "Ingress" for o in objects))
        for obj in objects:
            if obj["kind"] == "PersistentVolumeClaim":
                self.assertEqual(obj["spec"]["storageClassName"], "")
        app = next(o for o in objects if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-app")
        mounts = app["spec"]["template"]["spec"]["containers"][2]["volumeMounts"]
        self.assertTrue(any(m["name"] == "site-ca" for m in mounts))
        self.assertTrue(any(m["name"] == "runtime-override" for m in mounts))

    def test_invalid_combinations_fail(self):
        for values in [{"ezua": {"enabled": True}, "ingress": {"enabled": True}},
            {"ezua": {"autoHelm": True}}, {"postgres": {"enabled": False}},
            {"config": {"AUTH_MODE": "headers"}}, {"publicUrl": "http://helpudoc.example.com"},
            {"config": {"SANDBOX_INLINE_ENABLED": "true"}},
            {"ezua": {"enabled": True, "virtualService": {"endpoint": "wrong.example.com"}}}]:
            with self.subTest(values=values):
                self.assertNotEqual(render(values, fail=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
