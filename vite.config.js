import { defineConfig } from 'vite';
import { resolve } from 'path';

// Multiple plain HTML pages, no framework/router — each page is its own entry point.
export default defineConfig({
  build: {
    // several pages use top-level await (e.g. checking the session before
    // rendering), which needs a modern target — fine for all current browsers
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        login: resolve(__dirname, 'login.html'),
        signup: resolve(__dirname, 'signup.html'),
        forgotPassword: resolve(__dirname, 'forgot-password.html'),
        resetPassword: resolve(__dirname, 'reset-password.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
});
