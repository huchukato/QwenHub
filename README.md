# QwenHub

A standalone chat director for the [Livepeer Agent](https://agent.livepeer.org) network.

QwenHub lets you talk to a Qwen-style LLM (via any OpenAI-compatible API) and have it decide the right Livepeer capability, prompt, duration, and aspect ratio. Attach a reference image to drive image-to-video generation, then click the result to refine it.

> Built as a lightweight alternative to the ComfyUI integration in [`ComfyUI-QwenVL-Mod`](https://github.com/huchukato/ComfyUI-QwenVL-Mod).

## How it works

1. **Chat** describes what you want (photo, video, camera move, refine).
2. **Qwen** picks a Livepeer capability (image models like `flux-schnell`, video models like `minimax-h3-i2v`, etc.).
3. **Livepeer MCP** runs the generation asynchronously, polls for completion, and downloads the result.
4. **Preview** the image or video in chat and click it to use as the next reference.

## Run locally

```bash
cp .env.example .env
# edit .env with your OpenAI-compatible key and optional Livepeer key
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open `http://localhost:8000`.

## Deploy

```bash
docker build -t qwenhub .
docker run -p 8000:8000 --env-file .env qwenhub
```

Works on Hugging Face Spaces, Render, Railway, or any container host.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` | LLM API base URL |
| `OPENAI_API_KEY` | *(required)* | LLM API key |
| `MODEL` | `qwen/qwen-2.5-7b-instruct` | Chat model |
| `LIVEPEER_API_KEY` | *(empty)* | Optional Livepeer key |

## Project structure

```
QwenHub/
├── main.py              # FastAPI backend
├── livepeer_client.py   # Raw MCP client for Livepeer
├── llm_client.py        # OpenAI-compatible chat + system prompt
├── static/index.html    # Chat UI
├── Dockerfile
└── requirements.txt
```
