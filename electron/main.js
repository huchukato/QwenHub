const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { URL } = require('url');
const OpenAI = require('openai');

const MCP_ENDPOINT = 'https://agent.livepeer.org/api/mcp/raw';
const OUTPUT_DIR = path.join(app.getPath('userData'), 'outputs');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let mainWindow;
const ICON_PNG = path.join(__dirname, '..', 'img', 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    icon: process.platform === 'darwin' ? undefined : ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'static', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- Livepeer MCP helpers ----------

function httpPostJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function extractUrl(payload) {
  for (const key of ['url', 'video_url', 'output_url', 'asset_url', 'result_url']) {
    if (typeof payload[key] === 'string' && payload[key].startsWith('http')) return payload[key];
  }
  for (const key of ['result', 'output', 'asset', 'video', 'media']) {
    if (typeof payload[key] === 'object') {
      const found = extractUrl(payload[key]);
      if (found) return found;
    }
  }
  const m = (payload.text || '').match(/https:\/\/\S+/);
  return m ? m[0].replace(/[).,\]"']+$/, '') : null;
}

function unwrapMcpResponse(text) {
  if (text.trim().startsWith('event:') || text.includes('\ndata:') || text.trim().startsWith('data:')) {
    const lines = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    text = lines[lines.length - 1] || '{}';
  }
  const envelope = JSON.parse(text);
  if (envelope.error) throw new Error(`MCP error ${envelope.error.code}: ${envelope.error.message}`);
  const result = envelope.result || {};
  if (result.isError) {
    const sc = result.structuredContent || {};
    let msg = sc.error && sc.error.message ? sc.error.message : '';
    if (!msg) msg = (result.content || []).map(c => c.text).join('') || 'unknown tool error';
    throw new Error(`Livepeer tool failed: ${msg}`);
  }
  const sc = result.structuredContent;
  if (sc && typeof sc === 'object') return sc;
  for (const chunk of result.content || []) {
    try {
      const parsed = JSON.parse(chunk.text || '');
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  return { text: (result.content || []).map(c => c.text).join('') };
}

async function mcpCall(tool, args, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const text = await httpPostJson(MCP_ENDPOINT, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args },
  }, headers);
  return unwrapMcpResponse(text);
}

async function listCapabilities(apiKey) {
  const data = await mcpCall('list_capabilities', {}, apiKey);
  return (data.capabilities || []).map(c => ({
    name: c.name,
    kind: c.kind,
    description: (c.description || '').slice(0, 120),
  }));
}

async function uploadFile(b64, filename, apiKey) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const data = await mcpCall('upload', { filename, data: b64, content_type: 'application/octet-stream' }, apiKey);
  const url = extractUrl(data);
  if (!url) throw new Error('upload returned no URL');
  return url;
}

async function runCapability(name, inputs, apiKey) {
  return mcpCall('run_capability', { capability: name, prompt: inputs.prompt || '', inputs, async: true }, apiKey);
}

async function pollForMedia(jobId, apiKey, maxWait = 480) {
  const deadline = Date.now() + maxWait * 1000;
  while (Date.now() < deadline) {
    const data = await mcpCall('get_create_media', { job_id: jobId }, apiKey);
    const status = (data.status || '').toLowerCase();
    if (['completed', 'success', 'done'].includes(status)) {
      const url = extractUrl(data);
      if (url) return { url, report: data };
    }
    if (['failed', 'error'].includes(status)) throw new Error(`Livepeer job failed: ${JSON.stringify(data)}`);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error(`Livepeer job ${jobId} timed out`);
}

async function generateMedia(capability, prompt, apiKey, { imageUrl, duration, aspectRatio }) {
  const inputs = { prompt };
  if (duration !== undefined && duration !== null) inputs.duration = duration;
  if (aspectRatio) inputs.aspect_ratio = aspectRatio;
  if (imageUrl) inputs.image_url = imageUrl;

  const submit = await runCapability(capability, inputs, apiKey);
  const jobId = submit.job_id || submit.id;
  if (!jobId) throw new Error('run_capability returned no job_id');

  const { url, report } = await pollForMedia(jobId, apiKey);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const blob = await httpGet(url, headers);

  const ext = path.extname(new URL(url).pathname.split('?')[0]) || '.bin';
  const filename = `livepeer_${jobId.slice(0, 8)}${ext}`;
  const outPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outPath, blob);
  return { filename, report };
}

// ---------- OpenAI chat ----------

function getOpenAI() {
  return new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
  });
}

function defaultModel() {
  return process.env.MODEL || 'qwen/qwen-2.5-7b-instruct';
}

function stripFences(text) {
  return text.replace(/^```(json)?\s*/, '').replace(/\s*```$/, '').trim();
}

const SYSTEM_PROMPT = `You are QwenHub, an AI director for the Livepeer Agent network.
The user chats in natural language. Decide the next media generation action.

Rules:
1. If user asks for photo/image/picture: mode="image", pick an image-generation capability (flux-schnell, flux-dev, flux-pro, qwen-image-3-t2i, gpt-image, gemini-image, grok-image-2, etc.).
2. If user asks for video/clip/animation: mode="video", pick a video capability.
   - If an image is attached or previous image output exists, prefer an i2v capability (minimax-h3-i2v, kling-o3-i2v, ltx-i2v, seedance-i2v, etc.).
   - Otherwise pick a t2v capability (minimax-h3-t2v, kling-o3-t2v, ltx-t2v, veo-t2v, etc.).
3. Prompt must be English, shot-native, concise but complete: camera movement/framing, subject action, lighting/atmosphere. For still images: detailed realistic description.
4. Duration: default 5s for video. Use 2-3s for seamless loops. Max 10s unless user asks more.
5. Aspect ratio: default 16:9. Use 9:16 for vertical, 1:1 for square if requested.
6. If user refines previous output ("make it faster", "orbit camera", "pan left"), keep the same subject/style and change only what they asked. Set use_reference=true if a reference is available.
7. Do NOT describe the attached image yourself; the Livepeer model sees the reference. Only provide the action/camera/motion instruction.
8. Reply in the SAME LANGUAGE as the user's last message.

Output exactly one JSON object:
{"message":"short reply in user's language","action":{"mode":"image|video","capability":"exact Livepeer capability name","prompt":"English prompt","duration":5,"aspect_ratio":"16:9","use_reference":false}}
If just chatting, set action to null.`;

// ---------- IPC ----------

let cachedCapabilities = [];

ipcMain.handle('capabilities', async () => {
  if (!cachedCapabilities.length) {
    cachedCapabilities = await listCapabilities(process.env.LIVEPEER_API_KEY || '');
  }
  return cachedCapabilities;
});

ipcMain.handle('loadFile', async (_event, filePath) => {
  const clean = filePath.replace(/^file:\/\//, '');
  return fs.readFileSync(clean).toString('base64');
});

ipcMain.handle('chat', async (_event, { messages, imageB64, videoB64, lastOutputUrl }) => {
  const caps = await ipcMain.handle('capabilities')();

  let userContent = [{ type: 'text', text: messages[messages.length - 1]?.content || '' }];
  let referenceImageUrl = null;

  if (imageB64) {
    referenceImageUrl = await uploadFile(imageB64, 'reference.jpg', process.env.LIVEPEER_API_KEY || '');
    userContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } });
  }
  if (videoB64) {
    userContent.push({ type: 'text', text: '[A video clip is attached for review/refinement context.]' });
  }
  messages[messages.length - 1].content = userContent;

  const capBlock = JSON.stringify(caps.slice(0, 120), null, 2);
  let system = SYSTEM_PROMPT + '\n\nAVAILABLE CAPABILITIES:\n' + capBlock;
  if (lastOutputUrl) system += '\n\nLAST_GENERATED_OUTPUT_URL: ' + lastOutputUrl;

  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: defaultModel(),
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.6,
    max_tokens: 2048,
  });

  const raw = stripFences(completion.choices[0].message.content || '{}');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`LLM did not return valid JSON: ${e.message}\nRaw: ${raw}`);
  }

  const action = data.action;
  if (!action) return { message: data.message || '', action: null };

  let imageUrl = null;
  if (action.use_reference) {
    if (referenceImageUrl) imageUrl = referenceImageUrl;
    else if (lastOutputUrl) {
      let blob;
      if (lastOutputUrl.startsWith('file://')) {
        const localPath = lastOutputUrl.replace(/^file:\/\//, '');
        blob = fs.readFileSync(localPath);
      } else {
        const headers = process.env.LIVEPEER_API_KEY ? { Authorization: `Bearer ${process.env.LIVEPEER_API_KEY}` } : {};
        blob = await httpGet(lastOutputUrl, headers);
      }
      const ext = path.extname(lastOutputUrl.replace(/^file:\/\//, '')) || '.bin';
      imageUrl = await uploadFile(blob.toString('base64'), `reference${ext}`, process.env.LIVEPEER_API_KEY || '');
    }
  }

  const { filename, report } = await generateMedia(
    action.capability,
    action.prompt,
    process.env.LIVEPEER_API_KEY || '',
    {
      imageUrl,
      duration: action.duration,
      aspectRatio: action.aspect_ratio,
    },
  );

  return {
    message: data.message || '',
    action,
    mediaUrl: `file://${path.join(OUTPUT_DIR, filename)}`,
    mode: action.mode,
    report,
  };
});
