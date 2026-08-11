"""Gemini HTTP/search timeout configuration and bounded LangChain invokes."""
from __future__ import annotations

import concurrent.futures
import logging
import os
import random
import time
from typing import Any, Callable, Tuple

from .constants import MIN_GEMINI_TIMEOUT_S

logger = logging.getLogger(__name__)


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        logger.warning("Invalid int for %s=%r; using default=%s", name, raw, default)
        return default


def env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        logger.warning("Invalid float for %s=%r; using default=%s", name, raw, default)
        return default


def clamp_min(name: str, value: int, minimum: int) -> int:
    if value < minimum:
        logger.warning("%s=%s is too small; clamping to %s", name, value, minimum)
        return minimum
    return value


DEFAULT_HTTP_TIMEOUT = clamp_min(
    "GEMINI_HTTP_TIMEOUT_SECONDS",
    env_int("GEMINI_HTTP_TIMEOUT_SECONDS", 180),
    MIN_GEMINI_TIMEOUT_S,
)
DEFAULT_SEARCH_HTTP_TIMEOUT = clamp_min(
    "GEMINI_SEARCH_HTTP_TIMEOUT_SECONDS",
    env_int("GEMINI_SEARCH_HTTP_TIMEOUT_SECONDS", 90),
    MIN_GEMINI_TIMEOUT_S,
)
DEFAULT_SEARCH_TIMEOUT = max(
    clamp_min(
        "GOOGLE_SEARCH_TIMEOUT_SECONDS",
        env_int("GOOGLE_SEARCH_TIMEOUT_SECONDS", 100),
        MIN_GEMINI_TIMEOUT_S,
    ),
    DEFAULT_SEARCH_HTTP_TIMEOUT + 5,
)
DEFAULT_SEARCH_MAX_ATTEMPTS = min(
    3,
    clamp_min(
        "GOOGLE_SEARCH_MAX_ATTEMPTS",
        env_int("GOOGLE_SEARCH_MAX_ATTEMPTS", 2),
        1,
    ),
)
DEFAULT_SEARCH_MAX_CONSECUTIVE_FAILURES = min(
    3,
    clamp_min(
        "GOOGLE_SEARCH_MAX_CONSECUTIVE_FAILURES",
        env_int("GOOGLE_SEARCH_MAX_CONSECUTIVE_FAILURES", 2),
        1,
    ),
)
DEFAULT_SEARCH_RETRY_BASE_DELAY = max(
    0.0,
    env_float("GOOGLE_SEARCH_RETRY_BASE_DELAY_SECONDS", 1.0),
)
SEARCH_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def seconds_to_ms(seconds: int) -> int:
    # google.genai HttpOptions.timeout is milliseconds (see google.genai._api_client.get_timeout_in_seconds).
    return int(seconds) * 1000


def search_retry_delay(attempt: int) -> float:
    """Return bounded exponential backoff with jitter for a failed search attempt."""
    exponent = max(0, int(attempt) - 1)
    base = min(8.0, DEFAULT_SEARCH_RETRY_BASE_DELAY * (2**exponent))
    return base * random.uniform(0.75, 1.25)


def invoke_lc_with_timeout(
    invoke: Callable[[], Any],
    *,
    timeout_s: int,
    label: str,
) -> Tuple[Any, str | None]:
    start = time.monotonic()
    logger.info("%s started", label)
    future = SEARCH_EXECUTOR.submit(invoke)
    try:
        response = future.result(timeout=timeout_s)
    except concurrent.futures.TimeoutError:
        future.cancel()
        logger.warning("%s timed out after %ss", label, timeout_s)
        return None, f"timeout after {timeout_s}s"
    except Exception as exc:
        logger.exception("%s failed", label)
        return None, str(exc)
    finally:
        elapsed = time.monotonic() - start
        logger.info("%s completed in %.2fs", label, elapsed)
    return response, None
