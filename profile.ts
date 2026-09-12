import type { Model as PiModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODEL_PROFILE,
  getActiveModelProfile,
  getModelFallbacksForProfile,
  getModelProfiles,
  getProfileDefaultModel,
  getSubagentTierModels,
  MODEL_CONFIG_PURPOSES,
  modelMatchesProfile,
  resetActiveModelProfile,
  setActiveModelProfile,
  SUBAGENT_CAPABILITIES,
} from "./shared/model-config.ts";

type Model = PiModel<any>;
type ScopedModel = { model: Model; thinkingLevel?: any };

interface StoredScope {
  provider: string;
  id: string;
  thinkingLevel?: any;
}

interface ProfileState {
  name: string;
  baseWasScoped: boolean;
  baseScope: StoredScope[];
}

const STATE_ENTRY_TYPE = "model-profile-state";
const STATUS_ID = "model-profile";

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function replaceScope(ctx: ExtensionContext, models: ScopedModel[]): void {
  // ExtensionContext exposes the live session scope as a read-only view. Mutate
  // that array in place so Pi's built-in picker and model cycling see the gate.
  const scope = ctx.scopedModels as ScopedModel[];
  scope.splice(0, scope.length, ...models);
}

function findStoredState(ctx: ExtensionContext): ProfileState | undefined {
  let state: ProfileState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<ProfileState> | undefined;
    if (
      typeof data?.name === "string"
      && typeof data.baseWasScoped === "boolean"
      && Array.isArray(data.baseScope)
    ) {
      state = data as ProfileState;
    }
  }
  return state;
}

export default function profileExtension(pi: ExtensionAPI): void {
  let baseWasScoped = false;
  let baseScope: ScopedModel[] = [];
  let reconcilingModel = false;
  let invalidProfiles = new Map<string, string[]>();

  function validateProfiles(ctx: ExtensionContext): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const knownModels = new Set(ctx.modelRegistry.getAll().map((model) => modelKey(model)));

    for (const [name, profile] of Object.entries(getModelProfiles())) {
      const issues: string[] = [];
      for (const pattern of profile.allow) {
        try {
          new RegExp(pattern);
        } catch (error) {
          issues.push(`invalid allow regex ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const defaultRef = getProfileDefaultModel(name);
      if (!defaultRef) {
        issues.push("defaultModel is missing or invalid");
      } else {
        const defaultKey = `${defaultRef[0]}/${defaultRef[1]}`;
        if (!knownModels.has(defaultKey)) issues.push(`defaultModel ${defaultKey} was not found`);
        if (!modelMatchesProfile({ provider: defaultRef[0], id: defaultRef[1] }, name)) {
          issues.push(`defaultModel ${defaultKey} does not match the allow regexes`);
        }
      }

      for (const purpose of MODEL_CONFIG_PURPOSES) {
        const hasKnownModel = getModelFallbacksForProfile(purpose, name)
          .some(([provider, id]) => knownModels.has(`${provider}/${id}`));
        if (!hasKnownModel) issues.push(`${purpose} has no allowed model in the model catalog`);
      }
      for (const capability of SUBAGENT_CAPABILITIES) {
        const hasKnownModel = getSubagentTierModels(capability, name)
          .some(([provider, id]) => knownModels.has(`${provider}/${id}`));
        if (!hasKnownModel) issues.push(`subagentModels.${capability} has no allowed model in the model catalog`);
      }

      if (issues.length > 0) result.set(name, issues);
    }
    return result;
  }

  function reportInvalidProfiles(ctx: ExtensionContext): void {
    if (invalidProfiles.size === 0) return;
    const details = [...invalidProfiles]
      .flatMap(([name, issues]) => issues.map((issue) => `${name}: ${issue}`));
    const message = `Invalid model profiles:\n${details.map((issue) => `- ${issue}`).join("\n")}`;
    console.error(`[profile] ${message}`);
    ctx.ui.notify(message, "error");
  }

  function assertValidProfile(name: string): void {
    const issues = invalidProfiles.get(name);
    if (issues) throw new Error(`Profile "${name}" is invalid: ${issues.join("; ")}`);
  }

  function refreshBaseModels(ctx: ExtensionContext): ScopedModel[] {
    return baseScope.flatMap((scoped) => {
      const current = ctx.modelRegistry.find(scoped.model.provider, scoped.model.id);
      return current ? [{ ...scoped, model: current }] : [];
    });
  }

  function profileScope(ctx: ExtensionContext, profile: string): ScopedModel[] {
    const source = baseWasScoped
      ? refreshBaseModels(ctx)
      : ctx.modelRegistry.getAll().map((model) => ({ model }));
    const seen = new Set<string>();
    return source.filter(({ model }) => {
      const key = modelKey(model);
      if (seen.has(key) || !modelMatchesProfile(model, profile)) return false;
      seen.add(key);
      return true;
    });
  }

  function modelIsAllowed(model: Model | undefined, ctx: ExtensionContext): boolean {
    if (!model || !modelMatchesProfile(model)) return false;
    if (!baseWasScoped) return true;
    return refreshBaseModels(ctx).some((scoped) => modelKey(scoped.model) === modelKey(model));
  }

  function availableAllowedModels(ctx: ExtensionContext): Model[] {
    const allowed = new Set(profileScope(ctx, getActiveModelProfile()).map(({ model }) => modelKey(model)));
    return ctx.modelRegistry.getAvailable().filter((model) => allowed.has(modelKey(model)));
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_ID, `profile:${getActiveModelProfile()}`);
  }

  async function ensureAllowedModel(ctx: ExtensionContext, preferred?: Model): Promise<boolean> {
    if (modelIsAllowed(ctx.model, ctx)) return true;

    const available = availableAllowedModels(ctx);
    const replacement = preferred && available.some((model) => modelKey(model) === modelKey(preferred))
      ? preferred
      : available[0];
    if (!replacement) return false;

    reconcilingModel = true;
    try {
      return await pi.setModel(replacement);
    } finally {
      reconcilingModel = false;
    }
  }

  async function applyProfile(
    name: string,
    ctx: ExtensionContext,
    switchToDefault = false,
  ): Promise<boolean> {
    const profile = getModelProfiles()[name];
    if (!profile) throw new Error(`Unknown profile "${name}"`);

    // Validate every expression before changing session state.
    for (const pattern of profile.allow) new RegExp(pattern);

    const scoped = profileScope(ctx, name);
    if (name !== DEFAULT_MODEL_PROFILE && scoped.length === 0) {
      throw new Error(`Profile "${name}" matches no models in the current session scope`);
    }

    const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
    const currentModelIsAllowed = currentKey !== undefined
      && scoped.some(({ model }) => modelKey(model) === currentKey);

    let defaultModel: Model | undefined;
    if (switchToDefault && !currentModelIsAllowed) {
      const defaultRef = getProfileDefaultModel(name);
      if (!defaultRef) throw new Error(`Profile "${name}" has no valid defaultModel`);
      defaultModel = ctx.modelRegistry.find(defaultRef[0], defaultRef[1]);
      if (!defaultModel) throw new Error(`Default model ${defaultRef[0]}/${defaultRef[1]} was not found`);
      const defaultKey = modelKey(defaultModel);
      if (!scoped.some(({ model }) => modelKey(model) === defaultKey)) {
        throw new Error(`Default model ${defaultKey} is outside the current session scope`);
      }
    }

    const previousProfile = getActiveModelProfile();
    const previousScope = [...ctx.scopedModels] as ScopedModel[];
    setActiveModelProfile(name);
    replaceScope(ctx, baseWasScoped || name !== DEFAULT_MODEL_PROFILE ? scoped : []);

    if (defaultModel) {
      reconcilingModel = true;
      let switched = false;
      try {
        switched = await pi.setModel(defaultModel);
      } catch (error) {
        setActiveModelProfile(previousProfile);
        replaceScope(ctx, previousScope);
        throw error;
      } finally {
        reconcilingModel = false;
      }
      if (!switched) {
        setActiveModelProfile(previousProfile);
        replaceScope(ctx, previousScope);
        throw new Error(`Default model ${modelKey(defaultModel)} has no configured authentication`);
      }
    }

    const usable = await ensureAllowedModel(ctx);
    updateStatus(ctx);
    return usable;
  }

  function persistProfile(): void {
    pi.appendEntry<ProfileState>(STATE_ENTRY_TYPE, {
      name: getActiveModelProfile(),
      baseWasScoped,
      baseScope: baseScope.map(({ model, thinkingLevel }) => ({
        provider: model.provider,
        id: model.id,
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      })),
    });
  }

  pi.registerCommand("profile", {
    description: "Limit this session to models allowed by a named profile",
    getArgumentCompletions: (prefix) => {
      const items = Object.keys(getModelProfiles())
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      invalidProfiles = validateProfiles(ctx);
      let name = args.trim();
      if (!name) {
        const profiles = getModelProfiles();
        const names = Object.keys(profiles);
        if (!ctx.hasUI) {
          ctx.ui.notify(`Available profiles: ${names.join(", ")}`, "info");
          return;
        }
        const selected = await ctx.ui.select(
          `Model profile (current: ${getActiveModelProfile()})`,
          names.map((item) => {
            const profile = profiles[item];
            const defaultText = profile.defaultModel ? `default: ${profile.defaultModel}; ` : "";
            return `${item} — ${defaultText}${profile.allow.join(" | ")}`;
          }),
        );
        if (!selected) return;
        name = selected.split(" — ", 1)[0];
      }

      try {
        assertValidProfile(name);
        const usable = await applyProfile(name, ctx, true);
        persistProfile();
        ctx.ui.notify(
          usable
            ? `Model profile "${name}" is active`
            : `Model profile "${name}" is active, but no allowed authenticated model is available`,
          usable ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    invalidProfiles = validateProfiles(ctx);
    reportInvalidProfiles(ctx);

    const stored = findStoredState(ctx);
    if (stored) {
      baseWasScoped = stored.baseWasScoped;
      baseScope = stored.baseScope.flatMap((item) => {
        const model = ctx.modelRegistry.find(item.provider, item.id);
        return model ? [{ model, thinkingLevel: item.thinkingLevel }] : [];
      });
    } else {
      baseWasScoped = ctx.scopedModels.length > 0;
      baseScope = [...ctx.scopedModels];
    }

    const inheritedProfile = ctx.sessionManager.getSessionFile() === undefined
      ? getActiveModelProfile()
      : DEFAULT_MODEL_PROFILE;
    const requestedProfile = stored?.name ?? inheritedProfile;

    try {
      assertValidProfile(requestedProfile);
      const usable = await applyProfile(requestedProfile, ctx, true);
      if (!usable) {
        ctx.ui.notify(
          `Profile "${requestedProfile}" has no allowed authenticated model; prompts will be blocked`,
          "warning",
        );
      }
    } catch (error) {
      resetActiveModelProfile();
      if (!invalidProfiles.has(DEFAULT_MODEL_PROFILE)) {
        await applyProfile(DEFAULT_MODEL_PROFILE, ctx);
      } else {
        ctx.ui.setStatus(STATUS_ID, "profile:invalid");
      }
      ctx.ui.notify(
        `Could not restore model profile "${requestedProfile}": ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (reconcilingModel || modelIsAllowed(event.model, ctx)) return;

    const restored = await ensureAllowedModel(ctx, event.previousModel);
    if (restored) {
      ctx.ui.notify(
        `${modelKey(event.model)} is blocked by profile "${getActiveModelProfile()}"`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        `Profile "${getActiveModelProfile()}" has no allowed authenticated model`,
        "error",
      );
    }
  });

  pi.on("input", async (_event, ctx) => {
    const profile = getActiveModelProfile();
    if (invalidProfiles.has(profile)) {
      ctx.ui.notify(`Prompt blocked: profile "${profile}" is invalid`, "error");
      return { action: "handled" } as const;
    }
    if (await ensureAllowedModel(ctx)) return { action: "continue" } as const;
    ctx.ui.notify(
      `Prompt blocked: profile "${getActiveModelProfile()}" has no allowed authenticated model`,
      "error",
    );
    return { action: "handled" } as const;
  });

  pi.on("session_shutdown", () => {
    resetActiveModelProfile();
  });
}
