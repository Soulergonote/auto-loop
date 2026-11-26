import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './chain/wagmi'
import { App } from './app/App'
import { loadScannerSnapshot } from './services/scannerSnapshot'
import './styles.css'

const queryClient = new QueryClient()
// D1: the Scanner's hourly snapshot, shown at once while the live reads run
void loadScannerSnapshot(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
