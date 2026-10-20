// The daemon's requests besides /health and /events: sessions, prompts, permission answers,
// the model and effort. Bodies are JSON, checked against @ivy/protocol; a refusal is
// `{ error }` with a status that says what kind.

import {
  canSwitchModel,
  EFFORT_LEVELS,
  type Effort,
  errorMessage,
  type Ivy,
  saveEffort,
  saveModel,
} from "@ivy/kernel";
import {
  AnswerPermission,
  CreateSession,
  type DaemonState,
  Interrupt,
  SendPrompt,
  SetEffort,
  SetModel,
} from "@ivy/protocol";
import type { z } from "zod";
import type { Routes } from "./server.ts";
import { SessionNotFoundError, type Sessions } from "./sessions.ts";

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
    effortUsed: ivy.capabilities.for(ivy.agent.modelRef).effort,
    canSwitchModel: canSwitchModel(ivy.config),
  });

  /** Save a switch to config.toml; if that fails it still applies until the daemon stops. */
  const saved = (save: () => void) => {
    try {
      save();
      return { saved: true };
    } catch (err) {
      return { saved: false, error: errorMessage(err) };
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
        const { model } = await body(req, SetModel);
        try {
          ivy.agent.setModel(model);
        } catch (err) {
          return fail(400, `Can't switch to ${model}: ${errorMessage(err)}`);
        }
        return Response.json({ ...state(), ...saved(() => saveModel(ivy.paths, model)) });
      }
      case "PUT /effort": {
        const { effort } = await body(req, SetEffort);
        if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
          return fail(400, `Unknown effort ${effort}. Levels: ${EFFORT_LEVELS.join(", ")}`);
        }
        ivy.capabilities.setEffort(effort as Effort);
        return Response.json({
          ...state(),
          ...saved(() => saveEffort(ivy.paths, effort as Effort)),
        });
      }
      case "GET /sessions":
        return Response.json(sessions.list());
      case "POST /sessions": {
        const { display } = await body(req, CreateSession);
        return Response.json({ id: sessions.create(display) }, { status: 201 });
      }
      case "GET /sessions/:":
        return Response.json(sessions.view(id));
      case "POST /sessions/:/prompts": {
        const { text } = await body(req, SendPrompt);
        return Response.json(sessions.send(id, text), { status: 202 });
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
      throw err;
    }
  };
}
