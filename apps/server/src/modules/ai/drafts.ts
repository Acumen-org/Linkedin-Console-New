/**
 * AI reply drafts. A teammate asks for a suggestion; the result goes into the composer for a human
 * to edit and send. Nothing is ever sent automatically.
 *
 * Providers (AI_PROVIDER): "anthropic" (Claude via the official SDK) or "ollama" (local, self-hosted).
 * With "anthropic", the recent messages of the conversation are sent to the Claude API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../lib/config.ts';
import { HttpError } from '../../lib/errors.ts';

export interface DraftInput {
  ownerName: string;
  ownerHeadline: string | null;
  contactName: string;
  transcript: { fromSelf: boolean; name: string; text: string }[];
  instruction?: string;
}

const SYSTEM = `You draft LinkedIn direct-message replies on behalf of a professional.
Write only the reply text itself: no greeting line like "Here is a draft", no quotes, no sign-off unless the conversation uses them.
Match the language, tone and length of the conversation. Keep it natural and concise; LinkedIn DMs are usually 1-4 sentences.
Never invent facts, prices, dates or commitments that are not in the conversation; leave a short [placeholder] instead.`;

function userPrompt(input: DraftInput) {
  const lines = input.transcript.map((m) => `${m.fromSelf ? `${input.ownerName} (me)` : m.name}: ${m.text || '[attachment]'}`).join('\n');
  return `I am ${input.ownerName}${input.ownerHeadline ? ` (${input.ownerHeadline})` : ''}. I am talking with ${input.contactName}.

<conversation>
${lines}
</conversation>

Draft my next reply.${input.instruction ? `\nInstructions from me: ${input.instruction}` : ''}`;
}

let anthropic: Anthropic | null = null;

async function draftWithClaude(input: DraftInput): Promise<string> {
  anthropic ??= new Anthropic({ apiKey: config.ai.anthropicKey || undefined });
  const response = await anthropic.beta.messages.create({
    model: config.ai.model || 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    // Server-side fallback: if the model declines, Anthropic's recommended fallback answers instead.
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(input) }],
  } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI model declined to draft a reply for this conversation');
  const text = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new HttpError(502, 'The AI model returned an empty draft');
  return text;
}

async function draftWithOllama(input: DraftInput): Promise<string> {
  const res = await fetch(`${config.ai.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.ai.model || 'qwen2.5:7b',
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(input) },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new HttpError(502, `Ollama returned ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const text = data.message?.content?.trim();
  if (!text) throw new HttpError(502, 'The AI model returned an empty draft');
  return text;
}

export const aiEnabled = () => config.ai.provider !== '';

export async function draftReply(input: DraftInput): Promise<string> {
  if (config.ai.provider === 'anthropic') return draftWithClaude(input);
  if (config.ai.provider === 'ollama') return draftWithOllama(input);
  throw new HttpError(404, 'AI drafts are not enabled on this server');
}
