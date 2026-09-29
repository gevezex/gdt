/**
 * Renders Claude Code's stream-json output (`claude -p --output-format stream-json --verbose`) as
 * readable lines while a turn runs (issue #62). A line it cannot read is passed through, never thrown.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
/** The longest tool call summary, in characters. */
const SUMMARY_MAX = 120;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A passthrough line for a valid object: `[<type>]`, dimmed on a TTY. */
function passthrough(type: unknown, tty: boolean): string {
  const line = `[${typeof type === "string" ? type : String(JSON.stringify(type))}]`;
  return tty ? `${DIM}${line}${RESET}` : line;
}

/** `input.command`, else `input.file_path`, else `input.pattern`, else the compact JSON of `input`. */
function summary(input: unknown): string {
  let text: string;
  if (isObject(input) && typeof input.command === "string") text = input.command;
  else if (isObject(input) && typeof input.file_path === "string") text = input.file_path;
  else if (isObject(input) && typeof input.pattern === "string") text = input.pattern;
  else text = JSON.stringify(input) ?? "";
  return (text.split("\n")[0] ?? "").slice(0, SUMMARY_MAX);
}

function contentItems(event: Json): unknown[] {
  const message = event.message;
  return isObject(message) && Array.isArray(message.content) ? message.content : [];
}

function renderItem(item: unknown, eventType: "assistant" | "user", tty: boolean): string[] {
  if (!isObject(item)) return [passthrough(typeof item, tty)];
  if (eventType === "assistant" && item.type === "text" && typeof item.text === "string") return item.text.split("\n");
  if (eventType === "assistant" && item.type === "tool_use") {
    const name = typeof item.name === "string" ? item.name : "";
    return [`→ ${name} ${summary(item.input)}`];
  }
  if (eventType === "user" && item.type === "tool_result") return [item.is_error === true ? "  ✗ error" : "  ✓ ok"];
  return [passthrough(item.type, tty)];
}

/** The rendered lines for one line of stream-json output; an empty line gives none. */
export function renderClaudeLine(line: string, tty: boolean): string[] {
  if (line.trim() === "") return [];
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [line];
  }
  if (!isObject(event)) return [line];
  switch (event.type) {
    case "assistant":
    case "user": {
      const type = event.type;
      return contentItems(event).flatMap((item) => renderItem(item, type, tty));
    }
    case "result": {
      const subtype = typeof event.subtype === "string" ? event.subtype : "";
      const text = typeof event.result === "string" ? event.result.split("\n") : [];
      return [`result: ${subtype}`, ...text];
    }
    default:
      return [passthrough(event.type, tty)];
  }
}
