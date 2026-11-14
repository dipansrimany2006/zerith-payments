import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { WalletProvider } from './lib/wallet'
import { useTheme } from './lib/theme'
import App from './App'
import './index.css'

// Toasts read the app's color tokens, so they follow the theme too.
function ThemedProviders({ children }: { children: ReactNode }) {
  const [theme] = useTheme()
  return (
    <>
      {children}
      <Toaster
        position="top-center"
        theme={theme}
        toastOptions={{
          style: {
            fontFamily: 'Barlow, system-ui, sans-serif',
            borderRadius: 14,
            color: 'var(--ink)',
            background: 'var(--raised)',
            borderColor: 'var(--line)',
          },
        }}
      />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider>
      <ThemedProviders>
        <App />
      </ThemedProviders>
    </WalletProvider>
  </StrictMode>,
)
