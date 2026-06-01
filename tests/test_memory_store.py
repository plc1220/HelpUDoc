import pytest

from helpudoc_agent.memory_store import UserScopedStoreBackend, user_memory_namespace


class RuntimeStub:
    def __init__(self, *, context=None, config=None):
        self.context = context
        self.config = config


def test_user_scoped_store_backend_uses_runtime_context_user_id():
    backend = UserScopedStoreBackend()

    namespace = backend._namespace_from_runtime(
        RuntimeStub(context={"user_id": "user-123"})
    )

    assert namespace == user_memory_namespace("user-123")


def test_user_scoped_store_backend_falls_back_to_configurable_user_id():
    backend = UserScopedStoreBackend()

    namespace = backend._namespace_from_runtime(
        RuntimeStub(config={"configurable": {"userId": "user-abc"}})
    )

    assert namespace == user_memory_namespace("user-abc")


def test_user_scoped_store_backend_supports_legacy_fallback_runtime():
    fallback_runtime = RuntimeStub(context={"user_id": "legacy-user"})
    backend = UserScopedStoreBackend(fallback_runtime)

    namespace = backend._namespace_from_runtime(RuntimeStub(context={}))

    assert namespace == user_memory_namespace("legacy-user")


def test_user_scoped_store_backend_requires_user_id():
    backend = UserScopedStoreBackend()

    with pytest.raises(ValueError, match="user_id is required"):
        backend._namespace_from_runtime(RuntimeStub(context={}))
