const BASE = '/api'
const TOKEN_KEY = 'relay.token'

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

let onUnauthorized: () => void = () => {}
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn)

export async function request<T>(path: string, init: RequestInit = {}): Promise<{ data: T; res: Response }> {
  const headers = new Headers(init.headers)
  const token = tokenStore.get()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  const res = await fetch(BASE + path, { ...init, headers })
  if (res.status === 401 && token) onUnauthorized()
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = Array.isArray(body?.detail) ? body.detail[0]?.msg : body?.detail
    throw new ApiError(res.status, detail ?? res.statusText)
  }
  return { data: (await res.json()) as T, res }
}

const get = async <T,>(path: string, init?: RequestInit) => (await request<T>(path, init)).data

export type JobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'cancelled'
export type User = { id: string; email: string; role?: string }
export type Attempt = {
  number: number
  status: 'running' | 'succeeded' | 'failed'
  error: string | null
  retryable: boolean | null
  worker: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
}
export type Job = {
  id: string
  type: string
  status: JobStatus
  payload: Record<string, unknown>
  idempotency_key: string | null
  attempts: number
  max_retries: number
  progress: number
  result: Record<string, unknown> | null
  error: string | null
  next_retry_at: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}
export type JobDetail = Job & { attempt_log: Attempt[] }
export type Stats = {
  by_status: Partial<Record<JobStatus, number>>
  total: number
  success_rate: number | null
  retried_attempts: number
  avg_duration_ms: number | null
  throughput: number[]
}
export type Template = { name: string; description: string; type: string; payload: Record<string, unknown>; max_retries: number }
export type NewJob = { type: string; payload: Record<string, unknown>; max_retries: number }

export const api = {
  login: (email: string, password: string) =>
    get<{ access_token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) =>
    get<User>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => get<User>('/auth/me'),

  jobs: (status?: JobStatus) => get<{ items: Job[]; total: number }>(`/jobs?limit=100${status ? `&status=${status}` : ''}`),
  job: (id: string) => get<JobDetail>(`/jobs/${id}`),
  stats: () => get<Stats>('/jobs/stats'),
  templates: () => get<Template[]>('/jobs/templates'),
  /** Returns whether the server replayed an earlier job for this Idempotency-Key. */
  submit: async (job: NewJob, idempotencyKey?: string) => {
    const { data, res } = await request<Job>('/jobs', {
      method: 'POST',
      body: JSON.stringify(job),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    })
    return { job: data, replayed: res.headers.get('Idempotent-Replayed') === 'true' }
  },
  cancel: (id: string) => get<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),
  retry: (id: string) => get<Job>(`/jobs/${id}/retry`, { method: 'POST' }),
}
