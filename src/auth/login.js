import { supabase } from '../lib/supabaseClient.js';
import { redirectIfLoggedIn } from '../shared/session.js';

redirectIfLoggedIn();

const form = document.getElementById('loginForm');
const errorEl = document.getElementById('errorMsg');
const successEl = document.getElementById('successMsg');
const submitBtn = document.getElementById('submitBtn');

if (new URLSearchParams(window.location.search).get('resetSuccess') === '1') {
  successEl.textContent = 'Password updated. Please log in with your new password.';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in…';

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log In';
    return;
  }

  window.location.href = 'dashboard.html';
});
