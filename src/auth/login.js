import { supabase } from '../lib/supabaseClient.js';
import { redirectIfLoggedIn } from '../shared/session.js';
import { registerServiceWorker } from '../shared/pwa.js';
import { t, applyTranslations } from '../shared/i18n.js';

registerServiceWorker();
redirectIfLoggedIn();
applyTranslations();

const form = document.getElementById('loginForm');
const errorEl = document.getElementById('errorMsg');
const successEl = document.getElementById('successMsg');
const submitBtn = document.getElementById('submitBtn');

if (new URLSearchParams(window.location.search).get('resetSuccess') === '1') {
  successEl.textContent = t('auth.resetSuccess');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  submitBtn.disabled = true;
  submitBtn.textContent = t('auth.loggingIn');

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    submitBtn.disabled = false;
    submitBtn.textContent = t('auth.logInButton');
    return;
  }

  window.location.href = 'dashboard.html';
});
