import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { Fingerprint, HeartPulse, RotateCw, Workflow } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { Button, Input } from '../components/ui'

const features = [
  { icon: RotateCw, title: 'Retries with backoff', text: 'Transient failures retry with exponential backoff and jitter, honouring Retry-After.' },
  { icon: Fingerprint, title: 'Idempotent submission', text: 'Resend with the same Idempotency-Key and get the original job, never a duplicate.' },
  { icon: HeartPulse, title: 'Worker recovery', text: 'Jobs from a crashed worker are detected by lease expiry and re-queued.' },
]

export function Login() {
  const { user, login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (user) return <Navigate to="/" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await (mode === 'login' ? login : register)(email, password)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-zinc-950 p-12 text-white lg:flex">
        <div className="absolute -top-40 -left-40 size-[32rem] rounded-full bg-brand-600/30 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-brand-600">
            <Workflow className="size-5" />
          </div>
          <span className="text-lg font-semibold">Relay</span>
        </div>
        <div className="relative">
          <h2 className="max-w-md text-3xl font-semibold tracking-tight">
            Background jobs that survive failures.
          </h2>
          <div className="mt-10 space-y-6">
            {features.map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex gap-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/5 ring-1 ring-white/10">
                  <Icon className="size-5 text-brand-100" />
                </div>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="text-sm text-zinc-400">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-zinc-500">FastAPI · Celery · Redis · PostgreSQL</p>
      </div>

      <div className="flex items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {mode === 'login' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {mode === 'login' ? 'Sign in to continue to your workspace.' : 'Jobs are scoped to your account.'}
            </p>
          </div>
          <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          <Input label="Password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <Button type="submit" loading={busy} className="w-full">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          <p className="text-center text-sm text-zinc-500">
            {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
            <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
