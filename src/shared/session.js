import { supabase } from '../lib/supabaseClient.js';

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('Could not read session:', error);
    return null;
  }
  return data.session;
}

// Use on pages that require a logged-in user (e.g. the dashboard).
// Redirects to the login page and returns null if nobody is signed in.
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

// Use on pages a logged-in user shouldn't see again (login, signup).
// Sends them straight to the dashboard if a session already exists.
export async function redirectIfLoggedIn() {
  const session = await getSession();
  if (session) {
    window.location.href = 'dashboard.html';
  }
}
