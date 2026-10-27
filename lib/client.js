// dsh-workspace-tree-status — browser half.
//
// Loaded by dsh-client-modules as `/plugins/dsh-workspace-tree-status/client.js`
// and run through the shell's module table (`window.__ModuleLoader__.load`),
// the same shape the shipped ui-* bundles use: `require()` resolves `react`
// against the shell-seeded instance, so no bundler or build step is needed.
//
// What it does: every folder row of the sidebar's workspace tree gets a status
// dot in front of its name, aggregated from the sessions inside it (including
// sessions of nested workspaces), so a collapsed folder still shows whether
// something inside is waiting for you, just finished, or still running.
//
// Why it decorates the rendered rows instead of filling a slot: ui-workspace
// owns the whole `sidebar.workspaces` region and declares no seat for a
// workspace row (session rows have `sidebar.session.row.leading`, folders do
// not). The row contract used here is the sidebar's own published one — the
// `data-row-key="workspace:<id>"` identity on each row and the
// `data-slot="sidebar.workspaces"` outlet around the region — and everything
// degrades to "no dots" if a future version stops rendering them: no other
// DOM, component or stylesheet of the sidebar is read or replaced.

window.__ModuleLoader__.load({
  id: 'dsh-workspace-tree-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Marks the injected style element (also used to find it again on reload). */
    var STYLE_MARK = 'dsh-workspace-tree-status'
    /** The slot outlet the sidebar shell renders around the browsing region. */
    var REGION_SELECTOR = '[data-slot="sidebar.workspaces"]'
    /** A workspace group row: key is the workspace id, empty for the ungrouped bucket. */
    var ROW_SELECTOR = '[data-row-key^="workspace:"]'
    var KEY_PREFIX = 'workspace:'
    /** Our own marker on the injected dot (and the attribute naming its state). */
    var DOT_ATTR = 'data-dsh-wts'
    /** Group key of the sessions outside every workspace (matches ungroupedSessionIds). */
    var UNGROUPED_KEY = ''

    // ───────────────────────────── state derivation ─────────────────────────────

    /**
     * Normalize a path for prefix comparison without treating POSIX backslashes
     * as separators (same rule the workspace browser uses for its own nesting).
     * @param {unknown} path - host-spelled directory path.
     * @returns {string} the comparable form (empty for a non-string).
     */
    function normalizePath(path) {
      if (typeof path !== 'string' || path === '') return ''
      return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') ? path.replaceAll('\\', '/') : path).replace(
        /\/+$/,
        '',
      )
    }

    /**
     * Nearest registered ancestor of one workspace path.
     * @param {string} path - candidate child directory.
     * @param {readonly string[]} paths - every registered workspace directory.
     * @returns {string | undefined} the owning path, or undefined when nothing contains it.
     */
    function nearestParentPath(path, paths) {
      var child = normalizePath(path)
      var owner
      var length = -1
      for (var i = 0; i < paths.length; i++) {
        var root = normalizePath(paths[i])
        if (root === '' || root.length <= length || child === root) continue
        if (child.startsWith(root + '/')) {
          owner = paths[i]
          length = root.length
        }
      }
      return owner
    }

    /**
     * Map every workspace to its nearest registered parent workspace.
     * @param {readonly {workspaceId: string, path: string}[]} workspaces - registry rows in host order.
     * @returns {Map<string, string | undefined>} workspace id → parent id (or undefined at the root).
     */
    function parentWorkspaceIds(workspaces) {
      var paths = workspaces.map(function (workspace) {
        return workspace.path
      })
      var idByPath = new Map()
      for (var i = 0; i < workspaces.length; i++) idByPath.set(workspaces[i].path, workspaces[i].workspaceId)
      var parents = new Map()
      for (var j = 0; j < workspaces.length; j++) {
        var parentPath = nearestParentPath(workspaces[j].path, paths)
        parents.set(workspaces[j].workspaceId, parentPath === undefined ? undefined : idByPath.get(parentPath))
      }
      return parents
    }

    /** @returns {{waiting: number, done: number, running: number}} an empty count triple. */
    function emptyCounts() {
      return { waiting: 0, done: 0, running: 0 }
    }

    /**
     * Which attention state one session contributes to its folder.
     *
     * Pending interaction outranks a finished turn, which outranks live work:
     * the dot answers "where does someone need me", not "where is a machine busy".
     * @param {{pendingInteraction?: unknown, completionUnread?: boolean, running?: boolean} | undefined} status - unified UI status.
     * @param {{running?: boolean} | undefined} summary - session row fallback state.
     * @returns {'waiting' | 'done' | 'running' | null} the contribution, or null for an idle session.
     */
    function sessionAttention(status, summary) {
      if (status !== undefined && status !== null) {
        if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return 'waiting'
        if (status.completionUnread === true) return 'done'
        if (status.running === true) return 'running'
      }
      if (summary !== undefined && summary !== null && summary.running === true) return 'running'
      return null
    }

    /**
     * Aggregate session attention per workspace, then bubble each workspace's
     * own numbers up through its registered parent chain, so a parent folder
     * summarizes everything nested inside it.
     * @param {object} input - current snapshots.
     * @param {readonly {workspaceId: string, path: string, sessionIds?: readonly string[]}[]} input.workspaces - registry rows in host order.
     * @param {{ids?: readonly string[], byId?: Record<string, object>}} input.sessions - session list snapshot.
     * @param {ReadonlyMap<string, object>} input.statuses - unified UI status per session id.
     * @param {readonly string[]} input.archivedSessionIds - registry-global archive set.
     * @returns {Map<string, {waiting: number, done: number, running: number}>} group key → counts.
     */
    function deriveWorkspaceStatus(input) {
      var workspaces = input.workspaces || []
      var sessions = input.sessions || {}
      var byId = sessions.byId || {}
      var statuses = input.statuses instanceof Map ? input.statuses : new Map()
      var archived = new Set(input.archivedSessionIds || [])
      var direct = new Map()
      var seen = new Set()

      /** Add one session's attention to a count triple. */
      function accumulate(counts, sessionId) {
        var summary = byId[sessionId]
        if (summary === undefined || summary === null) return
        if (archived.has(sessionId)) return
        if (summary.origin === 'subagent' || summary.parentId !== undefined) return
        var kind = sessionAttention(statuses.get(sessionId), summary)
        if (kind !== null) counts[kind] += 1
      }

      for (var i = 0; i < workspaces.length; i++) {
        var workspace = workspaces[i]
        var ids = workspace.sessionIds || []
        var counts = emptyCounts()
        for (var j = 0; j < ids.length; j++) {
          seen.add(ids[j])
          accumulate(counts, ids[j])
        }
        direct.set(workspace.workspaceId, counts)
      }

      var ungrouped = emptyCounts()
      var allIds = sessions.ids || []
      for (var k = 0; k < allIds.length; k++) {
        var id = allIds[k]
        if (seen.has(id)) continue
        var summary = byId[id]
        if (summary === undefined || summary === null || summary.blank === true) continue
        accumulate(ungrouped, id)
      }

      // Each workspace starts with its own numbers and then receives every
      // nested workspace's *direct* numbers once, walking up the parent chain.
      var aggregate = new Map()
      for (var m = 0; m < workspaces.length; m++) {
        var own = direct.get(workspaces[m].workspaceId)
        aggregate.set(workspaces[m].workspaceId, {
          waiting: own.waiting,
          done: own.done,
          running: own.running,
        })
      }
      var parents = parentWorkspaceIds(workspaces)
      for (var n = 0; n < workspaces.length; n++) {
        var source = direct.get(workspaces[n].workspaceId)
        if (source.waiting + source.done + source.running === 0) continue
        var key = parents.get(workspaces[n].workspaceId)
        var guard = 0
        while (key !== undefined && guard++ <= workspaces.length) {
          var target = aggregate.get(key)
          if (target === undefined) break
          target.waiting += source.waiting
          target.done += source.done
          target.running += source.running
          key = parents.get(key)
        }
      }
      aggregate.set(UNGROUPED_KEY, ungrouped)
      return aggregate
    }

    /**
     * The single dot one folder row shows.
     * @param {{waiting: number, done: number, running: number} | undefined} counts - aggregated numbers.
     * @returns {'waiting' | 'done' | 'running' | 'idle'} the presented state.
     */
    function displayKind(counts) {
      if (counts === undefined || counts === null) return 'idle'
      if (counts.waiting > 0) return 'waiting'
      if (counts.done > 0) return 'done'
      if (counts.running > 0) return 'running'
      return 'idle'
    }

    // ─────────────────────────────────── styles ──────────────────────────────────

    /** One row's dot, addressed by its state (state rules repeat the row scope to outrank the base rule). */
    function dotSelector(state) {
      return ROW_SELECTOR + ' > [' + DOT_ATTR + (state === undefined ? '' : '="' + state + '"') + ']'
    }

    /** Dot geometry: an own flex slot keeps every folder name aligned; idle keeps it empty. */
    var CSS = [
      dotSelector() + ' {',
      '  flex: none;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  box-sizing: border-box;',
      '  width: 9px;',
      '  height: 9px;',
      '  margin-inline: -2px;',
      '  border-radius: 50%;',
      '  corner-shape: round;',
      '  position: relative;',
      '  pointer-events: none;',
      '}',
      dotSelector() + '::before,',
      dotSelector() + '::after {',
      '  content: "";',
      '  position: absolute;',
      '  inset: 0;',
      '  box-sizing: border-box;',
      '  border-radius: 50%;',
      '  corner-shape: round;',
      '}',
      dotSelector('waiting') + ' { color: var(--dsw-alias-state-warn-primary); }',
      dotSelector('waiting') + '::before { background: currentColor; animation: dsh-wts-pulse 1.4s ease-in-out infinite; }',
      dotSelector('done') + ' { color: var(--dsw-alias-state-success-primary); }',
      dotSelector('done') + '::before { background: currentColor; }',
      dotSelector('running') + ' { color: var(--dsw-alias-label-tertiary); }',
      dotSelector('running') + '::before { border: 1.5px solid currentColor; opacity: 0.45; }',
      dotSelector('running') + '::after { border: 1.5px solid transparent; border-top-color: currentColor; animation: dsh-wts-spin 0.9s linear infinite; }',
      dotSelector('idle') + ' { visibility: hidden; }',
      dotSelector('idle') + '::before,',
      dotSelector('idle') + '::after { display: none; }',
      '@keyframes dsh-wts-spin { to { transform: rotate(360deg); } }',
      '@keyframes dsh-wts-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
      '@media (prefers-reduced-motion: reduce) {',
      '  ' + dotSelector() + '::before,',
      '  ' + dotSelector() + '::after { animation: none; }',
      '}',
    ].join('\n')

    /**
     * Insert the plugin stylesheet once per document.
     * @returns {HTMLStyleElement | null} the live element (null before a document exists).
     */
    function ensureStyle() {
      if (typeof document === 'undefined' || document.head === null) return null
      var existing = document.querySelector('style[data-plugin-css="' + STYLE_MARK + '"]')
      if (existing !== null) return existing
      var tag = document.createElement('style')
      tag.dataset.plugin = STYLE_MARK
      tag.dataset.pluginCss = STYLE_MARK
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    // ──────────────────────────────── row decoration ─────────────────────────────

    /**
     * Find the dot this plugin already injected into one row.
     * @param {Element} row - workspace group row.
     * @returns {Element | null} the dot, when present.
     */
    function findDot(row) {
      for (var i = 0; i < row.children.length; i++) {
        if (row.children[i].hasAttribute(DOT_ATTR)) return row.children[i]
      }
      return null
    }

    /**
     * Inject the dot slot right after the row's folder icon. The dot is a
     * sibling of the row's own children, marked ours; React does not manage it
     * and leaves it in place across re-renders (it is re-created if removed).
     * @param {Element} row - workspace group row.
     * @returns {Element} the injected dot.
     */
    function mountDot(row) {
      var dot = document.createElement('span')
      dot.setAttribute(DOT_ATTR, 'idle')
      dot.setAttribute('aria-hidden', 'true')
      var folder = row.firstElementChild
      while (folder !== null && folder.hasAttribute(DOT_ATTR)) folder = folder.nextElementSibling
      var anchor = folder === null ? null : folder.nextSibling
      row.insertBefore(dot, anchor)
      return dot
    }

    /**
     * Remove dots whose row no longer is a workspace row (React reuses nodes
     * when the list is reordered or the grouping mode changes).
     */
    function sweepStaleDots() {
      var root = scopeRoot()
      if (root === null) return
      var dots = root.querySelectorAll('[' + DOT_ATTR + ']')
      for (var i = 0; i < dots.length; i++) {
        var parent = dots[i].parentElement
        var key = parent === null ? null : parent.getAttribute('data-row-key')
        if (key === null || !key.startsWith(KEY_PREFIX)) dots[i].remove()
      }
    }

    /**
     * Root of the sidebar browsing region, or the document before it mounts.
     * @returns {ParentNode} the scoped search root.
     */
    function scopeRoot() {
      if (typeof document === 'undefined') return null
      return document.querySelector(REGION_SELECTOR) || document
    }

    /**
     * Project the aggregated counts onto the rendered folder rows.
     * @param {Map<string, {waiting: number, done: number, running: number}>} counts - derivation result.
     */
    function applyCounts(counts) {
      var root = scopeRoot()
      if (root === null) return
      var rows = root.querySelectorAll(ROW_SELECTOR)
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i]
        var key = row.getAttribute('data-row-key').slice(KEY_PREFIX.length)
        var kind = displayKind(counts.get(key))
        var dot = findDot(row)
        if (dot === null) dot = mountDot(row)
        if (dot.getAttribute(DOT_ATTR) !== kind) dot.setAttribute(DOT_ATTR, kind)
      }
      sweepStaleDots()
    }

    // ────────────────────────────────── wiring ───────────────────────────────────

    /**
     * Resolve one client service without turning it into an activation gate.
     * @param {object} ctx - cordis client context.
     * @param {string} name - service name.
     * @returns {object | null} the service, when the profile provides it.
     */
    function lookup(ctx, name) {
      if (ctx === null || ctx === undefined) return null
      if (typeof ctx.get === 'function') return ctx.get(name) || null
      if (ctx.reflect && typeof ctx.reflect.get === 'function') return ctx.reflect.get(name) || null
      return null
    }

    /**
     * Read one observable store snapshot.
     * @param {object | null} store - host observable.
     * @returns {unknown} the snapshot, or undefined without the store.
     */
    function readSnapshot(store) {
      if (store === null || store === undefined) return undefined
      if (typeof store.getSnapshot !== 'function') return undefined
      return store.getSnapshot()
    }

    /**
     * Subscribe one observer to every store that can change a folder's state.
     * @param {object} ctx - cordis client context.
     * @param {() => void} onChange - coalesced invalidation.
     * @param {Array<() => void>} disposers - receives every unsubscribe.
     * @returns {object} the resolved services (maybe missing in a reduced profile).
     */
    function watchStores(ctx, onChange, disposers) {
      var servers = {
        sessions: lookup(ctx, 'sessions'),
        workspaces: lookup(ctx, 'workspaces'),
        uiSession: lookup(ctx, 'uiSession'),
      }
      var stores = [
        servers.sessions && servers.sessions.list,
        servers.workspaces && servers.workspaces.list,
        servers.uiSession && servers.uiSession.sessionStatus,
      ]
      for (var i = 0; i < stores.length; i++) {
        var store = stores[i]
        if (store === null || store === undefined || typeof store.subscribe !== 'function') continue
        disposers.push(store.subscribe(onChange))
      }
      return servers
    }

    /**
     * Mount the decorator: one coalesced sync on every store change, every
     * mutation inside the sidebar region, and every region remount.
     * @param {object} ctx - cordis client context.
     * @returns {() => void} disposer (stores, observers, injected DOM).
     */
    function start(ctx) {
      var disposers = []
      var timer = 0
      var alive = true
      var applying = false
      var region = null
      var regionObserver = null
      var documentObserver = null

      /** Coalesce bursts of store/mutation notifications into one sync. */
      function schedule() {
        if (!alive || timer !== 0) return
        timer = setTimeout(function () {
          timer = 0
          sync()
        }, 20)
      }

      /** Ignore our own attribute/child writes so the observer cannot loop. */
      function guarded(fn) {
        applying = true
        try {
          return fn()
        } finally {
          applying = false
        }
      }

      /** Recompute and project. */
      function sync() {
        if (!alive) return
        var servers = services
        var workspaces = readSnapshot(servers.workspaces && servers.workspaces.list)
        var sessions = readSnapshot(servers.sessions && servers.sessions.list)
        var statuses = readSnapshot(servers.uiSession && servers.uiSession.sessionStatus)
        if (workspaces === undefined || sessions === undefined || statuses === undefined) return
        guarded(function () {
          ensureStyle()
          applyCounts(
            deriveWorkspaceStatus({
              workspaces: workspaces.items || [],
              sessions: sessions,
              statuses: statuses,
              archivedSessionIds: workspaces.archivedSessionIds || [],
            }),
          )
        })
      }

      function onMutations() {
        if (applying || !alive) return
        schedule()
      }

      /** Observe the browsing region itself, falling back to the document before it mounts. */
      function bindRegion() {
        var next = document.querySelector(REGION_SELECTOR)
        if (next === region && regionObserver !== null) return
        if (regionObserver !== null) regionObserver.disconnect()
        region = next
        regionObserver = null
        if (region === null) return
        regionObserver = new MutationObserver(onMutations)
        regionObserver.observe(region, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-row-key'],
        })
        // The region appeared after the boot sync: the rows inside it are
        // already rendered, so nothing else would invalidate them.
        schedule()
      }

      /** The browsing region is created/destroyed with sidebar width; rebind and resync. */
      function bindDocument() {
        if (typeof MutationObserver !== 'function' || document.body === null) return
        documentObserver = new MutationObserver(function () {
          if (region !== null && region.isConnected) return
          bindRegion()
          schedule()
        })
        documentObserver.observe(document.body, { childList: true, subtree: true })
      }

      function warnOnce(message) {
        if (warned) return
        warned = true
        try {
          console.warn('[dsh-workspace-tree-status] ' + message)
        } catch (error) {
          /* a missing console must not break the plugin */
        }
      }

      ensureStyle()
      var services = watchStores(ctx, schedule, disposers)
      var warned = false
      if (!services.sessions || !services.sessions.list) warnOnce('session list service unavailable; folder dots stay off')
      if (!services.workspaces || !services.workspaces.list) warnOnce('workspace list service unavailable; folder dots stay off')
      if (!services.uiSession || !services.uiSession.sessionStatus) {
        warnOnce('session status service unavailable; only the running fallback is shown')
      }
      bindRegion()
      bindDocument()
      schedule()

      return function dispose() {
        alive = false
        if (timer !== 0) {
          clearTimeout(timer)
          timer = 0
        }
        for (var i = 0; i < disposers.length; i++) {
          try {
            disposers[i]()
          } catch (error) {
            /* a broken subscriber must not block teardown */
          }
        }
        if (regionObserver !== null) regionObserver.disconnect()
        if (documentObserver !== null) documentObserver.disconnect()
        var style = document.querySelector('style[data-plugin-css="' + STYLE_MARK + '"]')
        if (style !== null) style.remove()
        var dots = document.querySelectorAll('[' + DOT_ATTR + ']')
        for (var j = 0; j < dots.length; j++) dots[j].remove()
      }
    }

    /**
     * Mount the plugin.
     * @param {object} ctx - browser cordis context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return start(ctx)
      }, 'dsh-workspace-tree-status: workspace folder dots')
    }

    /**
     * Required client services (cordis fiber inject): the plugin must not apply
     * before the session/workspace stores are active, or the first lookup
     * resolves to nothing and the dots never mount. `dsh.client.inject` in
     * package.json only orders module loading; this is the activation gate.
     */
    exports.inject = ['sessions', 'workspaces', 'uiSession']
    exports.apply = apply
    // Exposed for the package's node --test suite; not part of the public face.
    exports.__internals = {
      normalizePath: normalizePath,
      nearestParentPath: nearestParentPath,
      parentWorkspaceIds: parentWorkspaceIds,
      sessionAttention: sessionAttention,
      deriveWorkspaceStatus: deriveWorkspaceStatus,
      displayKind: displayKind,
    }
    return module.exports
  },
})
