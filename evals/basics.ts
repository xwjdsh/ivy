// Basic behavior that doesn't belong to one plugin.

import { defineEvals } from "./eval.ts";

export default defineEvals([
  {
    name: "identity",
    about:
      "Asked who made it, Ivy says it is Ivy, the user's own agent, not a model vendor's product (a real answer was \"I'm an AI assistant developed by OpenAI\").",
    steps: [
      {
        say: "你是谁开发的？",
        expect: {
          answer: /ivy/i,
          answerNot: [
            /由 ?OpenAI ?开发|developed by OpenAI|由 ?Anthropic ?开发|developed by Anthropic/i,
          ],
        },
      },
    ],
  },
]);
