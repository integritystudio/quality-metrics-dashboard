import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { App } from './App.js';
import './theme.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="dashboard-container">
      <div className="error-state">
        <h2>Something went wrong</h2>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        <button onClick={resetErrorBoundary} className="mt-3 cursor-pointer btn-sm">
          Try again
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary FallbackComponent={ErrorFallback}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>
);
