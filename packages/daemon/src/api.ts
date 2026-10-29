// The daemon's requests besides /health and /events: sessions, prompts, permission answers,
// the model and effort, and what the settings page shows and changes (DESIGN.md §5.7). Bodies are JSON, checked against @ivy/protocol; a refusal is
// `{ error }` with a status that says what kind.

import {
  addProvider,
  canSwitchModel,
  createLogger,
  EFFORT_LEVELS,
  type Effort,
  errorMessage,
  type Ivy,
  isOfficialApi,
  removeApiKey,
  removeProvider,
  resolveModel,
  saveEffort,
  saveHelperModel,
  saveModel,
  saveUpload,
  saveWritesFirst,
  UnlistedModels,
  updateProvider,
} from "@ivy/kernel";
import type { Logger } from "@ivy/plugin-api";
import {
  AddProvider,
  AnswerPermission,
  type CommandInfo,
  type CommandResult,
  CreateSession,
  type DaemonState,
  Interrupt,
  onlyOneModel,
  type Report,
  RunCommand,
  SendPrompt,
  SetEffort,
  SetHelperModel,
  SetKey,
  SetModel,
  type Settings,
  SetWritesFirst,
  type Switched,
  TestProvider,
  UpdateProvider,
  type Uploaded,
} from "@ivy/protocol";
import type { z } from "zod";
import { statusReport, usageReport } from "./reports.ts";
import { findMessages } from "./search.ts";
import type { Routes } from "./server.ts";
import { PromptError, SessionNotFoundError, type Sessions } from "./sessions.ts";
import { codeVersion } from "./version.ts";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    const text = await req.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    return fail(400, "The body isn't JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return fail(400, parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

export function api(ivy: Ivy, sessions: Sessions): Routes {
  const state = (): DaemonState => ({
    model: ivy.agent.model,
    effort: ivy.capabilities.effort,
    effortUsed: ivy.agent.modelRef && ivy.capabilities.for(ivy.agent.modelRef).effort,
    canSwitchModel: canSwitchModel(ivy.config),
    helperModel: ivy.config.agent.helper_model ?? "",
    writesFirst: ivy.config.agent.writes_first,
    efforts: [...EFFORT_LEVELS],
    plugins: ivy.plugins.list().length,
    tools: ivy.plugins.apiTools().length,
  });

  /** Save a switch to config.toml; if that fails it still applies until the daemon stops. */
  const switched = (save: () => void): Switched => {
    try {
      save();
      return { ...state(), saved: true };
    } catch (err) {
      return { ...state(), saved: false, error: errorMessage(err) };
    }
  };

  const settings = (): Settings => {
    const inUse = ivy.agent.modelRef?.provider.name;
    return {
      providers: Object.values(ivy.config.providers)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          name: p.name,
          type: p.type,
          base_url: p.base_url,
          official: isOfficialApi(p.type, p.base_url),
          models: p.models,
          key: ivy.keySource(p.name),
          inUse: p.name === inUse,
        })),
      keychain: ivy.keys.available,
      permissions: ivy.config.permissions,
      tools: ivy.plugins.toolList(),
      plugins: ivy.plugins.catalog(),
      paths: { home: ivy.paths.home, config: ivy.paths.config },
      code: codeVersion(),
    };
  };

  /** Change the providers in config.toml, then use them as they are now. */
  const changeProviders = (change: () => void): Response => {
    try {
      change();
    } catch (err) {
      return fail(400, errorMessage(err));
    }
    ivy.reloadProviders();
    return Response.json(settings());
  };

  const provider = (name: string) =>
    ivy.config.providers[name] ?? fail(404, `No provider named ${name}`);

  /** Run a plugin command, keeping what it logs for the client's verbose view. */
  const runCommand = async (sessionId: string | undefined, name: string, args: string) => {
    const command = ivy.plugins.getCommand(name);
    if (!command) return fail(404, `Unknown command ${name}. Try /help.`);
    const logs: string[] = [];
    const log = createLogger(command.pluginId);
    const keep =
      (level: keyof Logger) =>
      (msg: string, data?: unknown): void => {
        log[level](msg, data);
        logs.push(
          `[${level}] ${command.pluginId}: ${msg}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`,
        );
      };
    const ctx = {
      ...(sessionId && { sessionId }),
      log: { debug: keep("debug"), info: keep("info"), warn: keep("warn"), error: keep("error") },
    };
    try {
      const output = await command.def.run(args, ctx);
      const result: CommandResult = { logs, ...(output && { output }) };
      return Response.json(result);
    } catch (err) {
      return fail(500, `${name} failed: ${errorMessage(err)}`);
    }
  };

  const handle = async (req: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(req.url);
    let parts: string[];
    try {
      parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return fail(400, "The path isn't valid");
    }
    const route = `${req.method} /${parts.map((p, i) => (i % 2 === 1 ? ":" : p)).join("/")}`;
    const [, id, , sub] = parts as [string, string, string, string];

    switch (route) {
      case "GET /state":
        return Response.json(state());
      case "GET /models":
        return Response.json(await ivy.modelChoices());
      case "PUT /model": {
        const { model: name } = await body(req, SetModel);
        const { models } = await ivy.modelChoices();
        // With none chosen yet, the only one there is can be.
        if (models.length < 2 && ivy.agent.model) return fail(400, onlyOneModel(ivy.agent.model));
        // The provider can be left out when only one provider has a model by that id.
        const byId = models.filter((m) => m.slice(m.indexOf("/") + 1) === name);
        const model = models.includes(name) ? name : byId.length === 1 ? byId[0] : undefined;
        if (!model) return fail(400, `Unknown model ${name}. /model lists the available ones.`);
        try {
          ivy.agent.setModel(model);
        } catch (err) {
          return fail(400, `Can't switch to ${model}: ${errorMessage(err)}`);
        }
        return Response.json(switched(() => saveModel(ivy.paths, model)));
      }
      case "PUT /helper-model": {
        const { model } = await body(req, SetHelperModel);
        if (model) {
          try {
            resolveModel(ivy.config.providers, model);
          } catch (err) {
            return fail(400, `Can't use ${model} as the helper: ${errorMessage(err)}`);
          }
        }
        // Applies at once, saved or not, as a model switch does.
        ivy.config.agent.helper_model = model || undefined;
        return Response.json(switched(() => saveHelperModel(ivy.paths, model || undefined)));
      }
      case "PUT /writes-first": {
        const { on } = await body(req, SetWritesFirst);
        ivy.config.agent.writes_first = on; // applies at once, as the helper does
        saveWritesFirst(ivy.paths, on);
        return Response.json(state());
      }
      case "PUT /effort": {
        const { effort } = await body(req, SetEffort);
        if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
          return fail(400, `Unknown effort ${effort}. Levels: ${EFFORT_LEVELS.join(", ")}`);
        }
        ivy.capabilities.setEffort(effort as Effort);
        return Response.json(switched(() => saveEffort(ivy.paths, effort as Effort)));
      }
      case "GET /settings":
        return Response.json(settings());
      case "POST /providers": {
        const p = await body(req, AddProvider);
        if (p.key && !ivy.keys.available) {
          return fail(400, "No Keychain here: put api_key in config.toml instead");
        }
        return changeProviders(() => {
          addProvider(ivy.paths, p.name, {
            type: p.type,
            ...(p.base_url && { base_url: p.base_url }),
            models: p.models,
          });
          if (p.key) ivy.keys.set(p.name, p.key);
        });
      }
      case "PUT /providers/:": {
        provider(id);
        const edit = await body(req, UpdateProvider);
        return changeProviders(() => updateProvider(ivy.paths, id, edit));
      }
      case "DELETE /providers/:": {
        provider(id);
        if (ivy.agent.modelRef?.provider.name === id) {
          return fail(409, `The model in use is one of ${id}'s: switch models first`);
        }
        // config.toml naming a model on no provider would keep Ivy from starting.
        if (ivy.config.agent.helper_model?.startsWith(`${id}/`)) {
          return fail(409, `The helper model is one of ${id}'s: choose another first`);
        }
        return changeProviders(() => {
          removeProvider(ivy.paths, id);
          if (ivy.keys.available) ivy.keys.remove(id);
        });
      }
      case "PUT /providers/:/key": {
        provider(id);
        const given = (await body(req, SetKey)).key;
        if (!ivy.keys.available) return fail(400, "No Keychain here: put api_key in config.toml");
        const key = given ?? provider(id).api_key ?? fail(400, `${id} has no key to move`);
        return changeProviders(() => {
          ivy.keys.set(id, key);
          // One in config.toml would win over the Keychain's: it moves out.
          if (ivy.keySource(id) === "config") removeApiKey(ivy.paths, id);
        });
      }
      case "DELETE /providers/:/key": {
        provider(id);
        if (ivy.agent.modelRef?.provider.name === id) {
          return fail(409, `The model in use needs ${id}'s key: switch models first`);
        }
        return changeProviders(() => {
          if (ivy.keys.available) ivy.keys.remove(id);
        });
      }
      case "POST /provider-test": {
        const t = await body(req, TestProvider);
        const known = t.name ? ivy.config.providers[t.name] : undefined;
        const key =
          t.key ||
          known?.api_key ||
          (t.name && ivy.keys.available ? ivy.keys.get(t.name) : undefined) ||
          fail(400, "An API key is needed to reach the endpoint");
        try {
          const models = await ivy.listModelsAt({ type: t.type, base_url: t.base_url, key });
          return Response.json({ models });
        } catch (err) {
          const why = `Couldn't list the models: ${errorMessage(err)}`;
          // Reached with the key, but no list: the models are named by hand instead.
          if (err instanceof UnlistedModels) return Response.json({ models: [], unlisted: why });
          return fail(400, why);
        }
      }
      case "GET /commands": {
        const commands: CommandInfo[] = ivy.plugins.commands().map(({ def }) => ({
          name: def.name,
          description: def.description,
          ...(def.args && { args: def.args }),
        }));
        return Response.json(commands);
      }
      // Outside a conversation: what the window shows from a plugin with none going on.
      case "POST /commands": {
        const { name, args } = await body(req, RunCommand);
        return runCommand(undefined, name, args);
      }
      case "POST /sessions/:/commands": {
        const { name, args } = await body(req, RunCommand);
        sessions.fileOf(id); // the session exists
        return runCommand(id, name, args);
      }
      case "GET /sessions/:/usage": {
        sessions.fileOf(id);
        const report: Report = { text: usageReport(ivy.paths.sessions, id) };
        return Response.json(report);
      }
      case "GET /sessions/:/status": {
        const file = sessions.fileOf(id);
        const parts = await ivy.systemPrompt.partsFor(id);
        const report: Report = { text: statusReport(ivy, id, file, parts) };
        return Response.json(report);
      }
      case "GET /search":
        return Response.json(
          findMessages(ivy.history, new URL(req.url).searchParams.get("q") ?? ""),
        );
      case "GET /sessions":
        return Response.json(sessions.list());
      case "POST /sessions": {
        const { display, offRecord } = await body(req, CreateSession);
        return Response.json({ id: sessions.create(display, offRecord) }, { status: 201 });
      }
      case "GET /sessions/:":
        return Response.json(sessions.view(id));
      case "DELETE /sessions/:":
        if (!sessions.delete(id)) fail(409, "Ivy is replying in this session; stop it first");
        return new Response(null, { status: 204 });
      case "POST /sessions/:/prompts": {
        const { text, images } = await body(req, SendPrompt);
        return Response.json(sessions.send(id, text, images), { status: 202 });
      }
      case "POST /images": {
        // The image itself, not JSON: it is kept until a prompt names it (DESIGN.md §5.4).
        const bytes = new Uint8Array(await req.arrayBuffer());
        try {
          const name = saveUpload(ivy.paths.uploads, bytes, req.headers.get("content-type") ?? "");
          return Response.json({ name } satisfies Uploaded, { status: 201 });
        } catch (err) {
          return fail(400, errorMessage(err));
        }
      }
      case "GET /sessions/:/images/:": {
        const file = sessions.imageFile(id, sub) ?? fail(404, "No such image");
        // Named by its content: it never changes.
        return new Response(Bun.file(file), {
          headers: { "cache-control": "private, max-age=31536000, immutable" },
        });
      }
      case "DELETE /sessions/:/prompts/:":
        if (!sessions.withdraw(id, sub)) fail(409, "That message already ran, or isn't waiting");
        return new Response(null, { status: 204 });
      case "POST /sessions/:/interrupt": {
        const { clearQueue } = await body(req, Interrupt);
        sessions.interrupt(id, clearQueue);
        return new Response(null, { status: 204 });
      }
      case "POST /permissions/:": {
        const { choice } = await body(req, AnswerPermission);
        if (!sessions.answer(id, choice)) fail(409, "Already answered");
        return new Response(null, { status: 204 });
      }
      default:
        return undefined;
    }
  };

  return async (req) => {
    try {
      return await handle(req);
    } catch (err) {
      if (err instanceof HttpError)
        return Response.json({ error: err.message }, { status: err.status });
      if (err instanceof SessionNotFoundError) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof PromptError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  };
}
