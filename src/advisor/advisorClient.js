// Network boundary for the AI Student Advisor (Phase 9) — the ONLY place
// in the frontend that talks to the Edge Function (supabase/functions/
// ai-advisor). No AI provider secret ever exists on this side;
// supabase.functions.invoke sends the user's own auth session, and the
// function itself holds the actual API key server-side. Reuses the exact
// same provider/security approach as Phase 8's board-ai-breakdown — this
// is a second Edge Function endpoint (different request/response shape:
// a chat message + planning context, not a single node title), not a
// second AI provider integration.
//
// Deliberately thin and isolated from UI logic (src/advisor/advisor.js)
// and from validation logic (src/advisor/advisorModel.js). Not
// unit-tested directly (same rationale as boardData.js and
// aiBreakdownClient.js: it needs a live Supabase project and network
// access) — advisorModel.js's pure functions are what tests exercise,
// using hand-built fake responses that stand in for whatever this
// function would have returned.

import { supabase } from '../lib/supabaseClient.js';

const FUNCTION_NAME = 'ai-advisor';

// Always resolves — never throws — so a caller can render an error state
// without a try/catch. `ok: false` covers every failure mode: the request
// never reached the function (network down, CORS, DNS), the function ran
// but returned a non-2xx (unauthorized/not_configured/rate_limited/
// provider_error/invalid_request, all defined in the Edge Function), or
// the function returned something that isn't valid JSON at all.
export async function requestAdvisorReply({ message, context }) {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { message, context },
    });
    if (error) {
      return { ok: false, error: mapInvokeError(error) };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('requestAdvisorReply failed:', err);
    return { ok: false, error: 'network_error' };
  }
}

function mapInvokeError(error) {
  const status = error?.context?.status;
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 500 || status === 502) return 'provider_error';
  return 'network_error';
}
