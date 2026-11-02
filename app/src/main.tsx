import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const HudApp = lazy(() => import('./hud/HudApp.tsx'))
const isHud = window.location.hash === '#hud'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isHud ? <Suspense fallback={null}><HudApp /></Suspense> : <App />}
  </StrictMode>,
)
