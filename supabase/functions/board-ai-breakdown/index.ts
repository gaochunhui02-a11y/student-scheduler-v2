// Supabase Edge Function — "Break down with AI" for a Board node (Phase 8).
//
// This is the ONLY place the AI provider's secret API key ever exists. It
// runs server-side on Supabase's infrastructure (Deno), never in the
// browser bundle, never in a Vite env var (those are all exposed to the
// client), and never committed to git. The frontend
// (src/board/aiBreakdownClient.js) only ever calls this function by name
// via supabase.functions.invoke(); it never talks to the AI provider
// directly and never sees this key.
//
// ---------------------------------------------------------------------------
// Deploy (from the project's Supabase CLI, one time):
//
//   supabase functions deploy board-ai-breakdown
//   supabase secrets set OPENAI_API_KEY=sk-...your-key...
//
// SUPABASE_URL and SUPABASE_ANON_KEY are provided automatically to every
// Edge Function by the Supabase platform — you do not set those yourself.
//
// To swap AI providers, only callProvider() below needs to change; the
// request/response contract with the frontend (see validateBreakdownResponse
// in src/board/aiBreakdownModel.js) stays the same either way.
// ---------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_TITLE_LENGTH = 200;
const VALID_NODE_TYPES = ['goal', 'subject', 'task', 'note'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'invalid_request' }, 405);

  // Require a real, authenticated Supabase session. The AI key is never
  // exposed to the caller either way, but this stops the function from
  // being usable as an open, unauthenticated proxy to a paid API by anyone
  // who has the project's public anon key (which is not a secret, but
  // should not by itself be enough to spend the project owner's AI budget).
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (!OPENAI_API_KEY) {
    // The function is deployed but no secret has been configured yet.
    return json({ error: 'not_configured' }, 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const rawTitle = (body as Record<string, unknown> | null)?.title;
  const rawType = (body as Record<string, unknown> | null)?.nodeType;
  const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const nodeType = typeof rawType === 'string' && VALID_NODE_TYPES.includes(rawType) ? rawType : 'goal';
  if (!title) return json({ error: 'invalid_request' }, 400);

  try {
    const result = await callProvider(title, nodeType);
    return json(result, 200);
  } catch (err) {
    if (err instanceof RateLimitError) return json({ error: 'rate_limited' }, 429);
    console.error('board-ai-breakdown provider error:', err);
    return json({ error: 'provider_error' }, 502);
  }
});

class RateLimitError extends Error {}

// Isolated on purpose: this is the only function that knows about the
// specific AI provider's request/response shape. Everything else in this
// file, and everything on the frontend, only deals with the sanitized
// { message, suggestions: [{ title }] } contract.
async function callProvider(title: string, nodeType: string): Promise<unknown> {
  const prompt =
    `A student has this Board goal/task: "${title}" (type: ${nodeType}). ` +
    'Break it down into 3 to 6 concrete, actionable subtasks a student could schedule as separate study sessions. ' +
    'Respond with ONLY a JSON object of the exact shape ' +
    '{"message": "one short sentence", "suggestions": [{"title": "..."}]} and nothing else.';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.4,
    }),
  });

  if (res.status === 429) throw new RateLimitError();
  if (!res.ok) throw new Error(`provider responded ${res.status}`);

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('provider response missing content');

  try {
    // The frontend (validateBreakdownResponse) re-validates this shape
    // independently before it's ever shown to the user or used to create a
    // node — this function is not the trust boundary, that one is.
    return JSON.parse(text);
  } catch {
    throw new Error('provider did not return valid JSON');
  }
}
