/**
 * API key, endpoint/model presets and their quotas, target language, prompt.
 *
 * Free-tier limits change, so every number here is editable rather than hardcoded,
 * and users can add their own OpenAI-compatible endpoints.
 */
import { useState } from "preact/hooks";
import type { Preset } from "../llm/presets";
import { DEFAULT_SYSTEM_PROMPT } from "../llm/prompt";
import { LANGS, LANG_LABEL, type Lang } from "../scenario/model";
import { useStore } from "./store";

const LIMIT_FIELDS: { key: keyof Preset["limits"]; label: string; hint: string }[] = [
  { key: "rpm", label: "Requests / minute", hint: "0 = no limit" },
  { key: "rpd", label: "Requests / day", hint: "0 = no limit" },
  { key: "tpm", label: "Input tokens / minute", hint: "0 = no limit" },
  { key: "maxInputTokens", label: "Max input tokens", hint: "per request" },
  { key: "maxOutputTokens", label: "Max output tokens", hint: "per request" },
];

export function SettingsView() {
  const store = useStore();
  const { settings } = store;
  const preset = store.activePreset();
  const [showKey, setShowKey] = useState(false);

  const updatePreset = (patch: Partial<Preset>) => {
    void store.saveSettings({
      presets: settings.presets.map((p) => (p.id === preset.id ? { ...p, ...patch } : p)),
    });
  };

  const updateLimits = (patch: Partial<Preset["limits"]>) =>
    updatePreset({ limits: { ...preset.limits, ...patch } });

  const usedToday = settings.limiter[preset.id]?.dayRequests ?? 0;
  const calibration = settings.calibration[`${preset.model}:${settings.targetLang}`];

  return (
    <section class="settings">
      <h2>Endpoint</h2>
      <div class="row">
        <select
          value={settings.presetId}
          onChange={(e) => void store.saveSettings({ presetId: (e.target as HTMLSelectElement).value })}
        >
          {settings.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button onClick={addPreset}>Add endpoint…</button>
        {!preset.builtin ? (
          <button class="danger" onClick={removePreset}>
            Delete
          </button>
        ) : null}
      </div>

      <div class="grid">
        <label>
          Name
          <input value={preset.label} onInput={(e) => updatePreset({ label: value(e) })} />
        </label>
        <label>
          Base URL
          <input value={preset.baseUrl} onInput={(e) => updatePreset({ baseUrl: value(e) })} />
        </label>
        <label>
          Model
          <input value={preset.model} onInput={(e) => updatePreset({ model: value(e) })} />
        </label>
        <label>
          Daily quota resets in
          <input value={preset.quotaResetTz} onInput={(e) => updatePreset({ quotaResetTz: value(e) })} />
        </label>
        <label>
          Reasoning effort
          <select
            value={preset.reasoningEffort ?? ""}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              updatePreset({ reasoningEffort: v ? (v as Preset["reasoningEffort"]) : undefined });
            }}
          >
            <option value="">Default (let the endpoint decide)</option>
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <small>
            Caps "thinking" tokens on reasoning models (e.g. Gemini 3) that would otherwise consume
            most of the output budget before writing any translation.
          </small>
        </label>
      </div>

      <label class="key">
        API key for {new URL(safeUrl(preset.baseUrl)).host}
        <span class="row">
          <input
            type={showKey ? "text" : "password"}
            value={settings.apiKeys[preset.baseUrl] ?? ""}
            placeholder={preset.baseUrl.includes("localhost") ? "not needed for the mock server" : "paste your key"}
            onInput={(e) =>
              void store.saveSettings({
                apiKeys: { ...settings.apiKeys, [preset.baseUrl]: value(e) },
              })
            }
          />
          <button onClick={() => setShowKey((v) => !v)}>{showKey ? "Hide" : "Show"}</button>
        </span>
      </label>
      <p class="hint">
        Keys stay in this browser and are sent only to the endpoint above. They are never included
        in exported translation files.
        {preset.keyUrl ? (
          <>
            {" "}
            <a href={preset.keyUrl} target="_blank" rel="noreferrer">
              Get a key
            </a>
            .
          </>
        ) : null}
      </p>

      <h2>Limits</h2>
      <div class="grid">
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              min={0}
              value={preset.limits[f.key]}
              onInput={(e) => updateLimits({ [f.key]: Number(value(e)) || 0 })}
            />
            <small>{f.hint}</small>
          </label>
        ))}
        <label>
          Chunk size override
          <input
            type="number"
            min={0}
            value={settings.chunkInputTokens}
            onInput={(e) => void store.saveSettings({ chunkInputTokens: Number(value(e)) || 0 })}
          />
          <small>input tokens per call; 0 = use the endpoint's</small>
        </label>
      </div>
      <p class="hint">
        Used today: {usedToday}
        {preset.limits.rpd ? ` of ${preset.limits.rpd}` : ""} requests.
        {calibration?.samples
          ? ` Measured ${calibration.charsPerToken.toFixed(2)} Japanese characters per token over ${calibration.samples} response(s).`
          : " Japanese tokenizes far denser than English; the estimate calibrates itself after the first call."}
      </p>

      <h2>Translation</h2>
      <label>
        Default target language
        <select
          value={settings.targetLang}
          onChange={(e) =>
            void store.saveSettings({ targetLang: (e.target as HTMLSelectElement).value as Lang })
          }
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {LANG_LABEL[l]}
            </option>
          ))}
        </select>
      </label>

      <label class="prompt">
        System prompt
        <textarea
          rows={22}
          value={settings.systemPrompt}
          onInput={(e) => void store.saveSettings({ systemPrompt: value(e) })}
        />
      </label>
      <div class="row">
        <span class="hint">
          <code>{"{{targetLanguage}}"}</code> and <code>{"{{glossary}}"}</code> are filled in per
          request. Changing the output-format rules will break response parsing.
        </span>
        <span class="spacer" />
        <button onClick={() => void store.saveSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>
          Reset to default
        </button>
      </div>
    </section>
  );

  function addPreset() {
    const id = `custom-${Date.now().toString(36)}`;
    const next: Preset = {
      ...preset,
      id,
      label: "New endpoint",
      builtin: false,
    };
    void store.saveSettings({ presets: [...settings.presets, next], presetId: id });
  }

  function removePreset() {
    const presets = settings.presets.filter((p) => p.id !== preset.id);
    void store.saveSettings({ presets, presetId: presets[0]?.id ?? "" });
  }
}

function value(e: Event): string {
  return (e.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function safeUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return "http://invalid.example";
  }
}
