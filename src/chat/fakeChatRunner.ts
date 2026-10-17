import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ChatRunner, ChatRunnerStart, ChatSession, ToolReply } from './types.js';

/**
 * A chat runner that plays a script, so the chat's API and UI tests spend no
 * tokens (BRIEF-phase-4 §5). Each user message plays the next turn. A turn
 * is a list of steps:
 *
 * - `{"say":"text"}`: an assistant message;
 * - `{"call":"list_projects","args":{}}`: a tool call through the same
 *   executor as the real runner (validation, confirmation, redaction);
 * - `{"sayResult":"data.0.name"}`: an assistant message with a value from the
 *   last tool result (a dotted path into its JSON; `""` for the whole text);
 * - `{"echo":true}`: an assistant message repeating the user's message;
 * - `{"fail":"text"}`: the session fails with that message.
 *
 * With no turn left it says "(no scripted answer)". `resumeFails` makes
 * every resume fail before the session opens.
 */

const stepSchema = z.union([
  z.strictObject({ say: z.string() }),
  z.strictObject({ call: z.string().min(1), args: z.unknown().optional() }),
  z.strictObject({ sayResult: z.string() }),
  z.strictObject({ echo: z.literal(true) }),
  z.strictObject({ fail: z.string() }),
]);
export type ChatScriptStep = z.infer<typeof stepSchema>;
const scriptSchema = z.strictObject({ turns: z.array(z.array(stepSchema)), resumeFails: z.boolean().optional() });
export type ChatScript = z.infer<typeof scriptSchema>;

export function parseChatScript(text: string): ChatScript {
  return scriptSchema.parse(JSON.parse(text));
}

function pick(value: unknown, dotted: string): unknown {
  let current = value;
  for (const part of dotted.split('.').filter((segment) => segment !== '')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export class FakeChatRunner implements ChatRunner {
  /** Every start, for tests: model, effort, resume. */
  readonly starts: Omit<ChatRunnerStart, 'execute' | 'emit'>[] = [];
  /** Every message the sessions received, in order. */
  readonly received: string[] = [];
  /** Every tool reply, in order. */
  readonly replies: ToolReply[] = [];
  private turn = 0;

  constructor(private readonly script: ChatScript) {}

  static async fromFile(file: string): Promise<FakeChatRunner> {
    return new FakeChatRunner(parseChatScript(await readFile(file, 'utf8')));
  }

  start(options: ChatRunnerStart): ChatSession {
    const { execute, emit, ...shown } = options;
    this.starts.push(shown);
    let stopped = false;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const queue: string[] = [];
    let running = false;

    if (options.resume !== undefined && this.script.resumeFails === true) {
      // As the SDK does when a transcript is gone: the session never opens.
      setTimeout(() => {
        emit({ kind: 'resumeFailed' });
        finish();
      }, 0);
      return { send: () => undefined, stop: async () => finish(), done };
    }
    const sessionId = options.resume ?? randomUUID();

    const play = async (text: string) => {
      emit({ kind: 'session', sessionId });
      const steps = this.script.turns[this.turn] ?? [{ say: '(no scripted answer)' }];
      this.turn += 1;
      let last: ToolReply | undefined;
      for (const step of steps) {
        if (stopped) return;
        if ('say' in step) emit({ kind: 'text', text: step.say });
        else if ('echo' in step) emit({ kind: 'text', text });
        else if ('call' in step) {
          last = await execute(step.call, step.args ?? {});
          this.replies.push(last);
        } else if ('sayResult' in step) {
          const raw = last?.content[0]?.text ?? '';
          let value: unknown = raw;
          if (step.sayResult !== '') {
            try {
              value = pick(JSON.parse(raw), step.sayResult);
            } catch {
              value = undefined;
            }
          }
          emit({ kind: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) });
        } else if ('fail' in step) {
          emit({ kind: 'error', message: step.fail });
          stopped = true;
          finish();
          return;
        }
      }
      if (!stopped) emit({ kind: 'turnEnd' });
    };

    const drain = async () => {
      if (running) return;
      running = true;
      while (queue.length > 0 && !stopped) await play(queue.shift() as string);
      running = false;
    };

    return {
      send: (text) => {
        if (stopped) return;
        this.received.push(text);
        queue.push(text);
        void drain();
      },
      stop: async () => {
        stopped = true;
        finish();
      },
      done,
    };
  }
}
