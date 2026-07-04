import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TARGET_PROVIDER = "openai-codex";
export const TARGET_MODEL = "gpt-5.5";
export const FAST_SERVICE_TIER = "priority";
export const KEYBINDING_FIELD = "pi-gpt-fast-mode";
export const DEFAULT_SHORTCUT = "ctrl+alt+m";
export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

type PiModel = { provider?: string; id?: string };
type ProviderPayload = Record<string, unknown>;
type KeybindingsConfig = Record<string, unknown>;
type ReadTextFile = (path: string, encoding: "utf8") => string;

type ShortcutLoadOptions = {
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: ReadTextFile;
};

/**
 * True when this request is the GPT-5.5 Codex request this extension knows how to speed up.
 * The payload check makes tests and future provider edge-cases less dependent on ctx.model.
 */
export function shouldApplyFastMode(model: PiModel | undefined, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;

  const requestModel = (payload as ProviderPayload).model;
  const isTargetRequest = requestModel === TARGET_MODEL;
  const isTargetContext = model?.provider === TARGET_PROVIDER && model?.id === TARGET_MODEL;

  return isTargetRequest && isTargetContext;
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
 * Resolve the global Pi keybindings file this extension should read.
 * Order: PI_CODING_AGENT_DIR, then XDG config locations if present, then Pi's default.
 */
export function resolveKeybindingsPath(options: ShortcutLoadOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;

  const piDir = env.PI_CODING_AGENT_DIR?.trim();
  if (piDir) return join(resolve(expandHome(piDir, home)), "keybindings.json");

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
    ? resolve(expandHome(env.XDG_CONFIG_HOME, home))
    : join(home, ".config");

  const xdgCandidates = [
    join(xdgConfigHome, "pi", "agent", "keybindings.json"),
    join(xdgConfigHome, "pi", "keybindings.json"),
  ];

  for (const candidate of xdgCandidates) {
    if (exists(candidate)) return candidate;
  }

  return join(home, ".pi", "agent", "keybindings.json");
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

/**
 * Read shortcuts from the global Pi keybindings JSON.
 * Uses the field `pi-gpt-fast-mode`. Missing or invalid config falls back to ctrl+alt+m.
 * Set the field to false or null to disable the shortcut entirely.
 */
export function loadShortcuts(options: ShortcutLoadOptions = {}): string[] {
  const readFile: ReadTextFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const keybindingsPath = resolveKeybindingsPath(options);

  try {
    const raw = readFile(keybindingsPath, "utf8");
    const parsed = JSON.parse(raw) as KeybindingsConfig;
    return normalizeShortcutSetting(parsed[KEYBINDING_FIELD]);
  } catch {
    return [DEFAULT_SHORTCUT];
  }
}

function isTargetModelContext(ctx: unknown): boolean {
  const model = (ctx as { model?: PiModel } | undefined)?.model;
  return model?.provider === TARGET_PROVIDER && model?.id === TARGET_MODEL;
}

function notify(ctx: unknown, message: string, level: "info" | "warning" | "error" = "info"): void {
  const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } } | undefined)?.ui;
  ui?.notify?.(message, level);
}

function announceState(ctx: unknown, enabled: boolean): void {
  if (!enabled) {
    notify(ctx, "GPT-5.5 Fast mode disabled.");
    return;
  }

  if (isTargetModelContext(ctx)) {
    notify(ctx, "GPT-5.5 Fast mode enabled (service_tier: priority).");
    return;
  }

  notify(
    ctx,
    `GPT-5.5 Fast mode enabled; it will apply when the active model is ${TARGET_PROVIDER}/${TARGET_MODEL}.`,
    "warning",
  );
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = false;

  async function toggle(ctx: unknown): Promise<void> {
    enabled = !enabled;
    announceState(ctx, enabled);
  }

  pi.registerCommand("fast", {
    description: "Toggle GPT-5.5 Codex Fast mode (service_tier: priority)",
    handler: async (_args, ctx) => {
      await toggle(ctx);
    },
  });

  for (const shortcut of loadShortcuts()) {
    pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: "Toggle GPT-5.5 Codex Fast mode",
      handler: async (ctx) => {
        await toggle(ctx);
      },
    });
  }

  pi.on("session_start", () => {
    enabled = false;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return undefined;
    if (!shouldApplyFastMode(ctx.model, event.payload)) return undefined;
    return withFastServiceTier(event.payload);
  });
}
