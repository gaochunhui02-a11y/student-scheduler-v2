import { supabase } from '../lib/supabaseClient.js';
import { registerServiceWorker } from '../shared/pwa.js';

registerServiceWorker();

const subtitleEl = document.getElementById('subtitleText');
const errorEl = document.getElementById('errorMsg');
const form = document.getElementById('resetForm');
const submitBtn = document.getElementById('submitBtn');

let recoveryReady = false;

function showForm() {
  if (recoveryReady) return;
  recoveryReady = true;
  subtitleEl.textContent = 'Enter a new password for your account.';
  form.style.display = '';
}

// Supabase's client reads the recovery token out of the URL automatically
// (via detectSessionInUrl, on by default) and fires this event once it does.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') showForm();
});

// Fallback: if the event already fired before this listener attached, or the
// link established a session some other way, a plain session check catches it.
// If neither happens within a few seconds, the link is treated as invalid.
setTimeout(async () => {
  if (recoveryReady) return;
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    showForm();
  } else {
    subtitleEl.textContent = '';
    errorEl.textContent = 'This password reset link is invalid or has expired. Please request a new one.';
  }
}, 2500);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';

  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (password.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (password !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Updating…';

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    errorEl.textContent = error.message;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Reset Password';
    return;
  }

  await supabase.auth.signOut();
  window.location.href = 'login.html?resetSuccess=1';
});
