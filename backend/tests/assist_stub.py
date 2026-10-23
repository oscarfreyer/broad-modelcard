"""A stub model provider on 127.0.0.1 for the helper tests: no real model, no network.

``StubProvider`` serves ``POST /v1/messages`` (the Anthropic Messages API
shape) and ``POST /v1/chat/completions`` (the OpenAI-compatible shape). Each
request is recorded (headers and JSON body) and answered by ``respond``, a
function the test sets: ``respond(path, headers, body) -> (status, json body,
extra headers)``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable


class StubProvider:
    def __init__(self):
        self.requests: list[dict] = []
        self.respond: Callable[[str, dict, dict], tuple[int, dict, dict]] = lambda path, headers, body: (500, {}, {})
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep test output quiet
                pass

            def _answer(self, method: str) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError:
                    body = {}
                headers = {key.lower(): value for key, value in self.headers.items()}
                stub.requests.append({"method": method, "path": self.path, "headers": headers, "body": body, "raw": raw})
                status, answer, extra = stub.respond(self.path, headers, body)
                payload = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                for name, value in extra.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):  # noqa: N802
                self._answer("POST")

            def do_GET(self):  # noqa: N802
                self._answer("GET")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self) -> "StubProvider":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()


def anthropic_text(text: str) -> dict:
    return {"id": "msg_stub", "type": "message", "role": "assistant", "model": "stub", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 1, "output_tokens": 1}}


def anthropic_tool_use(tool_id: str, query: str) -> dict:
    return {"id": "msg_stub", "type": "message", "role": "assistant", "model": "stub", "stop_reason": "tool_use",
            "content": [{"type": "text", "text": "Searching."},
                        {"type": "tool_use", "id": tool_id, "name": "search_conditions", "input": {"query": query}}],
            "usage": {"input_tokens": 1, "output_tokens": 1}}


def openai_text(text: str) -> dict:
    return {"id": "chat_stub", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]}
