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
  const all = []
  const visit = (node) => {
    all.push(node)
    for (const child of node.children) visit(child)
  }
  for (const root of roots) visit(root)
  const doc = {
    body: new FakeNode('body'),
    documentElement: new FakeNode('html'),
    querySelectorAll(selector) {
      return all.filter((node) => node.matches(selector))
    },
    querySelector(selector) {
      return doc.querySelectorAll(selector)[0] ?? null
    },
    elementsFromPoint(x, y) {
      return all.filter((node) => contains(node.rect, x, y)).reverse()
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
  assert.equal(captured.id, 'dsh-annotate')
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
  const log = { drafted: [], attachments: [], inits: [], released: [] }
  const conversation = {
    createDrafts(sessionId, files) {
      log.drafted.push({ sessionId, files })
      return files.map((file, index) => ({ id: `draft-${log.drafted.length - 1}-${index}`, file }))
    },
    releaseDraftAttachments(list) { log.released.push(list) },
    input: {
      for: () => ({
        addAttachments(ids) { log.attachments.push(ids); return true },
        focus() {},
      }),
      requestDraftInitialization(binding, options) { log.inits.push(options); return 'applied' },
    },
  }
  const binding = {
    sessionId: 's1',
    ctx: { get: (name) => (name === 'conversation' ? conversation : undefined) },
    session: { getSnapshot: () => ({ subagent: null }) },
  }
  const sessions = { binding: (id) => (id === 's1' ? binding : undefined) }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : name === 'conversation' ? conversation : undefined),
    slots: {
      registry: {},
      inject(name, callback) { callback() },
      register(options, component) { this.registry[options.name] = { options, component }; return () => {} },
    },
  }
  const useSessions = (selector) => selector({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } }, ids: ['s1'] })
  return { ctx, useSessions, log }
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
  globalThis.document = fakeDocument([webview], canvasLog)
  globalThis.Image = FakeImage

  const scene = await mountScenario({ runtime, plugin, ctx, useSessions, stage: rect(260, 100, 1020, 760) })

  const floatButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-float')
  check('page: floating button sits on the webview', () => {
    assert.ok(floatButton, 'no floating button')
    assert.match(textOf(floatButton), /标注页面/)
    assert.equal(floatButton.props.style.left, `${1280 - 118}px`)
    assert.equal(floatButton.props.style.top, '110px')
  })

  check('page: only the overlay is registered', () => {
    assert.deepEqual(Object.keys(ctx.slots.registry), ['shell.overlay'])
    assert.equal(ctx.slots.registry['shell.overlay'].options.id, 'annotate.page')
  })

  floatButton.props.onClick()
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
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-tip'), 'no hint on how to start')
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
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-chip'), 'no numbered chip')
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

  // Selecting the first chip brings the editor back next to that region.
  find(scene.tree, (node) => node.props?.className === 'dwa-chip').props.onClick()
  await runtime.flush()
  scene.tree = scene.mount()

  check('page: the editor follows the selected region', () => {
    const sheet = find(scene.tree, (node) => node.props?.className === 'dwa-sheet')
    const left = Number.parseFloat(sheet.props.style.left)
    assert.ok(left >= 420 && left <= 460, `editor did not follow the selection: ${left}`)
    const chip = find(scene.tree, (node) => node.props?.className === 'dwa-chip')
    assert.equal(chip.props['data-selected'], '1')
  })

  check('page: the card keeps only chips, a delete badge and a close button', () => {
    assert.ok(!find(scene.tree, (node) => node.props?.className === 'dwa-sheet-hint'), 'the hint line came back')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-sheet-bar'), 'no card bar')
    assert.ok(find(scene.tree, (node) => node.props?.className === 'dwa-x'), 'no close button')
    const badges = findAll(scene.tree, (node) => node.props?.className === 'dwa-sb-del')
    assert.equal(badges.length, 1, 'exactly the selected region should offer a delete badge')
    const removeButtons = findAll(scene.tree, (node) => node.type === 'button' && textOf(node) === '删除')
    assert.equal(removeButtons.length, 0, 'the bottom-left remove button is back')
    assert.ok(!source.includes('brightness('), 'the primary button still has a hover filter')
  })

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这个按钮在右键菜单里点不到' } })
  await runtime.flush()
  scene.tree = scene.mount()

  const insertButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-btn dwa-btn-primary')
  insertButton.props.onClick()
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('page: crop reaches the composer', () => {
    assert.ok(canvasLog.length >= 1, 'the crop canvas was never built')
    assert.equal(canvasLog[0].width, 82, 'crop width ignores the capture scale')
    assert.equal(canvasLog[0].height, 74, 'crop height ignores the capture scale')
    assert.equal(log.drafted.length, 1, 'createDrafts was not called')
    const files = log.drafted[0].files
    assert.equal(files.length, 2, 'both regions should be cropped')
    assert.match(files[0].name, /^page-1-.*\.png$/)
    assert.match(files[1].name, /^page-2-.*\.png$/)
    assert.equal(log.inits.length, 1)
    assert.equal(log.inits[0].whenDraftExists, 'append')
    assert.match(log.inits[0].prompt, /我在页面 http:\/\/127\.0\.0\.1:8799\/third 上标了 2 处/)
    assert.match(log.inits[0].prompt, /这个按钮在右键菜单里点不到/)
    assert.match(log.inits[0].prompt, /提交订单/, 'the heading anchor went missing')
    assert.ok(!log.inits[0].prompt.includes('div#app'), 'the element path leaked into the prompt')
    assert.ok(!log.inits[0].prompt.includes('> 区域'), 'the element path leaked into the prompt')
    assert.deepEqual(log.attachments, [['draft-0-0', 'draft-0-1']])
    assert.equal(webview.style.visibility, '', 'the page stayed frozen after inserting')
    assert.equal(log.released.length, 0)
  })

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

  const floatButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-float')
  check('text: button knows it is a document', () => {
    assert.ok(floatButton, 'no floating button')
    assert.match(textOf(floatButton), /标注文档/)
  })

  floatButton.props.onClick()
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

  const anchor = find(scene.tree, (node) => node.props?.className === 'dwa-anchor')
  check('text: box carries a line-range locator', () => {
    assert.ok(anchor, 'no locator strip')
    const text = textOf(anchor)
    assert.match(text, /第 138–139 行|第 139–140 行|第 138 行|第 139 行/, `unexpected locator: ${text}`)
    assert.match(text, /缓存失效/)
  })

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这句说的缓存问题要写清楚什么时候失效' } })
  await runtime.flush()
  scene.tree = scene.mount()

  const insertButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-btn dwa-btn-primary')
  insertButton.props.onClick()
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('text: prompt carries path, lines and quoted text, no image', () => {
    assert.equal(log.drafted.length, 1)
    assert.equal(log.drafted[0].files.length, 0, 'a text document should not ship a screenshot')
    assert.equal(log.inits.length, 1)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /「notes\/a\.txt」/)
    assert.match(prompt, /第 \d+–\d+ 行|第 \d+ 行/, `no line range in prompt: ${prompt}`)
    assert.match(prompt, /缓存失效/)
    assert.match(prompt, /这句说的缓存问题要写清楚什么时候失效/)
    assert.match(prompt, /定位以引号里的文字为准/)
    assert.deepEqual(log.attachments, [[]], 'no attachments expected for a text document')
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

  const floatButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-float')
  floatButton.props.onClick()
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  const stageNode = find(scene.tree, (node) => node.props?.className === 'dwa-stage')
  stageNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 300, clientY: 205, currentTarget: { setPointerCapture() {} } })
  stageNode.props.onPointerMove({ clientX: 700, clientY: 262 })
  stageNode.props.onPointerUp({ clientX: 700, clientY: 262 })
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  const anchor = find(scene.tree, (node) => node.props?.className === 'dwa-anchor')
  check('pdf: box carries page + quoted text', () => {
    assert.ok(anchor, 'no locator strip')
    const text = textOf(anchor)
    assert.match(text, /第 2\/3 页/, `unexpected locator: ${text}`)
    assert.match(text, /缓存失效策略/)
  })

  const note = find(scene.tree, (node) => node.type === 'textarea')
  note.props.onChange({ target: { value: '这一节的标题要改' } })
  await runtime.flush()
  scene.tree = scene.mount()

  const insertButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-btn dwa-btn-primary')
  insertButton.props.onClick()
  await settle(runtime, scene.mount)
  scene.tree = scene.mount()

  check('pdf: crop comes from the page canvas, at device resolution', () => {
    assert.equal(canvasLog.length, 1, 'the page canvas was never cropped')
    assert.equal(canvasLog[0].width, 800, 'crop width ignores the canvas scale')
    assert.equal(log.drafted.length, 1)
    assert.equal(log.drafted[0].files.length, 1, 'expected one crop')
    assert.match(log.drafted[0].files[0].name, /^page-1-.*\.png$/)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /「docs\/guide\.pdf」/)
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

  const floatButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-float')
  floatButton.props.onClick()
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

  const insertButton = find(scene.tree, (node) => node.type === 'button' && node.props?.className === 'dwa-btn dwa-btn-primary')
  insertButton.props.onClick()
  await settle(runtime, scene.mount)

  check('image: crop comes from the rendered image at natural scale', () => {
    assert.equal(canvasLog.length, 1, 'the image was never cropped')
    assert.equal(canvasLog[0].width, 400, 'crop width ignores the 2x natural scale')
    assert.equal(log.drafted[0].files.length, 1)
    const prompt = log.inits[0].prompt
    assert.match(prompt, /「assets\/wide\.png」/)
    assert.match(prompt, /这张图的右侧留白太多/)
    assert.doesNotMatch(prompt, /这个文件/, 'a bare "this file" label is noise')
  })
}

await scenarioPage()
await scenarioText()
await scenarioPdf()
await scenarioImage()

console.log(`ok — ${checks.length} checks`)
for (const label of checks) console.log('  ✓', label)
process.exit(0)
