import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';

import "@atyrode/excalidraw/index.css";
import "./index.scss";

import App from "./src/App";
import AuthGate from "./src/AuthGate";
import ErrorBoundary from './src/ui/ErrorBoundary';
import i18n from './src/i18n';

const queryClient = new QueryClient();

// In dev, a service worker registered by a past *production* build persists on
// this origin and will keep serving stale precached JS/CSS — which silently
// masks every source change (the exact "my fix didn't show up" symptom).
// Unregister any SW and drop its caches when running against the dev server.
async function purgeStaleServiceWorkers() {
  if (!import.meta.env.DEV) return;
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length) {
        await Promise.all(regs.map(r => r.unregister()));
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        // A controlled page keeps using the old SW until the next load — reload once.
        if (navigator.serviceWorker.controller) {
          console.warn('[alcove] Removed a stale service worker — reloading for fresh assets.');
          location.reload();
        }
      }
    }
  } catch (e) {
    console.error('[alcove] SW purge failed:', e);
  }
}

async function initApp() {
  await purgeStaleServiceWorkers();
  const rootElement = document.getElementById("root")!;
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <AuthGate />
            <App />
          </QueryClientProvider>
        </I18nextProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

initApp().catch(console.error);
