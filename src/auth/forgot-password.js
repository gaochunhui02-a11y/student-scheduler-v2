import { supabase } from '../lib/supabaseClient.js';
import { registerServiceWorker } from '../shared/pwa.js';
import { t, applyTranslations } from '../shared/i18n.js';

registerServiceWorker();
applyTranslations();

const form = document.getElementById('forgotForm');
const errorEl = document.getElementById('errorMsg');
const successEl = document.getElementById('successMsg');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  successEl.textContent = '';

  const email = document.getElementById('email').value.trim();

  submitBtn.disabled = true;
  submitBtn.textContent = t('auth.sending');

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = t('auth.sendResetLink');

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  successEl.textContent = t('auth.resetLinkSent');
  form.reset();
});
