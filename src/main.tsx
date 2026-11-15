import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App';
import { AppBoot } from './components/AppBoot';
import { installAudioUnlock } from './lib/chatNotify';
import './index.css';

// Unlock Web Audio on the very first user gesture (even while the app is still booting)
installAudioUnlock();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (count, err) => count < 1 && !/permission|not found/i.test(String((err as Error)?.message)), refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppBoot>
          <App />
        </AppBoot>
        <Toaster richColors position="top-right" closeButton />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
