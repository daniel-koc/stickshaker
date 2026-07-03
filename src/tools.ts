import type Anthropic from "@anthropic-ai/sdk";
import type { Snapshot } from "./types.js";

/**
 * The agent's tool surface. Deliberately small and typed — clear names,
 * prescriptive descriptions, tight enums. The MCP server exposes this same set.
 */
export const tools: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Load an absolute URL in the browser.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL, including scheme." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click the interactive element with the given ref number from the current snapshot.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer", description: "The [ref] of the element to click." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type text into an input or textarea identified by its ref. Set submit=true to press Enter afterward (e.g. to run a search).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The [ref] of the field." },
        text: { type: "string", description: "The text to type." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a <select> element by its value or visible label.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The [ref] of the <select>." },
        value: { type: "string", description: "Option value or visible label." },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down to reveal more content.",
    input_schema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"] } },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "go_back",
    description: "Go back to the previous page in history.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "done",
    description: "Finish the task. Provide the answer to the user's question or a summary of what was accomplished.",
    input_schema: {
      type: "object",
      properties: { answer: { type: "string", description: "The answer or summary." } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  {
    name: "fail",
    description: "Abandon the task because it cannot be completed, explaining why.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Why the task cannot be completed." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

/** Render a snapshot into the compact text block the model reads each turn. */
export function formatSnapshot(s: Snapshot): string {
  const lines: string[] = [];
  lines.push(`URL: ${s.url}`);
  lines.push(`Title: ${s.title}`);
  lines.push("");
  lines.push("Interactive elements — act on these with click / type / select_option using the [ref]:");
  if (s.elements.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const e of s.elements) {
      const parts = [`[${e.ref}]`, e.type ? `${e.tag}:${e.type}` : e.tag];
      if (e.role) parts.push(`role=${e.role}`);
      if (e.name) parts.push(JSON.stringify(e.name));
      if (e.value) parts.push(`value=${JSON.stringify(e.value)}`);
      lines.push("  " + parts.join(" "));
    }
    if (s.elementsTruncated) {
      lines.push(`  … element list truncated at ${s.elements.length}; scroll to reach the rest.`);
    }
  }
  lines.push("");
  lines.push("Visible page text:");
  lines.push(s.text || "(no visible text)");
  if (s.textTruncated) lines.push("… page text truncated.");
  return lines.join("\n");
}
