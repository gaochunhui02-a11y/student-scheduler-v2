import { supabase } from '../lib/supabaseClient.js';
import { redirectIfLoggedIn } from '../shared/session.js';
import { registerServiceWorker } from '../shared/pwa.js';
import { t, applyTranslations } from '../shared/i18n.js';

registerServiceWorker();
redirectIfLoggedIn();
applyTranslations();

const form = document.getElementById('signupForm');
const errorEl = document.getElementById('errorMsg');
const successEl = document.getElementById('successMsg');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  successEl.textContent = '';

  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (!name) {
    errorEl.textContent = t('auth.nameRequired');
    return;
  }
  if (password.length < 6) {
    errorEl.textContent = t('auth.passwordTooShort');
    return;
  }
  if (password !== confirmPassword) {
    errorEl.textContent = t('auth.passwordsDontMatch');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = t('auth.creatingAccount');

  // The "name" here is stored as auth user metadata. A database trigger
  // (see supabase/schema.sql) reads it back out to create the profiles row —
  // this app never writes to profiles directly on sign-up.
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });

  if (error) {
    errorEl.textContent = error.message;
    submitBtn.disabled = false;
    submitBtn.textContent = t('auth.signUpButton');
    return;
  }

  // If your Supabase project has "Confirm email" turned on, there is no
  // session yet — the user must click the confirmation link first.
  if (!data.session) {
    successEl.textContent = t('auth.accountCreatedCheckEmail');
    form.reset();
    submitBtn.disabled = false;
    submitBtn.textContent = t('auth.signUpButton');
    return;
  }

  window.location.href = 'dashboard.html';
});
