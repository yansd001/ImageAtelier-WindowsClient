import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

const font = document.createElement('link')
font.rel = 'stylesheet'
font.href = '/api/fonts/result.css'
document.head.appendChild(font)
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
