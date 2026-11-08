/**
 * Reading `codex exec --json` (decisions.md, "Phase 8: Codex spike", "The
 * JSONL"): `thread.started`, `turn.started`, `item.started` and
 * `item.completed` (a `command_execution` or an `agent_message`),
 * `turn.completed` with `usage`, `turn.failed` and `error`. What Codex
 * writes is data: only counts, codes and cut text are kept.
 */

/** Tokens of one call, from `turn.completed`. */
export interface CodexUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface CodexCommandRun {
  command: string;
  exitCode: number | null;
}

export interface CodexEventSummary {
  threadId?: string;
  /** Commands Codex ran (completed items), at most `MAX_COMMANDS`. */
  commands: CodexCommandRun[];
  /** How many commands it ran, all of them. */
  commandCount: number;
  /** The last agent message. */
  lastMessage?: string;
  usage?: CodexUsage;
  /** Why the turn failed (`turn.failed`), or the last `error` event. */
  failure?: string;
  /** Lines that were not JSON, or too long to read. */
  unreadLines: number;
}

const MAX_LINE = 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_COMMANDS = 100;
const MAX_TEXT = 16_000;
const MAX_COMMAND_TEXT = 300;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (isObject(value) && typeof value.message === 'string' && value.message.trim() !== '') return value.message;
  return undefined;
}

/** Reads the JSONL as it arrives, a chunk at a time. */
export class CodexEventReader {
  private pending = '';
  private total = 0;
  private readonly state: CodexEventSummary = { commands: [], commandCount: 0, unreadLines: 0 };

  push(chunk: string): void {
    if (this.total >= MAX_TOTAL) return;
    this.total += chunk.length;
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line);
    if (this.pending.length > MAX_LINE) {
      this.pending = '';
      this.state.unreadLines += 1;
    }
  }

  /** The output ended: the last line, if it had no newline. */
  end(): CodexEventSummary {
    if (this.pending.trim() !== '') this.line(this.pending);
    this.pending = '';
    return this.summary();
  }

  summary(): CodexEventSummary {
    return { ...this.state, commands: this.state.commands.map((item) => ({ ...item })), ...(this.state.usage === undefined ? {} : { usage: { ...this.state.usage } }) };
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (line === '') return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.state.unreadLines += 1;
      return;
    }
    if (!isObject(event) || typeof event.type !== 'string') {
      this.state.unreadLines += 1;
      return;
    }
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') this.state.threadId = cut(event.thread_id, 200);
        break;
      case 'item.completed': {
        const item = event.item;
        if (!isObject(item)) break;
        if (item.type === 'command_execution') {
          this.state.commandCount += 1;
          if (this.state.commands.length < MAX_COMMANDS) {
            const exitCode = typeof item.exit_code === 'number' && Number.isInteger(item.exit_code) ? item.exit_code : null;
            this.state.commands.push({ command: cut(typeof item.command === 'string' ? item.command : '', MAX_COMMAND_TEXT), exitCode });
          }
        } else if (item.type === 'agent_message' && typeof item.text === 'string') {
          this.state.lastMessage = cut(item.text, MAX_TEXT);
        }
        break;
      }
      case 'turn.completed': {
        const usage = isObject(event.usage) ? event.usage : {};
        this.state.usage = { input: count(usage.input_tokens), cached: count(usage.cached_input_tokens), output: count(usage.output_tokens), reasoning: count(usage.reasoning_output_tokens) };
        break;
      }
      case 'turn.failed': {
        const message = messageOf(event.error) ?? messageOf(event.message);
        this.state.failure = cut(message ?? 'The turn failed.', MAX_TEXT);
        break;
      }
      case 'error': {
        const message = messageOf(event.message) ?? messageOf(event.error);
        if (message !== undefined) this.state.failure = cut(message, MAX_TEXT);
        break;
      }
      default:
        break;
    }
  }
}
