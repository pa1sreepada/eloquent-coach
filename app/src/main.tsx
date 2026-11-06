import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const HudApp = lazy(() => import('./hud/HudApp.tsx'))
const PrompterApp = lazy(() => import('./prompter/PrompterApp.tsx'))
const route = window.location.hash

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {route === '#hud' ? <Suspense fallback={null}><HudApp /></Suspense>
      : route === '#prompter' ? <Suspense fallback={null}><PrompterApp /></Suspense>
      : <App />}
  </StrictMode>,
)
