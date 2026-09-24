"""Guard native filesystem tools as well as builtins during preview generation."""
from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import SystemMessage, ToolMessage

from helpudoc_agent.slide_style_preview import preview_request, preview_tool_error


class SlideStylePreviewMiddleware(AgentMiddleware):
    def before_model(self, state, runtime):
        context = getattr(runtime, "context", None)
        request = preview_request(context if isinstance(context, dict) else None)
        if request is None:
            return None
        return {"messages": [SystemMessage(content=(
            "This is a protected style-preview turn for an EXISTING HTML deck, not creation or PPTX. "
            "Load frontend-slides in Mode C, read the selected design and original deck. "
            f"Only {request.get('output', '(invalid preview path)')} may be written. "
            "Keep the original unchanged. Do not ask setup/style questions. Generate a complete "
            "self-contained HTML draft with the original slide count, content and order. "
            "Report the preview path when complete; the user will compare and apply it in the UI."
        ))]}

    @staticmethod
    def _error(request):
        context = getattr(request.runtime, "context", None)
        call = request.tool_call
        error = preview_tool_error(context if isinstance(context, dict) else None, call["name"], call.get("args", {}))
        if error:
            return ToolMessage(content=error, tool_call_id=call["id"], name=call["name"], status="error")
        return None

    def wrap_tool_call(self, request, handler):
        return self._error(request) or handler(request)

    async def awrap_tool_call(self, request, handler):
        return self._error(request) or await handler(request)
