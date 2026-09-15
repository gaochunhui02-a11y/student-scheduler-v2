import { supabase } from '../lib/supabaseClient.js';

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
  submitBtn.textContent = 'Sending…';

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Send Reset Link';

  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  successEl.textContent = 'If an account exists for that email, a password reset link has been sent.';
  form.reset();
});
