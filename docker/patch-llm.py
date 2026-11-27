#!/usr/bin/env python3
"""Make Horon's model calls configurable and give the two fragile ones a fallback.

Applied by docker/entrypoint.sh at every container start, and by the plugin itself for the
spawn / artifact runtimes (pass the Horon root's backend/llm.py as argv[1]). Upstream's `backend/llm.py` is not ours
to edit, so this appends one marked block to it and rewrites the three model constants to read
the environment. Everything is idempotent: running it twice changes nothing.

Why each piece:

1. **Constants read the environment.** The settings page writes `HORON_NAMER_MODEL`,
   `HORON_JEV_MODEL` and friends; hard-coded constants meant the only way to change a model was
   to rebuild the image.

2. **A fallback chain per endpoint.** `openai/gpt-6-luna` answers 403 "not available in your
   region" from some networks, and the decisions endpoint can be unreachable or refuse the
   configured decider. Each endpoint gets one optional fallback (base URL + key + model) that is
   tried only after the primary raises.

3. **`max_tokens` on the chat call.** Upstream sends no cap, so OpenRouter reserves room for the
   model's whole output window and refuses with HTTP 402 as soon as the account cannot cover
   that reservation. A node name is a few words.

The fallback is *not* used for embeddings: a vector from a different model cannot be compared
with the ones already stored, so silently switching would corrupt semantic search.
"""

from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/app/backend/llm.py")

MARKER = "# ---- dsh-horon: configurable model routes"

# ── 1. constants read the environment ────────────────────────────────────────────────────────

CONSTANT_SWAPS = [
    # The three endpoints, so an install can point embeddings (or anything else) at a local
    # gateway. Ollama's /v1/embeddings speaks the same protocol as OpenRouter's, so a plain base
    # URL swap is enough; no per-provider adapter is needed.
    (
        'EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings"',
        'EMBEDDINGS_ENDPOINT = os.environ.get("HORON_EMBEDDINGS_ENDPOINT", "").strip()'
        ' or "https://openrouter.ai/api/v1/embeddings"',
    ),
    (
        'DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"',
        'DECISIONS_ENDPOINT = os.environ.get("HORON_DECISIONS_ENDPOINT", "").strip()'
        ' or "https://openrouter.ai/api/alpha/decisions"',
    ),
    (
        'CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"',
        'CHAT_ENDPOINT = os.environ.get("HORON_CHAT_ENDPOINT", "").strip()'
        ' or "https://openrouter.ai/api/v1/chat/completions"',
    ),
    (
        'NAMER_MODEL = "openai/gpt-6-luna"',
        'NAMER_MODEL = os.environ.get("HORON_NAMER_MODEL", "").strip() or "openai/gpt-6-luna"',
    ),
    (
        'JEV_MODEL = "perplexity/pplx-decider-v1.2"',
        'JEV_MODEL = os.environ.get("HORON_JEV_MODEL", "").strip() or "perplexity/pplx-decider-v1.2"',
    ),
    (
        'EMBEDDING_MODEL = "qwen/qwen3-embedding-8b"',
        'EMBEDDING_MODEL = os.environ.get("HORON_EMBEDDING_MODEL", "").strip() or "qwen/qwen3-embedding-8b"',
    ),
]

PRICE_ANCHOR = '    "openai/gpt-6-luna": {"input": 0.0000001, "output": 0.0000005},'
PRICE_EXTRA = (
    '    "openai/gpt-6-luna": {"input": 0.0000001, "output": 0.0000005},\n'
    '    "deepseek/deepseek-v3.2": {"input": 0.00000026, "output": 0.00000038},'
)

# ── 2. the appended routing block ───────────────────────────────────────────────────────────

ROUTES = '''

# ---- dsh-horon: configurable model routes --------------------------------------------------
# Appended by the dsh-horon plugin. Upstream `backend/llm.py` is replaced on every image bump, so
# nothing above this line is edited in place beyond the three constants and the price table.
#
# Each endpoint can name one fallback (base URL + key + model). The fallback is tried only after
# the primary raises, so a healthy primary never pays for it. Embeddings have no fallback on
# purpose: vectors from two different models are not comparable, and switching silently would
# make `search_semantic` return nonsense instead of an error.

def _env(prefix: str, name: str) -> str:
    return os.environ.get(f"HORON_{prefix}_{name}", "").strip()


def _fallback_for(url: str) -> dict | None:
    """The configured fallback for this endpoint, or None when it is not set up."""
    if url == DECISIONS_ENDPOINT:
        prefix, path = "JEV_FALLBACK", "/v1/decisions"
    elif url == CHAT_ENDPOINT:
        prefix, path = "NAMER_FALLBACK", "/v1/chat/completions"
    else:
        return None  # embeddings (and anything else) never fall back
    base = _env(prefix, "BASE").rstrip("/")
    model = _env(prefix, "MODEL")
    if not base or not model:
        return None
    return {"base": base, "path": path, "model": model, "key": _env(prefix, "KEY")}


def _post_to(route: dict, payload: dict, timeout: float, kind: str | None) -> dict:
    """POST to a fallback route, reshaping the payload for it.

    `state` may be a dict (this deployment's shape) or a string (upstream's); both are sent
    as-is because the endpoint accepts either.
    """
    body = {**payload, "model": route["model"]}
    body["provider"] = {**body.get("provider", {})}
    # A local gateway does not implement OpenRouter's zero-retention switch; sending it there
    # only makes the request fail validation.
    body["provider"].pop("zdr", None)
    body["provider"].pop("data_collection", None)
    if not body["provider"]:
        body.pop("provider")
    # Cloudflare fronts some gateways and rejects the default `Python-urllib` agent outright.
    headers = {"Content-Type": "application/json", "User-Agent": "horon-dsh/1.0"}
    if route["key"]:
        headers["Authorization"] = f"Bearer {route['key']}"
    req = urllib.request.Request(
        route["base"] + route["path"],
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            reply = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"fallback HTTP {e.code} from {route['base']}{route['path']}: {text}") from e
    record_usage(kind or "fallback", route["model"], reply.get("usage"))
    return reply


_primary_post = openrouter_post


def _is_openrouter(url: str) -> bool:
    return "openrouter.ai" in url


def _post_local(url: str, payload: dict, timeout: float, kind: str | None) -> dict:
    """POST to a non-OpenRouter endpoint (Ollama, vLLM, a LAN gateway).

    Ollama's `/v1/embeddings` speaks the same JSON as OpenRouter's, so no per-provider adapter is
    needed — but two OpenRouter-isms have to go: the zero-retention `provider` block (meaningless
    there, and some gateways reject unknown keys) and the API-key requirement.
    """
    body = {k: v for k, v in payload.items() if k != "provider"}
    headers = {"Content-Type": "application/json", "User-Agent": "horon-dsh/1.0"}
    key = os.environ.get("HORON_LOCAL_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            reply = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"local HTTP {e.code} from {url}: {text}") from e
    record_usage(kind or "local", body.get("model", ""), reply.get("usage"))
    return reply


def openrouter_post(url, payload, timeout, *, kind=None):  # noqa: F811 - deliberate override
    """`openrouter_post` with a local-endpoint path and an optional per-endpoint fallback."""
    if not _is_openrouter(url):
        return _post_local(url, payload, timeout, kind)
    try:
        return _primary_post(url, payload, timeout, kind=kind)
    except Exception as primary_error:
        route = _fallback_for(url)
        if route is None:
            raise
        try:
            return _post_to(route, payload, timeout, kind)
        except Exception as fallback_error:
            raise RuntimeError(
                f"primary failed ({primary_error}); fallback failed ({fallback_error})"
            ) from fallback_error


_primary_complete_text = complete_text


def complete_text(prompt: str, *, kind: str, model: str = NAMER_MODEL, timeout: int = 120):  # noqa: F811
    """`complete_text` with a token cap and the chat fallback."""
    route = _fallback_for(CHAT_ENDPOINT)
    # A name is a few words. Without a cap OpenRouter reserves the model's whole output window
    # and answers 402 once the account cannot cover that reservation.
    payload = {
        "model": model,
        "reasoning": {"effort": "none"},
        "max_tokens": 512,
        "messages": [{"role": "user", "content": prompt}],
    }
    if os.environ.get("OPENCODE_GO_API_KEY", "").strip():
        return _primary_complete_text(prompt, kind=kind, model=model, timeout=timeout)
    try:
        data = _primary_post(CHAT_ENDPOINT, payload, timeout, kind=kind)
        return data["choices"][0]["message"]["content"] or ""
    except Exception as primary_error:
        if route is None:
            raise
        try:
            data = _post_to(route, payload, timeout, kind)
            return data["choices"][0]["message"]["content"] or ""
        except Exception as fallback_error:
            raise RuntimeError(
                f"primary failed ({primary_error}); fallback failed ({fallback_error})"
            ) from fallback_error
# ---- end dsh-horon -------------------------------------------------------------------------
'''


def main() -> int:
    if not TARGET.exists():
        print(f"patch-llm: {TARGET} is missing; nothing to patch", file=sys.stderr)
        return 0
    text = TARGET.read_text()
    original = text
    done = []

    for old, new in CONSTANT_SWAPS:
        if old in text:
            text = text.replace(old, new)
            done.append(old.split(" = ")[0])
    if PRICE_ANCHOR in text and PRICE_EXTRA not in text:
        text = text.replace(PRICE_ANCHOR, PRICE_EXTRA)
        done.append("prices")
    if MARKER not in text:
        text = text.rstrip("\n") + ROUTES
        done.append("routes")

    if text != original:
        TARGET.write_text(text)
        print(f"patch-llm: applied {', '.join(done)}", file=sys.stderr)
    else:
        print("patch-llm: already patched; left untouched", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
