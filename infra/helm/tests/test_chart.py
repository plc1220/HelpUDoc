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
            "persistence": {"storageClass": "-"}, "ingress": {"enabled": True},
            "auth": {"provider": "google"}, "ezua": {"enabled": False, "authorizationPolicy": {"enabled": False}}})
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
            {"auth": {"provider": "headers"}},
            {"auth": {"provider": "oidc", "oidc": {"issuerUrl": "http://keycloak.internal/realm"}}},
            {"auth": {"provider": "oidc", "oidc": {"existingSecret": ""}}},
            {"config": {"OIDC_CLIENT_SECRET": "must-not-be-a-value"}},
            {"ezua": {"enabled": True, "virtualService": {"endpoint": "wrong.example.com"}}}]:
            with self.subTest(values=values):
                self.assertNotEqual(render(values, fail=True).returncode, 0)

    def test_oidc_metadata_callbacks_and_backend_only_secret(self):
        objects = render({"auth": {"provider": "oidc", "oidc": {"issuerUrl": "https://sso.internal/realms/site",
            "clientId": "lumo", "existingSecret": "site-client", "clientSecretKey": "secret-key",
            "logoutFromProvider": False}}})
        env = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "helpudoc-env")["data"]
        self.assertEqual(env["AUTH_PROVIDER"], "oidc")
        self.assertEqual(env["OIDC_ISSUER_URL"], "https://sso.internal/realms/site")
        self.assertEqual(env["OIDC_REDIRECT_URI"], "https://helpudoc.example.com/api/auth/oidc/callback")
        self.assertEqual(env["OIDC_POST_LOGOUT_REDIRECT_URI"], "https://helpudoc.example.com/login")
        self.assertEqual(env["OIDC_LOGOUT_FROM_PROVIDER"], "false")
        self.assertNotIn("OIDC_CLIENT_SECRET", env)
        app = next(o for o in objects if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-app")
        for container in app["spec"]["template"]["spec"]["containers"]:
            refs = [e for e in container["env"] if e["name"] == "OIDC_CLIENT_SECRET"]
            if container["name"] == "backend":
                self.assertEqual(refs, [{"name": "OIDC_CLIENT_SECRET", "valueFrom": {
                    "secretKeyRef": {"name": "site-client", "key": "secret-key"}}}])
            else:
                self.assertEqual(refs, [])

    def test_google_provider_keeps_legacy_login_without_oidc_secret(self):
        objects = render({"auth": {"provider": "google", "oidc": {"issuerUrl": "", "existingSecret": ""}}})
        env = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "helpudoc-env")["data"]
        self.assertEqual(env["AUTH_PROVIDER"], "google")
        self.assertFalse(any(key.startswith("OIDC_") for key in env))
        app = next(o for o in objects if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-app")
        self.assertFalse(any(e["name"] == "OIDC_CLIENT_SECRET" for c in app["spec"]["template"]["spec"]["containers"] for e in c["env"]))

    def test_pcai_proxy_metadata_policy_and_presigned_uploads_need_no_client_secret(self):
        objects = render({"auth": {"pcaiProxy": {"audiences": ["browser-app", "other-aud"],
            "authorizedParty": "ua"}, "oidc": {"existingSecret": ""}}})
        env = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "helpudoc-env")["data"]
        self.assertEqual(env["AUTH_PROVIDER"], "pcai-proxy")
        self.assertEqual(env["AUTH_MODE"], "oidc")
        self.assertEqual(env["PCAI_SSO_AUDIENCES"], "browser-app,other-aud")
        self.assertEqual(env["PCAI_SSO_AUTHORIZED_PARTY"], "ua")
        self.assertEqual(env["PCAI_SSO_JWKS_URL"], "https://keycloak.pcai.example.com/realms/UA/protocol/openid-connect/certs")
        self.assertFalse(any(key.startswith("OIDC_") for key in env))
        app = next(o for o in objects if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-app")
        self.assertFalse(any(e["name"] == "OIDC_CLIENT_SECRET" for c in app["spec"]["template"]["spec"]["containers"] for e in c["env"]))
        gateway = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "helpudoc-gateway")["data"]["Caddyfile"]
        api_route, object_route = gateway.split("@objects", 1)
        self.assertNotIn("header_up -Authorization", api_route)
        self.assertIn("header_up -Authorization", object_route)
        self.assertIn("header_up -X-User-Id", api_route)
        policy = next(o for o in objects if o["kind"] == "AuthorizationPolicy")
        self.assertEqual(policy["spec"]["provider"]["name"], "oauth2-proxy")
        hosts = policy["spec"]["rules"][0]["to"][0]["operation"]["hosts"]
        self.assertEqual(hosts, ["helpudoc.example.com", "helpudoc.example.com:*"])

    def test_proxy_fails_without_policy_or_token_validation_settings(self):
        for values in [
            {"ezua": {"enabled": False}},
            {"ezua": {"authorizationPolicy": {"enabled": False}}},
            {"config": {"AUTH_MODE": "hybrid"}},
            {"auth": {"pcaiProxy": {"audiences": []}}},
            {"auth": {"pcaiProxy": {"audiences": [""]}}},
            {"auth": {"pcaiProxy": {"audiences": ["ua,another"]}}},
            {"auth": {"pcaiProxy": {"authorizedParty": ""}}},
            {"auth": {"pcaiProxy": {"issuerUrl": "http://keycloak/realms/UA"}}},
            {"auth": {"pcaiProxy": {"jwksUrl": "https://user:pass@keycloak/certs"}}},
            {"auth": {"pcaiProxy": {"portalUrl": "https://home.example.com/?redirect=evil"}}},
            {"config": {"PCAI_SSO_AUDIENCES": "bypass"}},
        ]:
            with self.subTest(values=values):
                self.assertNotEqual(render(values, fail=True).returncode, 0)

    def test_externally_applied_proxy_policy_is_an_explicit_dependency(self):
        objects = render({"ezua": {"authorizationPolicy": {"enabled": False, "existingPolicy": "site-lumo-sso"}}})
        self.assertTrue(any(o["kind"] == "VirtualService" for o in objects))
        self.assertFalse(any(o["kind"] == "AuthorizationPolicy" for o in objects))

    def test_frontend_mounts_static_config_without_compose_upstream_dependencies(self):
        objects = render()
        config = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "helpudoc-frontend")
        self.assertNotIn("proxy_pass", config["data"]["nginx.conf"])
        self.assertIn("application/javascript mjs", config["data"]["nginx.conf"])
        frontend = next(o for o in objects if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-frontend")
        pod = frontend["spec"]["template"]["spec"]
        self.assertIn({"name": "frontend-config", "mountPath": "/etc/nginx/conf.d/default.conf", "subPath": "nginx.conf"},
            pod["containers"][0]["volumeMounts"])
        self.assertIn({"name": "frontend-config", "configMap": {"name": "helpudoc-frontend"}}, pod["volumes"])
        gateway = next(o for o in objects if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-gateway")
        other = render({"auth": {"provider": "google"}})
        changed = next(o for o in other if o["kind"] == "Deployment" and o["metadata"]["name"] == "helpudoc-gateway")
        self.assertNotEqual(gateway["spec"]["template"]["metadata"]["annotations"]["checksum/gateway"],
            changed["spec"]["template"]["metadata"]["annotations"]["checksum/gateway"])


if __name__ == "__main__":
    unittest.main()
