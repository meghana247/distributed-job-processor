import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, Ban, CheckCircle2, Clock, Cpu, FileBarChart, Fingerprint, Globe, Loader2, LogOut, Mail,
  RefreshCw, RotateCw, Send, Timer, Workflow, X, XCircle, Zap,
} from 'lucide-react'
import { api, type Job, type JobDetail, type JobStatus, type Stats, type Template } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Badge, Button, Card, EmptyState, Input, cx } from '../components/ui'

const STATUS: Record<JobStatus, { tone: 'gray' | 'blue' | 'amber' | 'green' | 'red'; label: string }> = {
  queued: { tone: 'gray', label: 'Queued' },
  running: { tone: 'blue', label: 'Running' },
  retrying: { tone: 'amber', label: 'Retrying' },
  succeeded: { tone: 'green', label: 'Succeeded' },
  failed: { tone: 'red', label: 'Failed' },
  cancelled: { tone: 'gray', label: 'Cancelled' },
}
const ACTIVE: JobStatus[] = ['queued', 'running', 'retrying']
const TYPE_ICON: Record<string, typeof Globe> = { http_request: Globe, generate_report: FileBarChart, send_email: Mail }
const FILTERS: (JobStatus | 'all')[] = ['all', 'running', 'retrying', 'succeeded', 'failed']

const newKey = () => `key-${crypto.randomUUID().slice(0, 8)}`
const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}
const until = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000))
const ms = (v: number | null | undefined) => (v == null ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`)

function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status]
  return (
    <Badge tone={s.tone}>
      {status === 'running' && <Loader2 className="size-3 animate-spin" />}
      {status === 'retrying' && <RotateCw className="size-3" />}
      {s.label}
    </Badge>
  )
}

export function Console() {
  const { user, logout } = useAuth()
  const [jobs, setJobs] = useState<Job[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [filter, setFilter] = useState<JobStatus | 'all'>('all')
  const [selected, setSelected] = useState<JobDetail | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const [, tick] = useState(0)

  const refresh = useCallback(async () => {
    const [list, s] = await Promise.all([api.jobs(filter === 'all' ? undefined : filter), api.stats()])
    setJobs(list.items)
    setStats(s)
  }, [filter])

  useEffect(() => {
    api.templates().then(setTemplates)
  }, [])

  // Poll while the console is open. Cheap queries, and it keeps retries and progress visibly live.
  useEffect(() => {
    refresh()
    const t = setInterval(() => {
      refresh()
      tick((n) => n + 1)
    }, 1500)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (!selected) return
    const t = setInterval(() => api.job(selected.id).then(setSelected).catch(() => {}), 1500)
    return () => clearInterval(t)
  }, [selected?.id])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const open = async (id: string) => setSelected(await api.job(id))
  const inFlight = ACTIVE.reduce((n, s) => n + (stats?.by_status[s] ?? 0), 0)
  const peak = Math.max(1, ...(stats?.throughput ?? [0]))

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
              <Workflow className="size-4" />
            </div>
            <span className="font-semibold">Relay</span>
            <span className="ml-2 hidden items-center gap-1.5 text-xs text-zinc-500 sm:flex">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-500" />
              </span>
              Live
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-zinc-600">
            {user?.email}
            <button onClick={logout} className="rounded-md p-1.5 hover:bg-zinc-100" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] space-y-6 p-6">
        {/* metrics */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {[
            { icon: Activity, label: 'Total jobs', value: stats?.total ?? 0 },
            { icon: Cpu, label: 'In flight', value: inFlight, accent: inFlight > 0 },
            { icon: CheckCircle2, label: 'Succeeded', value: stats?.by_status.succeeded ?? 0 },
            { icon: XCircle, label: 'Failed', value: stats?.by_status.failed ?? 0 },
            { icon: Zap, label: 'Success rate', value: stats?.success_rate == null ? '—' : `${(stats.success_rate * 100).toFixed(1)}%` },
            { icon: RotateCw, label: 'Retries', value: stats?.retried_attempts ?? 0, hint: `avg run ${ms(stats?.avg_duration_ms)}` },
          ].map(({ icon: Icon, label, value, accent, hint }) => (
            <Card key={label} className="p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
                <Icon className={cx('size-3.5', accent && 'text-brand-600')} /> {label}
              </div>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
              {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
            </Card>
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-6">
            {/* throughput */}
            <Card className="p-5">
              <div className="mb-4 flex items-baseline justify-between">
                <div>
                  <p className="text-sm font-semibold">Throughput</p>
                  <p className="text-xs text-zinc-500">Jobs finished per minute · last 30 minutes</p>
                </div>
                <p className="text-xs text-zinc-500">peak {peak}/min</p>
              </div>
              <div className="flex h-24 items-end gap-1">
                {(stats?.throughput ?? Array(30).fill(0)).map((n, i) => (
                  <div key={i} className="group relative flex-1">
                    <div
                      className={cx('w-full rounded-sm transition-all', n ? 'bg-brand-500 group-hover:bg-brand-700' : 'bg-zinc-100')}
                      style={{ height: `${Math.max(4, (n / peak) * 96)}px` }}
                    />
                    <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-white group-hover:block">
                      {n} · {29 - i}m ago
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            {/* jobs */}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
                <p className="text-sm font-semibold">Jobs</p>
                <div className="flex gap-1 rounded-lg bg-zinc-100 p-0.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={cx('rounded-md px-2.5 py-1 text-xs font-medium capitalize', filter === f ? 'bg-white shadow-sm' : 'text-zinc-500 hover:text-zinc-800')}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              {jobs.length === 0 ? (
                <EmptyState icon={<Workflow className="size-5" />} title="No jobs here" hint="Submit one from a template on the right." />
              ) : (
                <div className="max-h-[560px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-xs text-zinc-500">
                        <th className="px-5 py-2.5 font-medium">Job</th>
                        <th className="px-3 py-2.5 font-medium">Status</th>
                        <th className="px-3 py-2.5 font-medium">Progress</th>
                        <th className="px-3 py-2.5 font-medium">Attempts</th>
                        <th className="px-3 py-2.5 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {jobs.map((j) => {
                        const Icon = TYPE_ICON[j.type] ?? Workflow
                        return (
                          <tr key={j.id} onClick={() => open(j.id)} className={cx('cursor-pointer hover:bg-zinc-50', selected?.id === j.id && 'bg-brand-50/50')}>
                            <td className="px-5 py-2.5">
                              <div className="flex items-center gap-3">
                                <div className="grid size-8 place-items-center rounded-lg bg-zinc-100 text-zinc-600">
                                  <Icon className="size-4" />
                                </div>
                                <div>
                                  <p className="font-medium">{j.type.replace('_', ' ')}</p>
                                  <p className="font-mono text-[11px] text-zinc-400">{j.id.slice(0, 8)}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <StatusBadge status={j.status} />
                              {j.status === 'retrying' && j.next_retry_at && <p className="mt-1 text-[11px] text-amber-700">in {until(j.next_retry_at)}s</p>}
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="h-1.5 w-24 rounded-full bg-zinc-100">
                                <div
                                  className={cx('h-full rounded-full transition-all', j.status === 'failed' ? 'bg-red-400' : 'bg-brand-500')}
                                  style={{ width: `${j.progress}%` }}
                                />
                              </div>
                            </td>
                            <td className="px-3 py-2.5 tabular-nums text-zinc-600">
                              {j.attempts}
                              <span className="text-zinc-400">/{j.max_retries + 1}</span>
                            </td>
                            <td className="px-3 py-2.5 text-zinc-500">{ago(j.created_at)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <SubmitPanel templates={templates} onSubmitted={(text, ok = true) => { setToast({ ok, text }); refresh() }} />
        </div>
      </div>

      {selected && <JobDrawer job={selected} onClose={() => setSelected(null)} onChange={setSelected} />}

      {toast && (
        <div className={cx('fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg px-4 py-2.5 text-sm text-white shadow-lg', toast.ok ? 'bg-zinc-900' : 'bg-red-600')}>
          {toast.ok ? <CheckCircle2 className="size-4 text-brand-500" /> : <XCircle className="size-4" />}
          {toast.text}
        </div>
      )}
    </div>
  )
}

function SubmitPanel({ templates, onSubmitted }: { templates: Template[]; onSubmitted: (text: string, ok?: boolean) => void }) {
  const [index, setIndex] = useState(0)
  const [retries, setRetries] = useState<number | null>(null)
  const [key, setKey] = useState(newKey)
  const [lastKey, setLastKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<'one' | 'replay' | 'burst' | null>(null)
  const template = templates[index]
  const body = useMemo(
    () => template && { type: template.type, payload: template.payload, max_retries: retries ?? template.max_retries },
    [template, retries],
  )

  const run = async (mode: 'one' | 'replay' | 'burst') => {
    if (!body) return
    setBusy(mode)
    try {
      if (mode === 'burst') {
        await Promise.all(Array.from({ length: 20 }, () => api.submit(body)))
        onSubmitted(`Submitted 20 × ${template.name}`)
      } else {
        const useKey = mode === 'replay' ? lastKey! : key
        const { job, replayed } = await api.submit(body, useKey)
        onSubmitted(replayed ? `Replayed job ${job.id.slice(0, 8)} — no duplicate created` : `Queued job ${job.id.slice(0, 8)}`)
        if (mode === 'one') {
          setLastKey(key)
          setKey(newKey())
        }
      }
    } catch (err) {
      onSubmitted((err as Error).message, false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <p className="text-sm font-semibold">Submit a job</p>
        <p className="mb-4 text-xs text-zinc-500">Templates call a built-in mock third-party API.</p>
        <div className="space-y-2">
          {templates.map((t, i) => (
            <button
              key={t.name}
              onClick={() => {
                setIndex(i)
                setRetries(null)
              }}
              className={cx('w-full rounded-lg p-3 text-left ring-1 transition', i === index ? 'bg-brand-50/60 ring-brand-500' : 'ring-zinc-200 hover:ring-zinc-300')}
            >
              <p className="text-sm font-medium">{t.name}</p>
              <p className="mt-0.5 text-xs text-zinc-500">{t.description}</p>
            </button>
          ))}
        </div>
        {template && (
          <div className="mt-4 space-y-3">
            <Input label="Max retries" type="number" min={0} max={10} value={retries ?? template.max_retries} onChange={(e) => setRetries(Number(e.target.value))} />
            <label className="block">
              <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-zinc-700">
                <Fingerprint className="size-3.5" /> Idempotency-Key
              </span>
              <div className="flex gap-2">
                <input value={key} onChange={(e) => setKey(e.target.value)} className="w-full rounded-lg bg-white px-3 py-2 font-mono text-xs ring-1 ring-zinc-200 focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                <button onClick={() => setKey(newKey())} className="rounded-lg px-2.5 ring-1 ring-zinc-200 hover:bg-zinc-50" title="New key">
                  <RefreshCw className="size-3.5" />
                </button>
              </div>
            </label>
            <Button className="w-full" loading={busy === 'one'} onClick={() => run('one')}>
              <Send className="size-4" /> Submit job
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" disabled={!lastKey} loading={busy === 'replay'} onClick={() => run('replay')} title="Send the same request again with the previous key">
                <Fingerprint className="size-4" /> Resend same key
              </Button>
              <Button variant="secondary" loading={busy === 'burst'} onClick={() => run('burst')}>
                <Zap className="size-4" /> Burst × 20
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function JobDrawer({ job, onClose, onChange }: { job: JobDetail; onClose: () => void; onChange: (j: JobDetail) => void }) {
  const act = async (fn: (id: string) => Promise<unknown>) => {
    await fn(job.id)
    onChange(await api.job(job.id))
  }
  const Icon = TYPE_ICON[job.type] ?? Workflow

  return (
    <>
      <div className="fixed inset-0 z-30 bg-zinc-950/20" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-30 flex w-[520px] flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-100 p-5">
          <div className="flex gap-3">
            <div className="grid size-10 place-items-center rounded-lg bg-zinc-100">
              <Icon className="size-5 text-zinc-600" />
            </div>
            <div>
              <p className="font-semibold">{job.type.replace('_', ' ')}</p>
              <p className="font-mono text-xs text-zinc-400">{job.id}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-zinc-100">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusBadge status={job.status} />
              {job.status === 'retrying' && job.next_retry_at && (
                <span className="flex items-center gap-1 text-xs text-amber-700">
                  <Timer className="size-3" /> next attempt in {until(job.next_retry_at)}s
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {ACTIVE.includes(job.status) && (
                <Button variant="secondary" onClick={() => act(api.cancel)}>
                  <Ban className="size-4" /> Cancel
                </Button>
              )}
              {(job.status === 'failed' || job.status === 'cancelled') && (
                <Button onClick={() => act(api.retry)}>
                  <RotateCw className="size-4" /> Re-drive
                </Button>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1 flex justify-between text-xs text-zinc-500">
              <span>Progress</span>
              <span>{job.progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100">
              <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${job.progress}%` }} />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ['Attempts', `${job.attempts} of ${job.max_retries + 1}`],
              ['Idempotency-Key', job.idempotency_key ?? '—'],
              ['Created', new Date(job.created_at).toLocaleTimeString()],
              ['Finished', job.finished_at ? new Date(job.finished_at).toLocaleTimeString() : '—'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-zinc-50 p-3">
                <dt className="text-xs text-zinc-500">{k}</dt>
                <dd className="mt-0.5 truncate font-medium">{v}</dd>
              </div>
            ))}
          </dl>

          <div>
            <p className="mb-3 text-sm font-semibold">Attempt timeline</p>
            {job.attempt_log.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-zinc-500">
                <Clock className="size-4" /> Waiting for a worker…
              </p>
            ) : (
              <ol className="relative space-y-4 border-l border-zinc-200 pl-5">
                {job.attempt_log.map((a) => (
                  <li key={a.number} className="relative">
                    <span
                      className={cx(
                        'absolute -left-[27px] grid size-3.5 place-items-center rounded-full ring-4 ring-white',
                        a.status === 'succeeded' ? 'bg-brand-500' : a.status === 'failed' ? 'bg-red-500' : 'bg-sky-500',
                      )}
                    />
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">
                        Attempt {a.number} <span className="font-normal text-zinc-500">· {a.status}</span>
                      </p>
                      <span className="text-xs text-zinc-500 tabular-nums">{ms(a.duration_ms)}</span>
                    </div>
                    <p className="font-mono text-[11px] text-zinc-400">{a.worker}</p>
                    {a.error && (
                      <div className="mt-1.5 flex items-start gap-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
                        <span className="flex-1">{a.error}</span>
                        <Badge tone={a.retryable ? 'amber' : 'red'}>{a.retryable ? 'retryable' : 'permanent'}</Badge>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          {[
            ['Payload', job.payload],
            ['Result', job.result],
          ].map(([label, value]) =>
            value ? (
              <div key={label as string}>
                <p className="mb-2 text-sm font-semibold">{label as string}</p>
                <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200">{JSON.stringify(value, null, 2)}</pre>
              </div>
            ) : null,
          )}
          {job.error && job.status === 'failed' && (
            <div>
              <p className="mb-2 text-sm font-semibold">Final error</p>
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{job.error}</p>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
