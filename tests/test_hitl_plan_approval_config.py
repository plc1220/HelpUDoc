from helpudoc_agent.configuration import load_settings


def test_runtime_config_exposes_request_plan_approval_interrupt() -> None:
    settings = load_settings()

    interrupt_cfg = settings.backend.interrupt_on.get("request_plan_approval")
    assert isinstance(interrupt_cfg, dict)
    assert interrupt_cfg.get("allowed_decisions") == ["approve", "edit", "reject"]


def test_runtime_config_registers_request_plan_approval_tool() -> None:
    settings = load_settings()
    assert "request_plan_approval" in settings.tools
