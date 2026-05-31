"""Anthropic Claude API wrapper for TG Service AI modules."""

from __future__ import annotations

import structlog
from anthropic import Anthropic

from app.config import settings

log = structlog.get_logger(__name__)


def get_client() -> Anthropic:
    """Get Anthropic client. Uses API key from settings or env."""
    api_key = settings.anthropic_api_key
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")
    return Anthropic(api_key=api_key)


# ── Cost tables (USD per 1K tokens) ─────────────────────────────────────────

_COST_PER_1K_IN: dict[str, float] = {
    "claude-haiku-4-5-20251001": 0.001,
    "claude-sonnet-4-6-20260514": 0.003,
    "claude-opus-4-6-20260514": 0.015,
}

_COST_PER_1K_OUT: dict[str, float] = {
    "claude-haiku-4-5-20251001": 0.005,
    "claude-sonnet-4-6-20260514": 0.015,
    "claude-opus-4-6-20260514": 0.075,
}


def _estimate_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    """Estimate USD cost for a given model and token counts."""
    ci = _COST_PER_1K_IN.get(model, 0.001)
    co = _COST_PER_1K_OUT.get(model, 0.005)
    return round((tokens_in / 1000) * ci + (tokens_out / 1000) * co, 6)


def generate_message(
    system_prompt: str,
    user_message: str,
    model: str = "claude-haiku-4-5-20251001",
    max_tokens: int = 1024,
    temperature: float = 0.7,
) -> dict:
    """Generate a single message using Claude.

    Returns:
        {
            "text": "generated response",
            "model": "model used",
            "tokens_in": N,
            "tokens_out": N,
            "cost_usd": float,  # estimated
        }
    """
    client = get_client()

    log.info(
        "claude_api_call",
        model=model,
        system_len=len(system_prompt),
        user_len=len(user_message),
    )

    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )

    text = response.content[0].text if response.content else ""
    tokens_in = response.usage.input_tokens
    tokens_out = response.usage.output_tokens
    cost = _estimate_cost(model, tokens_in, tokens_out)

    log.info(
        "claude_api_response",
        model=model,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost,
    )

    return {
        "text": text,
        "model": model,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost,
    }


def generate_chat(
    system_prompt: str,
    messages: list[dict],
    model: str = "claude-haiku-4-5-20251001",
    max_tokens: int = 1024,
    temperature: float = 0.7,
) -> dict:
    """Generate response in a multi-turn conversation.

    Args:
        messages: List of {"role": "user"|"assistant", "content": "..."}

    Returns:
        {
            "text": "generated response",
            "model": "model used",
            "tokens_in": N,
            "tokens_out": N,
            "cost_usd": float,
        }
    """
    client = get_client()

    log.info(
        "claude_chat_call",
        model=model,
        system_len=len(system_prompt),
        turns=len(messages),
    )

    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system_prompt,
        messages=messages,
    )

    text = response.content[0].text if response.content else ""
    tokens_in = response.usage.input_tokens
    tokens_out = response.usage.output_tokens
    cost = _estimate_cost(model, tokens_in, tokens_out)

    log.info(
        "claude_chat_response",
        model=model,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost,
    )

    return {
        "text": text,
        "model": model,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost,
    }
