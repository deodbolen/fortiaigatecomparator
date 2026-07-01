import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Download, Eraser, FileUp, Play, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

const emptyTarget = (label, defaultUrl) => ({
  label,
  baseUrl: defaultUrl,
  apiToken: '',
  saveToken: false,
  allowSelfSigned: false,
  model: '',
  temperature: 0.7,
  maxTokens: 1024,
  stream: true,
  output: '',
  events: [],
  request: null,
  responseHeaders: null,
  metrics: null,
  status: 'idle',
  error: '',
});

function buildPayload(panel, prompt, systemPrompt) {
  const messages = [];
  if (systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  return {
    model: panel.model,
    messages,
    temperature: Number(panel.temperature),
    max_tokens: Number(panel.maxTokens),
    stream: Boolean(panel.stream),
  };
}

function maskHeaders(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = { ...value };
  for (const key of Object.keys(clone)) {
    if (key.toLowerCase() === 'authorization') clone[key] = 'Bearer ***masked***';
  }
  return clone;
}

function pretty(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function safeFileName(value) {
  return String(value || 'export')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80) || 'export';
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readJsonFile(file) {
  return JSON.parse(await file.text());
}

function parseSse(buffer) {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = parts.map((part) => {
    let event = 'message';
    const dataLines = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    return { event, data: JSON.parse(dataLines.join('\n') || '{}') };
  });
  return { events, rest };
}

function normalizeRequestForDiff(request) {
  if (!request) return null;
  return request.payload;
}

function diffLines(leftText, rightText) {
  const left = String(leftText || '').split('\n');
  const right = String(rightText || '').split('\n');
  const max = Math.max(left.length, right.length);
  const rows = [];
  for (let i = 0; i < max; i += 1) {
    const a = left[i] ?? '';
    const b = right[i] ?? '';
    rows.push({ index: i + 1, left: a, right: b, changed: a !== b });
  }
  return rows;
}

function analyzeRequests(raw, fortiAIGate) {
  const findings = [];
  const rawPayload = raw?.payload;
  const gatePayload = fortiAIGate?.payload;
  if (!rawPayload || !gatePayload) return findings;

  const rawMessages = rawPayload.messages || [];
  const gateMessages = gatePayload.messages || [];
  const rawSystem = rawMessages.filter((m) => m.role === 'system').length;
  const gateSystem = gateMessages.filter((m) => m.role === 'system').length;
  if (gateSystem > rawSystem) findings.push(`Added system messages: ${gateSystem - rawSystem}`);

  for (const key of ['temperature', 'max_tokens', 'stream', 'model']) {
    if (rawPayload[key] !== gatePayload[key]) {
      findings.push(`Changed ${key}: raw=${JSON.stringify(rawPayload[key])}, FortiAIGate=${JSON.stringify(gatePayload[key])}`);
    }
  }

  const rawShape = Object.keys(rawPayload).sort().join(', ');
  const gateShape = Object.keys(gatePayload).sort().join(', ');
  if (rawShape !== gateShape) findings.push(`Request structure differs: raw keys [${rawShape}], FortiAIGate keys [${gateShape}]`);
  if (!findings.length) findings.push('No request mutation visible in captured outbound payloads.');
  return findings;
}

async function streamPanel(panel, prompt, systemPrompt, scenarioValue, setPanel) {
  const payload = buildPayload(panel, prompt, systemPrompt);
  const scenario = (scenarioValue || '').trim();
  const body = {
    base_url: panel.baseUrl,
    api_token: panel.apiToken,
    allow_self_signed: panel.allowSelfSigned,
    request_headers: scenario ? { 'X-Scenario': scenario } : {},
    payload,
  };

  setPanel((current) => ({
    ...current,
    status: 'running',
    output: '',
    events: [],
    request: null,
    responseHeaders: null,
    metrics: null,
    error: '',
  }));

  try {
    const response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.body) throw new Error('Browser did not expose a response stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    let finalStatus = 'done';

    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;

      for (const item of parsed.events) {
        setPanel((current) => {
          const displayData = item.event === 'request'
            ? { ...item.data, headers: maskHeaders(item.data.headers) }
            : item.data;
          const eventEntry = {
            type: item.event,
            timestamp: displayData.timestamp,
            timestamp_ms: displayData.timestamp_ms,
            data: displayData,
          };
          const next = { ...current, events: [...current.events, eventEntry] };
          if (item.event === 'request') next.request = displayData;
          if (item.event === 'response_headers') next.responseHeaders = item.data;
          if (item.event === 'chunk') next.output = item.data.output_so_far ?? next.output;
          if (item.event === 'done') {
            next.output = item.data.output ?? next.output;
            next.metrics = item.data.metrics;
            next.status = 'done';
          }
          if (item.event === 'error') {
            next.error = `${item.data.error_type}: ${item.data.message}`;
            next.metrics = item.data.metrics;
            next.status = 'error';
            finalStatus = 'error';
          }
          return next;
        });
      }
    }
    return finalStatus;
  } catch (error) {
    setPanel((current) => ({ ...current, status: 'error', error: String(error) }));
    return 'error';
  }
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Panel({ panel, setPanel, prompt, systemPrompt, scenario, onSend, mode }) {
  const update = (key, value) => setPanel((current) => ({ ...current, [key]: value }));
  const isDemo = mode === 'demo';
  const showDemoThinking = isDemo && panel.status === 'running' && !panel.output;
  const chunkRows = panel.events.filter((event) => event.type === 'chunk');
  const bufferedHint = chunkRows.length > 1 && chunkRows.every((event, index) => {
    if (index === 0) return true;
    return Math.abs(event.timestamp_ms - chunkRows[index - 1].timestamp_ms) < 5;
  });

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2 className={panel.secured ? 'securedTitle' : ''}>
          {panel.secured && <ShieldCheck size={20} aria-hidden="true" />}
          {panel.label}
        </h2>
        <button onClick={() => onSend(panel, prompt, systemPrompt, scenario, setPanel)} disabled={panel.status === 'running' || !prompt}>
          <Play size={16} /> Send
        </button>
      </div>

      {!isDemo && (
        <div className="grid">
          <Field label="Base URL">
            <input value={panel.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="http://localhost:11434" />
          </Field>
          <Field label="API token">
            <input value={panel.apiToken} onChange={(event) => update('apiToken', event.target.value)} type="password" placeholder="masked" />
          </Field>
          <Field label="Model">
            <input value={panel.model} onChange={(event) => update('model', event.target.value)} placeholder="model-name" />
          </Field>
          <Field label="Temperature">
            <input value={panel.temperature} onChange={(event) => update('temperature', event.target.value)} type="number" min="0" max="2" step="0.1" />
          </Field>
          <Field label="Max tokens">
            <input value={panel.maxTokens} onChange={(event) => update('maxTokens', event.target.value)} type="number" min="1" />
          </Field>
          <label className="check">
            <input checked={panel.stream} onChange={(event) => update('stream', event.target.checked)} type="checkbox" />
            Stream
          </label>
          <label className="check">
            <input checked={panel.saveToken} onChange={(event) => update('saveToken', event.target.checked)} type="checkbox" />
            Save token
          </label>
          <label className="check">
            <input checked={panel.allowSelfSigned} onChange={(event) => update('allowSelfSigned', event.target.checked)} type="checkbox" />
            Allow self-signed TLS
          </label>
        </div>
      )}

      {panel.error && <pre className="error">{panel.error}</pre>}

      <h3>Output</h3>
      {showDemoThinking ? (
        <div className="output thinking" role="status" aria-live="polite">
          <span>Thinking</span>
          <span className="dot dotOne" />
          <span className="dot dotTwo" />
          <span className="dot dotThree" />
        </div>
      ) : (
        <pre className="output">{panel.output || `[${panel.status}]`}</pre>
      )}

      {!isDemo && (
        <>
          <h3>Metrics</h3>
          <div className="metrics">
            {Object.entries(panel.metrics || {}).map(([key, value]) => (
              <div key={key}><span>{key}</span><b>{String(value)}</b></div>
            ))}
            {bufferedHint && <div className="warn">Chunks arrived within 5ms windows; streaming may be buffered.</div>}
          </div>

          <h3>Raw Request JSON</h3>
          <pre className="json">{pretty(panel.request)}</pre>

          <h3>Raw Response/Event Log</h3>
          <pre className="json">{pretty(panel.events)}</pre>
        </>
      )}
    </section>
  );
}

function DiffView({ raw, fortiAIGate }) {
  const outputRows = useMemo(() => diffLines(raw.output, fortiAIGate.output), [raw.output, fortiAIGate.output]);
  const requestRows = useMemo(
    () => diffLines(pretty(normalizeRequestForDiff(raw.request)), pretty(normalizeRequestForDiff(fortiAIGate.request))),
    [raw.request, fortiAIGate.request],
  );
  const findings = useMemo(() => analyzeRequests(raw.request, fortiAIGate.request), [raw.request, fortiAIGate.request]);

  return (
    <section className="diff">
      <h2>What changed?</h2>
      <div className="findings">
        {findings.map((finding) => <div key={finding}>{finding}</div>)}
      </div>
      <h3>Output Diff</h3>
      <DiffTable rows={outputRows} />
      <h3>Request Payload Diff</h3>
      <DiffTable rows={requestRows} />
    </section>
  );
}

function DiffTable({ rows }) {
  return (
    <div className="diffTable">
      {rows.map((row) => (
        <React.Fragment key={row.index}>
          <div className={row.changed ? 'lineNo changed' : 'lineNo'}>{row.index}</div>
          <pre className={row.changed ? 'changed' : ''}>{row.left}</pre>
          <pre className={row.changed ? 'changed' : ''}>{row.right}</pre>
        </React.Fragment>
      ))}
    </div>
  );
}

function App() {
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [scenario, setScenario] = useState('');
  const [promptName, setPromptName] = useState('');
  const [savedPrompts, setSavedPrompts] = useState([]);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [savedProfiles, setSavedProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [mode, setMode] = useState('analytic');
  const [raw, setRaw] = useState(() => emptyTarget('RAW MODEL', ''));
  const [aigate, setAigate] = useState(() => ({ ...emptyTarget('FortiAIGate Secured', ''), secured: true }));
  const promptImportRef = useRef(null);
  const profileImportRef = useRef(null);

  const loadPrompts = async () => {
    const response = await fetch(`${API_BASE}/api/prompts`);
    const data = await response.json();
    const prompts = data.prompts || [];
    setSavedPrompts(prompts);
    return prompts;
  };

  const loadProfiles = async () => {
    const response = await fetch(`${API_BASE}/api/profiles`);
    const data = await response.json();
    const profiles = data.profiles || [];
    setSavedProfiles(profiles);
    return profiles;
  };

  useEffect(() => {
    loadPrompts().catch(() => {});
    loadProfiles().catch(() => {});
  }, []);

  const clear = () => {
    setRaw((current) => ({ ...current, output: '', events: [], request: null, responseHeaders: null, metrics: null, error: '', status: 'idle' }));
    setAigate((current) => ({ ...current, output: '', events: [], request: null, responseHeaders: null, metrics: null, error: '', status: 'idle' }));
  };

  const profilePayload = () => ({
    raw: { ...raw, apiToken: raw.saveToken ? raw.apiToken : '', output: '', events: [], request: null, responseHeaders: null, metrics: null, error: '', status: 'idle' },
    aigate: { ...aigate, label: 'FortiAIGate Secured', secured: true, apiToken: aigate.saveToken ? aigate.apiToken : '', output: '', events: [], request: null, responseHeaders: null, metrics: null, error: '', status: 'idle' },
  });

  const saveProfileWithName = async (name) => {
    if (!name) return;
    const response = await fetch(`${API_BASE}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, profile: profilePayload() }),
    });
    const data = await response.json();
    const profiles = await loadProfiles();
    if (data.profile?.id) {
      setSelectedProfileId(data.profile.id);
      const saved = profiles.find((item) => item.id === data.profile.id);
      if (saved) setProfileName(saved.name);
    }
  };

  const saveProfile = async () => {
    const current = savedProfiles.find((item) => item.id === selectedProfileId);
    const name = current?.name || profileName.trim();
    if (!name) {
      saveProfileAs();
      return;
    }
    await saveProfileWithName(name);
  };

  const saveProfileAs = async () => {
    const name = window.prompt('Save configuration profile as:', profileName || 'New Profile');
    if (!name?.trim()) return;
    await saveProfileWithName(name.trim());
  };

  const exportSelectedProfile = () => {
    const current = savedProfiles.find((item) => item.id === selectedProfileId);
    if (!current) return;
    downloadJson(`fortiaigate-profile-${safeFileName(current.name)}.json`, {
      kind: 'fortiaigate.profile',
      version: 1,
      name: current.name,
      profile: current.profile || {},
    });
  };

  const importProfileFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = await readJsonFile(file);
      const imported = data.kind === 'fortiaigate.profile' ? data : { name: data.name, profile: data.profile || data };
      if (!imported.name || !imported.profile) throw new Error('Profile import JSON must include name and profile.');
      const response = await fetch(`${API_BASE}/api/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: imported.name, profile: imported.profile }),
      });
      const saved = await response.json();
      const profiles = await loadProfiles();
      if (saved.profile?.id) {
        setSelectedProfileId(saved.profile.id);
        const item = profiles.find((profile) => profile.id === saved.profile.id);
        setProfileName(item?.name || imported.name);
        applyProfile(imported.profile);
      }
    } catch (error) {
      window.alert(`Could not import profile: ${error.message}`);
    }
  };

  const applyProfile = (profile) => {
    if (profile.raw) setRaw(profile.raw);
    if (profile.aigate) setAigate({ ...profile.aigate, label: 'FortiAIGate Secured', secured: true });
  };

  const loadSelectedProfile = (id = selectedProfileId) => {
    const saved = savedProfiles.find((item) => item.id === id);
    if (saved) {
      applyProfile(saved.profile || {});
      setProfileName(saved.name);
    }
  };

  const selectProfile = (id) => {
    setSelectedProfileId(id);
    if (!id) {
      setProfileName('');
      return;
    }
    loadSelectedProfile(id);
  };

  const savePromptWithName = async (name) => {
    if (!name || !prompt) return;
    const response = await fetch(`${API_BASE}/api/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, prompt, system_prompt: systemPrompt, scenario }),
    });
    const data = await response.json();
    const prompts = await loadPrompts();
    if (data.prompt?.id) {
      setSelectedPromptId(data.prompt.id);
      const saved = prompts.find((item) => item.id === data.prompt.id);
      setPromptName(saved?.name || data.prompt.name);
    }
  };

  const savePrompt = async () => {
    const current = savedPrompts.find((item) => item.id === selectedPromptId);
    if (!current) return;
    await savePromptWithName(current.name);
  };

  const savePromptAs = async () => {
    const name = window.prompt('Save prompt as:', promptName || 'New Prompt');
    if (!name?.trim()) return;
    await savePromptWithName(name.trim());
  };

  const exportSelectedPrompt = () => {
    const current = savedPrompts.find((item) => item.id === selectedPromptId);
    if (!current) return;
    downloadJson(`fortiaigate-prompt-${safeFileName(current.name)}.json`, {
      kind: 'fortiaigate.prompt',
      version: 1,
      name: current.name,
      prompt: current.prompt || '',
      system_prompt: current.system_prompt || '',
      scenario: current.scenario || '',
    });
  };

  const importPromptFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = await readJsonFile(file);
      const imported = data.kind === 'fortiaigate.prompt' ? data : data;
      if (!imported.name || imported.prompt === undefined) throw new Error('Prompt import JSON must include name and prompt.');
      const response = await fetch(`${API_BASE}/api/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: imported.name,
          prompt: imported.prompt || '',
          system_prompt: imported.system_prompt || '',
          scenario: imported.scenario || '',
        }),
      });
      const saved = await response.json();
      const prompts = await loadPrompts();
      if (saved.prompt?.id) {
        setSelectedPromptId(saved.prompt.id);
        const item = prompts.find((promptItem) => promptItem.id === saved.prompt.id);
        setPromptName(item?.name || imported.name);
        setPrompt(imported.prompt || '');
        setSystemPrompt(imported.system_prompt || '');
        setScenario(imported.scenario || '');
      }
    } catch (error) {
      window.alert(`Could not import prompt: ${error.message}`);
    }
  };

  const deleteSelectedPrompt = async () => {
    const current = savedPrompts.find((item) => item.id === selectedPromptId);
    if (!current) return;
    const confirmed = window.confirm(`Delete saved prompt "${current.name}"?`);
    if (!confirmed) return;
    await fetch(`${API_BASE}/api/prompts/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    setSelectedPromptId('');
    setPromptName('');
    await loadPrompts();
  };

  const loadSelectedPrompt = (id = selectedPromptId) => {
    const saved = savedPrompts.find((item) => item.id === id);
    if (saved) {
      setPrompt(saved.prompt);
      setSystemPrompt(saved.system_prompt || '');
      setScenario(saved.scenario || '');
      setPromptName(saved.name);
    }
  };

  const selectPrompt = (id) => {
    setSelectedPromptId(id);
    if (!id) {
      setPromptName('');
      setScenario('');
      return;
    }
    loadSelectedPrompt(id);
  };

  const sendBoth = async () => {
    await streamPanel(raw, prompt, systemPrompt, scenario, setRaw);
    await streamPanel(aigate, prompt, systemPrompt, scenario, setAigate);
  };

  return (
    <main>
      <header>
        <div>
          <h1>FortiAIGate Raw Comparator</h1>
          <p>Lab wiretap for request mutation, filtering, overlays, latency, and streaming behavior.</p>
        </div>
        <div className="headerTools">
          <div className="modeToggle" role="group" aria-label="View mode">
            <button className={mode === 'demo' ? 'active' : ''} onClick={() => setMode('demo')}>Demo</button>
            <button className={mode === 'analytic' ? 'active' : ''} onClick={() => setMode('analytic')}>Analytic</button>
          </div>
          <div className="banner"><AlertTriangle size={18} /> Local debug tool only. Do not expose to the internet.</div>
        </div>
      </header>

      <section className="shared">
        <div className="promptBox">
          <div className="promptTools">
            <select value={selectedPromptId} onChange={(event) => selectPrompt(event.target.value)}>
              <option value="">Select saved prompt</option>
              {savedPrompts.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
            <button onClick={() => loadSelectedPrompt()} disabled={!selectedPromptId}><Upload size={16} /> Load Prompt</button>
            <button onClick={savePrompt} disabled={!selectedPromptId || !prompt}><Save size={16} /> Save</button>
            <button onClick={savePromptAs} disabled={!prompt}><Save size={16} /> Save As</button>
            <button onClick={exportSelectedPrompt} disabled={!selectedPromptId}><Download size={16} /> Export</button>
            <button onClick={() => promptImportRef.current?.click()}><FileUp size={16} /> Import</button>
            <button className="dangerButton" onClick={deleteSelectedPrompt} disabled={!selectedPromptId} title="Delete selected prompt" aria-label="Delete selected prompt">
              <Trash2 size={16} />
            </button>
            <input ref={promptImportRef} className="hiddenFile" type="file" accept="application/json,.json" onChange={importPromptFile} />
          </div>
          {mode === 'analytic' && (
            <div className="promptMeta">
              <input value={scenario} onChange={(event) => setScenario(event.target.value)} placeholder="X-Scenario header, blank = default" />
              <textarea
                className="systemPrompt"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                placeholder="Optional system prompt saved with this prompt and sent before the user prompt..."
              />
            </div>
          )}
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Enter the exact prompt to send to both targets..." />
        </div>
        <div className="actions">
          <button onClick={() => streamPanel(raw, prompt, systemPrompt, scenario, setRaw)} disabled={!prompt}><Play size={16} /> Send to Raw</button>
          <button onClick={() => streamPanel(aigate, prompt, systemPrompt, scenario, setAigate)} disabled={!prompt}><Play size={16} /> Send to FortiAIGate</button>
          <button onClick={sendBoth} disabled={!prompt}><Play size={16} /> Send to Both</button>
          <button onClick={clear}><Eraser size={16} /> Clear</button>
          {mode === 'analytic' && (
            <div className="profileTools">
              <select value={selectedProfileId} onChange={(event) => selectProfile(event.target.value)}>
                <option value="">Select profile</option>
                {savedProfiles.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <button onClick={() => loadSelectedProfile()} disabled={!selectedProfileId}><Upload size={16} /> Load Profile</button>
              <button onClick={saveProfile} disabled={!selectedProfileId && !profileName.trim()}><Save size={16} /> Save</button>
              <button onClick={saveProfileAs}><Save size={16} /> Save As</button>
              <button onClick={exportSelectedProfile} disabled={!selectedProfileId}><Download size={16} /> Export</button>
              <button onClick={() => profileImportRef.current?.click()}><FileUp size={16} /> Import</button>
              <input ref={profileImportRef} className="hiddenFile" type="file" accept="application/json,.json" onChange={importProfileFile} />
            </div>
          )}
        </div>
      </section>

      <div className="panels">
        <Panel panel={raw} setPanel={setRaw} prompt={prompt} systemPrompt={systemPrompt} scenario={scenario} onSend={streamPanel} mode={mode} />
        <Panel panel={aigate} setPanel={setAigate} prompt={prompt} systemPrompt={systemPrompt} scenario={scenario} onSend={streamPanel} mode={mode} />
      </div>

      {mode === 'analytic' && <DiffView raw={raw} fortiAIGate={aigate} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
