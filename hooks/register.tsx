import type { EngineInterface, Register } from 'claude-code'

// Message rows carry no timestamp. New rows: we record the moment each is
// saved (keyed by its id). Older rows: at session start we read their saved
// timestamps from the session's transcript file. Either way the time is drawn
// under the message.
const KEY = 'times'
const MAX = 20000

const pad = (n: number) => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function format(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function asTimes(v: unknown): Record<string, number> {
  return v && typeof v === 'object' ? { ...(v as Record<string, number>) } : {}
}

function trim(times: Record<string, number>) {
  const ids = Object.keys(times)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX))) delete times[id]
}

// Transcript folders are named after the project path, every non-alphanumeric
// character turned into '-'.
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

// Adds { id: epoch ms } for one transcript line, if it is a visible
// user/assistant row.
function parseLine(line: string, out: Record<string, number>) {
  if (!line.includes('"timestamp"')) return
  let row: any
  try { row = JSON.parse(line) } catch { return }
  if (row?.type !== 'user' && row?.type !== 'assistant') return
  if (typeof row.uuid !== 'string' || typeof row.timestamp !== 'string') return
  const ms = Date.parse(row.timestamp)
  if (Number.isNaN(ms)) return
  const c = row.message?.content
  const hasText = typeof c === 'string' ||
    (Array.isArray(c) && c.some((b: any) => b?.type === 'text'))
  if (!hasText) return
  out[row.uuid] = ms
  // Reply rows are drawn under the API message id ("msg_…-t0"), so key
  // assistant rows by that id too, keeping the earliest time.
  const mid = row.message?.id
  if (row.type === 'assistant' && typeof mid === 'string') {
    if (out[mid] === undefined || ms < out[mid]) out[mid] = ms
  }
}

// Reads a transcript's times. `$.fs.read` stops at 4 MiB, so a longer
// session's file is streamed through `type` (Windows) or `cat` instead.
async function readTranscript($: EngineInterface, path: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const { size } = await $.fs.stat(path)
  if (size < 4 * 1024 * 1024) {
    for (const line of (await $.fs.read(path)).split('\n')) parseLine(line, out)
    return out
  }
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows
    ? ['cmd', '/d', '/c', 'type', path.replace(/\//g, '\\')]
    : ['cat', path]
  let rest = ''
  for await (const piece of $.process.spawn({ argv })) {
    if (piece.stream !== 'stdout') continue
    rest += piece.text
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) parseLine(line, out)
  }
  parseLine(rest, out)
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      const id = await $.session.id()
      const configured = await $.env.get('CLAUDE_CONFIG_DIR')
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
      const base = configured ?? (home ? `${home}/.claude` : undefined)
      if (base) {
        const dirs = [await $.session.root(), await $.session.cwd(), e.cwd]
        for (const dir of dirs) {
          const path = `${base}/projects/${slug(dir)}/${id}.jsonl`
          if (!(await $.fs.exists(path))) continue
          const found = await readTranscript($, path)
          const times = asTimes(await $.store.get(KEY))
          let added = 0
          for (const [uuid, ms] of Object.entries(found)) {
            if (times[uuid] === undefined) { times[uuid] = ms; added++ }
          }
          if (added > 0) {
            trim(times)
            await $.store.set(KEY, times)
            $.ui.invalidate('ui.render')
          }
          break
        }
      }
    } catch {
      // a missing or oversized transcript just means no older times
    }
    return result
  })

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && (e.door === 'prompt' || e.door === 'response')) {
      try {
        const times = asTimes(await $.store.get(KEY))
        times[result.uuid] = await $.clock.now()
        trim(times)
        await $.store.set(KEY, times)
        // The row may already be drawn without its time: draw it again.
        $.ui.invalidate('ui.render')
      } catch {
        // never block a message over a timestamp
      }
    }
    return result
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const at = asTimes(await $.store.get(KEY))[e.requestId]
    if (at === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="row" justifyContent="flex-end">
          <Text dimColor>🕒 {format(at)}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Every text block of a reply is its own row with its own time; a reply
    // usually opens with tool calls, so its text is rarely the first block.
    if (e.props.isSummary) return next(e)
    // "msg_abc-t0" → "msg_abc": the reply's API message id.
    const mid = e.requestId.replace(/-t\d+$/, '')
    const times = asTimes(await $.store.get(KEY))
    let at = times[e.requestId] ?? times[mid]
    if (at === undefined) {
      // A reply too new for the session file: it is being drawn as it
      // arrives, so now is its time.
      at = await $.clock.now()
      try {
        times[mid] = at
        trim(times)
        await $.store.set(KEY, times)
      } catch {}
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Text dimColor>🕒 {format(at)}</Text>
      </Box>
    )
  })
}
