import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from './lib/auth'
import { Login } from './pages/Login'
import { Console } from './pages/Console'
import './index.css'

function Home() {
  const { user, loading } = useAuth()
  if (loading)
    return (
      <div className="grid h-screen place-items-center">
        <Loader2 className="size-6 animate-spin text-zinc-400" />
      </div>
    )
  return user ? <Console /> : <Navigate to="/login" replace />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
