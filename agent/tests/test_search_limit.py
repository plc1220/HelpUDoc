"""A run that keeps searching without finding anything must end with an answer."""
import asyncio
import json
from typing import Any
from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
import helpudoc_agent.middleware.empty_reply as m
HIT=set()
@tool
def search_document(query: str) -> str:
    "s"
    return json.dumps({"status":"ok","query":query,"resultCount":1 if query in HIT else 0})
@tool
def read(query: str) -> str:
    "r"
    return "content"
class Model(BaseChatModel):
    log: list=[]; stubborn: bool=False; stop_at: int=999; reader: bool=False; blank: bool=False
    @property
    def _llm_type(self): return "x"
    def bind_tools(self,tools,**k): return self.bind(n=len(tools))
    def _generate(self,messages,stop=None,run_manager=None,**k):
        n=len(self.log); self.log.append((k.get("n",0),str(messages[-1].content)[:60]))
        done = n>=self.stop_at or (not k.get("n") and not self.stubborn)
        if done: a=AIMessage("ANSWER")
        elif self.blank and not k.get("n"): a=AIMessage("")
        else: a=AIMessage("", tool_calls=[{"name":"read" if self.reader and n%5==4 else "search_document","args":{"query":f"C{n}"},"id":f"c{n}"}])
        return ChatResult(generations=[ChatGeneration(message=a)])
def go(limit=1000,**k):
    mod=Model(log=[],**k); a=create_agent(model=mod,tools=[search_document,read],middleware=[m.EmptyReplyMiddleware()])
    return asyncio.run(a.ainvoke({"messages":[HumanMessage("q")]},{"recursion_limit":limit})),mod
def test_guessing_ends_with_an_answer():
    r,mod=go(); assert r["messages"][-1].content=="ANSWER" and len(mod.log)==16 and mod.log[-1][0]==0
    assert not any("system note" in str(x.content) for x in r["messages"])
def test_warned_first():
    _,mod=go(); assert "system note" in mod.log[8][1] and "system note" not in mod.log[7][1] and mod.log[8][0]==2
def test_useful_results_reset_it():
    r,mod=go(reader=True,stop_at=120); assert len(mod.log)==121 and r["messages"][-1].content=="ANSWER"
def test_a_hit_resets_it():
    HIT.update({f"C{i}" for i in range(0,200,7)}); r,mod=go(stop_at=60); HIT.clear(); assert len(mod.log)==61
def test_model_that_ignores_it_still_ends():
    r,mod=go(stubborn=True); assert len(mod.log)==18 and not r["messages"][-1].tool_calls and 'found nothing' in r['messages'][-1].content
def test_normal_run_is_unchanged():
    r,mod=go(stop_at=5); assert not any("system note" in l[1] for l in mod.log)
def test_no_extra_graph_step():
    g=create_agent(model=Model(),tools=[read],middleware=[m.EmptyReplyMiddleware()]); assert set(g.nodes)=={"__start__","model","tools","EmptyReplyMiddleware.after_model"}
def test_pending_form_is_left_alone(monkeypatch):
    monkeypatch.setattr(m,"next_pending_gate",lambda c:{"gate_id":"x"}); _,mod=go(stop_at=40); assert len(mod.log)==41
def test_broken_check_never_fails_the_run(monkeypatch):
    monkeypatch.setattr(m,"empty_searches_in_a_row",lambda x:1/0); r,mod=go(stop_at=5); assert r["messages"][-1].content=="ANSWER"
def test_other_results_do_not_count():
    from langchain_core.messages import ToolMessage as T
    for c in ("[]","{bad",'{"resultCount": false}','{"resultCount": "0"}',"resultCount: 0",'{"status":"error"}'): assert not m._is_empty_search(T(c,tool_call_id="1"))

def test_planning_notes_do_not_restart_the_count():
    from langchain_core.messages import ToolMessage as T
    e=lambda i: T('{"resultCount": 0}',tool_call_id=str(i),name="search_document"); todo=T("Updated todo list",tool_call_id="t",name="write_todos"); hit=T('{"resultCount": 2}',tool_call_id="h",name="search_document"); read=T("text",tool_call_id="r",name="read_file")
    f=m.empty_searches_in_a_row
    assert f([HumanMessage("q"),*[e(i) for i in range(9)],todo,*[e(i) for i in range(6)],todo])==15
    assert f([e(1),e(2),hit,e(3),todo])==1 and f([e(1),read,e(2)])==1 and f([todo])==0

def test_plain_text_retry_gives_the_answer():
    class Late(Model):
        seen: list=[]
        def _generate(self,messages,stop=None,run_manager=None,**k):
            if any("Findings so far" in str(x.content) for x in messages):
                assert not any(x.type=="tool" for x in messages) and not any(getattr(x,"tool_calls",None) for x in messages)
                self.seen.extend(str(x.content) for x in messages); self.log.append((0,"plain")); return ChatResult(generations=[ChatGeneration(message=AIMessage("LATE ANSWER"))])
            return super()._generate(messages,stop,run_manager,**k)
    mod=Late(log=[],stubborn=True); a=create_agent(model=mod,tools=[search_document,read],middleware=[m.EmptyReplyMiddleware()]); r=asyncio.run(a.ainvoke({"messages":[HumanMessage("old"),AIMessage("old answer"),HumanMessage("q")]},{"recursion_limit":300}))
    assert r["messages"][-1].content=="LATE ANSWER" and len(mod.log)==17
    seen=mod.seen; assert "old" in seen and "old answer" in seen and any("<request>\nq\n" in x for x in seen) and any("no tools" in x for x in seen) and not any(x=="q" for x in seen)
