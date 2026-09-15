// Network boundary for "Break down with AI" (Phase 8) — the ONLY place in
// the frontend that talks to the Edge Function (supabase/functions/
// board-ai-breakdown). No AI provider secret ever exists on this side;
// supabase.functions.invoke sends the user's own auth session, and the
// function itself holds the actual API key server-side.
//
// Deliberately thin and isolated from UI logic (src/board/board.js) and
// from validation logic (src/board/aiBreakdownModel.js) — this file's only
// job is "make the call, translate failure modes into a small typed
// result." It is not unit-tested directly (same rationale as
// src/board/boardData.js: it needs a live Supabase project and network
// access, which plain Node tests don't have) — aiBreakdownModel.js's pure
// functions are what tests exercise, using hand-built fake responses that
// stand in for whatever this function would have returned.

import { supabase } from '../lib/supabaseClient.js';

const FUNCTION_NAME = 'board-ai-breakdown';

// Always resolves — never throws — so a caller can render an error state
// without a try/catch. `ok: false` covers every failure mode: the request
// never reached the function (network down, CORS, DNS), the function ran
// but returned a non-2xx (unauthorized/not_configured/rate_limited/
// provider_error/invalid_request, all defined in the Edge Function), or
// the function returned something that isn't valid JSON at all.
export async function requestBoardBreakdown({ title, nodeType }) {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { title, nodeType },
    });
    if (error) {
      return { ok: false, error: mapInvokeError(error) };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('requestBoardBreakdown failed:', err);
    return { ok: false, error: 'network_error' };
  }
}

// supabase-js's FunctionsHttpError carries the response status/body when
// the function itself returned a non-2xx; anything else (FunctionsFetchError,
// FunctionsRelayError, or the request never completing) is a network-level
// failure.
function mapInvokeError(error) {
  const status = error?.context?.status;
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 500 || status === 502) return 'provider_error';
  return 'network_error';
}
