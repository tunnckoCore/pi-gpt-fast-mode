import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_MODELS = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.5",
  "openai/gpt-5.6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.4-mini",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
]);
export const TARGET_PROVIDER = "openai-codex";
export const TARGET_MODEL = "gpt-5.6";
export const FAST_SERVICE_TIER = "priority";
export const CONFIG_FIELD = "pi-gpt-fast-mode";
export const KEYBINDING_FIELD = CONFIG_FIELD;
export const DEFAULT_SHORTCUT = "ctrl+alt+m";
export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

type PiModel = { provider?: string; id?: string };
type ProviderPayload = Record<string, unknown>;
type PiConfig = Record<string, unknown>;
type ReadTextFile = (path: string, encoding: "utf8") => string;

type PiFileLoadOptions = {
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: ReadTextFile;
};

/**
 * True when this request is for a supported GPT model this extension knows how to speed up.
 * The payload check makes tests and future provider edge-cases less dependent on ctx.model.
 */
export function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

export function isSupportedModel(model: PiModel | undefined): boolean {
  if (!model?.provider || !model.id) return false;
  return SUPPORTED_MODELS.has(modelKey(model));
}

export function shouldApplyFastMode(model: PiModel | undefined, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const requestModel = (payload as ProviderPayload).model;
  return isSupportedModel(model) && requestModel === model?.id;
}

/** Return a patched provider payload that asks Codex for the Fast service tier. */
export function withFastServiceTier(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as ProviderPayload),
    service_tier: FAST_SERVICE_TIER,
  };
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/**
 * Resolve a global Pi config file path for this extension to read.
 * Order: PI_CODING_AGENT_DIR, then XDG config locations if present, then Pi's default.
 */
export function resolvePiFilePath(fileName: string, options: PiFileLoadOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;

  const piDir = env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return join(resolve(expandHome(piDir, home)), fileName);

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
    ? resolve(expandHome(env.XDG_CONFIG_HOME, home))
    : join(home, ".config");

  const xdgCandidates = [join(xdgConfigHome, "pi", "agent", fileName), join(xdgConfigHome, "pi", fileName)];

  for (const candidate of xdgCandidates) {
    if (exists(candidate)) return candidate;
  }

  return join(home, ".pi", "agent", fileName);
}

/** Resolve the global Pi keybindings file this extension should read. */
export function resolveKeybindingsPath(options: PiFileLoadOptions = {}): string {
  return resolvePiFilePath("keybindings.json", options);
}

/** Resolve the global Pi settings file this extension should read. */
export function resolveSettingsPath(options: PiFileLoadOptions = {}): string {
  return resolvePiFilePath("settings.json", options);
}

function normalizeShortcutList(values: unknown[]): string[] {
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shortcut) => !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()));
}

export function normalizeShortcutSetting(value: unknown): string[] {
  if (value === false || value === null) return [];
  if (Array.isArray(value)) return normalizeShortcutList(value);

  const shortcuts = normalizeShortcutList([value]);
  return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

function readPiJson(path: string, readFile: ReadTextFile): PiConfig | undefined {
  try {
    const raw = readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PiConfig) : undefined;
  } catch {
    return undefined;
  }
}

function writeDefaultEnabled(enabled: boolean): string | undefined {
  const settingsPath = resolveSettingsPath();
  let settings: PiConfig = {};

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `Settings file ${settingsPath} must contain a JSON object.`;
    }
    settings = parsed as PiConfig;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      return `Unable to read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const extensionConfig = settings[CONFIG_FIELD];
  const nextSettings = {
    ...settings,
    [CONFIG_FIELD]: extensionConfig && typeof extensionConfig === "object" && !Array.isArray(extensionConfig)
      ? { ...(extensionConfig as PiConfig), enabled }
      : { enabled },
  };
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  let tempFd: number | undefined;
  let tempCreated = false;

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    tempFd = openSync(tempPath, "wx", 0o600);
    tempCreated = true;
    writeFileSync(tempFd, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
    closeSync(tempFd);
    tempFd = undefined;
    renameSync(tempPath, settingsPath);
    tempCreated = false;
    return undefined;
  } catch (error) {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch {}
    }
    if (tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
    return `Unable to save ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Read shortcuts from the global Pi keybindings JSON.
 * Uses the field `pi-gpt-fast-mode`. Missing or invalid config falls back to ctrl+alt+m.
 * Set the field to false or null to disable the shortcut entirely.
 */
export function loadShortcuts(options: PiFileLoadOptions = {}): string[] {
  const readFile: ReadTextFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const parsed = readPiJson(resolveKeybindingsPath(options), readFile);
  return parsed ? normalizeShortcutSetting(parsed[KEYBINDING_FIELD]) : [DEFAULT_SHORTCUT];
}

/**
 * Read the default Fast mode state from global Pi settings.
 * `{ "pi-gpt-fast-mode": { "enabled": true } }` starts sessions enabled.
 */
export function loadDefaultEnabled(options: PiFileLoadOptions = {}): boolean {
  const readFile: ReadTextFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const parsed = readPiJson(resolveSettingsPath(options), readFile);
  const extensionConfig = parsed?.[CONFIG_FIELD];

  if (!extensionConfig || typeof extensionConfig !== "object" || Array.isArray(extensionConfig)) return false;
  return (extensionConfig as { enabled?: unknown }).enabled === true;
}

function isSupportedModelContext(ctx: unknown): boolean {
  const model = (ctx as { model?: PiModel } | undefined)?.model;
  return isSupportedModel(model);
}

function currentModelLabel(ctx: unknown): string {
  const model = (ctx as { model?: PiModel } | undefined)?.model;
  return model?.provider && model.id ? modelKey(model) : "unknown model";
}

function notify(ctx: unknown, message: string, level: "info" | "warning" | "error" = "info"): void {
  const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } } | undefined)?.ui;
  ui?.notify?.(message, level);
}

function announceState(ctx: unknown, enabled: boolean): void {
  if (!enabled) {
    notify(ctx, "GPT Fast mode disabled.");
    return;
  }

  if (isSupportedModelContext(ctx)) {
    notify(ctx, `GPT Fast mode enabled (service_tier: ${FAST_SERVICE_TIER}).`);
    return;
  }

  notify(ctx, `GPT Fast mode enabled, but ${currentModelLabel(ctx)} is not supported.`, "warning");
}

const FAST_USAGE = "Usage: /fast [on|off|status|default on|default off]";

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = loadDefaultEnabled();

  async function toggle(ctx: unknown): Promise<void> {
    enabled = !enabled;
    announceState(ctx, enabled);
  }

  function setEnabled(value: boolean, ctx: unknown): void {
    enabled = value;
    announceState(ctx, enabled);
  }

  function setDefault(value: boolean, ctx: unknown): void {
    const error = writeDefaultEnabled(value);
    if (error) return notify(ctx, error, "error");
    notify(ctx, `GPT Fast mode default ${value ? "enabled" : "disabled"} for future sessions.`);
  }

  pi.registerCommand("fast", {
    description: "Control GPT Fast mode (service_tier: priority)",
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase().replace(/\s+/g, " ")) {
        case "": return toggle(ctx);
        case "on": return setEnabled(true, ctx);
        case "off": return setEnabled(false, ctx);
        case "status":
          notify(ctx, `GPT Fast mode status: current: ${enabled ? "enabled" : "disabled"}; default: ${loadDefaultEnabled() ? "enabled" : "disabled"}.`);
          return;
        case "default on": return setDefault(true, ctx);
        case "default off": return setDefault(false, ctx);
        default: return notify(ctx, FAST_USAGE, "warning");
      }
    },
  });

  for (const shortcut of loadShortcuts()) {
    pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: "Toggle GPT Fast mode",
      handler: async (ctx) => {
        await toggle(ctx);
      },
    });
  }

  pi.on("session_start", () => {
    enabled = loadDefaultEnabled();
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return undefined;
    if (!shouldApplyFastMode(ctx.model, event.payload)) return undefined;
    return withFastServiceTier(event.payload);
  });
}
