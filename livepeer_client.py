"""Standalone Livepeer Agent MCP client.

Raw JSON-RPC over HTTP against https://agent.livepeer.org/api/mcp/raw.
Keyless by default; a Livepeer/Daydream API key can be supplied.
"""

import asyncio
import json
import mimetypes
import re
import time
from typing import Any

import httpx

MCP_ENDPOINT = "https://agent.livepeer.org/api/mcp/raw"


def _extract_url(payload: dict) -> str | None:
    for key in ("url", "video_url", "output_url", "asset_url", "result_url"):
        v = payload.get(key)
        if isinstance(v, str) and v.startswith("http"):
            return v
    for key in ("result", "output", "asset", "video", "media"):
        sub = payload.get(key)
        if isinstance(sub, dict):
            found = _extract_url(sub)
            if found:
                return found
    text = payload.get("text", "")
    m = re.search(r"https://\S+", text)
    if m:
        return m.group(0).rstrip(').,]"\'')
    return None


async def mcp_call(
    tool: str,
    arguments: dict,
    api_key: str = "",
    endpoint: str = MCP_ENDPOINT,
    timeout: float = 120,
) -> dict:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(endpoint, json=payload, headers=headers)
        resp.raise_for_status()
        body = resp.text

    # SSE unwrap
    if body.lstrip().startswith("event:") or "\ndata:" in body or body.lstrip().startswith("data:"):
        data_lines = [l[5:].strip() for l in body.splitlines() if l.startswith("data:")]
        body = data_lines[-1] if data_lines else "{}"

    envelope = json.loads(body)
    if "error" in envelope:
        raise RuntimeError(f"MCP error {envelope['error'].get('code')}: {envelope['error'].get('message')}")

    result = envelope.get("result") or {}
    if result.get("isError"):
        sc = result.get("structuredContent") or {}
        err = sc.get("error")
        msg = err.get("message") if isinstance(err, dict) else err
        if not msg:
            msg = "".join(c.get("text", "") for c in result.get("content", [])) or "unknown tool error"
        raise RuntimeError(f"Livepeer tool '{tool}' failed: {msg}")

    sc = result.get("structuredContent")
    if isinstance(sc, dict) and sc:
        return sc

    for chunk in result.get("content", []):
        text = chunk.get("text", "")
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError):
            pass
    return {"text": "".join(c.get("text", "") for c in result.get("content", []))}


async def list_capabilities(api_key: str = "") -> list[dict]:
    data = await mcp_call("list_capabilities", {}, api_key=api_key, timeout=60)
    return data.get("capabilities", []) or []


async def describe_capability(name: str, api_key: str = "") -> dict:
    return await mcp_call("describe_capability", {"name": name}, api_key=api_key, timeout=60)


async def upload_file(data: bytes, filename: str, api_key: str = "") -> str:
    b64 = __import__("base64").b64encode(data).decode("ascii")
    mime, _ = mimetypes.guess_type(filename)
    mime = mime or "application/octet-stream"
    result = await mcp_call(
        "upload",
        {"filename": filename, "data": b64, "content_type": mime},
        api_key=api_key,
        timeout=120,
    )
    url = _extract_url(result)
    if not url:
        raise RuntimeError(f"upload returned no URL: {result}")
    return url


async def run_capability(
    name: str,
    inputs: dict,
    api_key: str = "",
    timeout: float = 180,
) -> dict:
    return await mcp_call(
        "run_capability",
        {"capability": name, "prompt": inputs.get("prompt", ""), "inputs": inputs, "async": True},
        api_key=api_key,
        timeout=timeout,
    )


async def poll_for_media(
    job_id: str,
    api_key: str = "",
    max_wait: float = 480,
    poll_interval: float = 4,
) -> tuple[str, dict]:
    deadline = time.time() + max_wait
    while time.time() < deadline:
        result = await mcp_call("get_create_media", {"job_id": job_id}, api_key=api_key, timeout=60)
        status = (result.get("status") or "").lower()
        if status in ("completed", "success", "done"):
            url = _extract_url(result)
            if url:
                return url, result
        if status in ("failed", "error"):
            raise RuntimeError(f"Livepeer job failed: {result}")
        await asyncio.sleep(poll_interval)
    raise TimeoutError(f"Livepeer job {job_id} did not complete within {max_wait}s")


async def download_media(url: str, api_key: str = "") -> bytes:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        return resp.content


def guess_mime_from_bytes(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and b"WEBP" in data[:20]:
        return "image/webp"
    if data.startswith(b"\x1aE\xdf\xa3"):
        return "video/matroska"
    if data.startswith(b"\x00\x00\x00 ") or data.startswith(b"ftyp"):
        return "video/mp4"
    return "application/octet-stream"


async def generate(
    capability: str,
    prompt: str,
    api_key: str = "",
    image_url: str | None = None,
    duration: int | None = None,
    aspect_ratio: str | None = None,
    max_wait: float = 480,
) -> tuple[bytes, str, dict]:
    """Generate image or video via Livepeer.

    Returns (file_bytes, filename_hint, report_dict).
    """
    inputs: dict[str, Any] = {"prompt": prompt}
    if duration is not None:
        inputs["duration"] = duration
    if aspect_ratio is not None:
        inputs["aspect_ratio"] = aspect_ratio
    if image_url:
        inputs["image_url"] = image_url

    submit = await run_capability(capability, inputs, api_key=api_key)
    job_id = submit.get("job_id") or submit.get("id")
    if not job_id:
        raise RuntimeError(f"run_capability returned no job_id: {submit}")

    url, report = await poll_for_media(job_id, api_key=api_key, max_wait=max_wait)
    blob = await download_media(url, api_key=api_key)

    # Determine extension
    ext = ".bin"
    lower_url = url.split("?")[0].lower()
    if lower_url.endswith((".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov")):
        ext = "." + lower_url.split(".")[-1]
    else:
        mime = guess_mime_from_bytes(blob)
        ext = mimetypes.guess_extension(mime) or ".bin"

    filename = f"livepeer_{job_id[:8]}{ext}"
    return blob, filename, report
