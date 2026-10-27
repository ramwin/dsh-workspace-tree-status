// Unit tests for the pure derivation half of dsh-workspace-tree-status.
//
// The browser bundle registers itself through the shell's module table, so the
// test seeds a minimal `window.__ModuleLoader__`, imports the bundle once, and
// reaches the exported internals through the captured factory.

import assert from 'node:assert/strict'
import { test } from 'node:test'

/** @type {{id: string, factory: (require: (id: string) => unknown) => any} | null} */
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

await import(new URL('../lib/client.js', import.meta.url))
assert.ok(captured, 'bundle must register a module factory')
const api = captured.factory((id) => {
  throw new Error(`unexpected require(${id})`)
})
assert.equal(captured.id, 'dsh-workspace-tree-status')
assert.equal(typeof api.apply, 'function')
assert.deepEqual(api.inject, ['sessions', 'workspaces', 'uiSession'])

const {
  normalizePath,
  nearestParentPath,
  parentWorkspaceIds,
  sessionAttention,
  deriveWorkspaceStatus,
  displayKind,
} = api.__internals

/** One workspace row. */
function workspace(workspaceId, path, sessionIds = []) {
  return { workspaceId, path, title: workspaceId, sessionIds, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
}

/** One session list snapshot. */
function sessionList(items) {
  const byId = {}
  const ids = []
  for (const item of items) {
    const id = item.id
    ids.push(id)
    byId[id] = {
      id,
      displayTitle: id,
      running: false,
      retainedBy: {},
      blank: false,
      updatedAt: 0,
      ...item,
    }
  }
  return { ids, byId, phase: 'ready', projectionsBySession: {} }
}

/** Empty unified status baseline. */
function statusMap(entries = {}) {
  return new Map(Object.entries(entries))
}

test('normalizePath accepts both separators and drops trailing slashes', () => {
  assert.equal(normalizePath('/home/me/proj/'), '/home/me/proj')
  assert.equal(normalizePath('/home/me/proj'), '/home/me/proj')
  assert.equal(normalizePath('C:\\work\\proj\\'), 'C:/work/proj')
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath(undefined), '')
})

test('nearestParentPath picks the deepest registered ancestor, not a name prefix', () => {
  const paths = ['/home/me/proj', '/home/me/proj/sub', '/home/me/proj2']
  assert.equal(nearestParentPath('/home/me/proj/sub', paths), '/home/me/proj')
  assert.equal(nearestParentPath('/home/me/proj2/x', paths), '/home/me/proj2')
  assert.equal(nearestParentPath('/home/me/proj2', paths), undefined)
  assert.equal(nearestParentPath('/home/me/proj', paths), undefined)
})

test('parentWorkspaceIds links nested workspaces only', () => {
  const parents = parentWorkspaceIds([
    workspace('root', '/h/g'),
    workspace('life', '/h/g/个人/life'),
    workspace('mem', '/h/g/个人/memory-repo'),
    workspace('dj', '/h/g/django'),
    workspace('djsub', '/h/g/django/django-reference'),
    workspace('other', '/h/other'),
  ])
  assert.equal(parents.get('root'), undefined)
  assert.equal(parents.get('life'), 'root')
  assert.equal(parents.get('mem'), 'root')
  assert.equal(parents.get('dj'), 'root')
  assert.equal(parents.get('djsub'), 'dj')
  assert.equal(parents.get('other'), undefined)
})

test('sessionAttention ranks pending input above finished turns above live work', () => {
  assert.equal(sessionAttention({ pendingInteraction: { kind: 'question' }, running: true }, {}), 'waiting')
  assert.equal(sessionAttention({ completionUnread: true, running: false }, {}), 'done')
  assert.equal(sessionAttention({ running: true }, {}), 'running')
  assert.equal(sessionAttention({ running: false }, {}), null)
  assert.equal(sessionAttention(undefined, { running: true }), 'running')
  assert.equal(sessionAttention(undefined, { running: false }), null)
})

test('displayKind follows waiting > done > running > idle', () => {
  assert.equal(displayKind({ waiting: 2, done: 1, running: 3 }), 'waiting')
  assert.equal(displayKind({ waiting: 0, done: 1, running: 3 }), 'done')
  assert.equal(displayKind({ waiting: 0, done: 0, running: 3 }), 'running')
  assert.equal(displayKind({ waiting: 0, done: 0, running: 0 }), 'idle')
  assert.equal(displayKind(undefined), 'idle')
})

test('deriveWorkspaceStatus aggregates nested workspaces and the ungrouped bucket', () => {
  const workspaces = [
    workspace('root', '/h/g', []),
    workspace('life', '/h/g/个人/life', ['life-done']),
    workspace('dj', '/h/g/django', ['dj-wait', 'dj-run']),
    workspace('sub', '/h/g/django/sub', ['sub-done']),
  ]
  const sessions = sessionList([
    { id: 'life-done', cwd: '/h/g/个人/life' },
    { id: 'dj-wait', cwd: '/h/g/django' },
    { id: 'dj-run', cwd: '/h/g/django' },
    { id: 'sub-done', cwd: '/h/g/django/sub' },
    { id: 'loose', cwd: '/h/loose' },
  ])
  const statuses = statusMap({
    'life-done': { completionUnread: true, running: false },
    'dj-wait': { pendingInteraction: { kind: 'question' }, running: true },
    'dj-run': { running: true },
    'sub-done': { completionUnread: true, running: false },
    loose: { running: true },
  })

  const counts = deriveWorkspaceStatus({
    workspaces,
    sessions,
    statuses,
    archivedSessionIds: [],
  })

  assert.deepEqual(counts.get('life'), { waiting: 0, done: 1, running: 0 })
  // dj also summarizes its nested workspace `sub`
  assert.deepEqual(counts.get('dj'), { waiting: 1, done: 1, running: 1 })
  assert.deepEqual(counts.get('sub'), { waiting: 0, done: 1, running: 0 })
  // root receives every nested workspace exactly once (no double counting)
  assert.deepEqual(counts.get('root'), { waiting: 1, done: 2, running: 1 })
  // sessions outside every workspace land in the ungrouped bucket
  assert.deepEqual(counts.get(''), { waiting: 0, done: 0, running: 1 })
})

test('deriveWorkspaceStatus skips archived, subagent and blank rows', () => {
  const workspaces = [workspace('dj', '/h/g/django', ['archived-done', 'child-run', 'blank'])]
  const sessions = sessionList([
    { id: 'archived-done' },
    { id: 'child-run', parentId: 'parent' },
    { id: 'blank', blank: true },
  ])
  const statuses = statusMap({
    'archived-done': { completionUnread: true, running: false },
    'child-run': { running: true },
  })
  const counts = deriveWorkspaceStatus({
    workspaces,
    sessions,
    statuses,
    archivedSessionIds: ['archived-done'],
  })
  assert.deepEqual(counts.get('dj'), { waiting: 0, done: 0, running: 0 })
})

test('deriveWorkspaceStatus falls back to the list running flag before a status baseline', () => {
  const workspaces = [workspace('dj', '/h/g/django', ['busy'])]
  const sessions = sessionList([{ id: 'busy', running: true }])
  const counts = deriveWorkspaceStatus({
    workspaces,
    sessions,
    statuses: statusMap(),
    archivedSessionIds: [],
  })
  assert.deepEqual(counts.get('dj'), { waiting: 0, done: 0, running: 1 })
})
