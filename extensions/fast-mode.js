// @ts-check

const TARGET_PROVIDER = "openai-codex";
const TARGET_MODEL = "gpt-5.5";
const FAST_SERVICE_TIER = "priority";
const STATUS_ID = "gpt-fastmode";
const DEFAULT_SHORTCUT = "ctrl+alt+f";

/**
 * @typedef {{ provider?: string; id?: string }} PiModel
 * @typedef {Record<string, unknown>} ProviderPayload
 */

/**
 * True when this request is the GPT-5.5 Codex request this extension knows how to speed up.
 * The payload check makes smoke tests and future provider edge-cases less dependent on ctx.model.
 *
 * @param {PiModel | undefined} model
 * @param {unknown} payload
 */
export function shouldApplyFastMode(model, payload) {
  if (!payload || typeof payload !== "object") return false;

  const requestModel = /** @type {ProviderPayload} */ (payload).model;
  const isTargetRequest = requestModel === TARGET_MODEL;
  const isTargetContext = model?.provider === TARGET_PROVIDER && model?.id === TARGET_MODEL;

  return isTargetRequest && isTargetContext;
}

/**
 * Return a patched provider payload that asks Codex for the Fast service tier.
 *
 * @param {unknown} payload
 */
export function withFastServiceTier(payload) {
  if (!payload || typeof payload !== "object") return payload;
  return {
    .../** @type {ProviderPayload} */ (payload),
    service_tier: FAST_SERVICE_TIER,
  };
}

/** @param {unknown} ctx */
function isTargetModelContext(ctx) {
  const model = /** @type {{ model?: PiModel }} */ (ctx)?.model;
  return model?.provider === TARGET_PROVIDER && model?.id === TARGET_MODEL;
}

/**
 * @param {unknown} ctx
 * @param {string | undefined} value
 */
function setStatus(ctx, value) {
  const ui = /** @type {{ ui?: { setStatus?: (id: string, value?: string) => void } }} */ (ctx)?.ui;
  ui?.setStatus?.(STATUS_ID, value);
}

/**
 * @param {unknown} ctx
 * @param {string} message
 * @param {"info" | "warning" | "error"} [level]
 */
function notify(ctx, message, level = "info") {
  const ui = /** @type {{ ui?: { notify?: (message: string, level?: string) => void } }} */ (ctx)?.ui;
  ui?.notify?.(message, level);
}

/**
 * @param {unknown} ctx
 * @param {boolean} enabled
 */
function syncStatus(ctx, enabled) {
  setStatus(ctx, enabled ? "fast: on" : undefined);
}

/**
 * @param {unknown} ctx
 * @param {boolean} enabled
 */
function announceState(ctx, enabled) {
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

/**
 * Pi extension entry point.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function fastModeExtension(pi) {
  let enabled = false;

  async function toggle(ctx) {
    enabled = !enabled;
    syncStatus(ctx, enabled);
    announceState(ctx, enabled);
  }

  pi.registerCommand("fast", {
    description: "Toggle GPT-5.5 Codex Fast mode (service_tier: priority)",
    handler: async (_args, ctx) => {
      await toggle(ctx);
    },
  });

  pi.registerShortcut(DEFAULT_SHORTCUT, {
    description: "Toggle GPT-5.5 Codex Fast mode",
    handler: async (ctx) => {
      await toggle(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    syncStatus(ctx, enabled);
  });

  pi.on("model_select", (_event, ctx) => {
    syncStatus(ctx, enabled);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return undefined;
    if (!shouldApplyFastMode(ctx.model, event.payload)) return undefined;
    return withFastServiceTier(event.payload);
  });
}

export { DEFAULT_SHORTCUT, FAST_SERVICE_TIER, TARGET_MODEL, TARGET_PROVIDER };
