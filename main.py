"""QwenHub backend: chat + Livepeer MCP generation."""

import base64
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

import livepeer_client as lp
import llm_client

OUTPUT_DIR = Path("outputs")
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="QwenHub", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

LIVEPEER_API_KEY = os.getenv("LIVEPEER_API_KEY", "")
_DEFAULT_CAPABILITIES: list[dict] = []


def _resolve_capability(raw_name: str, mode: str, caps: list[dict]) -> str | None:
    name = (raw_name or "").strip().lower()
    if not name:
        return None
    if not caps:
        return raw_name

    exact = next((c["name"] for c in caps if c.get("name", "").lower() == name), None)
    if exact:
        return exact

    contains = next(
        (c["name"] for c in caps if name in c.get("name", "").lower() or c.get("name", "").lower() in name),
        None,
    )
    if contains:
        return contains

    words = [w for w in name.replace("-", " ").replace("_", " ").split() if len(w) > 2]
    if words:
        best = max(
            ((c, sum(1 for w in words if w in c.get("name", "").lower())) for c in caps),
            key=lambda x: x[1],
        )
        if best[1] > 0:
            return best[0]["name"]

    if mode == "image":
        fallback = next((c for c in caps if re.search(r"flux|image|krea|schnell|dev|pro", c.get("name", ""), re.I)), None)
    else:
        fallback = next(
            (c for c in caps if re.search(r"i2v|t2v|video|minimax|kling|ltx|veo|seedance|wan", c.get("name", ""), re.I)),
            None,
        )
    return fallback["name"] if fallback else raw_name


async def _cached_capabilities() -> list[dict]:
    global _DEFAULT_CAPABILITIES
    if not _DEFAULT_CAPABILITIES:
        try:
            caps = await lp.list_capabilities(api_key=LIVEPEER_API_KEY)
            # Filter to media-generation capabilities only
            _DEFAULT_CAPABILITIES = [
                {
                    "name": c.get("name"),
                    "kind": c.get("kind"),
                    "description": (c.get("description") or "")[:120],
                }
                for c in caps
                if c.get("kind") == "ai" or any(kw in (c.get("name") or "").lower() for kw in ("flux", "image", "video", "i2v", "t2v", "schnell"))
            ]
        except Exception as exc:
            print(f"[QwenHub] failed to fetch capabilities: {exc}")
            _DEFAULT_CAPABILITIES = []
    return _DEFAULT_CAPABILITIES


@app.on_event("startup")
async def startup():
    await _cached_capabilities()
    print(f"[QwenHub] {len(_DEFAULT_CAPABILITIES)} capabilities cached")


def _save_blob(blob: bytes, ext: str) -> str:
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    path = OUTPUT_DIR / name
    path.write_bytes(blob)
    return name


@app.post("/api/chat")
async def chat(payload: dict[str, Any]):
    messages = payload.get("messages") or []
    image_b64 = payload.get("image_b64")
    video_b64 = payload.get("video_b64")
    last_output_url = payload.get("last_output_url")

    # Build multimodal user message if media attached
    user_content: list[dict] = [{"type": "text", "text": messages[-1].get("content", "") if messages else ""}]
    reference_image_url: str | None = None

    if image_b64:
        data = base64.b64decode(image_b64, validate=True)
        reference_image_url = await lp.upload_file(data, "reference.jpg", api_key=LIVEPEER_API_KEY)
        user_content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}})

    if video_b64:
        # For now, video is only for review; we do not auto-extract frames.
        user_content.append({"type": "text", "text": "[A video clip is attached for review/refinement context.]"})

    if len(messages) == 1 or messages[-1].get("role") != "user":
        messages = messages + [{"role": "user", "content": user_content}]
    else:
        messages[-1]["content"] = user_content

    # Inject capabilities and last output into system prompt
    caps = await _cached_capabilities()
    cap_block = json.dumps(caps[:120], indent=2)
    extra = f"\n\nAVAILABLE CAPABILITIES:\n{cap_block}"
    if last_output_url:
        extra += f"\n\nLAST_GENERATED_OUTPUT_URL: {last_output_url}"

    system_prompt = llm_client.DEFAULT_SYSTEM_PROMPT + extra

    try:
        result = await llm_client.chat_direct(messages, system_prompt=system_prompt)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"LLM error: {exc}")

    action = result.get("action")
    if not action:
        return {"message": result.get("message", ""), "action": None}

    mode = action.get("mode", "video")
    capability = _resolve_capability(action.get("capability"), mode, caps)
    prompt = action.get("prompt", "")
    duration = action.get("duration")
    aspect_ratio = action.get("aspect_ratio")
    use_reference = action.get("use_reference", False)

    image_url = None
    if use_reference:
        if reference_image_url:
            image_url = reference_image_url
        elif last_output_url:
            # Re-upload last output so Livepeer can use it
            try:
                blob = await lp.download_media(last_output_url, api_key=LIVEPEER_API_KEY)
                ext = Path(last_output_url).suffix or ".bin"
                image_url = await lp.upload_file(blob, f"reference{ext}", api_key=LIVEPEER_API_KEY)
            except Exception as exc:
                print(f"[QwenHub] failed to re-upload last output: {exc}")

    try:
        blob, filename, report = await lp.generate(
            capability=capability,
            prompt=prompt,
            api_key=LIVEPEER_API_KEY,
            image_url=image_url,
            duration=duration if mode == "video" else None,
            aspect_ratio=aspect_ratio,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Livepeer error: {exc}")

    saved_name = _save_blob(blob, Path(filename).suffix)
    local_url = f"/outputs/{saved_name}"

    return {
        "message": result.get("message", ""),
        "action": action,
        "media_url": local_url,
        "mode": mode,
        "report": report,
    }


@app.get("/outputs/{filename}")
async def serve_output(filename: str):
    path = OUTPUT_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path)


@app.get("/api/capabilities")
async def capabilities():
    return await _cached_capabilities()


# Static UI
app.mount("/", StaticFiles(directory="static", html=True), name="static")
