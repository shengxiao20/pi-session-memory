"""Strict, local-only Ollama BGE-M3 client. No startup, pull, retry or truncation."""
import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import numpy as np

MODEL = "bge-m3:latest"
DIMENSION = 1024
CONTEXT_WINDOW = 8192


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("Ollama redirects are disabled; use the local root URL")


class BgeM3Client:
    def __init__(self, base_url="http://127.0.0.1:11434", timeout=300):
        url = urlsplit(base_url)
        if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
                or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError("base URL must be a local HTTP root URL")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = build_opener(ProxyHandler({}), _NoRedirects())

    def _request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf8")
        request = Request(self.base_url + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"Ollama HTTP {error.code}: {error.read().decode('utf8')}") from error

    def profile(self):
        models = self._request("/api/tags")["models"]
        matches = [model for model in models if model["name"] == MODEL]
        if len(matches) != 1:
            raise RuntimeError(f"{MODEL} must be installed exactly once; run ollama pull bge-m3")
        info = self._request("/api/show", {"model": MODEL})["model_info"]
        if info["bert.embedding_length"] != DIMENSION or info["bert.context_length"] != CONTEXT_WINDOW:
            raise RuntimeError("BGE-M3 must have 1024 dimensions and an 8192-token context")
        return {"model": MODEL, "digest": matches[0]["digest"], "dimension": DIMENSION,
                "context_window": CONTEXT_WINDOW, "normalization": "l2-float32-v1",
                "document_template": "User: {user_text}\n\nAssistant: {reply_text}",
                "query_template": "raw-query", "truncate": False,
                "num_batch": CONTEXT_WINDOW}

    @staticmethod
    def _normalize(values, count):
        vectors = np.asarray(values, dtype=np.float32)
        if vectors.shape != (count, DIMENSION) or not np.isfinite(vectors).all():
            raise ValueError(f"expected {count} finite vectors with {DIMENSION} dimensions")
        norms = np.linalg.norm(vectors.astype(np.float64), axis=1)
        if np.any(norms <= 0):
            raise ValueError("zero-length embedding")
        return (vectors / norms[:, None]).astype("<f4")

    def embed(self, texts):
        if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("embedding inputs must be non-empty text")
        result = self._request("/api/embed", {"model": MODEL, "input": texts,
            "truncate": False, "options": {"num_ctx": CONTEXT_WINDOW, "num_batch": CONTEXT_WINDOW},
            "keep_alive": "10m"})
        if result["model"] != MODEL:
            raise RuntimeError("Ollama returned a different model")
        return self._normalize(result["embeddings"], len(texts))
