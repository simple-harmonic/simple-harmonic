"""LIVE demo — how Simple Harmonic talks to the real Codex model (app-server).

No mocking: this spawns the real `codex app-server`, passes the tool as a
STRUCTURED `dynamicTools` field (not prompt text), drives a real turn via the
adapter's own `_run_turn`, and shows codex calling the tool back natively via
`item/tool/call`.

    initialize (experimentalApi)  ->  thread/start { dynamicTools: [...] }
    turn/start { input }          ->  item/tool/call  ->  agentMessage  ->  turn/completed

Run:  uv run --project backend-py python backend-py/demo_codex_live.py
Needs: codex CLI installed + `codex login`.
"""

from __future__ import annotations

import asyncio
import json

from simple_harmonic.meta_agent import codex_adapter as ca


def hr(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


async def demo_app_server() -> None:
    """LIVE app-server demo — tools passed as a STRUCTURED `dynamicTools` field.

    Spawns the real `codex app-server`, registers a dynamic tool on `thread/start`,
    runs a real turn via the adapter's own `_run_turn`, and shows codex calling the
    tool back natively (`item/tool/call`) — no tool text in the prompt.
    """
    import os
    import tempfile

    hr("APP-SERVER RUNTIME — tools as a STRUCTURED field, not prompt text")

    with tempfile.TemporaryDirectory() as tmp:
        codex_home = ca.ensure_isolated_codex_home(tmp)
        client = await ca.spawn_codex_app_server(codex_home=codex_home)
        try:
            await asyncio.wait_for(
                client.initialize(
                    {"name": "simple-harmonic", "title": "Simple Harmonic", "version": "0.1.0"}
                ),
                30,
            )
            print("handshake ok — initialize sent the experimentalApi capability that unlocks dynamicTools")

            # The tools: a STRUCTURED dynamicTools array (DynamicToolSpec), NOT prompt text.
            thread_params = {
                "model": "gpt-5.5",
                "cwd": os.getcwd(),
                "ephemeral": True,
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "developerInstructions": (
                    "You are Scout. When asked to log an action, call the report_action dynamic tool."
                ),
                "dynamicTools": [
                    {
                        "name": "report_action",
                        "description": "Record what the agent just did.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "action_type": {"type": "string"},
                                "summary": {"type": "string"},
                            },
                            "required": ["action_type", "summary"],
                        },
                    }
                ],
            }
            hr("1. thread/start — dynamicTools is a STRUCTURED array (the native field)")
            print(json.dumps(thread_params, indent=2))
            started = await asyncio.wait_for(client.request("thread/start", thread_params), 30)
            thread_id = None
            if isinstance(started, dict):
                thread_id = (started.get("thread") or {}).get("id") or started.get("threadId")
            print(f"\n<< thread started: {thread_id}")

            tool_calls: list[tuple[str, object]] = []

            def emit(event: str, payload: dict) -> None:
                print(f"   [event] {event}: {json.dumps(payload)[:180]}")

            async def handle_tool_call(call: ca._IncomingToolCall) -> dict:
                hr("2. codex calls the dynamic tool NATIVELY (item/tool/call)")
                print(f"tool={call.tool}  args={json.dumps(call.arguments)}")
                tool_calls.append((call.tool, call.arguments))
                return {"resultText": json.dumps({"ok": True, "recorded": call.arguments})}

            usage = {"inputTokens": 0, "outputTokens": 0}
            hr("3. turn/start — the prompt itself carries NO tool definitions")
            input_text = "Log that you reviewed the launch backlog. Call the report_action tool."
            print(repr(input_text))
            outcome = await asyncio.wait_for(
                ca._run_turn(
                    client=client,
                    thread_id=str(thread_id),
                    input_text=input_text,
                    model="gpt-5.5",
                    signal=None,
                    emit=emit,
                    usage=usage,
                    handle_tool_call=handle_tool_call,
                ),
                180,
            )

            hr("4. RESULT")
            print("tool calls codex made :", tool_calls)
            print("final agent message   :", outcome.finalText)
            print("status                :", outcome.status, "| error:", getattr(outcome, "error", None))
            print("token usage           :", usage)
        finally:
            client.close()


if __name__ == "__main__":
    asyncio.run(demo_app_server())
