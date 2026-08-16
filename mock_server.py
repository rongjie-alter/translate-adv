"""Mock OpenAI-compatible endpoint for exercising the translation orchestration.

Implements just enough of the API for the web app: chat completions, a model list,
CORS preflight, and a usage block. The point is the failure modes -- rate limits,
transient errors, dropped ids, truncated output -- which are hard to trigger on
purpose against a real endpoint.

    py mock_server.py --port 8787 --rpm 6 --drop-rate 0.1 --fail-rate 0.1

Then add http://localhost:8787/v1 as an endpoint in the app's settings.
"""

import argparse
import json
import random
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ID_LINE = re.compile(r'^(\d+)[ \t](.*)$')
STRUCTURE = re.compile(r'^\s*(==|=>|\?|~)')
SPEAKER = re.compile(r'^(?:>\S+ |# )?(?:([^:：]{1,24})[:：] )?(.*)$')

MODEL_ID = "mock-translate-1"


class Limiter:
  """Sliding-window request-per-minute counter, shared across threads."""

  def __init__(self, rpm):
    self.rpm = rpm
    self.hits = []
    self.lock = threading.Lock()

  def check(self):
    """Return seconds to wait, or 0 when the request is allowed."""
    if not self.rpm:
      return 0
    with self.lock:
      now = time.monotonic()
      self.hits = [t for t in self.hits if now - t < 60]
      if len(self.hits) >= self.rpm:
        return max(1, int(60 - (now - self.hits[0])) + 1)
      self.hits.append(now)
      return 0


def count_tokens(s):
  """Rough CJK-aware token count, close enough to make the app's estimate meaningful."""
  cjk = sum(1 for c in s if ord(c) > 0x2E80)
  return cjk + max(1, (len(s) - cjk) // 4)


def translate_line(text, lang):
  """Deterministic stand-in for a translation.

  Keeps `{param}` placeholders and the `^`/`*` markers intact so the app's
  round-trip handling is actually exercised.
  """
  m = SPEAKER.match(text)
  body = m.group(2) if m else text
  tag = {"en": "EN", "zh-hans": "简", "zh-hant": "繁"}.get(lang, "TL")
  return f"[{tag}] {body}"


def detect_lang(prompt):
  low = prompt.lower()
  for key, lang in (("simplified", "zh-hans"), ("traditional", "zh-hant"), ("english", "en")):
    if key in low:
      return lang
  return "en"


class Handler(BaseHTTPRequestHandler):
  protocol_version = "HTTP/1.1"

  def log_message(self, fmt, *a):
    print(f"[mock] {self.address_string()} {fmt % a}")

  def _cors(self):
    self.send_header("Access-Control-Allow-Origin", "*")
    self.send_header("Access-Control-Allow-Headers", "*")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    self.send_header("Access-Control-Max-Age", "86400")

  def _send(self, code, obj, extra_headers=()):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    self.send_response(code)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    for k, v in extra_headers:
      self.send_header(k, v)
    self._cors()
    self.end_headers()
    self.wfile.write(body)

  def _error(self, code, message, kind, extra_headers=()):
    self._send(code, {"error": {"message": message, "type": kind, "code": code}}, extra_headers)

  def do_OPTIONS(self):
    self.send_response(204)
    self.send_header("Content-Length", "0")
    self._cors()
    self.end_headers()

  def do_GET(self):
    if self.path.rstrip("/").endswith("/models"):
      self._send(200, {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "owned_by": "mock"}],
      })
      return
    self._error(404, f"no route for {self.path}", "invalid_request_error")

  def do_POST(self):
    if not self.path.rstrip("/").endswith("/chat/completions"):
      self._error(404, f"no route for {self.path}", "invalid_request_error")
      return

    cfg = self.server.cfg
    length = int(self.headers.get("Content-Length", 0))
    raw = self.rfile.read(length).decode("utf-8") if length else "{}"

    if cfg.require_key and not self.headers.get("Authorization"):
      self._error(401, "missing api key", "authentication_error")
      return

    wait = self.server.limiter.check()
    if wait:
      self._error(429, f"rate limit exceeded, retry in {wait}s", "rate_limit_error",
                  [("Retry-After", str(wait))])
      return

    if cfg.fail_rate and random.random() < cfg.fail_rate:
      self._error(503, "mock transient failure", "server_error")
      return

    try:
      req = json.loads(raw)
    except json.JSONDecodeError as e:
      self._error(400, f"bad json: {e}", "invalid_request_error")
      return

    messages = req.get("messages", [])
    system = "\n".join(m.get("content", "") for m in messages if m.get("role") == "system")
    user = "\n".join(m.get("content", "") for m in messages if m.get("role") == "user")
    lang = detect_lang(system)

    out = []
    for line in user.split("\n"):
      if STRUCTURE.match(line):
        continue
      m = ID_LINE.match(line.strip())
      if not m:
        continue
      if cfg.drop_rate and random.random() < cfg.drop_rate:
        continue
      out.append(f"{m.group(1)} {translate_line(m.group(2), lang)}")

    content = "\n".join(out)
    finish = "stop"
    if cfg.truncate and random.random() < cfg.truncate:
      content = content[: max(1, len(content) // 2)]
      finish = "length"

    if cfg.latency_ms:
      time.sleep(cfg.latency_ms / 1000.0)

    prompt_tokens = count_tokens(system) + count_tokens(user)
    completion_tokens = count_tokens(content)

    message = {"role": "assistant", "content": content}
    usage = {
      "prompt_tokens": prompt_tokens,
      "completion_tokens": completion_tokens,
      "total_tokens": prompt_tokens + completion_tokens,
    }
    # Mirrors Gemini's OpenAI-compat "include thoughts" response shape, so the
    # per-call debug view can be exercised without a real Gemini key.
    thinking_config = req.get("extra_body", {}).get("google", {}).get("thinking_config", {})
    if thinking_config.get("include_thoughts"):
      reasoning_tokens = max(1, completion_tokens // 4)
      message["reasoning_content"] = f"(mock reasoning) considering {len(out)} line(s) in {lang}…"
      usage["completion_tokens_details"] = {"reasoning_tokens": reasoning_tokens}
      usage["total_tokens"] += reasoning_tokens

    self._send(200, {
      "id": f"chatcmpl-mock-{random.randint(1000, 9999)}",
      "object": "chat.completion",
      "created": int(time.time()),
      "model": req.get("model", MODEL_ID),
      "choices": [{
        "index": 0,
        "message": message,
        "finish_reason": finish,
      }],
      "usage": usage,
    })


def main():
  p = argparse.ArgumentParser(description=__doc__,
                              formatter_class=argparse.RawDescriptionHelpFormatter)
  p.add_argument("--port", type=int, default=8787)
  p.add_argument("--host", default="127.0.0.1")
  p.add_argument("--rpm", type=int, default=0, help="requests per minute before 429 (0 = no limit)")
  p.add_argument("--fail-rate", type=float, default=0.0, help="chance of a 503")
  p.add_argument("--drop-rate", type=float, default=0.0, help="chance of omitting each line")
  p.add_argument("--truncate", type=float, default=0.0, help="chance of a cut-off response")
  p.add_argument("--latency-ms", type=int, default=0)
  p.add_argument("--seed", type=int, default=None, help="make the failure injection reproducible")
  p.add_argument("--require-key", action="store_true", help="401 without an Authorization header")
  cfg = p.parse_args()

  if cfg.seed is not None:
    random.seed(cfg.seed)

  server = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
  server.cfg = cfg
  server.limiter = Limiter(cfg.rpm)
  print(f"[mock] listening on http://{cfg.host}:{cfg.port}/v1  model={MODEL_ID}")
  print(f"[mock] rpm={cfg.rpm or 'unlimited'} fail={cfg.fail_rate} drop={cfg.drop_rate} "
        f"truncate={cfg.truncate} latency={cfg.latency_ms}ms")
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("\n[mock] bye")


if __name__ == "__main__":
  main()
