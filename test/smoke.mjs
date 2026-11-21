// Headless smoke test for the annotate client half.
//
// Mounts the module with a tiny hooks runtime and a tiny fake DOM so the real
// component code runs without a browser. Three scenarios:
//   A. sidebar browser (<webview>) — frozen bitmap, crops from the screenshot
//   B. plain-text document preview — live overlay, line-range locators
//   C. PDF preview — live overlay, page locators, crops from the page canvas
//
// Run: node .tools\smoke-v2.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- fake React
function createRuntime() {
  const instances = new Map()
  const pending = new Set()
  let current = null
  let stageRect = { left: 0, top: 0, width: 1280, height: 860 }

  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const Fragment = Symbol('Fragment')

  function hookSlot() {
    const instance = current
    const index = instance.cursor++
    return { instance, index }
  }

  function bump(instance) { pending.add(instance) }

  function ensure(instance, index, init) {
    if (!(index in instance.hooks)) instance.hooks[index] = { value: typeof init === 'function' ? init() : init, deps: undefined }
    return instance.hooks[index]
  }

  const React = {
    createElement,
    Fragment,
    useState(init) {
      const { instance, index } = hookSlot()
      const slot = ensure(instance, index, init)
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        bump(instance)
      }]
    },
    useRef(init) {
      const { instance, index } = hookSlot()
      return ensure(instance, index, () => ({ current: init })).value
    },
    useMemo(factory, deps) {
      const { instance, index } = hookSlot()
      const slot = ensure(instance, index, factory)
      if (slot.deps !== undefined && Array.isArray(deps) && slot.deps.length === deps.length && slot.deps.every((value, at) => Object.is(value, deps[at]))) return slot.value
      slot.value = factory()
      slot.deps = deps
      return slot.value
    },
    useCallback(fn, deps) {
      const { instance, index } = hookSlot()
      const slot = ensure(instance, index, () => fn)
      if (slot.deps === undefined || !Array.isArray(deps) || slot.deps.length !== deps.length || slot.deps.some((value, at) => !Object.is(value, deps[at]))) {
        slot.value = fn
        slot.deps = deps
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const { instance, index } = hookSlot()
      const slot = ensure(instance, index, () => ({ deps: undefined, cleanup: undefined, run: fn }))
      slot.run = fn
      if (slot.deps === undefined || !Array.isArray(deps) || slot.deps.length !== deps.length || slot.deps.some((value, at) => !Object.is(value, deps[at]))) {
        slot.pendingRun = true
        slot.deps = deps
      }
    },
  }

  const reactDom = {
    createPortal: (element, host) => ({ type: 'portal', element, host }),
  }

  function makeNode() {
    return {
      style: {},
      getBoundingClientRect: () => ({ ...stageRect, right: stageRect.left + stageRect.width, bottom: stageRect.top + stageRect.height }),
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      setPointerCapture() {},
    }
  }

  function renderNode(element) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map(renderNode)
    if (element.type === 'portal') return { ...element, element: renderNode(element.element) }
    if (typeof element.type === 'function') {
      const key = element.type
      let instance = instances.get(key)
      if (!instance) {
        instance = { key, hooks: [], cursor: 0, props: {}, output: null, mounted: false }
        instances.set(key, instance)
      }
      instance.props = element.props
      instance.cursor = 0
      current = instance
      const output = element.type({ ...instance.props })
      current = null
      instance.output = output
      instance.mounted = true
      runEffects(instance)
      return renderNode(output)
    }
    const props = { ...element.props }
    if (props.ref) {
      const node = makeNode(element)
      if (typeof props.ref === 'function') props.ref(node)
      else if (typeof props.ref === 'object') props.ref.current = node
    }
    return {
      type: element.type,
      props,
      children: element.children.map(renderNode).flat(Infinity).filter((child) => child !== null),
    }
  }

  /** Effects run after the render, like React does after commit. */
  function runEffects(instance) {
    for (const slot of instance.hooks ?? []) {
      if (!slot || !slot.pendingRun) continue
      slot.pendingRun = false
      if (slot.cleanup) {
        try { slot.cleanup() } catch { /* an effect cleanup may throw in a stub */ }
        slot.cleanup = undefined
      }
      const result = slot.run()
      if (typeof result === 'function') slot.cleanup = result
    }
  }

  async function flush(rounds = 30) {
    for (let round = 0; round < rounds; round += 1) {
      if (pending.size === 0) return
      const batch = [...pending]
      pending.clear()
      for (const instance of batch) {
        instance.cursor = 0
        current = instance
        instance.output = instance.key({ ...instance.props })
        current = null
        instance.output = renderNode(instance.output)
        runEffects(instance)
      }
    }
  }

  return {
    React,
    reactDom,
    renderNode,
    flush,
    instances,
    setStageRect(rect) { stageRect = rect },
  }
}

// --------------------------------------------------------------------- fake DOM
function matchesSimple(node, selector) {
  const match = /^([a-zA-Z][\w-]*)?(\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector.trim())
  if (!match) return false
  const [, tag, , attr, value] = match
  if (!tag && !attr) return false
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false
  if (attr && node.getAttribute(attr) === null) return false
  if (attr && value !== undefined && node.getAttribute(attr) !== value) return false
  return true
}

function contains(rect, x, y) {
  return Boolean(rect) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

class FakeNode {
  constructor(tagName, attrs = {}, rect = null, children = [], text = '') {
    this.tagName = tagName.toUpperCase()
    this.attrs = attrs
    this.rect = rect
    this.children = []
    this.parentElement = null
    this.text = text
    this.style = {}
    this.scrollTop = 0
    this.scrollLeft = 0
    this.width = 0
    this.height = 0
    this.classList = []
    this.listeners = {}
    for (const child of children) this.append(child)
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return this
  }

  appendChild(child) {
    return this.append(child)
  }

  insertBefore(child, reference) {
    child.parentElement = this
    const at = reference ? this.children.indexOf(reference) : -1
    if (at < 0) this.children.push(child)
    else this.children.splice(at, 0, child)
    return child
  }

  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentElement = null
    return child
  }

  get nextSibling() {
    const parent = this.parentElement
    if (!parent) return null
    const at = parent.children.indexOf(this)
    return at >= 0 ? parent.children[at + 1] ?? null : null
  }

  get textContent() {
    if (this.children.length === 0) return this.text
    return `${this.text}${this.children.map((child) => child.textContent).join('')}`
  }

  getBoundingClientRect() {
    return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  matches(selector) {
    return String(selector).split(',').some((part) => this.matchesChain(part.trim()))
  }

  /** Descendant combinators only — enough for the selectors the plugin uses. */
  matchesChain(selector) {
    const tokens = selector.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return false
    if (!matchesSimple(this, tokens[tokens.length - 1])) return false
    let index = tokens.length - 2
    let node = this.parentElement
    while (index >= 0 && node) {
      if (matchesSimple(node, tokens[index])) index -= 1
      node = node.parentElement
    }
    return index < 0
  }

  closest(selector) {
    if (String(selector).startsWith('.')) return null
    let node = this
    while (node) {
      if (node.matches && node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }

  /** `Node.contains` — selections are checked against the preview body. */
  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentElement
    }
    return false
  }

  querySelectorAll(selector) {
    const found = []
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  addEventListener(type, handler) {
    this.listeners[type] = this.listeners[type] ?? []
    this.listeners[type].push(handler)
  }

  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== handler)
  }

  fire(type, event) {
    for (const handler of this.listeners[type] ?? []) handler(event ?? {})
  }
}

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function fakeDocument(roots, canvasLog) {
  // Queries walk the tree on every call, like a real document: the plugin keeps
  // looking for its pane while a session is open, and a cached list would make
  // a pane that went away look like it was still there.
  const collect = () => {
    const all = []
    const visit = (node) => {
      all.push(node)
      for (const child of node.children) visit(child)
    }
    for (const root of roots) visit(root)
    return all
  }
  const doc = {
    body: new FakeNode('body'),
    documentElement: new FakeNode('html'),
    listeners: {},
    // The plugin listens on the document in the capture phase; the stub keeps
    // the handlers so a scenario can fire a right click through the same path.
    addEventListener(type, handler) {
      doc.listeners[type] = doc.listeners[type] ?? []
      doc.listeners[type].push(handler)
    },
    removeEventListener(type, handler) {
      doc.listeners[type] = (doc.listeners[type] ?? []).filter((entry) => entry !== handler)
    },
    fire(type, event) {
      for (const handler of doc.listeners[type] ?? []) handler(event)
    },
    querySelectorAll(selector) {
      return collect().filter((node) => node.matches(selector))
    },
    querySelector(selector) {
      return doc.querySelectorAll(selector)[0] ?? null
    },
    elementsFromPoint(x, y) {
      return collect().filter((node) => contains(node.rect, x, y)).reverse()
    },
    createElement(tag) {
      if (tag !== 'canvas') return new FakeNode(tag)
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (callback) => {
          canvasLog.push(canvas)
          callback({ size: 128, type: 'image/png' })
        },
      }
      return canvas
    },
  }
  return doc
}

// --------------------------------------------------------------- module load
function loadModule(runtime) {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    listeners: [],
    addEventListener(type, handler) { this.listeners.push({ type, handler }) },
    removeEventListener() {},
  }
  globalThis.document = { body: { tag: 'body' }, documentElement: { getAttribute: () => 'zh-CN' } }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true })
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', source)(globalThis.window, globalThis)
  assert.ok(captured, 'client.js did not register with __ModuleLoader__')
  assert.equal(captured.id, '@wuwen1994/dsh-annotate')
  const require = (name) => {
    if (name === 'react') return runtime.React
    if (name === 'react-dom') return runtime.reactDom
    throw new Error(`unexpected require: ${name}`)
  }
  return captured.factory(require)
}

// ------------------------------------------------------------- find helpers
function walk(node, visit) {
  if (!node || typeof node === 'string') return
  visit(node)
  if (node.element) walk(node.element, visit)
  for (const child of node.children ?? []) walk(child, visit)
}

function find(node, predicate) {
  let hit = null
  walk(node, (candidate) => {
    if (!hit && candidate.type && predicate(candidate)) hit = candidate
  })
  return hit
}

function findAll(node, predicate) {
  const hits = []
  walk(node, (candidate) => {
    if (candidate.type && predicate(candidate)) hits.push(candidate)
  })
  return hits
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.children) return node.children.map(textOf).join('')
  if (node.element) return textOf(node.element)
  return ''
}

// ------------------------------------------------------------- test plumbing
const checks = []
const check = (label, fn) => { fn(); checks.push(label) }

class FakeImage {
  set src(value) {
    this.value = value
    setTimeout(() => this.onload && this.onload(), 0)
  }
}

function makeComposer() {
  const log = { drafted: [], attachments: [], inits: [], released: [], setDrafts: [], removed: [], freed: [], draft: '', phase: 'plain' }
  const conversation = {
    createDrafts(sessionId, files) {
      log.drafted.push({ sessionId, files })
      return files.map((file, index) => ({ id: `draft-${log.drafted.length - 1}-${index}`, file }))
    },
    releaseDraftAttachments(list) { log.released.push(list) },
    releaseDraftAttachment(id) { log.freed.push(id) },
    input: {
      for: () => ({
        state: { getSnapshot: () => ({ draft: log.draft, phase: log.phase }) },
        setDraft(text) { log.setDrafts.push(text); log.draft = text },
        addAttachments(ids) { log.attachments.push(ids); return true },
        removeAttachment(id) { log.removed.push(id); return true },
        focus() {},
      }),
      requestDraftInitialization(binding, options) {
        log.inits.push(options)
        log.draft = log.draft ? `${log.draft}\n${options.prompt}` : options.prompt
        return 'applied'
      },
    },
  }
  const binding = {
    sessionId: 's1',
    ctx: { get: (name) => (name === 'conversation' ? conversation : undefined) },
    session: { getSnapshot: () => ({ subagent: null }) },
  }
  const sessions = { binding: (id) => (id === 's1' || id === 's2' ? binding : undefined) }
  // The real service opens a shared popup in the shell; here it only has to
  // remember what was asked for, so a scenario can resolve and run the rows.
  const contextMenus = {
    registered: [],
    opened: [],
    register(input) { contextMenus.registered.push(input); return () => {} },
    open(target, point) { contextMenus.opened.push({ target, point }) },
  }
  const effects = []
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : name === 'conversation' ? conversation : undefined),
    // Cordis runs the callback at once and keeps its disposer; so does this.
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    contextMenus,
    slots: {
      registry: {},
      inject(name, callback) { callback() },
      register(options, component) { this.registry[options.name] = { options, component }; return () => {} },
    },
  }
  // Two conversations are known; only the one named by `current` is in the
  // sidebar, which is exactly how the host reports a switch.
  let current = 's1'
  const roster = () => ({
    byId: {
      s1: { id: 's1', retainedBy: { mainView: 1 } },
      s2: { id: 's2', retainedBy: { mainView: 1 } },
    },
    ids: [current],
  })
  const useSessions = (selector) => selector(roster())
  useSessions.switchTo = (id) => { current = id }
  return { ctx, useSessions, log, contextMenus }
}

async function mountScenario({ runtime, plugin, ctx, useSessions, stage }) {
  runtime.setStageRect(stage)
  plugin.apply(ctx)
  const overlay = ctx.slots.registry['shell.overlay']
  const mount = () => runtime.renderNode(runtime.React.createElement(overlay.component, { useSessions, ctx }))
  let tree = mount()
  await runtime.flush()
  tree = mount()
  return { overlay, mount, get tree() { return tree }, set tree(value) { tree = value } }
}

const settle = async (runtime, mount) => {
  for (let tick = 0; tick < 8; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runtime.flush()
    if (mount) mount()
  }
}

function drag(scene, from, to) {
  const stage = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  return stage.props
}

// =========================================================== scenario A: page
async function scenarioPage() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log } = makeComposer()
  const canvasLog = []

  const webview = new FakeNode('webview', { 'data-sidebar-browser-frame': 'webview' }, rect(260, 100, 1020, 760))
  webview.captured = 0
  webview.capturePage = function capture() {
    this.captured += 1
    return Promise.resolve({ toDataURL: () => 'data:image/png;base64,AAAA', getSize: () => ({ width: 840, height: 600 }) })
  }
  webview.getURL = () => 'http://127.0.0.1:8799/third'
  // The plugin asks the page for a best-effort locator; the element path it
  // returns is for our own eyes and must never reach the prompt.
  webview.executeJavaScript = () => Promise.resolve({
    selector: 'div#app > form > button',
    heading: '提交订单',
    quote: '提交订单',
  })
  // The pane chrome: back / forward / reload buttons, then the address box.
  // The plugin has to slot its icon right after reload. The real host wraps
  // its reload button in a tooltip element and puts the address input in a box,
  // so the fixture does the same — the placeholder must still land in between.
  const toolbar = new FakeNode('form', {})
  toolbar.append(new FakeNode('button', { 'aria-label': 'back' }))
  toolbar.append(new FakeNode('button', { 'aria-label': 'forward' }))
  const reload = new FakeNode('button', { 'aria-label': 'reload' })
  const reloadWrap = new FakeNode('span', { className: 'dwa-fake-tooltip' }, null, [reload])
  toolbar.append(reloadWrap)
  const addressBox = new FakeNode('div', { className: 'dwa-fake-address' })
  addressBox.append(new FakeNode('input', { 'aria-label': 'address' }))
  toolbar.append(addressBox)
  const pane = new FakeNode('div', {}, rect(260, 60, 1020, 800), [toolbar, webview])
  globalThis.document = fakeDocument([pane], canvasLog)
  globalThis.Image = FakeImage

  // Timers stay quiet: the polls are driven by hand below, which is also how
  // the pane poll gets exercised without waiting four hundred milliseconds.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const polls = []
  globalThis.setInterval = (callback) => { polls.push(callback); return polls.length }
  globalThis.clearInterval = () => {}

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })

  const trigger = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
  check('page: the icon sits in the pane toolbar, right after reload', () => {
    assert.ok(trigger, 'no annotate icon')
    assert.equal(trigger.props.title, '标注页面')
    const slot = toolbar.children[toolbar.children.indexOf(reloadWrap) + 1]
    assert.ok(slot && slot.tagName === 'SPAN', 'the placeholder did not land after the reload button')
    assert.equal(slot.children.length, 0, 'the placeholder must stay empty in the DOM')
  })

  check('page: only the overlay is registered', () => {
    assert.deepEqual(Object.keys(ctx.slots.registry), ['shell.overlay'])
    assert.equal(ctx.slots.registry['shell.overlay'].options.id, 'annotate.page')
  })

  trigger.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: capture freezes the page', () => {
    assert.equal(webview.captured, 1, 'capturePage was not called')
    assert.equal(webview.style.visibility, 'hidden', 'the page was not frozen')
    const freeze = find(scene.tree, (node) => node.props?.className === 'dwa-freeze')
    assert.equal(freeze.props['data-mode'], 'frozen')
    assert.equal(freeze.props.style.width, '1020px')
    const image = find(scene.tree, (node) => node.type === 'img')
    assert.ok(image, 'no frozen screenshot')
  })

  check('page: no editor before a region is picked', () => {
    assert.ok(!find(scene.tree, (node) => node.type === 'textarea'), 'the note box covers the page too early')
    assert.ok(!find(scene.tree, (node) => node.props?.className === 'dwa-sheet'), 'the sheet covers the page too early')
    assert.ok(!find(scene.tree, (node) => node.props?.className === 'dwa-tip'), 'the tip line came back')
  })

  const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 320, clientY: 160, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 420, clientY: 250 })
  stageNode.props.onPointerUp({ clientX: 420, clientY: 250 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: box drawn on the frozen bitmap', () => {
    const box = find(scene.tree, (node) => node.props?.className === 'dwa-sb-box')
    assert.ok(box, 'no box drawn')
    assert.equal(box.props.style.width, `${(100 / 1020) * 100}%`)
    assert.equal(textOf(find(scene.tree, (node) => node.props?.className === 'dwa-sb-n')), '1', 'the region lost its number')
    // Numbers live on the region only: the card itself is unnumbered.
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-chip'), null, 'a numbered chip came back')
  })

  check('page: the editor appears only after the first region', () => {
    const sheet = find(scene.tree, (node) => node.props?.className === 'dwa-sheet')
    assert.ok(sheet, 'no editor once a region exists')
    // It hugs the region: 12px to the right of it, level with its top.
    const left = Number.parseFloat(sheet.props.style.left)
    const top = Number.parseFloat(sheet.props.style.top)
    const width = Number.parseFloat(sheet.props.style.width)
    assert.ok(left >= 420 && left <= 460, `editor is not next to the region: ${left}`)
    assert.ok(Math.abs(top - 160) <= 24, `editor is not level with the region: ${top}`)
    assert.ok(left + width <= 1280, 'editor runs off the window')
    assert.ok(find(scene.tree, (node) => node.type === 'textarea'), 'no note box')
  })

  // A second region near the right edge must flip the editor to its left.
  stageNode.props.onPointerDown({ button: 0, pointerId: 2, clientX: 1150, clientY: 300, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 1250, clientY: 380 })
  stageNode.props.onPointerUp({ clientX: 1250, clientY: 380 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: the editor flips to the left when the right edge is full', () => {
    const sheet = find(scene.tree, (node) => node.props?.className === 'dwa-sheet')
    const left = Number.parseFloat(sheet.props.style.left)
    const width = Number.parseFloat(sheet.props.style.width)
    assert.ok(left + width <= 1140, `editor should sit left of the region: ${left}`)
    assert.ok(left >= 0, 'editor runs off the window')
  })

  // Clicking the first region brings the editor back next to it.
  find(scene.tree, (node) => node.props?.className === 'dwa-sb-box').props.onClick({ stopPropagation() {} })
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: the editor follows the selected region', () => {
    const sheet = find(scene.tree, (node) => node.props?.className === 'dwa-sheet')
    const left = Number.parseFloat(sheet.props.style.left)
    assert.ok(left >= 420 && left <= 460, `editor did not follow the selection: ${left}`)
    const box = find(scene.tree, (node) => node.props?.className === 'dwa-sb-box')
    assert.equal(box.props['data-selected'], '1')
  })

  check('page: the card keeps only a close button', () => {
    assert.ok(!find(scene.tree, (node) => node.props?.className === 'dwa-sheet-hint'), 'the hint line came back')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-sheet-bar'), 'no card bar')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-x'), 'no close button')
    // The locator is recorded for the prompt, never shown in the card.
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-anchor'), null, 'the locator strip came back')
    // Numbers live on the regions; the card carries none of them.
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-chip'), null, 'a numbered chip came back')
    const badges = findAll(scene.tree, (node) => node.props?.className === 'dwa-sb-del')
    assert.equal(badges.length, 0, 'the region still paints a close badge')
    const insertButtons = findAll(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-btn')
    assert.equal(insertButtons.length, 1, 'the bulk insert button is missing while two regions wait')
    assert.match(textOf(insertButtons[0]), /全部插入/, 'the bulk button does not say what it does')
    assert.ok(!source.includes('brightness('), 'the primary button still has a hover filter')
  })

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这个按钮在右键菜单里点不到' } })
  await runtime.flush()
  scene.tree = scene.mount()

  // Enter in the note box inserts the selected region — there is no button to
  // click, and the session stays open for the next one. The press is delivered
  // twice on purpose: holding the key down repeats it, and both events reach
  // the handler before React can re-render the (now read-only) box.
  const enter = { key: 'Enter', shiftKey: false, preventDefault() {} }
  const noteBox = find(scene.tree, (node) => node.type === 'textarea')
  noteBox.props.onKeyDown(enter)
  noteBox.props.onKeyDown(enter)
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: a held Enter inserts the region once', () => {
    assert.equal(log.drafted.length, 1, 'the same region was pushed twice')
    assert.equal(log.inits.length, 1, 'the prompt line was appended twice')
    assert.equal(findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble').length, 1, 'two beads for one region')
  })

  check('page: the selected region is cropped into the composer', () => {
    assert.ok(canvasLog.length >= 1, 'the crop canvas was never built')
    assert.equal(canvasLog[0].width, 96, 'crop width ignores the capture scale')
    assert.equal(canvasLog[0].height, 87, 'crop height ignores the capture scale')
    assert.equal(log.drafted.length, 1, 'createDrafts was not called')
    const files = log.drafted[0].files
    assert.equal(files.length, 1, 'only the region that was inserted should be cropped')
    assert.match(files[0].name, /^page-1-.*\.jpg$/)
    assert.equal(log.inits.length, 1)
    assert.equal(log.inits[0].whenDraftExists, 'append')
    // One line, no header and no trailer around it.
    assert.match(log.inits[0].prompt, /^1\. /, `the line lost its number: ${log.inits[0].prompt}`)
    assert.ok(!log.inits[0].prompt.includes('我在页面'), 'the header came back')
    assert.ok(!log.inits[0].prompt.includes('定位以引号里的文字为准'), 'the trailer came back')
    assert.match(log.inits[0].prompt, /这个按钮在右键菜单里点不到/)
    assert.match(log.inits[0].prompt, /提交订单/, 'the heading anchor went missing')
    assert.ok(!log.inits[0].prompt.includes('div#app'), 'the element path leaked into the prompt')
    assert.ok(!log.inits[0].prompt.includes('> 区域'), 'the element path leaked into the prompt')
    // The position word comes from the dictionary; a wrong key used to leak the
    // raw id ("posLc") straight into the prompt.
    assert.ok(!/pos[A-Za-z]/.test(log.inits[0].prompt), `a raw position key leaked: ${log.inits[0].prompt}`)
    assert.match(
      log.inits[0].prompt,
      /左上|上方居中|右上|左侧居中|页面中部|右侧居中|左下|下方居中|右下/,
      `no position word in the line: ${log.inits[0].prompt}`,
    )
    assert.deepEqual(log.attachments, [['draft-0-0']])
    assert.equal(log.released.length, 0)
  })

  check('page: a bead marks what went in, and marking goes on', () => {
    assert.equal(webview.style.visibility, 'hidden', 'the overlay closed after inserting')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-freeze'), 'the overlay closed after inserting')
    const bead = find(scene.tree, (node) => node.props?.className === 'dwa-bubble')
    assert.ok(bead, 'no bead for the inserted region')
    assert.equal(textOf(bead), '1', 'the bead lost its number')
    // The editor steps aside so the next region can be drawn right away.
    assert.equal(find(scene.tree, (node) => node.type === 'textarea'), null, 'the card stayed over the picture')
    // The inserted region left the picture; the other one is still waiting for
    // its own note.
    const numbers = findAll(scene.tree, (node) => node.props?.className === 'dwa-sb-n').map(textOf)
    assert.deepEqual(numbers, ['2'], `the inserted region kept its box: ${numbers.join(',')}`)
  })

  // The next region keeps climbing instead of starting over at 1.
  stageNode.props.onPointerDown({ button: 0, pointerId: 3, clientX: 700, clientY: 400, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 780, clientY: 470 })
  stageNode.props.onPointerUp({ clientX: 780, clientY: 470 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: numbering keeps climbing after an insert', () => {
    const numbers = findAll(scene.tree, (node) => node.props?.className === 'dwa-sb-n').map(textOf)
    assert.equal(numbers[numbers.length - 1], '3', `the new region should be 3, got ${numbers.join(',')}`)
  })

  // Tapping the bead reopens the note it came with.
  find(scene.tree, (node) => node.props?.className === 'dwa-bubble').props.onClick({ preventDefault() {}, stopPropagation() {} })
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: a bead reopens its note for a second edit', () => {
    const editor = find(scene.tree, (node) => node.type === 'textarea')
    assert.ok(editor, 'the bead did not reopen the editor')
    assert.equal(editor.props.value, '这个按钮在右键菜单里点不到')
  })

  find(scene.tree, (node) => node.type === 'textarea').props.onChange({ target: { value: '这个按钮在右键菜单里点不到，改成 hover 反而能看到' } })
  await runtime.flush()
  scene.tree = scene.mount()

  // The pruner runs on a timer. Grab the interval callbacks instead of waiting
  // for real seconds: rewriting the note re-registers the effect, so the swap
  // has to happen before the edit that hands us a pruner bound to this bead.
  const realSetInterval2 = globalThis.setInterval
  const realClearInterval2 = globalThis.clearInterval
  let pruners = []
  globalThis.setInterval = (callback) => { pruners.push(callback); return pruners.length }
  globalThis.clearInterval = () => {}

  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: the second edit rewrites the drafted line', () => {
    assert.equal(log.setDrafts.length, 1, 'the draft was not rewritten')
    assert.match(log.setDrafts[0], /改成 hover 反而能看到/)
    assert.ok(!log.setDrafts[0].includes('这个按钮在右键菜单里点不到 ·'), 'the old line survived')
    assert.ok(log.draft.includes('改成 hover 反而能看到'), 'the fake draft never received the edit')
  })

  check('page: the card closes but the beads stay', () => {
    // Enter closed the editor; reopening from the bead closes again with ✕.
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-sheet'), null, 'the editor stayed open after a second edit')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-bubble'), 'the beads disappeared after an edit')
  })

  // Sending is the only thing that retires the beads. The pruners were grabbed
  // above; run them all, newest last, once the composer reports it is sending.
  try {
    assert.ok(pruners.length > 0, 'no pruner was registered')
    log.phase = 'sending'
    for (const pruner of [...pruners].reverse()) pruner()
    await runtime.flush()
    scene.tree = scene.mount()

    check('page: sending the prompt turns the beads into records', () => {
      const beads = findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble')
      assert.equal(beads.length, 1, 'the bead vanished with the send')
      assert.equal(beads[0].props['data-ghost'], '1', 'the sent bead is not marked as sent')
    })

    check('page: the regions still open keep their numbers', () => {
      assert.deepEqual(
        findAll(scene.tree, (node) => node.props?.className === 'dwa-sb-n').map(textOf),
        ['2', '3'],
        'the live regions were renumbered after a send',
      )
    })
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }

  log.phase = 'plain'

  // The bead from the send is still there, as a record: it opens without an
  // editor, and closing it drops the record without touching the composer.
  find(scene.tree, (node) => node.props?.className === 'dwa-bubble').props.onClick({ preventDefault() {}, stopPropagation() {} })
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: a sent bead reopens as a record, not an editor', () => {
    assert.equal(find(scene.tree, (node) => node.type === 'textarea'), null, 'a sent bead offered a text box')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-actions'), 'the record has no actions')
  })

  find(scene.tree, (node) => node.props?.className === 'dwa-x').props.onClick()
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: closing a sent bead only closes its card', () => {
    const beads = findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble')
    assert.equal(beads.length, 1, 'closing the record dropped the note')
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-actions'), null, 'the record card stayed open')
    assert.equal(log.setDrafts.length, 1, 'a record edit rewrote the draft')
  })

  // An open region is still numbered after the ones already sent.
  find(scene.tree, (node) => node.props?.className === 'dwa-sb-box').props.onClick({ preventDefault() {}, stopPropagation() {} })
  await runtime.flush()
  scene.tree = scene.mount()
  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()
  const freshLine = log.inits[log.inits.length - 1].prompt

  check('page: numbering does not restart after a send', () => {
    const bubbles = findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble')
    assert.ok(bubbles.length >= 2, 'no bead was created')
    assert.equal(bubbles[bubbles.length - 1].children[0], '2', 'the bead reused a number that had already gone out')
  })

  const lastBubble = () => {
    const all = findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble')
    return all[all.length - 1]
  }
  lastBubble().props.onClick({ preventDefault() {}, stopPropagation() {} })
  await runtime.flush()
  scene.tree = scene.mount()
  find(scene.tree, (node) => node.props?.className === 'dwa-x').props.onClick()
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: closing the bead deletes it and its line', () => {
    const left = findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble')
    assert.equal(left.length, 1, 'the live bead or the sent record went with the close')
    assert.equal(left[0].props['data-ghost'], '1', 'the bead that stayed is not the sent record')
    const written = log.setDrafts[log.setDrafts.length - 1]
    assert.ok(typeof written === 'string', 'the draft was never rewritten')
    assert.ok(!written.includes(freshLine), 'the line stayed in the prompt')
  })

  check('page: closing the bead takes its picture with it', () => {
    const attached = log.attachments[log.attachments.length - 1]
    assert.ok(Array.isArray(attached) && attached.length === 1, 'the bead never attached a crop')
    assert.deepEqual(log.removed, attached, 'the crop is still in the composer')
    assert.deepEqual(log.freed, attached, 'the draft attachment was never released')
  })

  // A right click dismisses the whole annotation session; nothing stays marked.
  find(scene.tree, (node) => node.props?.className === 'dwa-freeze').props.onContextMenu({
    preventDefault() {},
    stopPropagation() {},
  })
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: a right click leaves the marking mode', () => {
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-freeze'), null, 'the overlay stayed open')
    assert.equal(webview.style.visibility, '', 'the page stayed frozen after a right click')
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-sheet'), null, 'the card survived the right click')
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-sb-box'), null, 'the regions survived the right click')
  })

  // Cancelling a session does not hand numbers back out: the sent record keeps
  // its number for good, and the next region carries on after it.
  find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool').props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()
  const freshStage = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  freshStage.props.onPointerDown({ button: 0, pointerId: 9, clientX: 320, clientY: 160, currentTarget: { setPointerCapture() {} } })
  freshStage.props.onPointerMove({ clientX: 420, clientY: 250 })
  freshStage.props.onPointerUp({ clientX: 420, clientY: 250 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: a new session numbers after the sent record', () => {
    assert.deepEqual(
      findAll(scene.tree, (node) => node.props?.className === 'dwa-sb-n').map(textOf),
      ['2'],
      'the number went back to one and collided with a line that was already sent',
    )
  })

  // The sidebar swapped to another tab, so the pane is gone. Without the poll
  // the frozen bitmap would keep floating over nothing and the <webview> would
  // stay hidden for good.
  pane.removeChild(webview)
  for (const poll of polls) poll()
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: the session ends with the pane that hosted it', () => {
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-freeze'), null, 'the overlay outlived its pane')
    assert.equal(webview.style.visibility, '', 'the page stayed hidden after the pane went away')
  })

  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval


  check('page: no leftovers in the source', () => {
    for (const marker of ['dwa-entry', 'dwa-panel', 'dwa-backdrop', 'conversation.composer.dock', 'annotate/api', 'web-annotate']) {
      assert.ok(!source.includes(marker), `client.js still mentions ${marker}`)
    }
  })
}

// ===================================================== scenario B: text file
async function scenarioText() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log } = makeComposer()
  const canvasLog = []

  const lines = []
  for (let number = 138; number <= 143; number += 1) {
    lines.push(new FakeNode('div', { 'data-textpreview-line': String(number) }, rect(280, 300 + (number - 138) * 20, 600, 18), [], `第 ${number} 行：缓存失效以后，页面还在用旧样式。`))
  }
  const scrollport = new FakeNode('div', { 'data-textpreview-body': '' }, rect(260, 100, 1020, 760), lines)
  const root = new FakeNode('div', {
    'data-document-preview': 'text',
    'data-textpreview-url': 'file:///notes/a.txt',
  }, rect(260, 100, 1020, 760), [
    new FakeNode('div', { 'data-textpreview-path': '' }, rect(260, 100, 1020, 24), [], 'notes/a.txt'),
    scrollport,
  ])
  globalThis.document = fakeDocument([root], canvasLog)
  globalThis.Image = FakeImage

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })

  const trigger = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
  check('text: the icon knows it is a document', () => {
    assert.ok(trigger, 'no annotate icon')
    assert.equal(trigger.props.title, '标注文档')
  })

  trigger.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('text: live overlay, no bitmap', () => {
    const freeze = find(scene.tree, (node) => node.props?.className === 'dwa-freeze')
    assert.equal(freeze.props['data-mode'], 'live')
    assert.equal(find(scene.tree, (node) => node.type === 'img'), null, 'a bitmap was painted over a document')
  })

  const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 300, clientY: 320, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 520, clientY: 342 })
  stageNode.props.onPointerUp({ clientX: 520, clientY: 342 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('text: the locator stays out of the card', () => {
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-anchor'), null, 'the locator strip came back')
    assert.ok(find(scene.tree, (node) => node.type === 'textarea'), 'no note box')
  })

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这句说的缓存问题要写清楚\n什么时候失效' } })
  await runtime.flush()
  scene.tree = scene.mount()

  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('text: prompt carries path, lines and quoted text, no image', () => {
    assert.equal(log.drafted.length, 1)
    assert.equal(log.drafted[0].files.length, 0, 'a text document should not ship a screenshot')
    assert.equal(log.inits.length, 1)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /^1\. notes\/a\.txt · /, `the line lost its file: ${prompt}`)
    assert.match(prompt, /第 \d+–\d+ 行|第 \d+ 行/, `no line range in prompt: ${prompt}`)
    assert.match(prompt, /缓存失效/)
    // A note typed over two lines still goes in as one line: a bead is found and
    // removed by its exact line, so a stray break would orphan it.
    assert.equal(prompt.split('\n').length, 1, `the line broke in two: ${JSON.stringify(prompt)}`)
    assert.match(prompt, /这句说的缓存问题要写清楚 什么时候失效/)
    // No header and no trailer around the line any more.
    assert.ok(!prompt.includes('我在'), 'the header came back')
    assert.ok(!prompt.includes('定位以引号里的文字为准'), 'the trailer came back')
    // A note without a crop never asks the composer to attach anything: an
    // empty call could be answered with "busy" and fail a plain text note.
    assert.deepEqual(log.attachments, [], 'no attachment call expected for a text document')
  })
}

// ========================================================== scenario C: PDF
async function scenarioPdf() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log } = makeComposer()
  const canvasLog = []

  const spans = [
    new FakeNode('span', {}, rect(300, 210, 200, 16), [], '3.2 缓存失效策略'),
    new FakeNode('span', {}, rect(300, 240, 320, 16), [], '旧样式会被浏览器缓存，需要强制刷新。'),
  ]
  const textLayer = new FakeNode('div', { 'data-pdf-text': '' }, rect(290, 200, 700, 60), spans)
  const pageCanvas = new FakeNode('canvas', {}, rect(290, 200, 850, 1100))
  pageCanvas.width = 1700
  pageCanvas.height = 2200
  const surface = new FakeNode('div', { 'data-document-zoom-surface': '' }, rect(290, 200, 850, 1100), [pageCanvas, textLayer])
  const pageNode = new FakeNode('div', { 'data-pdf-page': '2' }, rect(290, 200, 850, 1100), [surface])
  const firstPage = new FakeNode('div', { 'data-pdf-page': '1' }, rect(290, -1000, 850, 1100))
  const thirdPage = new FakeNode('div', { 'data-pdf-page': '3' }, rect(290, 1400, 850, 1100))
  const pdfBody = new FakeNode('div', { 'data-pdf-preview': '' }, rect(260, 100, 1020, 760), [firstPage, pageNode, thirdPage])
  const scrollport = new FakeNode('div', { 'data-document-zoom-scrollport': '' }, rect(260, 100, 1020, 760), [pdfBody])
  const root = new FakeNode('div', {
    'data-document-preview': 'pdf',
    'data-textpreview-url': 'file:///guide.pdf',
  }, rect(260, 100, 1020, 760), [
    new FakeNode('div', { 'data-textpreview-path': '' }, rect(260, 76, 1020, 24), [], 'docs/guide.pdf'),
    new FakeNode('div', { 'data-textpreview-body': '' }, rect(260, 100, 1020, 760), [scrollport]),
  ])
  globalThis.document = fakeDocument([root], canvasLog)
  globalThis.Image = FakeImage

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })

  const trigger = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
  trigger.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 300, clientY: 205, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 700, clientY: 262 })
  stageNode.props.onPointerUp({ clientX: 700, clientY: 262 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('pdf: the locator stays out of the card', () => {
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-anchor'), null, 'the locator strip came back')
    assert.ok(find(scene.tree, (node) => node.type === 'textarea'), 'no note box')
  })

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这一节的标题要改' } })
  await runtime.flush()
  scene.tree = scene.mount()

  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('pdf: crop comes from the page canvas, at device resolution', () => {
    assert.equal(canvasLog.length, 1, 'the page canvas was never cropped')
    assert.equal(canvasLog[0].width, 832, 'crop width ignores the canvas scale')
    assert.equal(log.drafted.length, 1)
    assert.equal(log.drafted[0].files.length, 1, 'expected one crop')
    assert.match(log.drafted[0].files[0].name, /^page-1-.*\.jpg$/)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /^1\. docs\/guide\.pdf · /)
    assert.match(prompt, /第 2\/3 页/)
    assert.match(prompt, /缓存失效策略/)
    assert.match(prompt, /这一节的标题要改/)
  })
}

// ======================================================== scenario D: image
async function scenarioImage() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log } = makeComposer()
  const canvasLog = []

  const image = new FakeNode('img', {}, rect(320, 220, 600, 400))
  image.naturalWidth = 1200
  image.naturalHeight = 800
  const frame = new FakeNode('div', { 'data-image-preview': '' }, rect(320, 220, 600, 400), [image])
  const surface = new FakeNode('div', { 'data-document-zoom-surface': '' }, rect(320, 220, 600, 400), [frame])
  const body = new FakeNode('div', { 'data-textpreview-body': '' }, rect(260, 100, 1020, 760), [surface])
  const root = new FakeNode('div', {
    'data-document-preview': 'image',
    'data-textpreview-url': 'file:///shots/wide.png',
  }, rect(260, 100, 1020, 760), [
    new FakeNode('div', { 'data-textpreview-path': '' }, rect(260, 76, 1020, 24), [], 'assets/wide.png'),
    body,
  ])
  globalThis.document = fakeDocument([root], canvasLog)
  globalThis.Image = FakeImage

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })

  const trigger = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
  trigger.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 420, clientY: 320, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 620, clientY: 420 })
  stageNode.props.onPointerUp({ clientX: 620, clientY: 420 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这张图的右侧留白太多' } })
  await runtime.flush()
  scene.tree = scene.mount()

  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)

  check('image: crop comes from the rendered image at natural scale', () => {
    assert.equal(canvasLog.length, 1, 'the image was never cropped')
    assert.equal(canvasLog[0].width, 432, 'crop width ignores the 2x natural scale')
    assert.equal(log.drafted[0].files.length, 1)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /^1\. assets\/wide\.png · /)
    assert.match(prompt, /这张图的右侧留白太多/)
    assert.doesNotMatch(prompt, /这个文件/, 'a bare "this file" label is noise')
  })
}

// ============================================== scenario E: selected text menu
async function scenarioSelection() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log, contextMenus } = makeComposer()
  const canvasLog = []

  const quote = '缓存失效以后，页面还在用旧样式。'
  const line = new FakeNode('div', { 'data-textpreview-line': '140' }, rect(280, 340, 600, 18), [], `第 140 行：${quote}`)
  const scrollport = new FakeNode('div', { 'data-textpreview-body': '' }, rect(260, 100, 1020, 760), [line])
  const root = new FakeNode('div', {
    'data-document-preview': 'markdown',
    'data-textpreview-url': 'file:///notes/a.md',
  }, rect(260, 100, 1020, 760), [
    new FakeNode('div', { 'data-textpreview-path': '' }, rect(260, 100, 1020, 24), [], 'notes/a.md'),
    scrollport,
  ])
  globalThis.document = fakeDocument([root], canvasLog)
  globalThis.Image = FakeImage

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })

  // A browser selection over part of one line: the range's container is the
  // line element, so page/line reading has to come from its box.
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => quote,
    getRangeAt: () => ({
      commonAncestorContainer: line,
      getBoundingClientRect: () => rect(300, 340, 260, 18),
    }),
  }
  globalThis.window.getSelection = () => selection

  const rightClick = (overrides = {}) => {
    let prevented = 0
    let stopped = 0
    const event = {
      button: 2,
      target: line,
      clientX: 420,
      clientY: 350,
      defaultPrevented: false,
      preventDefault() { prevented += 1; this.defaultPrevented = true },
      stopPropagation() { stopped += 1 },
      ...overrides,
    }
    globalThis.document.fire('contextmenu', event)
    return { event, prevented, stopped }
  }

  const gesture = rightClick()
  check('selection: the gesture is taken away from the native menu', () => {
    assert.equal(gesture.prevented, 1, 'the native menu was not suppressed')
    assert.equal(gesture.stopped, 1)
    assert.equal(contextMenus.opened.length, 1)
    assert.equal(contextMenus.opened[0].target.kind, 'annotate.selection')
    assert.deepEqual(contextMenus.opened[0].point, { x: 420, y: 350 })
  })

  const value = contextMenus.opened[0].target.value
  check('selection: the menu knows the words and where they live', () => {
    assert.equal(value.path, 'notes/a.md')
    assert.equal(value.from, 140)
    assert.equal(value.page, 0)
    assert.equal(value.quote, quote)
    assert.match(value.text, /缓存失效/)
  })

  const provider = contextMenus.registered[0]
  const actions = provider.resolve(value, undefined)
  check('selection: copy keeps the native row, annotate is added after it', () => {
    assert.deepEqual(actions.map((action) => action.id), ['copy', 'annotate'])
    assert.deepEqual(actions.map((action) => action.label), ['复制', '批注'])
  })

  let copied = ''
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', clipboard: { writeText: async (text) => { copied = text } } },
    configurable: true,
    writable: true,
  })
  await actions[0].run()
  check('selection: copy carries the selection itself, not the whole line', () => {
    assert.equal(copied, quote, `copied ${JSON.stringify(copied)}`)
  })

  // Nothing selected: the native menu must stay untouched for the rest of the app.
  selection.isCollapsed = true
  const collapsed = rightClick()
  selection.isCollapsed = false
  check('selection: a collapsed caret leaves the native menu alone', () => {
    assert.equal(collapsed.prevented, 0)
    assert.equal(contextMenus.opened.length, 1)
  })

  actions[1].run()
  await runtime.flush()
  scene.tree = scene.mount()

  check('selection: annotate opens the same card, quoting the words', () => {
    const strip = find(scene.tree, (node) => node.props?.className === 'dwa-quote')
    assert.ok(strip, 'no quote strip')
    assert.equal(textOf(strip), quote)
    assert.ok(find(scene.tree, (node) => node.type === 'textarea'), 'no note box')
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-freeze'), null, 'a selection must not open the overlay')
  })

  find(scene.tree, (node) => node.type === 'textarea').props.onChange({ target: { value: '这句要解释缓存什么时候失效' } })
  await runtime.flush()
  scene.tree = scene.mount()
  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('selection: the prompt line carries file, line, quote and note, without a picture', () => {
    assert.equal(log.drafted.length, 1)
    assert.deepEqual(log.drafted[0].files, [], 'a text selection must not mint a crop')
    assert.equal(log.inits.length, 1)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /^notes\/a\.md · /)
    assert.match(prompt, /第 140 行/)
    assert.match(prompt, new RegExp(quote))
    assert.match(prompt, /这句要解释缓存什么时候失效/)
    assert.equal(prompt.split('\n').length, 1, `the line broke in two: ${JSON.stringify(prompt)}`)
    assert.deepEqual(log.attachments, [], 'no attachment call expected for a text selection')
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-quote'), null, 'the card stayed open')
  })

  // Esc closes the card without touching the draft.
  actions[1].run()
  await runtime.flush()
  scene.tree = scene.mount()
  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Escape', shiftKey: false, preventDefault() {}, stopPropagation() {} })
  await runtime.flush()
  scene.tree = scene.mount()
  check('selection: escape closes the card', () => {
    assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-quote'), null)
    assert.equal(log.inits.length, 1, 'escape must not write to the draft')
  })
}

// ============================================== scenario F: session switching
async function scenarioSessionSwitch() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log } = makeComposer()

  const webview = new FakeNode('webview', { 'data-sidebar-browser-frame': 'webview' }, rect(260, 100, 1020, 760))
  webview.capturePage = () => Promise.resolve({ toDataURL: () => 'data:image/png;base64,AAAA', getSize: () => ({ width: 840, height: 600 }) })
  webview.getURL = () => 'http://127.0.0.1:8799/third'
  webview.executeJavaScript = () => Promise.resolve({ selector: '', heading: '', quote: '' })
  const toolbar = new FakeNode('form', {})
  toolbar.append(new FakeNode('button', { 'aria-label': 'reload' }))
  const addressBox = new FakeNode('div', {})
  addressBox.append(new FakeNode('input', { 'aria-label': 'address' }))
  toolbar.append(addressBox)
  const pane = new FakeNode('div', {}, rect(260, 60, 1020, 800), [toolbar, webview])
  globalThis.document = fakeDocument([pane], [])
  globalThis.Image = FakeImage

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const timers = []
  globalThis.setInterval = (callback) => { timers.push(callback); return timers.length }
  globalThis.clearInterval = () => {}

  try {
    const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })
    const trigger = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
    trigger.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()

    const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
    stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 320, clientY: 160, currentTarget: { setPointerCapture() {} } })
    stageNode.props.onPointerMove({ clientX: 420, clientY: 250 })
    stageNode.props.onPointerUp({ clientX: 420, clientY: 250 })
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()
    find(scene.tree, (node) => node.type === 'textarea').props.onChange({ target: { value: '这一条只属于第一个会话' } })
    await runtime.flush()
    scene.tree = scene.mount()
    find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()

    check('session: a note starts on the conversation that wrote it', () => {
      assert.equal(findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble').length, 1, 'no bead for the first session')
      assert.ok(log.draft.includes('这一条只属于第一个会话'), 'the line never reached the draft')
    })

    // The composer can be emptied by sending before the 900 ms prune ever saw
    // the line. The bead must still turn into a record instead of lingering as
    // a draft forever. It keeps its bead for the rest of this round.
    log.draft = ''
    for (const timer of timers) timer()
    await runtime.flush()
    scene.tree = scene.mount()

    check('session: a bead becomes a record once the composer is empty', () => {
      const bead = find(scene.tree, (node) => node.props?.className === 'dwa-bubble')
      assert.ok(bead, 'the bead vanished instead of becoming a record')
      assert.equal(bead.props['data-ghost'], '1', 'the bead still says it is drafting')
    })

    // The next markup round starts on a clean canvas: the record waits in the
    // ledger instead of floating over the next round's page.
    const freezeForExit = find(scene.tree, (node) => node.props?.className === 'dwa-freeze')
    freezeForExit.props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()
    const triggerAgain = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
    triggerAgain.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()

    check('session: a new round leaves the old record to the ledger', () => {
      assert.equal(findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble').length, 0, 'the old record is still on the canvas')
    })

    // Leave marking again: the toolbar (and its ledger count) is only drawn
    // outside the freeze, and the record has to still be counted there.
    const freezeAgain = find(scene.tree, (node) => node.props?.className === 'dwa-freeze')
    freezeAgain.props.onContextMenu({ preventDefault() {}, stopPropagation() {} })
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()

    check('session: the ledger still counts the old record', () => {
      const count = find(scene.tree, (node) => node.props?.className === 'dwa-tool-count')
      assert.ok(count, 'the ledger lost the record')
      assert.equal(textOf(count), '1', 'the ledger count is wrong')
    })

    // Switching conversations must not carry the record over, nor let the new
    // session's prune sweep delete the old line.
    useSessions.switchTo('s2')
    scene.tree = scene.mount()
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()

    check('session: another conversation does not inherit the beads', () => {
      assert.equal(findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble').length, 0, 'the bead followed the switch')
      assert.equal(find(scene.tree, (node) => node.props?.className === 'dwa-tool-count'), null, 'the ledger followed the switch')
      assert.equal(log.draft, '', 'the switch rewrote the composer draft')
      assert.equal(log.setDrafts.length, 0, 'the switch rewrote the draft')
    })

    useSessions.switchTo('s1')
    scene.tree = scene.mount()
    await settle(runtime, scene.mount)
    scene.tree = scene.mount()

    check('session: a record from an earlier round stays in the ledger', () => {
      const beads = findAll(scene.tree, (node) => node.props?.className === 'dwa-bubble')
      assert.equal(beads.length, 0, 'an old record came back onto the canvas')
      const count = find(scene.tree, (node) => node.props?.className === 'dwa-tool-count')
      assert.ok(count, 'the ledger lost the record')
      assert.equal(textOf(count), '1', 'the ledger count is wrong')
    })
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

// ================================================== scenario G: sheet preview
async function scenarioSheet() {
  const runtime = createRuntime()
  const plugin = loadModule(runtime)
  const { ctx, useSessions, log } = makeComposer()
  const canvasLog = []

  // A plain HTML table, no ARIA row/col attributes: the row and column have to
  // come from the DOM's own zero-based `rowIndex` and `cellIndex`.
  const table = new FakeNode('table', { 'data-sheet-name': 'Sheet1' }, rect(300, 310, 640, 96))
  for (let row = 0; row < 3; row += 1) {
    const tr = new FakeNode('tr', {}, rect(300, 310 + row * 32, 640, 32))
    tr.rowIndex = row
    for (let col = 0; col < 3; col += 1) {
      const td = new FakeNode('td', {}, rect(300 + col * 120, 310 + row * 32, 120, 32), [], `R${row + 1}C${col + 1}`)
      td.cellIndex = col
      tr.append(td)
    }
    table.append(tr)
  }
  // A canvas-like scrim over the grid: the element under the pointer is not a
  // cell, so the range has to be recovered from the cells that overlap the box.
  const scrim = new FakeNode('div', { className: 'dwa-fake-scrim' }, rect(300, 310, 640, 96))
  const body = new FakeNode('div', { 'data-textpreview-body': '' }, rect(260, 100, 1020, 760), [table, scrim])
  const root = new FakeNode('div', {
    'data-document-preview': 'sheet',
    'data-textpreview-url': 'file:///data/a.xlsx',
  }, rect(260, 100, 1020, 760), [
    new FakeNode('div', { 'data-textpreview-path': '' }, rect(260, 100, 1020, 24), [], 'data/a.xlsx'),
    body,
  ])
  globalThis.document = fakeDocument([root], canvasLog)
  globalThis.Image = FakeImage

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })
  const trigger = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-tool')
  trigger.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 305, clientY: 315, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 470, clientY: 355 })
  stageNode.props.onPointerUp({ clientX: 470, clientY: 355 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  find(scene.tree, (node) => node.type === 'textarea').props.onChange({ target: { value: '这两行数字对不上' } })
  await runtime.flush()
  scene.tree = scene.mount()
  find(scene.tree, (node) => node.type === 'textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('sheet: the anchor names the cell range, not just the file', () => {
    assert.equal(log.inits.length, 1, 'the line never reached the draft')
    const prompt = log.inits[0].prompt
    assert.match(prompt, /data\/a\.xlsx/, `the file went missing: ${prompt}`)
    assert.match(prompt, /Sheet1!A1:B2/, `the cell range is wrong or missing: ${prompt}`)
  })
}

await scenarioPage()
await scenarioText()
await scenarioPdf()
await scenarioImage()
await scenarioSelection()
await scenarioSessionSwitch()
await scenarioSheet()

console.log(`ok — ${checks.length} checks`)
for (const label of checks) console.log('  ✓', label)
process.exit(0)
