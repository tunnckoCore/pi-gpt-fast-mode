import assert from "node:assert/strict";
import fastModeExtension, {
  DEFAULT_SHORTCUT,
  FAST_SERVICE_TIER,
  TARGET_MODEL,
  TARGET_PROVIDER,
  shouldApplyFastMode,
  withFastServiceTier,
} from "../extensions/fast-mode.js";

function createMockPi() {
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();

  return {
    commands,
    shortcuts,
    handlers,
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut(shortcut, options) {
      shortcuts.set(shortcut, options);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function createCtx(model = { provider: TARGET_PROVIDER, id: TARGET_MODEL }) {
  const notifications = [];
  const statuses = [];

  return {
    model,
    notifications,
    statuses,
    ui: {
      notify(message, level = "info") {
        notifications.push({ message, level });
      },
      setStatus(id, value) {
        statuses.push({ id, value });
      },
    },
  };
}

assert.equal(shouldApplyFastMode({ provider: TARGET_PROVIDER, id: TARGET_MODEL }, { model: TARGET_MODEL }), true);
assert.equal(shouldApplyFastMode({ provider: "openai", id: TARGET_MODEL }, { model: TARGET_MODEL }), false);
assert.equal(shouldApplyFastMode({ provider: TARGET_PROVIDER, id: "gpt-5.4" }, { model: "gpt-5.4" }), false);
assert.deepEqual(withFastServiceTier({ model: TARGET_MODEL, input: [] }), {
  model: TARGET_MODEL,
  input: [],
  service_tier: FAST_SERVICE_TIER,
});

const pi = createMockPi();
fastModeExtension(pi);

assert.ok(pi.commands.has("fast"), "registers /fast command");
assert.ok(pi.shortcuts.has(DEFAULT_SHORTCUT), `registers ${DEFAULT_SHORTCUT} shortcut`);
assert.ok(pi.handlers.has("before_provider_request"), "registers payload hook");

const ctx = createCtx();
const payloadHook = pi.handlers.get("before_provider_request");

assert.equal(payloadHook({ payload: { model: TARGET_MODEL } }, ctx), undefined, "default is off");

await pi.commands.get("fast").handler("", ctx);
assert.equal(ctx.statuses.at(-1).value, "fast: on");
assert.match(ctx.notifications.at(-1).message, /enabled/);
assert.deepEqual(payloadHook({ payload: { model: TARGET_MODEL, store: false } }, ctx), {
  model: TARGET_MODEL,
  store: false,
  service_tier: FAST_SERVICE_TIER,
});

await pi.commands.get("fast").handler("", ctx);
assert.equal(ctx.statuses.at(-1).value, undefined);
assert.match(ctx.notifications.at(-1).message, /disabled/);
assert.equal(payloadHook({ payload: { model: TARGET_MODEL } }, ctx), undefined, "second toggle disables");

const unsupportedCtx = createCtx({ provider: "openai", id: TARGET_MODEL });
await pi.shortcuts.get(DEFAULT_SHORTCUT).handler(unsupportedCtx);
assert.equal(payloadHook({ payload: { model: TARGET_MODEL } }, unsupportedCtx), undefined, "does not patch other providers");
assert.equal(unsupportedCtx.notifications.at(-1).level, "warning");

console.log("smoke ok");
