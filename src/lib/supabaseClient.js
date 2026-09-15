import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase environment variables. Copy .env.example to .env and fill in ' +
    'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY from your Supabase project settings.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
