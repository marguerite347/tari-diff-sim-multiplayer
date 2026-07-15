'use strict';

/**
 * LLMBridge — optional second brain for the Copilot.
 *
 * Talks to any OpenAI-compatible chat-completions endpoint (OpenRouter,
 * OpenAI, local Ollama/LM Studio, or a custom base URL) directly from the
 * browser. The API key stays in memory unless the user opts into local
 * persistence, and is sent exclusively to the configured provider.
 *
 * The bridge is transport + settings + UI. Game knowledge (prompts, when to
 * call, how to blend guidance with the reflex heuristics) lives in agent.js.
 */
const LLMBridge = (function () {
  const SETTINGS_KEY = 'copilotLLM.v1';
  const CONTEXT_CACHE_PREFIX = 'copilotLLM.context.v1.';
  const MAX_PROMPT_CONTEXT_CHARS = 6000;
  const TIMEOUT_MS = 4000;

  const PRESETS = {
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelHint: 'e.g. meta-llama/llama-3.3-70b-instruct:free (":free" models cost nothing)',
    },
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      modelHint: 'e.g. gpt-4o-mini',
    },
    local: {
      label: 'Local (Ollama / LM Studio)',
      baseUrl: 'http://localhost:11434/v1',
      modelHint: 'e.g. llama3.2 — no key needed for most local servers',
    },
    custom: {
      label: 'Custom',
      baseUrl: '',
      modelHint: 'any OpenAI-compatible /chat/completions endpoint',
    },
  };

  let settings = loadSettings();
  let uiLog = null; // copilot log fn injected by multiplayer.js
  let repoContext = null;
  let repoContextPromise = null;

  function loadSettings() {
    const defaults = {
      enabled: false,
      preset: 'openrouter',
      baseUrl: PRESETS.openrouter.baseUrl,
      model: '',
      apiKey: '',
      rememberKey: false,
    };
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      const hasLegacyKey = typeof stored.apiKey === 'string' && stored.apiKey.length > 0;
      const rememberKey = typeof stored.rememberKey === 'boolean' ? stored.rememberKey : hasLegacyKey;
      return {
        ...defaults,
        ...stored,
        rememberKey,
        apiKey: rememberKey && typeof stored.apiKey === 'string' ? stored.apiKey : '',
      };
    }
    catch { return defaults; }
  }

  function saveSettings() {
    const persisted = {
      enabled: settings.enabled,
      preset: settings.preset,
      baseUrl: settings.baseUrl,
      model: settings.model,
      rememberKey: settings.rememberKey,
    };
    if (settings.rememberKey) persisted.apiKey = settings.apiKey;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted)); }
    catch { /* storage unavailable — settings just won't persist */ }
  }

  function baseUrlError() {
    if (!settings.baseUrl) return 'Set a base URL first.';
    let url;
    try { url = new URL(settings.baseUrl); }
    catch { return 'Base URL must be a valid HTTP or HTTPS URL.'; }
    if (!['http:', 'https:'].includes(url.protocol)) return 'Base URL must use HTTPS.';
    const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'http:' && !localHost) {
      return 'Custom providers must use HTTPS unless hosted on localhost or 127.0.0.1.';
    }
    return '';
  }

  function configurationIssue() {
    const urlError = baseUrlError();
    if (urlError) return { fieldId: 'mpLlmBaseUrl', message: urlError };
    if (!settings.model) return { fieldId: 'mpLlmModel', message: 'Set a model first.' };
    if (['openrouter', 'openai'].includes(settings.preset) && !settings.apiKey) {
      return { fieldId: 'mpLlmKey', message: `Set an API key for ${PRESETS[settings.preset].label} first.` };
    }
    return null;
  }

  /** Configured well enough to attempt calls. */
  function isConfigured() { return configurationIssue() === null; }

  /** The LLM brain is switched on AND usable. */
  function isActive() { return settings.enabled && isConfigured(); }

  // --- Transport ---

  async function chat(messages, { maxTokens = 400, timeoutMs = TIMEOUT_MS } = {}) {
    const urlError = baseUrlError();
    if (urlError) throw new Error(urlError);
    const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: settings.model, messages, max_tokens: maxTokens, temperature: 0.7 }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ''}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('provider returned no message content');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pull the first {...} object out of a reply that may include prose/fences. */
  function extractJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object in reply');
    return JSON.parse(text.slice(start, end + 1));
  }

  /**
   * Validate the tool contract:
   * {"weights":[..4..],"totalPower":n,"profileBias":"hardCounter|balanced|lightTouch","say":"..."}
   * Returns only the usable fields; anything malformed becomes null.
   */
  function validateGuidance(raw) {
    const out = { weights: null, totalPower: null, profileBias: null, say: null };
    if (!raw || typeof raw !== 'object') return null;
    if (Array.isArray(raw.weights) && raw.weights.length === 4) {
      const w = raw.weights.map((v) => Number(v));
      const sum = w.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
      if (w.every((v) => Number.isFinite(v) && v >= 0) && sum > 0) {
        out.weights = w.map((v) => v / sum);
      }
    }
    const power = Number(raw.totalPower);
    if (Number.isFinite(power)) out.totalPower = Math.max(40, Math.min(400, power));
    if (['hardCounter', 'balanced', 'lightTouch'].includes(raw.profileBias)) out.profileBias = raw.profileBias;
    if (typeof raw.say === 'string' && raw.say.trim()) out.say = raw.say.trim().slice(0, 600);
    if (out.weights === null && out.totalPower === null && out.profileBias === null && out.say === null) return null;
    return out;
  }

  /**
   * One guidance consultation. Never throws — returns validated guidance or
   * null (parse failure, HTTP error, timeout), so the caller can silently
   * fall back to heuristics.
   */
  async function requestGuidance(systemPrompt, userPrompt) {
    if (!isActive()) return null;
    try {
      const reply = await chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      return validateGuidance(extractJson(reply));
    } catch {
      return null;
    }
  }

  /** Minimal round-trip for the TEST button. */
  async function test() {
    const urlError = baseUrlError();
    if (urlError) return { ok: false, message: urlError };
    if (!settings.model) return { ok: false, message: 'Set a model first.' };
    try {
      const reply = await chat(
        [{ role: 'user', content: 'Reply with the single word OK.' }],
        { maxTokens: 10, timeoutMs: 8000 }
      );
      return { ok: true, message: `Provider responded: "${reply.trim().slice(0, 60)}"` };
    } catch (err) {
      const why = err.name === 'AbortError' ? 'timed out' : (err.message || String(err));
      return { ok: false, message: why };
    }
  }

  // --- UI (wired from multiplayer.js init) ---

  function el(id) { return document.getElementById(id); }

  function renderBrainButton() {
    const btn = el('mpLlmBrain');
    if (!btn) return;
    btn.textContent = `Brain: ${isActive() ? 'LLM' : 'HEURISTIC'}`;
    btn.classList.toggle('primary', isActive());
  }

  function renderEnabledButton() {
    const btn = el('mpLlmEnabled');
    if (!btn) return;
    btn.textContent = `Use LLM advisor: ${isActive() ? 'ON' : 'OFF'}`;
    btn.classList.toggle('primary', isActive());
  }

  function setPanelOpen(open) {
    const panel = el('mpLlmPanel');
    const btn = el('mpLlmBrain');
    if (panel) panel.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  function clearFieldError(fieldId) {
    const input = el(fieldId);
    if (!input) return;
    input.classList.remove('mp-llm-invalid');
    if (fieldId !== 'mpLlmBaseUrl') input.setCustomValidity('');
  }

  function showConfigurationIssue(issue) {
    setPanelOpen(true);
    const input = el(issue.fieldId);
    if (input) {
      input.setCustomValidity(issue.message);
      input.classList.add('mp-llm-invalid');
      input.focus();
      input.reportValidity();
      requestAnimationFrame(() => input.focus());
    }
    uiLog?.(`LLM bridge: advisor remains OFF — ${issue.message}`, 'alert');
  }

  function contextVersionLabel(bundle) {
    return bundle?.version?.commit
      ? bundle.version.commit.slice(0, 7)
      : `v${bundle?.version?.packageVersion || bundle?.schemaVersion || '?'}`;
  }

  function renderContextStatus(state, detail = '') {
    const status = el('mpLlmContextStatus');
    if (!status) return;
    status.textContent = state === 'synced'
      ? `Synced · ${detail}`
      : (state === 'syncing' ? 'Syncing…' : 'Not synced');
    status.classList.toggle('synced', state === 'synced');
    status.classList.toggle('failed', state === 'failed');
  }

  function contextCacheKey(bundle) {
    return `${CONTEXT_CACHE_PREFIX}${bundle.version?.buildId || bundle.schemaVersion}`;
  }

  function readCachedContext(bundle) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(contextCacheKey(bundle)));
      return cached?.schemaVersion === bundle.schemaVersion ? cached : null;
    } catch { return null; }
  }

  function cacheContext(bundle) {
    try { sessionStorage.setItem(contextCacheKey(bundle), JSON.stringify(bundle)); }
    catch { /* context still remains available in memory */ }
  }

  async function syncRepoContext({ force = false } = {}) {
    if (repoContext && !force) {
      renderContextStatus('synced', contextVersionLabel(repoContext));
      return repoContext;
    }
    if (repoContextPromise && !force) return repoContextPromise;
    renderContextStatus('syncing');
    repoContextPromise = fetch('/api/llm-context', {
      method: 'GET',
      credentials: 'same-origin',
      cache: force ? 'no-cache' : 'default',
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bundle = await res.json();
      if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.sources) || !bundle.version?.buildId) {
        throw new Error('invalid context bundle');
      }
      repoContext = force ? bundle : (readCachedContext(bundle) || bundle);
      cacheContext(repoContext);
      renderContextStatus('synced', contextVersionLabel(repoContext));
      return repoContext;
    }).catch((err) => {
      renderContextStatus('failed');
      uiLog?.(`LLM bridge: repo context sync unavailable (${err.message || err}); built-in game context remains active.`, 'sys');
      return null;
    }).finally(() => {
      repoContextPromise = null;
    });
    return repoContextPromise;
  }

  function repoContextPrompt() {
    if (!repoContext) return '';
    const wanted = [
      ['AGENTS.md', ['What this project is', 'Simulation invariants — never break these']],
      ['.cursor/rules/simulation-invariants.mdc', ['Never break']],
      ['.cursor/rules/research-data.mdc', ['Objective types']],
      ['skills/tune-copilot-strategy/SKILL.md', ['Architecture']],
    ];
    const chunks = [];
    wanted.forEach(([name, headings]) => {
      const source = repoContext.sources.find((item) => item.name === name);
      if (!source) return;
      source.sections
        .filter((section) => headings.includes(section.heading))
        .forEach((section) => chunks.push(section.text));
    });
    const text = chunks.join('\n\n');
    if (!text) return '';
    const version = contextVersionLabel(repoContext);
    return `CURATED REPOSITORY CONTEXT (${version}; read-only public docs):\n${text.slice(0, MAX_PROMPT_CONTEXT_CHARS)}`;
  }

  function renderBaseUrlValidity() {
    const input = el('mpLlmBaseUrl');
    if (!input) return;
    const error = baseUrlError();
    input.setCustomValidity(error);
    input.classList.toggle('mp-llm-invalid', !!error);
  }

  function fillForm() {
    if (el('mpLlmPreset')) el('mpLlmPreset').value = settings.preset;
    if (el('mpLlmBaseUrl')) el('mpLlmBaseUrl').value = settings.baseUrl;
    if (el('mpLlmModel')) {
      el('mpLlmModel').value = settings.model;
      el('mpLlmModel').placeholder = PRESETS[settings.preset]?.modelHint || 'model id';
    }
    if (el('mpLlmKey')) el('mpLlmKey').value = settings.apiKey;
    if (el('mpLlmRememberKey')) el('mpLlmRememberKey').checked = settings.rememberKey;
    renderBaseUrlValidity();
  }

  function initUI({ log } = {}) {
    uiLog = log || null;

    if (settings.enabled && !isConfigured()) {
      settings.enabled = false;
      saveSettings();
    }

    el('mpLlmBrain')?.addEventListener('click', () => {
      const panel = el('mpLlmPanel');
      setPanelOpen(panel?.hidden === true);
    });

    el('mpLlmPreset')?.addEventListener('change', (e) => {
      settings.preset = e.target.value;
      const preset = PRESETS[settings.preset];
      if (preset && preset.baseUrl) settings.baseUrl = preset.baseUrl;
      if (settings.enabled && !isConfigured()) settings.enabled = false;
      saveSettings();
      fillForm();
      renderEnabledButton();
      renderBrainButton();
    });
    el('mpLlmBaseUrl')?.addEventListener('change', (e) => {
      settings.baseUrl = e.target.value.trim();
      saveSettings();
      renderBaseUrlValidity();
      if (!e.target.checkValidity()) {
        uiLog?.(`LLM bridge: ${e.target.validationMessage}`, 'alert');
        e.target.reportValidity();
      }
    });
    el('mpLlmBaseUrl')?.addEventListener('input', () => clearFieldError('mpLlmBaseUrl'));
    el('mpLlmModel')?.addEventListener('input', () => clearFieldError('mpLlmModel'));
    el('mpLlmKey')?.addEventListener('input', () => clearFieldError('mpLlmKey'));
    el('mpLlmModel')?.addEventListener('change', (e) => { settings.model = e.target.value.trim(); saveSettings(); });
    el('mpLlmKey')?.addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); });
    el('mpLlmRememberKey')?.addEventListener('change', (e) => {
      settings.rememberKey = e.target.checked;
      saveSettings();
    });

    el('mpLlmTest')?.addEventListener('click', async () => {
      uiLog?.('LLM bridge: testing connection…', 'sys');
      const result = await test();
      uiLog?.(
        result.ok
          ? `[LLM] Bridge test OK — ${result.message}`
          : `[LLM] Bridge test FAILED — ${result.message}`,
        result.ok ? 'llm' : 'alert'
      );
    });

    el('mpLlmContextSync')?.addEventListener('click', () => {
      syncRepoContext({ force: true });
    });

    el('mpLlmEnabled')?.addEventListener('click', () => {
      if (!settings.enabled) {
        const issue = configurationIssue();
        if (issue) {
          settings.enabled = false;
          saveSettings();
          renderEnabledButton();
          renderBrainButton();
          showConfigurationIssue(issue);
          return;
        }
        settings.enabled = true;
      } else {
        settings.enabled = false;
      }
      saveSettings();
      renderEnabledButton();
      renderBrainButton();
      uiLog?.(
        settings.enabled
          ? `[LLM] Brain switched to LLM (${settings.model} via ${PRESETS[settings.preset]?.label || 'custom'}). Heuristics stay on as the reflex layer; I consult the model at mission brief, major attack shifts, and the postmortem.`
          : 'Brain switched to HEURISTIC — pure reflex agent, no LLM calls.',
        settings.enabled ? 'llm' : 'sys'
      );
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el('mpLlmPanel')?.hidden) {
        setPanelOpen(false);
        return;
      }
    });

    fillForm();
    renderEnabledButton();
    renderBrainButton();
    syncRepoContext();
  }

  return { initUI, isActive, isConfigured, repoContextPrompt, requestGuidance, syncRepoContext, test };
})();

if (typeof window !== 'undefined') window.LLMBridge = LLMBridge;
