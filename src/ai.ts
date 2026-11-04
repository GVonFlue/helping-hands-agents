import Anthropic from '@anthropic-ai/sdk';

export type LlmRequest = { system: string; prompt: string; maxTokens: number };
export type LlmResponse = { text: string; model: string; inputTokens: number; outputTokens: number };

export interface Llm {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class RetryableError extends Error {
  constructor(message: string, readonly delaySec = 600) {
    super(message);
  }
}

export function anthropicLlm(apiKey: string, model: string): Llm {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  return {
    model,
    async complete({ system, prompt, maxTokens }) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        return { text, model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 429 || status === 529 || (status !== undefined && status >= 500)) {
          throw new RetryableError(`Claude API busy (${status})`, 300);
        }
        throw err;
      }
    },
  };
}

// Pulls the first {...} JSON object out of a model reply.
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
