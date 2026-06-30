import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCap } from '../../lib/auth.js';
import { env } from '../../lib/env.js';

const Msg = z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string() });

export async function registerAiRoutes(app: FastifyInstance) {
  // Non-streaming
  app.post('/chat', {
    preHandler: [requireCap('ai.use')],
    schema: { body: z.object({ messages: z.array(Msg) }) },
  }, async (req) => {
    const { messages } = req.body as { messages: z.infer<typeof Msg>[] };
    if (!env.AI_API_KEY) return { content: 'AI is not configured.' };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.AI_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 1024,
        messages: messages.filter((m) => m.role !== 'system'),
        system: 'You are NEXORA AI, a business assistant for Kenyan SMBs. Be concise. Use KSh formatting.',
      }),
    }).then((res) => res.json() as Promise<{ content: { text: string }[] }>);

    return { content: r.content?.[0]?.text ?? '' };
  });

  // Streaming (SSE)
  app.post('/chat/stream', {
    preHandler: [requireCap('ai.use')],
    schema: { body: z.object({ messages: z.array(Msg) }) },
  }, async (req, reply) => {
    const { messages } = req.body as { messages: z.infer<typeof Msg>[] };
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (!env.AI_API_KEY) {
      reply.raw.write(`data: ${JSON.stringify({ delta: 'AI not configured.' })}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.AI_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 1024,
        stream: true,
        messages: messages.filter((m) => m.role !== 'system'),
        system: 'You are NEXORA AI, a business assistant for Kenyan SMBs. Be concise. Use KSh formatting.',
      }),
    });

    const reader = upstream.body?.getReader();
    const dec = new TextDecoder();
    if (!reader) { reply.raw.end(); return; }
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const ev of events) {
        const dline = ev.split('\n').find((l) => l.startsWith('data:'));
        if (!dline) continue;
        try {
          const j = JSON.parse(dline.slice(5).trim());
          if (j.type === 'content_block_delta' && j.delta?.text) {
            reply.raw.write(`data: ${JSON.stringify({ delta: j.delta.text })}\n\n`);
          }
        } catch { /* ignore */ }
      }
    }
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });
}
