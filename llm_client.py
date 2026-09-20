"""OpenAI-compatible chat client for QwenHub."""

import json
import os
import re
from typing import Any

from openai import AsyncOpenAI

DEFAULT_SYSTEM_PROMPT = """You are QwenHub, an AI director for the Livepeer Agent network.
The user chats in natural language. Decide the next media generation action.

Inputs you may receive:
- attached_image: a base64 image the user uploaded.
- attached_video_frames: sampled frames from an uploaded video.
- last_output_url: URL of the previously generated image/video, if any.
- available_capabilities: list of Livepeer capabilities (name, kind, description).

Rules:
1. If the user asks for a photo/image/picture: mode="image", pick an image-generation capability (flux-schnell, flux-dev, flux-pro, qwen-image-3-t2i, gpt-image, gemini-image, grok-image-2, etc.).
2. If the user asks for a video/clip/animation: mode="video", pick a video capability.
   - If an image is attached or a previous image output exists, prefer an i2v capability (minimax-h3-i2v, kling-o3-i2v, ltx-i2v, seedance-i2v, etc.).
   - Otherwise pick a t2v capability (minimax-h3-t2v, kling-o3-t2v, ltx-t2v, veo-t2v, etc.).
3. Prompt must be English, shot-native, concise but complete:
   - camera movement and framing
   - subject action and pacing
   - lighting and atmosphere
   For still images: detailed realistic description with style, subject, setting, light.
4. Duration: default 5s for video. Use shorter (2-3s) for seamless loops. Max 10s unless user asks more.
5. Aspect ratio: default 16:9. Use 9:16 for vertical, 1:1 for square if requested.
6. If the user refines a previous output ("make it faster", "orbit camera", "pan left"), keep the same subject/style and only change what they asked. Set use_reference=true if a reference image/URL is available.
7. Do NOT describe the attached image yourself in the prompt; the Livepeer model sees the reference image. Only provide the action/camera/motion instruction.
8. The reply text must be in the SAME LANGUAGE as the user's last message.

Output exactly one JSON object, no text outside it:
{
  "message": "short reply in the user's language",
  "action": {
    "mode": "image" | "video",
    "capability": "exact Livepeer capability name",
    "prompt": "English generation prompt",
    "duration": 5,
    "aspect_ratio": "16:9",
    "use_reference": false
  }
}

If the user is just chatting or asking a question, set action to null."""


def _client() -> AsyncOpenAI:
    base_url = os.getenv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1")
    api_key = os.getenv("OPENAI_API_KEY", "")
    return AsyncOpenAI(base_url=base_url, api_key=api_key)


def _default_model() -> str:
    return os.getenv("MODEL", "qwen/qwen-2.5-7b-instruct")


def _strip_json_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


async def chat_direct(
    messages: list[dict[str, Any]],
    system_prompt: str | None = None,
    model: str | None = None,
    temperature: float = 0.6,
) -> dict:
    """Send messages to the LLM and return parsed JSON action."""
    client = _client()
    model = model or _default_model()

    full_messages = [{"role": "system", "content": system_prompt or DEFAULT_SYSTEM_PROMPT}] + messages

    resp = await client.chat.completions.create(
        model=model,
        messages=full_messages,
        temperature=temperature,
        max_tokens=2048,
    )
    raw = resp.choices[0].message.content or "{}"
    raw = _strip_json_fences(raw)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"LLM did not return valid JSON: {e}\nRaw: {raw}") from e

    return {
        "message": data.get("message", ""),
        "action": data.get("action"),
    }
