# QwenHub v0.1.0 — Release Notes

First public release of **QwenHub**: a standalone desktop app where a Qwen-compatible LLM acts as an AI director for the [Livepeer Agent](https://agent.livepeer.org) network. Describe a shot in natural language, pick a capability, and get images and videos rendered straight into the chat — no ComfyUI, no node graph.

📹 Demo video: https://vimeo.com/1228648577

## Downloads

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `QwenHub-0.1.0-arm64.dmg` |
| Windows (x64, installer) | `QwenHub.Setup.0.1.0.exe` |
| Windows (x64, portable) | `QwenHub.0.1.0.exe` |
| Linux (x64) | `QwenHub-0.1.0.AppImage` / `qwenhub_0.1.0_amd64.deb` |
| Linux (ARM64) | `QwenHub-0.1.0-arm64.AppImage` |

> ⚠️ macOS builds are unsigned (no Developer ID certificate). On first launch: right-click → **Open**, or `xattr -cr /Applications/QwenHub.app`.
>
> ⚠️ Windows builds are unsigned — SmartScreen will warn; click **More info → Run anyway**.

## Highlights

### 🎬 AI-directed media generation
- Natural-language chat drives the Livepeer Agent network over MCP.
- Qwen inspects the request, picks a valid capability, writes an English generation prompt, polls the job, and displays the result inline.
- Works with **OpenRouter** (default: `qwen/qwen3.8-27b:free`) or **local OpenAI-compatible endpoints** — Ollama, llama.cpp, LM Studio, KoboldCpp, custom URL.

### 🎛️ Capability selectors
- Two dropdowns under the composer: media type (Auto / Image / Video) and the specific Livepeer capability.
- All ~200 real capabilities are listed — matched ones first, everything else under "Other capabilities".
- Selecting a capability auto-prefixes the prompt (`use <cap>.`) and bypasses the LLM for instant, deterministic generation.

### 🗂️ Media library
- Collapsible sidebar collecting every generated image and video.
- Click a card to attach it as the next reference; `⬇` saves to disk (native save dialog on desktop); `×` deletes the file.
- Persists across app restarts.

### 🔄 Reference & refine loop
- Attach images or videos, or click a generated result to reuse it.
- References are uploaded via Livepeer **signed PUT URLs** (no base64 transport limits).
- Capability-aware input mapping via `describe_capability`: `source_url`/`video_url` are routed to the correct field; i2v requests with a video attached fall back to the last generated image as first frame.
- Duration is clamped to each model's supported range and never sent to image capabilities.

### 🖥️ Desktop experience
- Custom `qwenhub://` media protocol with HTTP range support (in-chat video playback).
- Animated spinner while the agent works.
- EN/IT language switch.
- Friendly error messages for rate limits (429) and provider outages (5xx); Livepeer tool errors surface verbatim.

### 🌐 Web / Docker mode
- Same chat served by a FastAPI backend (`uvicorn main:app`), containerizable via the included `Dockerfile`.

## Known limitations

- macOS builds are unsigned; Gatekeeper requires right-click → Open.
- The media library tracks media generated after this feature shipped; older outputs remain accessible from chat.
- Local LLMs need a vision-capable model (e.g. `qwen2.5-vl`) to inspect attached images; text-only models work but ignore image content.
- `npm audit` reports transitive vulnerabilities from dev tooling (electron-builder chain); they do not affect the packaged app.

## Requirements

- A Livepeer-compatible workflow — works keyless in demo mode or with a Livepeer API key (Settings).
- An OpenAI-compatible LLM endpoint: OpenRouter key or a local server (Ollama & co.).
