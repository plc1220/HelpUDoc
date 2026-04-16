from __future__ import annotations

import importlib.util
import logging
import os
import unittest
from unittest.mock import MagicMock, patch

from helpudoc_agent import langfuse_callbacks as lf_mod
from helpudoc_agent.langfuse_callbacks import langfuse_langchain_callbacks


def _langfuse_installed() -> bool:
    return importlib.util.find_spec("langfuse") is not None


class LangfuseCallbacksTest(unittest.TestCase):
    def _base_env(self) -> dict[str, str]:
        return {
            "LANGFUSE_TRACING_ENABLED": "true",
            "LANGFUSE_PUBLIC_KEY": "lf_pk_test",
            "LANGFUSE_SECRET_KEY": "lf_sk_test",
            "LANGFUSE_BASE_URL": "http://langfuse.test",
        }

    def test_disabled_returns_empty(self) -> None:
        with patch.dict(os.environ, {**self._base_env(), "LANGFUSE_TRACING_ENABLED": "false"}):
            self.assertEqual(langfuse_langchain_callbacks(), [])

    def test_disabled_variants(self) -> None:
        for raw in ("0", "off", "NO", "False"):
            with self.subTest(raw=raw):
                with patch.dict(os.environ, {**self._base_env(), "LANGFUSE_TRACING_ENABLED": raw}):
                    self.assertEqual(langfuse_langchain_callbacks(), [])

    def test_missing_public_key_returns_empty(self) -> None:
        env = self._base_env()
        del env["LANGFUSE_PUBLIC_KEY"]
        with patch.dict(os.environ, env, clear=False):
            self.assertEqual(langfuse_langchain_callbacks(), [])

    def test_missing_secret_key_returns_empty(self) -> None:
        env = self._base_env()
        del env["LANGFUSE_SECRET_KEY"]
        with patch.dict(os.environ, env, clear=False):
            self.assertEqual(langfuse_langchain_callbacks(), [])

    def test_missing_base_url_logs_and_returns_empty(self) -> None:
        env = self._base_env()
        del env["LANGFUSE_BASE_URL"]
        with patch.dict(os.environ, env, clear=False):
            with self.assertLogs(lf_mod.__name__, level=logging.WARNING) as logs:
                self.assertEqual(langfuse_langchain_callbacks(), [])
        self.assertTrue(any("LANGFUSE_BASE_URL" in m for m in logs.output))

    def test_accepts_langfuse_host_instead_of_base_url(self) -> None:
        env = self._base_env()
        del env["LANGFUSE_BASE_URL"]
        env["LANGFUSE_HOST"] = "http://langfuse-host.test"
        with patch.dict(os.environ, env, clear=False):
            if not _langfuse_installed():
                self.skipTest("langfuse package not installed")
            with patch("langfuse.langchain.CallbackHandler", return_value=MagicMock(name="handler")) as mock_cb:
                out = langfuse_langchain_callbacks()
        self.assertEqual(len(out), 1)
        mock_cb.assert_called_once()

    @unittest.skipUnless(_langfuse_installed(), "langfuse package not installed")
    def test_returns_handler_when_configured(self) -> None:
        with patch.dict(os.environ, self._base_env(), clear=False):
            with patch("langfuse.langchain.CallbackHandler", return_value=MagicMock(name="handler")) as mock_cb:
                out = langfuse_langchain_callbacks()
        self.assertEqual(len(out), 1)
        mock_cb.assert_called_once()

    def test_import_error_returns_empty(self) -> None:
        import builtins

        real_import = builtins.__import__

        def selective_import(name, *args, **kwargs):
            if name == "langfuse" or name.startswith("langfuse."):
                raise ModuleNotFoundError("langfuse")
            return real_import(name, *args, **kwargs)

        with patch.dict(os.environ, self._base_env(), clear=False):
            with patch("builtins.__import__", side_effect=selective_import):
                with self.assertLogs(lf_mod.__name__, level=logging.WARNING):
                    self.assertEqual(langfuse_langchain_callbacks(), [])


if __name__ == "__main__":
    unittest.main()
