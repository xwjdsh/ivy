import { definePlugin, defineTool } from "@ivy/plugin-api";
import { z } from "zod";

const now = defineTool({
  name: "now",
  description:
    "Get the current local date, time, weekday and timezone. Use this whenever the answer depends on today's date or the current time.",
  input: z.object({}),
  risk: "read",
  run() {
    const d = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
    return `${d.toISOString()} (local: ${d.toLocaleString("sv-SE")}, ${weekday}, ${tz})`;
  },
});

export default definePlugin({
  id: "core",
  version: "0.0.1",
  description: "Basic built-in tools (time and date).",
  tools: [now],
});
