import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './ui/App'
import { RecoveryApp } from './ui/RecoveryApp'
import { initializeI18n } from './i18n'
import { installNativeContextMenuPolicy } from './nativeContextMenuPolicy'
import 'react-easy-crop/react-easy-crop.css'
import 'sonner/dist/styles.css'
import './styles.css'

const platform = navigator.userAgent.includes('Macintosh')
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux'

document.documentElement.dataset.platform = platform
installNativeContextMenuPolicy()

const recovery = location.hash === '#recovery'
void initializeI18n(recovery).finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {recovery ? <RecoveryApp /> : <App />}
    </React.StrictMode>
  )
})
