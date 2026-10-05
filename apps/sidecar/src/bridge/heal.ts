// Self-healing element lookup for the bridge's UI actions.
//
// Normal path: the hand-written locator (fast, free).
// If it stops matching (LinkedIn changed its UI), we use a previously learned fix from Redis,
// and if there is none, ask an LLM to pick the element from the page's accessibility
// snapshot. The answer (ARIA role + accessible name) is verified on the page and cached, so
// the model is only consulted once per UI change, not per action.
//
// Providers (env HEAL_PROVIDER):
//   ""          disabled (default)
//   "anthropic" Claude via the official SDK (ANTHROPIC_API_KEY, HEAL_MODEL default claude-opus-5-5)
//   "ollama"    local model, fully self-hosted (OLLAMA_URL, HEAL_MODEL e.g. qwen2.5:7b)
//
// Privacy: the snapshot can contain names and message text from the page. With "anthropic"
// that text is sent to the Claude API; use "ollama" to keep everything on your server.
import type Anthropic from '@anthropic-ai/sdk';
import type { Locator, Page } from 'patchright';

const SNAPSHOT_LIMIT = 40_000;
const ROLES = ['textbox', 'button', 'link', 'combobox', 'menuitem', 'tab', 'checkbox', 'option'] as const;
type Role = (typeof ROLES)[number];

export interface Hint {
  found: boolean;
  role: Role;
  name: string;
  index: number;
}

export type AskModel = (intent: string, snapshot: string) => Promise<Hint | null>;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'false if no element matches the description' },
    role: { type: 'string', enum: ROLES },
    name: { type: 'string', description: 'accessible name exactly as written in the snapshot' },
    index: { type: 'integer', description: '0-based position among elements with the same role and name' },
  },
  required: ['found', 'role', 'name', 'index'],
  additionalProperties: false,
};

function prompt(intent: string, snapshot: string) {
  return `You are helping a browser automation locate one element on a LinkedIn page.

Element to find: ${intent}

Below is the page's accessibility snapshot (YAML: role "name" [attributes]).
Return the element's ARIA role and its accessible name copied exactly from the snapshot.
If several elements share that role and name, give the 0-based index of the right one (in snapshot order).
If nothing matches, set found to false.

<snapshot>
${snapshot}
</snapshot>`;
}

const askAnthropic: AskModel = async (intent, snapshot) => {
  // Loaded on first use only, so pods without self-healing don't pay for the SDK in memory.
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  const client = new AnthropicClient(); // reads ANTHROPIC_API_KEY
  const response = await client.beta.messages.create({
    model: process.env.HEAL_MODEL || 'claude-opus-5-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: prompt(intent, snapshot) }],
  } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
  if (response.stop_reason === 'refusal') return null;
  const block = response.content.find((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text');
  return block ? (JSON.parse(block.text) as Hint) : null;
};

const askOllama: AskModel = async (intent, snapshot) => {
  const res = await fetch(`${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.HEAL_MODEL || 'qwen2.5:7b',
      stream: false,
      format: SCHEMA,
      options: { temperature: 0 },
      messages: [{ role: 'user', content: prompt(intent, snapshot) }],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return JSON.parse(data.message?.content ?? 'null') as Hint | null;
};

const visible = (locator: Locator, timeout: number) =>
  locator.waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );

export interface Healer {
  find(page: Page, key: string, intent: string, primary: Locator, timeout?: number): Promise<Locator>;
  enabled: boolean;
}

export function createHealer(opts: {
  redis: KeyValueStore;
  log?: { info(msg: string): void; error(msg: string): void };
  ask?: AskModel | null;
}): Healer {
  const { redis } = opts;
  const log = opts.log ?? { info: (m: string) => console.log(m), error: (m: string) => console.error(m) };
  const provider = (process.env.HEAL_PROVIDER || '').toLowerCase();
  const ask = opts.ask ?? (provider === 'anthropic' ? askAnthropic : provider === 'ollama' ? askOllama : null);
  if (ask) log.info(`self-healing enabled (${provider || 'custom'})`);

  const fromHint = (page: Page, h: Pick<Hint, 'role' | 'name' | 'index'>) =>
    page.getByRole(h.role, { name: h.name, exact: true }).nth(h.index ?? 0);

  async function find(page: Page, key: string, intent: string, primary: Locator, timeout = 20_000) {
    if (await visible(primary, timeout)) return primary;

    const cacheKey = `li:heal:${key}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const loc = fromHint(page, JSON.parse(cached));
      if (await visible(loc, 3000)) return loc;
      await redis.del(cacheKey);
    }

    if (!ask) throw new Error(`Element "${key}" not found (LinkedIn UI may have changed; enable HEAL_PROVIDER or update actions.ts)`);

    const snapshot = (await page.locator('body').ariaSnapshot()).slice(0, SNAPSHOT_LIMIT);
    let hint: Hint | null = null;
    try {
      hint = await ask(intent, snapshot);
    } catch (e) {
      log.error(`self-healing model call failed: ${(e as Error).message}`);
    }
    if (!hint?.found || !ROLES.includes(hint.role) || !hint.name) throw new Error(`Element "${key}" not found, even with self-healing`);

    const loc = fromHint(page, hint);
    if (!(await visible(loc, 3000))) throw new Error(`Self-healing suggested a "${key}" element that isn't visible`);
    await redis.set(cacheKey, JSON.stringify({ role: hint.role, name: hint.name, index: hint.index ?? 0 }), 'EX', 30 * 86400);
    log.info(`self-healing learned "${key}" → ${hint.role} "${hint.name}" #${hint.index ?? 0}`);
    return loc;
  }

  return { find, enabled: !!ask };
}
