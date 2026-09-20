const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { URL } = require('url');
const OpenAI = require('openai');

const MCP_ENDPOINT = 'https://agent.livepeer.org/api/mcp/raw';
const OUTPUT_DIR = path.join(app.getPath('userData'), 'outputs');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  openai_base_url: process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1',
  openai_api_key: process.env.OPENAI_API_KEY || '',
  model: process.env.MODEL || 'qwen/qwen3.8-27b:free',
  livepeer_api_key: process.env.LIVEPEER_API_KEY || '',
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('[QwenHub] failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  appSettings = { ...settings };
}

let appSettings = loadSettings();
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('qwenhub', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/')) pathname = pathname.slice(1);
    const filePath = path.join(OUTPUT_DIR, pathname);
    return net.fetch('file://' + filePath);
  });
  createWindow();
});
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

function httpPut(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request({
      method: 'PUT',
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      headers: { ...headers, 'Content-Length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Signed upload failed (${res.statusCode}): ${body}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function detectMime(buffer, filename) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  const ext = path.extname(filename || '').toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' })[ext] || 'application/octet-stream';
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
  const buffer = Buffer.from(b64, 'base64');
  const contentType = detectMime(buffer, filename);
  const signed = await mcpCall('create_upload_url', {
    filename,
    content_type: contentType,
    size: buffer.length,
  }, apiKey);
  if (!signed.upload_url || !signed.public_url) {
    throw new Error('create_upload_url returned no signed/public URL');
  }
  const uploadHeaders = { ...(signed.headers || {}) };
  if (!Object.keys(uploadHeaders).some(key => key.toLowerCase() === 'content-type')) {
    uploadHeaders['Content-Type'] = contentType;
  }
  await httpPut(signed.upload_url, buffer, uploadHeaders);
  return signed.public_url;
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
    baseURL: appSettings.openai_base_url,
    apiKey: appSettings.openai_api_key,
  });
}

function defaultModel() {
  return appSettings.model;
}

function stripFences(text) {
  return text.replace(/^```(json)?\s*/, '').replace(/\s*```$/, '').trim();
}

const SYSTEM_PROMPT = `You are QwenHub, an AI director for the Livepeer Agent network.
The user chats in natural language. Decide the next media generation action.

Rules:
1. If user asks for photo/image/picture: mode="image", pick an image-generation capability from the AVAILABLE CAPABILITIES list below.
   - Fast/cheap image: prefer flux-schnell, flux-dev, qwen-image-3-t2i, krea-2-turbo
   - High quality image: prefer flux-pro, flux-flex, krea-2, krea-2-large, grok-image-2, gpt-image, gemini-image, mai-image-2.5
2. If user asks for video/clip/animation: mode="video", pick a video capability from the AVAILABLE CAPABILITIES list below.
   - If an image is attached or previous image output exists, prefer an i2v capability (minimax-h3-i2v, kling-o3-i2v, ltx-i2v, seedance-i2v, etc.).
   - Otherwise pick a t2v capability (minimax-h3-t2v, kling-o3-t2v, ltx-t2v, veo-t2v, etc.).
3. The 'capability' value MUST be one of the exact names in the AVAILABLE CAPABILITIES list below. Never invent a capability name.
4. Prompt must be English, shot-native, concise but complete: camera movement/framing, subject action, lighting/atmosphere. For still images: detailed realistic description with subject, setting, style, and light.
5. For images, do NOT set duration. Duration only applies to video. Default 5s for video. Use shorter (2-3s) for seamless loops. Max 10s unless user asks more.
6. Aspect ratio: default 16:9. Use 9:16 for vertical, 1:1 for square if requested.
7. If user refines previous output ("make it faster", "orbit camera", "pan left"), keep the same subject/style and change only what they asked. Set use_reference=true if a reference is available.
8. Do NOT describe the attached image yourself; the Livepeer model sees the reference. Only provide the action/camera/motion instruction.
9. Reply in the SAME LANGUAGE as the user's last message.

Output exactly one JSON object:
{"message":"short reply in user's language","action":{"mode":"image|video","capability":"exact Livepeer capability name from AVAILABLE CAPABILITIES","prompt":"English prompt","duration":5,"aspect_ratio":"16:9","use_reference":false}}
If just chatting, set action to null.`;

// ---------- IPC ----------

let cachedCapabilities = [];

ipcMain.handle('getSettings', async () => {
  return { ...appSettings };
});

ipcMain.handle('saveSettings', async (_event, settings) => {
  saveSettings(settings);
  cachedCapabilities = []; // refresh capabilities cache on key change
  return { ...appSettings };
});

async function getCapabilities() {
  if (!cachedCapabilities.length) {
    cachedCapabilities = await listCapabilities(appSettings.livepeer_api_key || '');
  }
  return cachedCapabilities;
}

function resolveCapability(rawName, mode) {
  const name = (rawName || '').toString().trim().toLowerCase();
  if (!name) return null;
  const caps = cachedCapabilities;
  if (!caps.length) return rawName;

  // Exact match
  const exact = caps.find(c => c.name.toLowerCase() === name);
  if (exact) return exact.name;

  // Contains match
  const contains = caps.find(c => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase()));
  if (contains) return contains.name;

  // Fuzzy word overlap
  const words = name.split(/[-_\s]+/).filter(w => w.length > 2);
  if (words.length) {
    const scored = caps.map(c => {
      const cn = c.name.toLowerCase();
      const score = words.reduce((s, w) => s + (cn.includes(w) ? 1 : 0), 0);
      return { cap: c, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (scored.length) return scored[0].cap.name;
  }

  // Fallback by mode
  const fallback = mode === 'image'
    ? (caps.find(c => /flux|image|krea|schnell|dev|pro/i.test(c.name)) || caps[0])
    : (caps.find(c => /i2v|t2v|video|minimax|kling|ltx|veo|seedance|wan/i.test(c.name)) || caps[0]);
  return fallback ? fallback.name : rawName;
}

ipcMain.handle('capabilities', async () => getCapabilities());

ipcMain.handle('loadFile', async (_event, filePath) => {
  const clean = filePath.replace(/^file:\/\//, '');
  return fs.readFileSync(clean).toString('base64');
});

ipcMain.handle('loadMediaUrl', async (_event, url) => {
  let blob;
  if (url.startsWith('qwenhub://output/')) {
    const filePath = path.join(OUTPUT_DIR, url.replace(/^qwenhub:\/\/output\//, ''));
    blob = fs.readFileSync(filePath);
  } else if (url.startsWith('file://')) {
    const filePath = url.replace(/^file:\/\//, '');
    blob = fs.readFileSync(filePath);
  } else if (/^https?:\/\//i.test(url)) {
    const headers = appSettings.livepeer_api_key ? { Authorization: `Bearer ${appSettings.livepeer_api_key}` } : {};
    blob = await httpGet(url, headers);
  } else {
    blob = fs.readFileSync(url);
  }
  return blob.toString('base64');
});

ipcMain.handle('chat', async (_event, payload) => {
  try {
    const messages = payload.messages || [];
    const imageB64 = payload.image_b64 || payload.imageB64 || null;
    const videoB64 = payload.video_b64 || payload.videoB64 || null;
    const lastOutputUrl = payload.last_output_url || payload.lastOutputUrl || null;
    const caps = await getCapabilities();

    let userContent = [{ type: 'text', text: messages[messages.length - 1]?.content || '' }];
    let referenceImageUrl = null;

    if (imageB64) {
      referenceImageUrl = await uploadFile(imageB64, 'reference.jpg', appSettings.livepeer_api_key || '');
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

    let action = data.action;
    if (!action) {
      const userText = userContent[0].text || '';
      const explicit = userText.match(/\buse\s+([a-z0-9][a-z0-9._-]*)[.:]?\s*/i);
      if (!explicit) return { message: data.message || '', action: null };
      const capability = resolveCapability(explicit[1], /i2v|t2v|video|minimax|kling|ltx|veo|seedance|wan/i.test(explicit[1]) ? 'video' : 'image');
      const mode = /i2v|t2v|video|minimax|kling|ltx|veo|seedance|wan/i.test(capability || '') ? 'video' : 'image';
      action = {
        mode,
        capability,
        prompt: userText.replace(explicit[0], '').trim(),
        duration: mode === 'video' ? Number((userText.match(/\b(\d+)\s*(?:s|sec|seconds?)\b/i) || [])[1] || 5) : null,
        aspect_ratio: (userText.match(/\b(\d+:\d+)\b/) || [])[1] || '16:9',
        use_reference: mode === 'video' && Boolean(imageB64 || lastOutputUrl),
      };
    }

    // Validate/fallback capability name against Livepeer list
    action.capability = resolveCapability(action.capability, action.mode);
    if (action.mode === 'video' && imageB64 && /i2v|image.to.video/i.test(action.capability || '')) {
      action.use_reference = true;
    }

    let imageUrl = null;
    if (action.use_reference) {
      if (referenceImageUrl) imageUrl = referenceImageUrl;
      else if (lastOutputUrl) {
        let blob;
        let localPath = null;
        if (lastOutputUrl.startsWith('qwenhub://output/')) {
          localPath = path.join(OUTPUT_DIR, lastOutputUrl.replace(/^qwenhub:\/\/output\//, ''));
          blob = fs.readFileSync(localPath);
        } else if (lastOutputUrl.startsWith('file://')) {
          localPath = lastOutputUrl.replace(/^file:\/\//, '');
          blob = fs.readFileSync(localPath);
        } else {
          const headers = appSettings.livepeer_api_key ? { Authorization: `Bearer ${appSettings.livepeer_api_key}` } : {};
          blob = await httpGet(lastOutputUrl, headers);
        }
        const ext = path.extname(localPath || lastOutputUrl) || '.bin';
        imageUrl = await uploadFile(blob.toString('base64'), `reference${ext}`, appSettings.livepeer_api_key || '');
      }
    }

    const genOptions = { imageUrl, aspectRatio: action.aspect_ratio };
    if (action.mode === 'video') {
      genOptions.duration = action.duration;
    }

    const { filename, report } = await generateMedia(
      action.capability,
      action.prompt,
      appSettings.livepeer_api_key || '',
      genOptions,
    );

    return {
      message: data.message || '',
      action,
      media_url: `qwenhub://output/${filename}`,
      mode: action.mode,
      report,
    };
  } catch (err) {
    const status = err.status || (err.response && err.response.status);
    const is429 = status === 429 || /429|rate.limit|too many requests/i.test(err.message);
    const isProviderError = (status && status >= 500 && status < 600) || /503|502|504|provider returned error/i.test(err.message);
    if (is429) {
      return {
        error: 'rate_limit',
        message: 'Rate limit hit by the free model provider. Wait a few seconds and try again, or switch to a non-free / local model in Settings.',
      };
    }
    if (isProviderError) {
      return {
        error: 'provider_error',
        message: 'The model provider is temporarily unavailable (HTTP ' + (status || '503') + '). Wait a moment and retry, or switch model/provider in Settings.',
      };
    }
    throw err;
  }
});
