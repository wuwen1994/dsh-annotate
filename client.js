/**
 * Client half of the annotate bundle.
 *
 * A floating button rides on top of whatever the built-in right sidebar shows:
 * the sandboxed browser tab (an Electron <webview>) or the document preview
 * (PDF, Markdown, plain text, code …). It freezes pixels when the target is a
 * page, overlays live boxes when the target is a document, and drops the crops
 * plus a numbered prompt — every line carries a locator (page number, line
 * range, heading, quoted text) — into the composer.
 */
window.__ModuleLoader__.load({
  id: '@wuwen1994/dsh-annotate',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { useState, useRef, useEffect, useCallback, useMemo } = React
    const el = (tag, props, ...children) => React.createElement(tag, props, ...children)

    const NS = 'annotate'
    const MIN_SIDE = 6
    const QUOTE_MAX = 180
    const LOCATOR_MAX = 120

    const ZH = {
      close: '关闭',
      notePlaceholder: '写批注，回车插入',
      promptNoNote: '（未写批注）',
      posLt: '左上', posCt: '上方居中', posRt: '右上',
      posLm: '左侧居中', posCm: '页面中部', posRm: '右侧居中',
      posLb: '左下', posCb: '下方居中', posRb: '右下',
      errBusy: '输入框正忙，稍后再试。',
      errUnavailable: '当前离线，或者这个会话无法写入输入框。',
      errCrop: '裁切标注区域失败：{msg}',
      errShot: '截图失败：{msg}',
      errAnnotate: '写入这条选区批注失败：{msg}',
      sbButtonPage: '标注页面',
      sbButtonDoc: '标注文档',
      sbNeedSession: '先在左侧选一个会话，批注才能插进输入框。',
      sbNoPage: '右侧栏里还没有打开的网页或文件。',
      sbNoCapture: '当前环境不支持网页截图。',
      sbInserting: '正在插入…',
      bubbleHint: '点开编辑这条批注',
      bubbleRemove: '删掉这条批注（提示词和裁图一并删掉）',
      sbNoCrop: '这一页现在不在屏幕上，批注已插入，但没有带上裁图。',
      sbAnchorPage: '第 {page}/{total} 页',
      sbAnchorPageSolo: '第 {page} 页',
      sbAnchorLines: '第 {from}–{to} 行',
      sbAnchorLine: '第 {line} 行',
      sbAnchorHeading: '「{heading}」小节',
      sbAnchorElement: '<{tag}> 区域',
      menuCopy: '复制',
      menuAnnotate: '批注',
      menuCopyFailed: '复制失败：剪贴板不可用。',
      selQuote: '「{quote}」',
    }

    const EN = {
      close: 'Close',
      notePlaceholder: 'Note — press Enter to insert',
      promptNoNote: '(no note)',
      posLt: 'top left', posCt: 'top centre', posRt: 'top right',
      posLm: 'centre left', posCm: 'centre', posRm: 'centre right',
      posLb: 'bottom left', posCb: 'bottom centre', posRb: 'bottom right',
      errBusy: 'The composer is busy. Try again in a moment.',
      errUnavailable: 'Offline, or this session cannot accept a composer draft.',
      errCrop: 'Could not crop the marked region: {msg}',
      errShot: 'Could not capture the page: {msg}',
      errAnnotate: 'Could not add this note: {msg}',
      sbButtonPage: 'Annotate page',
      sbButtonDoc: 'Annotate file',
      sbNeedSession: 'Pick a session on the left so the notes have a composer to land in.',
      sbNoPage: 'The sidebar is not showing a page or a file.',
      sbNoCapture: 'This environment cannot capture the page.',
      sbInserting: 'Inserting…',
      bubbleHint: 'Open this note again',
      bubbleRemove: 'Delete this note (the prompt line and its crop go too)',
      sbNoCrop: 'That page is off screen now, so the note went in without its picture.',
      sbAnchorPage: 'page {page}/{total}',
      sbAnchorPageSolo: 'page {page}',
      sbAnchorLines: 'lines {from}–{to}',
      sbAnchorLine: 'line {line}',
      sbAnchorHeading: 'under "{heading}"',
      sbAnchorElement: 'in <{tag}>',
      menuCopy: 'Copy',
      menuAnnotate: 'Annotate',
      menuCopyFailed: 'Could not copy the selection.',
      selQuote: '“{quote}”',
    }

    function translator(dict) {
      return (key, params) => {
        const pattern = dict[key] ?? key
        if (!params) return pattern
        return String(pattern).replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
      }
    }

    function prefersEnglish() {
      try {
        const lang = (document.documentElement && document.documentElement.getAttribute('lang')) || ''
        if (/^en/i.test(lang)) return true
        if (/^en/i.test(String(navigator.language || ''))) return true
        if (lang) return false
      } catch { /* no document yet */ }
      return false
    }

    /** Host `t` when it knows our keys, our own dictionary otherwise. */
    function resolveT(hostT) {
      const fallback = translator(prefersEnglish() ? EN : ZH)
      if (typeof hostT !== 'function') return fallback
      return (key, params) => {
        const text = hostT(key, params)
        return text === undefined || text === null || text === key ? fallback(key, params) : text
      }
    }

    const clamp01 = (value) => Math.min(1, Math.max(0, value))

    // Where the box sits, in words. The dictionary names the middle band "m"
    // (posLm / posCm / posRm) while the row is picked as "c" here, hence the map.
    const POSITION_ROW = { t: 't', c: 'm', b: 'b' }

    function positionWord(t, cx, cy) {
      const row = cy < 0.34 ? 't' : cy < 0.67 ? 'c' : 'b'
      const col = cx < 0.34 ? 'l' : cx < 0.67 ? 'c' : 'r'
      const key = `pos${col.toUpperCase()}${POSITION_ROW[row]}`
      const word = t(key)
      // A missing entry comes back as the key itself; never let that reach the prompt.
      return word === key ? '' : word
    }

    function normalizeRect(start, end) {
      const x = Math.min(start.x, end.x)
      const y = Math.min(start.y, end.y)
      return { x, y, w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }
    }

    function stamp() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    }

    function shrink(text, max) {
      const flat = String(text || '').replace(/\s+/g, ' ').trim()
      return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
    }

    function rectOf(node) {
      try { return node.getBoundingClientRect() } catch { return null }
    }

    function queryAll(root, selector) {
      try { return Array.prototype.slice.call(root.querySelectorAll(selector)) } catch { return [] }
    }

    function query(root, selector) {
      try { return root.querySelector(selector) } catch { return null }
    }

    const CSS = `
      /* Icon button sized to the sidebar chrome's own toolbar tools (28x28). */
      .dwa-tool { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: 0 0 auto;
        padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; cursor: pointer;
        color: var(--dsw-alias-label-secondary, #4a4f57); }
      .dwa-tool:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #111); }
      .dwa-tool[disabled] { opacity: .5; cursor: default; }
      .dwa-tool svg { width: 16px; height: 16px; }
      .dwa-slot { display: contents; }
      .dwa-error { color: #e5484d; font-size: 12px; }

      /* Fallback when the pane has no toolbar to host the icon. */
      .dwa-float { position: fixed; z-index: 1400; border-radius: var(--dsw-radius-sm, 6px);
        background: var(--dsw-specific-menu, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12));
        box-shadow: 0 4px 14px rgba(0,0,0,.18); }
      .dwa-sb-toast { position: fixed; z-index: 1400; max-width: 260px; padding: 6px 10px; border-radius: var(--dsw-radius-sm, 6px);
        background: rgba(229,72,77,.96); color: #fff; font-size: 12px; line-height: 1.45; box-shadow: 0 6px 18px rgba(0,0,0,.24); }

      .dwa-freeze { position: fixed; z-index: 1400; overflow: hidden; background: #0b0d12; }
      .dwa-freeze[data-mode='live'] { background: transparent; box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary, #3b82f6); }
      .dwa-stage { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
      .dwa-stage img { display: block; width: 100%; height: 100%; object-fit: fill; pointer-events: none; user-select: none; }
      .dwa-sb-box { position: absolute; box-sizing: border-box; border: 2px solid #e5484d; background: rgba(229,72,77,.16); cursor: pointer; }
      .dwa-sb-box[data-selected='1'] { border-color: #2f6fed; background: rgba(47,111,237,.18); }
      .dwa-sb-n { position: absolute; top: -10px; left: -10px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
        background: #e5484d; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
      .dwa-sb-box[data-selected='1'] .dwa-sb-n { background: #2f6fed; }
      .dwa-sb-box[data-inside='1'] .dwa-sb-n { top: 2px; left: 2px; }
      .dwa-sb-ghost { position: absolute; border: 1px dashed #e5484d; background: rgba(229,72,77,.1); }

      .dwa-sheet { position: fixed; z-index: 1401; width: min(320px, calc(100vw - 24px)); max-height: calc(100vh - 20px); overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
        padding: 8px 10px 10px; border-radius: var(--dsw-radius-lg, 10px);
        background: var(--dsw-specific-menu, rgba(255,255,255,.96));
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); box-shadow: 0 10px 30px rgba(0,0,0,.28); }
      .dwa-sheet[data-compact='1'] { padding: 6px 8px; }
      .dwa-sheet-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      /* Left behind on the page after Enter: a glass bead that reopens its note. */
      .dwa-bubble { position: fixed; z-index: 1402; min-width: 22px; height: 22px; padding: 0 7px; border: 1px solid rgba(255,255,255,.42);
        border-radius: 999px; background: rgba(38,94,214,.82); color: #fff; font: inherit; font-size: 12px; font-weight: 600; line-height: 20px;
        text-align: center; cursor: pointer; backdrop-filter: blur(6px) saturate(1.5); -webkit-backdrop-filter: blur(6px) saturate(1.5);
        box-shadow: 0 2px 10px rgba(24,60,140,.32), inset 0 1px 0 rgba(255,255,255,.35); transform: translate(-50%, -50%); }
      .dwa-bubble:hover { background: rgba(38,94,214,.95); }
      .dwa-bubble[data-editing='1'] { box-shadow: 0 0 0 2px rgba(255,255,255,.9), 0 2px 10px rgba(24,60,140,.32); }
      .dwa-sheet textarea { width: 100%; box-sizing: border-box; min-height: 44px; max-height: 96px; resize: vertical; padding: 6px 8px;
        font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary, #111); background: var(--dsw-alias-bg-l1, rgba(127,127,127,.06));
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: var(--dsw-radius-sm, 6px); outline: none; }
      /* The words a note is about, kept short: the card is a composer, not a reader. */
      .dwa-quote { max-height: 56px; overflow: hidden; padding: 4px 8px; border-left: 2px solid var(--dsw-alias-brand-primary, #3b82f6);
        border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-l1, rgba(127,127,127,.06));
        color: var(--dsw-alias-label-secondary, #4a4f57); font-size: 12px; line-height: 1.5; }
      .dwa-x { width: 22px; height: 22px; margin-left: auto; border: none; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
        color: var(--dsw-alias-label-tertiary, #8a8f98); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
      .dwa-x:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #111); }
    `

    function FrameIcon() {
      return el('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        el('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }),
        el('path', { d: 'M1.5 6h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        el('rect', { x: 4, y: 8, width: 5.5, height: 4, rx: 0.8, stroke: '#e5484d', strokeWidth: 1.2, fill: 'rgba(229,72,77,.14)' }))
    }

    // ------------------------------------------------------------------ targets

    const SIDEBAR_FRAME = 'webview[data-sidebar-browser-frame]'
    const PREVIEW_ROOT = '[data-document-preview]'
    const PREVIEW_BODY = '[data-textpreview-body]'
    const PREVIEW_SCROLL = '[data-document-zoom-scrollport]'
    const PREVIEW_PATH = '[data-textpreview-path]'

    function bigEnough(rect) {
      return Boolean(rect) && rect.width >= 200 && rect.height >= 160
    }

    /**
     * What the sidebar is showing right now. The browser tab wins because its
     * frame paints over the document pane when both are mounted.
     */
    function documentTarget(root) {
      if (!root) return null
      const body = query(root, PREVIEW_BODY) || root
      const scroll = query(body, PREVIEW_SCROLL) || body
      const rect = rectOf(scroll)
      if (!bigEnough(rect)) return null
      return { kind: 'document', node: root, root, body, scroll, rect }
    }

    function findTarget() {
      for (const node of queryAll(document, SIDEBAR_FRAME)) {
        const rect = rectOf(node)
        if (bigEnough(rect)) return { kind: 'browser', node, rect, root: node, scroll: null }
      }
      for (const root of queryAll(document, PREVIEW_ROOT)) {
        const target = documentTarget(root)
        if (target) return target
      }
      return null
    }

    function documentKind(root) {
      try { return root.getAttribute('data-document-preview') || '' } catch { return '' }
    }

    function documentPath(root) {
      // The path label sits in the frame header, one level above the renderer.
      const where = [root, root && root.parentElement, document]
      for (const scope of where) {
        if (!scope) continue
        const label = query(scope, PREVIEW_PATH)
        const shown = label && label.textContent ? String(label.textContent).trim() : ''
        if (shown) return shown
      }
      let url = ''
      try { url = root.getAttribute('data-textpreview-url') || '' } catch { url = '' }
      return prettyPath(url)
    }

    function prettyPath(url) {
      if (!url) return ''
      let text = url
      try { text = decodeURIComponent(url) } catch { text = url }
      text = text.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '')
      return text
    }

    /**
     * The chrome row that owns the pane's own controls: the toolbar form above a
     * browser tab, or the frame header above a document preview. We insert one
     * (invisible) placeholder there and portal our icon into it, which is the
     * only way to sit next to the host's own reload button — the pane exposes no
     * slot for extra actions.
     */
    function paneChrome(target) {
      if (!target) return null
      if (target.kind === 'browser') {
        for (let node = target.node && target.node.parentElement; node; node = node.parentElement) {
          let form = null
          for (const child of node.children || []) {
            if (child.tagName === 'FORM') { form = child; break }
          }
          if (form) {
            const children = form.children || []
            // Back, forward, reload, then the address box. Anchoring on the
            // address box keeps us right after reload whether the host wraps
            // its reload button in a tooltip element or leaves it a plain
            // button, so we never have to count buttons.
            const input = query(form, 'input')
            const addressBox = input && input.parentElement
            if (addressBox && addressBox.parentElement === form) {
              return { host: form, before: addressBox }
            }
            const buttons = children.filter((child) => child.tagName === 'BUTTON')
            const reload = buttons[2] || children[2] || null
            return { host: form, before: (reload && reload.nextSibling) || null }
          }
          if (node === document.body) break
        }
        return null
      }
      // The path label lives in the frame header, which wraps the renderer
      // root — walk up until some ancestor owns that label.
      for (let node = target.root; node; node = node.parentElement) {
        const label = query(node, PREVIEW_PATH)
        const header = label && label.parentElement
        if (header) {
          const children = header.children || []
          const last = children[children.length - 1] || null
          return { host: header, before: last && last !== label ? last : null }
        }
        if (node === document.body) break
      }
      return null
    }

    function scrollOf(target) {
      const node = target && target.scroll
      if (!node) return { x: 0, y: 0 }
      return { x: Number(node.scrollLeft) || 0, y: Number(node.scrollTop) || 0 }
    }

    /** Topmost element at a viewport point, ignoring our own overlay. */
    function elementAt(x, y, own) {
      const stack = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(x, y)
        : [document.elementFromPoint(x, y)]
      for (const node of stack) {
        if (!node || node === document || node === document.body || node === document.documentElement) continue
        if (own && typeof node.closest === 'function' && node.closest(own)) continue
        return node
      }
      return null
    }

    function intersects(rect, box) {
      return Boolean(rect) && rect.right > box.left + 0.5 && rect.left < box.right - 0.5
        && rect.bottom > box.top + 0.5 && rect.top < box.bottom - 0.5
    }

    /** Leaf-ish text elements that overlap the box, in reading order. */
    function textHits(scope, box, selector) {
      const hits = []
      for (const node of queryAll(scope, selector)) {
        const text = node.textContent === null || node.textContent === undefined ? '' : String(node.textContent)
        if (!text.trim()) continue
        const rect = rectOf(node)
        if (!intersects(rect, box)) continue
        hits.push({ node, text, rect })
      }
      hits.sort((left, right) => (left.rect.top - right.rect.top) || (left.rect.left - right.rect.left))
      return hits
    }

    function joinHits(hits) {
      const seen = new Set()
      const parts = []
      for (const hit of hits) {
        const flat = hit.text.replace(/\s+/g, ' ').trim()
        if (!flat || seen.has(flat)) continue
        seen.add(flat)
        parts.push(flat)
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim()
    }

    function headingOf(node, scope) {
      let current = node
      while (current && current !== scope) {
        const tag = current.tagName ? String(current.tagName).toLowerCase() : ''
        if (/^h[1-6]$/.test(tag)) {
          const text = current.textContent ? String(current.textContent).trim() : ''
          if (text) return shrink(text, 60)
        }
        current = current.parentElement
      }
      return ''
    }

    /** The PDF page under a point, when the text layer has no span exactly there. */
    function pageUnder(pages, x, y) {
      let best = null
      let bestArea = Number.POSITIVE_INFINITY
      for (const page of pages) {
        const rect = rectOf(page)
        if (!rect || rect.width <= 0 || rect.height <= 0) continue
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
        const area = rect.width * rect.height
        if (area < bestArea) {
          best = page
          bestArea = area
        }
      }
      return best
    }

    const TEXT_SELECTOR = 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre, code, blockquote, dt, dd, figcaption, span'

    /**
     * Everything needed to point a later reader at this spot: page number, line
     * range, enclosing heading, and the text that sits inside the box. The
     * snapshot is taken while the box is drawn, so scrolling afterwards cannot
     * desync it from the note.
     */
    function readAnchor(target, viewRect, own) {
      const anchor = { page: 0, pages: 0, from: 0, to: 0, heading: '', quote: '', tag: '', kind: '' }
      if (!target) return anchor
      const box = {
        left: viewRect.left,
        top: viewRect.top,
        right: viewRect.left + viewRect.width,
        bottom: viewRect.top + viewRect.height,
      }
      try {
        if (target.kind === 'browser') return anchor
        const scope = target.scroll || target.body || target.root
        const kind = documentKind(target.root)
        anchor.kind = kind
        const center = {
          x: box.left + Math.min(viewRect.width / 2, 40),
          y: box.top + Math.min(viewRect.height / 2, 40),
        }
        const node = elementAt(center.x, center.y, own) || elementAt(box.left + 2, box.top + 2, own)
        if (node && node.tagName) anchor.tag = String(node.tagName).toLowerCase()

        if (kind === 'pdf') {
          const pages = queryAll(target.root, '[data-pdf-page]')
          anchor.pages = pages.length
          let pageNode = node && typeof node.closest === 'function' ? node.closest('[data-pdf-page]') : null
          if (!pageNode) pageNode = pageUnder(pages, center.x, center.y)
          if (pageNode) anchor.page = Number(pageNode.getAttribute('data-pdf-page')) || 0
          const layer = pageNode ? query(pageNode, '[data-pdf-text]') : null
          if (layer) {
            anchor.quote = shrink(joinHits(textHits(layer, box, 'span, br')), QUOTE_MAX)
          }
          if (!anchor.quote) anchor.quote = shrink(joinHits(textHits(scope, box, 'span')), QUOTE_MAX)
          return anchor
        }

        const lineNodes = queryAll(scope, '[data-textpreview-line]')
        if (lineNodes.length > 0) {
          const numbers = []
          const texts = []
          for (const line of lineNodes) {
            if (!intersects(rectOf(line), box)) continue
            numbers.push(Number(line.getAttribute('data-textpreview-line')) || 0)
            texts.push(String(line.textContent || ''))
          }
          if (numbers.length > 0) {
            anchor.from = Math.min(...numbers)
            anchor.to = Math.max(...numbers)
            anchor.quote = shrink(texts.join(' '), QUOTE_MAX)
            return anchor
          }
        }

        anchor.heading = node ? headingOf(node, scope) : ''
        anchor.quote = shrink(joinHits(textHits(scope, box, TEXT_SELECTOR)), QUOTE_MAX)
        return anchor
      } catch {
        return anchor
      }
    }

    /** Best-effort locator inside a live page: nearest heading and element path. */
    function pageAnchor(view, viewRect, target) {
      if (!view || typeof view.executeJavaScript !== 'function' || !target) return Promise.resolve({ selector: '', quote: '' })
      const x = Math.round(viewRect.left - target.rect.left + Math.min(viewRect.width / 2, 30))
      const y = Math.round(viewRect.top - target.rect.top + Math.min(viewRect.height / 2, 30))
      const script = `(() => {
        try {
          const node = document.elementFromPoint(${x}, ${y});
          if (!node) return null;
          const parts = [];
          let current = node;
          for (let depth = 0; current && depth < 4; depth += 1) {
            const tag = current.tagName ? current.tagName.toLowerCase() : '';
            if (!tag) break;
            parts.unshift(current.id ? tag + '#' + current.id : tag);
            current = current.parentElement;
          }
          const heading = node.closest ? node.closest('h1,h2,h3,h4,h5,h6') : null;
          return {
            selector: parts.join(' > '),
            heading: heading && heading.textContent ? heading.textContent.trim().slice(0, 60) : '',
            quote: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          };
        } catch (error) { return null; }
      })()`
      let pending
      try { pending = view.executeJavaScript(script) } catch { return Promise.resolve({ selector: '', quote: '' }) }
      if (!pending || typeof pending.then !== 'function') return Promise.resolve({ selector: '', quote: '' })
      return pending.then(
        (value) => (value && typeof value === 'object' ? value : { selector: '', quote: '' }),
        () => ({ selector: '', quote: '' }),
      )
    }

    // --------------------------------------------------------------- selection

    /**
     * Actions for selected text ride on the shared context menu, under this
     * target kind. The kind is ours: the registry only demands that a provider
     * exists for it, so no host type has to know about annotating.
     */
    const SELECTION_TARGET = 'annotate.selection'
    /** Long paragraphs make a prompt line unreadable; the full text is still copied. */
    const SELECTION_TEXT_MAX = 4000
    /** Our own floating UI: a right click there is never a new selection. */
    const OWN_UI = '.dwa-sheet, .dwa-freeze, .dwa-float, .dwa-bubble'

    function isOwnUi(node) {
      return Boolean(node) && typeof node.closest === 'function' && node.closest(OWN_UI) !== null
    }

    function isTextField(node) {
      if (!node || typeof node.closest !== 'function') return false
      return node.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
    }

    /** Viewport point of a gesture, falling back to the middle of the text. */
    function pointOf(event, rect) {
      const x = event && Number(event.clientX)
      const y = event && Number(event.clientY)
      if (Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)) return { x: Math.round(x), y: Math.round(y) }
      if (!rect) return { x: 0, y: 0 }
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    }

    /**
     * Describe the text the user has selected inside the document preview.
     *
     * The page (or line range) is read from the same geometry the frame tool
     * uses, but the quoted words come from the selection itself: the box-based
     * quote would take whole lines around it, which is not what was selected.
     */
    function selectionInfo(target, event) {
      if (!target || target.kind !== 'document') return null
      const scope = target.body || target.root
      let selection = null
      try { selection = window.getSelection() } catch { return null }
      if (!selection || selection.isCollapsed || !selection.rangeCount) return null
      const text = String(selection.toString() || '').trim()
      if (!text) return null
      const range = selection.getRangeAt(0)
      const holder = range.commonAncestorContainer
      try {
        if (!holder || !scope.contains(holder)) return null
      } catch { return null }

      let rect = null
      try {
        const box = range.getBoundingClientRect()
        if (box && box.width > 0 && box.height > 0) rect = { left: box.left, top: box.top, width: box.width, height: box.height }
      } catch { rect = null }
      if (!rect) {
        const node = holder.nodeType === 3 ? holder.parentElement : holder
        const fallback = rectOf(node)
        if (fallback && fallback.width > 0) rect = { left: fallback.left, top: fallback.top, width: fallback.width, height: fallback.height }
      }

      const anchor = rect
        ? readAnchor(target, rect, OWN_UI)
        : { page: 0, pages: 0, from: 0, to: 0, heading: '', quote: '', kind: '' }
      const point = pointOf(event, rect)
      return {
        // The clip keeps a pinned message line readable without dropping the
        // copy payload, which always uses the full selection.
        text: text.length > SELECTION_TEXT_MAX ? text.slice(0, SELECTION_TEXT_MAX) : text,
        quote: shrink(text, QUOTE_MAX),
        page: Number(anchor.page) || 0,
        pages: Number(anchor.pages) || 0,
        from: Number(anchor.from) || 0,
        to: Number(anchor.to) || 0,
        heading: anchor.heading || '',
        kind: anchor.kind || documentKind(target.root),
        path: documentPath(target.root),
        x: point.x,
        y: point.y,
      }
    }

    /**
     * One line for a selection: file, place, the quoted words, then the note.
     *
     * No leading number — numbers belong to the beads drawn on the page, and a
     * selection leaves no bead behind to keep them in step.
     */
    function selectionLine(t, value, note) {
      const where = []
      if (value.page) {
        where.push(value.pages
          ? t('sbAnchorPage', { page: value.page, total: value.pages })
          : t('sbAnchorPageSolo', { page: value.page }))
      } else if (value.from) {
        where.push(value.from === value.to
          ? t('sbAnchorLine', { line: value.from })
          : t('sbAnchorLines', { from: value.from, to: value.to }))
      } else if (value.heading) {
        where.push(t('sbAnchorHeading', { heading: value.heading }))
      }
      const quote = value.quote || shrink(value.text, QUOTE_MAX)
      if (quote) where.push(t('selQuote', { quote }))
      const place = [value.path, where.join(' · ')].filter(Boolean).join(' · ')
      const written = note && note.trim() ? note.trim().replace(/\s*\n\s*/g, ' ') : t('promptNoNote')
      return place ? `${place} · ${written}` : written
    }

    /**
     * Copy with the clipboard API, and with a select-and-execCommand fallback:
     * a renderer without clipboard permission (or an old engine) must not turn
     * the menu row into a no-op.
     */
    async function copyText(text) {
      const value = String(text || '')
      if (!value) throw new Error('empty selection')
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return
        }
      } catch { /* fall through to the legacy path */ }
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-10000px'
      area.style.top = '0'
      document.body.appendChild(area)
      try {
        if (typeof area.select === 'function') area.select()
        if (typeof document.execCommand === 'function' && !document.execCommand('copy')) throw new Error('copy refused')
      } finally {
        if (area.parentElement) area.parentElement.removeChild(area)
      }
    }

    // ------------------------------------------------------------------ capture

    /** `webview.capturePage()` is promise-based in current Electron, callback-based in old ones. */
    function capturePage(view) {
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (image) => {
          if (settled) return
          settled = true
          if (image && typeof image.toDataURL === 'function') resolve(image)
          else reject(new Error('empty capture'))
        }
        const fail = (why) => {
          if (settled) return
          settled = true
          reject(why instanceof Error ? why : new Error(String(why)))
        }
        try {
          const pending = view.capturePage()
          if (pending && typeof pending.then === 'function') {
            pending.then(finish, fail)
            return
          }
          if (pending && typeof pending.toDataURL === 'function') {
            finish(pending)
            return
          }
          view.capturePage(undefined, finish)
        } catch (cause) {
          fail(cause)
        }
      })
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('image'))
        image.src = src
      })
    }

    function canvasOf(width, height) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      const context = canvas.getContext && canvas.getContext('2d')
      if (!context) throw new Error('canvas')
      return { canvas, context }
    }

    function toBlob(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error('crop')) }, 'image/png')
      })
    }

    /** Cut one marked box out of the frozen page image, at capture resolution. */
    async function cropSnapshot(source, box) {
      const image = await loadImage(source.src)
      const scale = source.scale > 0 ? source.scale : 1
      const { canvas, context } = canvasOf(box.w * scale, box.h * scale)
      const width = canvas.width
      const height = canvas.height
      context.drawImage(image,
        Math.max(0, Math.round(box.x * scale)), Math.max(0, Math.round(box.y * scale)), width, height,
        0, 0, width, height)
      return toBlob(canvas)
    }

    /**
     * Cut a box out of the page canvas PDF.js painted. The canvas is only
     * mounted for pages near the viewport, so a box whose page went away just
     * loses its picture — the locator still identifies the place.
     */
    async function cropPdfPage(root, box) {
      const page = Number(box.anchor && box.anchor.page) || 0
      if (!page) return null
      const pageNode = query(root, `[data-pdf-page="${page}"]`)
      if (!pageNode) return null
      const canvasNode = query(pageNode, 'canvas')
      if (!canvasNode) return null
      const rect = rectOf(pageNode)
      if (!rect || rect.width <= 0) return null
      const scale = canvasNode.width / rect.width
      const left = box.pageX
      const top = box.pageY
      if (left === undefined || top === undefined) return null
      const { canvas, context } = canvasOf(box.w * scale, box.h * scale)
      context.drawImage(canvasNode,
        Math.max(0, Math.round(left * scale)), Math.max(0, Math.round(top * scale)), canvas.width, canvas.height,
        0, 0, canvas.width, canvas.height)
      return toBlob(canvas)
    }

    /**
     * Cut a box out of the image the preview renders. Unlike PDF there is no
     * page, so the picture itself is the only carrier of detail — and it is
     * already decoded, so the crop is at its natural resolution.
     */
    async function cropImage(target, box, scroll) {
      const image = query(target.root, '[data-image-preview] img') || query(target.root, 'img')
      if (!image) return null
      const rect = rectOf(image)
      if (!rect || rect.width <= 0) return null
      const natural = Number(image.naturalWidth) || rect.width
      const scale = natural / rect.width
      // The box lives in scroll-content pixels; the image sits in the viewport.
      const left = target.rect.left + box.x - (scroll ? scroll.x : 0)
      const top = target.rect.top + box.y - (scroll ? scroll.y : 0)
      const fromX = Math.max(rect.left, left)
      const fromY = Math.max(rect.top, top)
      const toX = Math.min(rect.right, left + box.w)
      const toY = Math.min(rect.bottom, top + box.h)
      if (toX - fromX < 1 || toY - fromY < 1) return null
      const width = (toX - fromX) * scale
      const height = (toY - fromY) * scale
      const { canvas, context } = canvasOf(width, height)
      context.drawImage(image,
        Math.round((fromX - rect.left) * scale), Math.round((fromY - rect.top) * scale), canvas.width, canvas.height,
        0, 0, canvas.width, canvas.height)
      return toBlob(canvas)
    }

    // ------------------------------------------------------------------- prompt

    function locator(t, box, source, options) {
      const anchor = box.anchor || {}
      const withElement = !options || options.element !== false
      const parts = []
      if (source.kind === 'browser') {
        if (box.where) parts.push(box.where)
        if (withElement && box.selector) parts.push(t('sbAnchorElement', { tag: shrink(box.selector, LOCATOR_MAX) }))
        if (box.heading) parts.push(t('sbAnchorHeading', { heading: box.heading }))
        if (box.quote) parts.push(box.quote)
        return parts.join(' · ')
      }
      if (anchor.page) {
        parts.push(anchor.pages ? t('sbAnchorPage', { page: anchor.page, total: anchor.pages }) : t('sbAnchorPageSolo', { page: anchor.page }))
      } else if (anchor.from) {
        parts.push(anchor.from === anchor.to
          ? t('sbAnchorLine', { line: anchor.from })
          : t('sbAnchorLines', { from: anchor.from, to: anchor.to }))
      } else if (anchor.heading) {
        parts.push(t('sbAnchorHeading', { heading: anchor.heading }))
      }
      // No fallback label: the header already names the file, and "this file"
      // on every line is noise. An empty locator just leaves the note alone.
      if (anchor.quote) parts.push(anchor.quote)
      return parts.join(' · ')
    }

    /**
     * One line per region, nothing else: the model reads the crops in the same
     * order, so a header ("I marked N spots…") and a trailer ("locate by the
     * quoted text…") only add noise to every single message.
     */
    function buildLine(t, box, source, number) {
      // The element path is a debugging aid, not something worth showing to the
      // model (or the user): the position word plus the quoted text is what
      // actually locates a region on a page.
      const where = locator(t, box, source, { element: false })
      // A file is not self-evident the way an open page is: keep its path on
      // the line, so the note still says what it is about once it leaves here.
      const path = source && source.path ? source.path : ''
      const place = [path, where].filter(Boolean).join(' · ')
      // One region is one line: a note typed over several lines would otherwise
      // break the draft bookkeeping (a bead is found and removed by its line),
      // so its breaks become spaces here.
      const written = box.note && box.note.trim() ? box.note.trim().replace(/\s*\n\s*/g, ' ') : t('promptNoNote')
      return `${number}. ${place ? `${place} · ` : ''}${written}`
    }

    // -------------------------------------------------------------- composer IO

    /** The session whose composer is on screen: the one the main view retains. */
    function selectMainSession(state) {
      if (!state || !state.byId) return null
      const rows = state.byId
      for (const id of state.ids || Object.keys(rows)) {
        const row = rows[id]
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id
      }
      return null
    }

    /**
     * The composer services behind a session: `conversation` creates drafts,
     * `input` is the same action surface the composer UI calls, so nothing has
     * to be mounted by us.
     */
    function composerFor(ctx, sessionId) {
      let sessions = null
      try { sessions = ctx.get('sessions') } catch { sessions = null }
      if (!sessions) sessions = ctx.sessions
      if (!sessions || !sessionId) return null

      let binding = null
      try { binding = sessions.binding(sessionId) } catch { binding = null }
      if (!binding) return null

      let conversation = null
      try { conversation = binding.ctx.get('conversation') } catch { conversation = null }
      if (!conversation) return null

      let input = null
      try { input = conversation.input.for(binding.ctx) } catch { input = null }
      return { binding, conversation, input }
    }

    /** The draft as plain text, or '' when the input is unavailable. */
    function readDraft(composer) {
      if (!composer || !composer.input || !composer.input.state) return ''
      try {
        const snapshot = composer.input.state.getSnapshot()
        return (snapshot && typeof snapshot.draft === 'string') ? snapshot.draft : ''
      } catch {
        return ''
      }
    }

    /**
     * Which beads still stand for a line in the draft. Returns null when nothing
     * changed, so the caller can skip a render.
     *
     * A bead is dropped once its line is gone from the draft, but only after we
     * have seen that line land there — otherwise the insert itself (which is
     * asynchronous) would look like a send. While the prompt is on its way out
     * every bead goes, even ones we never saw land.
     */
    function pruneBeads(entries, draft, phase) {
      if (phase === 'submitting' || phase === 'sending') return entries.length ? [] : null
      let touched = false
      const next = []
      for (const entry of entries) {
        if (draft.includes(entry.line)) {
          if (entry.seen) next.push(entry)
          else { next.push({ ...entry, seen: true }); touched = true }
          continue
        }
        if (!entry.seen) next.push(entry)
        else touched = true
      }
      return touched ? next : null
    }

    /**
     * Write the crops and the prompt into a session's composer through the
     * conversation service, so no composer component has to be mounted by us.
     */
    function makeCommit(ctx) {
      return async ({ sessionId, files, text }) => {
        const composer = composerFor(ctx, sessionId)
        if (!composer) return { ok: false, code: 'unavailable' }
        const { binding, conversation, input } = composer

        let ordinary = true
        try { ordinary = binding.session.getSnapshot().subagent === null } catch { ordinary = true }

        let drafts = []
        try {
          drafts = conversation.createDrafts(sessionId, files, ordinary) || []
        } catch {
          return { ok: false, code: 'failed' }
        }

        try {
          const outcome = conversation.input.requestDraftInitialization(binding, {
            prompt: text,
            whenDraftExists: 'append',
          })
          if (outcome === 'blocked') {
            conversation.releaseDraftAttachments(drafts)
            return { ok: false, code: 'busy' }
          }
          const ids = drafts.map((draft) => draft.id)
          if (!input || !input.addAttachments(ids)) {
            conversation.releaseDraftAttachments(drafts)
            return { ok: false, code: 'busy' }
          }
          input.focus()
          // The ids travel with the bead so removing it can take the picture too.
          return { ok: true, ids }
        } catch {
          conversation.releaseDraftAttachments(drafts)
          return { ok: false, code: 'failed' }
        }
      }
    }

    // ------------------------------------------------------------- the component

    /**
     * Menu actions run outside React — the registry keeps them after the popup
     * closes — so a selection travels from the menu to the card through this
     * bus instead of reaching into a component instance.
     */
    function createBus() {
      const listeners = new Set()
      return {
        listen(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        send(payload) {
          for (const fn of Array.from(listeners)) {
            try { fn(payload) } catch { /* the component went away */ }
          }
        },
      }
    }

    const selectionBus = createBus()

    /**
     * Floating annotator for the sidebar. Browser tabs are frozen into a bitmap
     * (the webview paints over DOM, so it is hidden while the bitmap is shown);
     * document previews keep living pixels and get a transparent capture layer,
     * because their text must stay queryable for the locators.
     */
    function SidebarAnnotator(props) {
      const t = useMemo(() => resolveT(undefined), [])
      const useSessions = props && props.useSessions
      const sessionId = typeof useSessions === 'function' ? useSessions(selectMainSession) : null
      const commit = useMemo(() => makeCommit(props && props.ctx ? props.ctx : {}), [])

      const [anchor, setAnchor] = useState(null)
      const [shot, setShot] = useState(null)
      const [boxes, setBoxes] = useState([])
      const [selected, setSelected] = useState(null)
      const [dragging, setDragging] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [scroll, setScroll] = useState({ x: 0, y: 0 })
      // Regions already pushed into the composer. They keep their bead on the
      // page (and their number) until the whole draft is sent.
      const [sent, setSent] = useState([])
      const [editing, setEditing] = useState(null)
      // The text an action picked out of the preview, waiting for its note.
      const [mark, setMark] = useState(null)

      const viewRef = useRef(null)
      const viewVisibilityRef = useRef('')
      const stageRef = useRef(null)
      const dragRef = useRef(null)
      const noteRefs = useRef({})
      const shotRef = useRef(null)
      const targetRef = useRef(null)
      const slotRef = useRef(null)
      // Filled in below: the pane poll has to close an open session when the
      // sidebar swaps to another tab, and `cancel` is defined after it.
      const cancelRef = useRef(null)
      // A capture is in flight: two clicks must not start two sessions.
      const openingRef = useRef(false)
      // One write at a time: holding down Enter would otherwise push the same
      // region twice before React re-renders the read-only textarea.
      const writingRef = useRef(false)
      const seqRef = useRef(0)
      const sentRef = useRef([])
      const boxesRef = useRef([])
      const [slotHost, setSlotHost] = useState(null)

      // Keep one placeholder inside the pane's own toolbar, so the icon sits
      // next to the host's reload button instead of floating over the page.
      const placeSlot = useCallback((found) => {
        const chrome = paneChrome(found)
        if (!chrome) {
          setSlotHost(null)
          return
        }
        let slot = slotRef.current
        if (!slot) {
          slot = document.createElement('span')
          slot.className = 'dwa-slot'
          slotRef.current = slot
        }
        if (slot.parentElement !== chrome.host) {
          try { chrome.host.insertBefore(slot, chrome.before || null) } catch { /* host moved on */ }
        }
        setSlotHost((prev) => (prev === slot ? prev : slot))
      }, [])

      // Glue the button to the sidebar pane: it can be dragged, resized, or
      // replaced when another tab takes over.
      useEffect(() => {
        let last = ''
        const sync = () => {
          const found = findTarget()
          // The pane can swap tabs, navigate, or close while a session is open.
          // The frozen bitmap would keep floating over nothing (and a hidden
          // <webview> would stay hidden), so the session ends with its target.
          const open = shotRef.current
          if (open) {
            const bound = targetRef.current
            if (!found || !bound || found.node !== bound.node) {
              if (cancelRef.current) cancelRef.current()
              return
            }
          }
          placeSlot(found)
          const key = found
            ? `${found.kind}:${Math.round(found.rect.left)}:${Math.round(found.rect.top)}:${Math.round(found.rect.width)}:${Math.round(found.rect.height)}`
            : ''
          if (key === last) return
          last = key
          setAnchor(found
            ? { kind: found.kind, left: found.rect.left, top: found.rect.top, width: found.rect.width, height: found.rect.height }
            : null)
        }
        sync()
        const timer = setInterval(sync, 400)
        window.addEventListener('resize', sync)
        return () => {
          clearInterval(timer)
          window.removeEventListener('resize', sync)
          const slot = slotRef.current
          slotRef.current = null
          if (slot && slot.parentElement) slot.parentElement.removeChild(slot)
        }
      }, [placeSlot])

      const unfreeze = useCallback(() => {
        const view = viewRef.current
        viewRef.current = null
        if (!view) return
        // Put back exactly what was there before the page was hidden.
        try { view.style.visibility = viewVisibilityRef.current || '' } catch { /* frame is gone */ }
        viewVisibilityRef.current = ''
      }, [])

      const cancel = useCallback(() => {
        unfreeze()
        shotRef.current = null
        targetRef.current = null
        setShot(null)
        // The regions that were never inserted are gone, so the beads renumber.
        if (renumberRef.current) renumberRef.current(sentRef.current, [], null)
        else setBoxes([])
        setEditing(null)
        setSelected(null)
        setDragging(null)
        setBusy(false)
        setError('')
      }, [unfreeze])
      cancelRef.current = cancel

      useEffect(() => () => unfreeze(), [unfreeze])

      // The context menu only offers the action; the card that follows is the
      // same one the frame tool uses, so the note reads exactly like a drawn one.
      useEffect(() => selectionBus.listen((payload) => {
        const value = payload && payload.value
        if (!value) return
        setEditing(null)
        setSelected(null)
        setMark({ value, note: '', busy: false, error: '' })
      }), [])

      const openMarkup = useCallback(async () => {
        // Already marking, or a capture is on its way: the icon is still
        // visible in the pane's toolbar, so a second click must not start a
        // nested session.
        if (shotRef.current || openingRef.current) return
        openingRef.current = true
        setMark(null)
        const found = findTarget()
        if (!found) {
          // Nothing to mark: the click has to be forgotten, or the guard above
          // would keep the icon dead for the rest of the session.
          openingRef.current = false
          setError(t('sbNoPage'))
          return
        }
        setError('')
        setBusy(true)
        try {
          const width = Math.max(1, Math.round(found.rect.width))
          const height = Math.max(1, Math.round(found.rect.height))
          const left = Math.round(found.rect.left)
          const top = Math.round(found.rect.top)
          if (found.kind === 'browser') {
            if (typeof found.node.capturePage !== 'function') {
              setError(t('sbNoCapture'))
              return
            }
            const image = await capturePage(found.node)
            const src = image.toDataURL('image/png')
            let natural = null
            try { natural = image.getSize() } catch { natural = null }
            let url = ''
            try { url = found.node.getURL() } catch { url = '' }
            const scale = natural && natural.width > 0 ? natural.width / found.rect.width : 1
            shotRef.current = { kind: 'browser', src, scale, width, height, url, left, top, left0: found.rect.left, top0: found.rect.top }
            viewRef.current = found.node
            try {
              // Remember what the page wore, so hiding it here never undoes
              // something the host set for another reason.
              viewVisibilityRef.current = found.node.style.visibility || ''
              found.node.style.visibility = 'hidden'
            } catch { /* not styleable */ }
            targetRef.current = found
            setBoxes([])
            setSelected(null)
            setScroll({ x: 0, y: 0 })
            setShot({ mode: 'frozen', src, width, height, left, top })
          } else {
            const path = documentPath(found.root)
            shotRef.current = { kind: 'document', width, height, left, top, path, url: '' }
            targetRef.current = found
            const current = scrollOf(found)
            setBoxes([])
            setSelected(null)
            setScroll(current)
            setShot({
              mode: 'live',
              width,
              height,
              left,
              top,
              path,
              kind: documentKind(found.root),
            })
          }
        } catch (cause) {
          unfreeze()
          setError(t('errShot', { msg: (cause && cause.message) || 'unknown' }))
        } finally {
          openingRef.current = false
          setBusy(false)
        }
      }, [t, unfreeze])

      useEffect(() => {
        if (!shot) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [shot, cancel])

      // Documents keep scrolling under the boxes, so the overlay has to follow
      // the scrollport instead of freezing it.
      useEffect(() => {
        const target = targetRef.current
        if (!shot || shot.mode !== 'live' || !target || !target.scroll) return undefined
        const node = target.scroll
        const sync = () => {
          const next = scrollOf(target)
          setScroll((previous) => (previous.x === next.x && previous.y === next.y ? previous : next))
        }
        sync()
        node.addEventListener('scroll', sync, { passive: true })
        return () => node.removeEventListener('scroll', sync)
      }, [shot])

      // Beads outlive the overlay: while any of them marks a live document, the
      // document can still be scrolled without the overlay being open.
      useEffect(() => {
        if (!sent.some((entry) => entry.live)) return undefined
        const timer = setInterval(() => {
          const found = findTarget()
          if (!found || found.kind !== 'document') return
          const next = scrollOf(found)
          setScroll((previous) => (previous.x === next.x && previous.y === next.y ? previous : next))
        }, 400)
        return () => clearInterval(timer)
      }, [sent])

      // A bead disappears once its line left the draft — either the message was
      // sent, or the line was deleted by hand.
      useEffect(() => {
        if (!sent.length) return undefined
        const timer = setInterval(() => {
          const services = composerFor(props && props.ctx ? props.ctx : {}, sessionId)
          if (!services || !services.input) return
          let phase = ''
          try {
            const state = services.input.state.getSnapshot()
            phase = state && state.phase ? state.phase : ''
          } catch { phase = '' }
          const draft = readDraft(services)
          const next = pruneBeads(sent, draft, phase)
          // Dropping a bead frees its number, so the live regions close the gap
          // and the drafted lines get rewritten to match.
          if (next) renumberRef.current(next, boxesRef.current, null)
        }, 900)
        return () => clearInterval(timer)
      }, [sent, sessionId])

      const pointIn = (event) => {
        const stage = stageRef.current
        if (!stage) return { x: 0, y: 0 }
        const rect = stage.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }

      const onPointerDown = (event) => {
        if (!shot || event.button !== 0) return
        const point = pointIn(event)
        dragRef.current = { x: point.x, y: point.y, moved: false }
        setDragging({ x: point.x, y: point.y, w: 0, h: 0 })
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* older engines */ }
      }

      const onPointerMove = (event) => {
        const start = dragRef.current
        if (!start) return
        const rect = normalizeRect(start, pointIn(event))
        if (!start.moved && (rect.w > 3 || rect.h > 3)) start.moved = true
        setDragging(rect)
      }

      const onPointerUp = (event) => {
        const start = dragRef.current
        dragRef.current = null
        setDragging(null)
        if (!start) return
        const rect = normalizeRect(start, pointIn(event))
        if (rect.w < MIN_SIDE || rect.h < MIN_SIDE) {
          setSelected(null)
          return
        }
        const source = shotRef.current
        const target = targetRef.current
        if (!source || !target) return
        const id = `b${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
        // `order` only keeps the drawing order; the number a region shows is
        // derived from what is still marked (see `layout`), so cancelling a
        // session and starting over begins at 1 again.
        seqRef.current += 1
        const number = seqRef.current
        const order = number
        setEditing(null)

        if (source.kind === 'browser') {
          // The position word is known right away; the DOM details (element
          // path, heading, quoted text) arrive a moment later. Keeping the word
          // on the box from the start means an immediate Enter still writes a
          // line that says where the region is.
          const where = positionWord(t,
            clamp01((rect.x + rect.w / 2) / Math.max(1, source.width)),
            clamp01((rect.y + rect.h / 2) / Math.max(1, source.height)))
          const box = { id, order, n: number, x: rect.x, y: rect.y, w: rect.w, h: rect.h, note: '', where, anchor: {} }
          renumber(sentRef.current, boxesRef.current.concat(box), null)
          setSelected(id)
          const viewRect = {
            left: target.rect.left + rect.x,
            top: target.rect.top + rect.y,
            width: rect.w,
            height: rect.h,
          }
          void pageAnchor(target.node, viewRect, target).then((found) => {
            setBoxes((previous) => previous.map((item) => (item.id === id
              ? { ...item, selector: found.selector, heading: found.heading, quote: found.quote }
              : item)))
          })
        } else {
          const current = scrollOf(target)
          const viewRect = {
            left: target.rect.left + rect.x,
            top: target.rect.top + rect.y,
            width: rect.w,
            height: rect.h,
          }
          const found = readAnchor(target, viewRect, '.dwa-freeze, .dwa-float, .dwa-sheet')
          let pageX
          let pageY
          if (found.page) {
            const pageNode = query(target.root, `[data-pdf-page="${found.page}"]`)
            const pageRect = pageNode ? rectOf(pageNode) : null
            if (pageRect) {
              // Page-local CSS pixels, so the crop still lines up after scroll.
              pageX = viewRect.left - pageRect.left
              pageY = viewRect.top - pageRect.top
            }
          }
          const box = {
            id,
            order,
            n: number,
            x: rect.x + current.x,
            y: rect.y + current.y,
            w: rect.w,
            h: rect.h,
            pageX,
            pageY,
            note: '',
            anchor: found,
          }
          renumber(sentRef.current, boxesRef.current.concat(box), null)
          setSelected(id)
        }

        setTimeout(() => {
          const node = noteRefs.current[id]
          if (node && typeof node.focus === 'function') node.focus()
        }, 30)
      }

      const onWheel = (event) => {
        const target = targetRef.current
        const node = target && target.scroll
        if (!node) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        node.scrollTop = Number(node.scrollTop || 0) + Number(event.deltaY || 0)
        node.scrollLeft = Number(node.scrollLeft || 0) + Number(event.deltaX || 0)
      }

      const updateNote = (id, note) => {
        setBoxes((previous) => previous.map((box) => (box.id === id ? { ...box, note } : box)))
      }

      const updateSentNote = (order, note) => {
        setSent((previous) => previous.map((entry) => (entry.order === order ? { ...entry, note } : entry)))
      }

      const removeBox = (id) => {
        const rest = boxes.filter((box) => box.id !== id)
        setSelected((current) => (current === id ? null : current))
        // A live region just went away, so the beads after it move up a number.
        renumber(sentRef.current, rest, null)
      }

      /** Composer services for the session on screen, or null. */
      const composer = () => composerFor(props && props.ctx ? props.ctx : {}, sessionId)

      // Live regions, numbered 1..n in the order they were drawn. A bead counts
      // only while it is still on the page, so numbers never skip: deleting the
      // first of three leaves 1 and 2, not 2 and 3.
      const layout = (sentList, boxList) => {
        const items = []
        for (const entry of sentList) items.push({ kind: 'sent', order: entry.order, value: entry })
        for (const box of boxList) items.push({ kind: 'box', order: box.order, value: box })
        items.sort((left, right) => left.order - right.order)
        const nextSent = []
        const nextBoxes = []
        const renames = []
        items.forEach((item, index) => {
          const n = index + 1
          if (item.kind === 'sent') {
            const line = item.value.n === n
              ? item.value.line
              : buildLine(t, { ...item.value.box, note: item.value.note }, item.value.source, n)
            if (line !== item.value.line) renames.push({ from: item.value.line, to: line })
            nextSent.push({ ...item.value, n, line })
          } else {
            nextBoxes.push(item.value.n === n ? item.value : { ...item.value, n })
          }
        })
        return { sent: nextSent, boxes: nextBoxes, renames }
      }

      /**
       * Apply a layout and keep the composer in step: the line of a removed bead
       * goes away, and any line whose number changed is rewritten in place.
       */
      const applyLayout = (next, removedLine) => {
        setSent(next.sent)
        setBoxes(next.boxes)
        if (!next.renames.length && !removedLine) return
        const services = composer()
        if (!services || !services.input) return
        const before = readDraft(services)
        let draft = before
        if (removedLine) {
          draft = draft.split('\n').filter((line) => line.trim() !== removedLine.trim()).join('\n')
        }
        for (const change of next.renames) draft = draft.split(change.from).join(change.to)
        // Nothing to rewrite means the line was already sent (or edited away):
        // touching the draft then would just move the caret around.
        if (draft === before) return
        try { services.input.setDraft(draft) } catch { /* composer is busy */ }
      }

      const renumber = (sentList, boxList, removedLine) => applyLayout(layout(sentList, boxList), removedLine)
      const renumberRef = useRef(null)
      renumberRef.current = renumber
      sentRef.current = sent
      boxesRef.current = boxes

      /** Where a committed region sits in the viewport right now. */
      const bubblePoint = (entry) => {
        const live = entry.live
        // A bead belongs to the pane it was drawn on: when the sidebar swaps to
        // another tab, the current pane's origin would drag the bead onto it.
        const same = !entry.paneKind || (anchor && anchor.kind === entry.paneKind)
        const pane = same ? anchor : null
        const left = pane ? pane.left : entry.left
        const top = pane ? pane.top : entry.top
        return {
          x: left + (live ? entry.box.x - scroll.x : entry.box.x),
          y: top + (live ? entry.box.y - scroll.y : entry.box.y),
        }
      }

      /**
       * Push one region into the composer. The overlay stays open so the next
       * region can be drawn right away; the inserted one turns into a bead.
       */
      const insert = async () => {
        if (!sessionId) {
          setError(t('sbNeedSession'))
          return
        }
        const source = shotRef.current
        const target = targetRef.current
        if (!source || !target) return
        const box = selectedBox || boxes[boxes.length - 1] || null
        if (!box) return
        // Enter auto-repeats; a second pass would append the same region (and
        // crop) twice, so a write already in flight wins.
        if (writingRef.current) return
        writingRef.current = true
        setError('')
        setBusy(true)
        let missed = false
        try {
          const renderer = documentKind(target.root)
          let blob = null
          if (source.kind === 'browser') {
            blob = await cropSnapshot(source, box)
            missed = !blob
          } else if (box.anchor && box.anchor.page) {
            blob = await cropPdfPage(target.root, box)
            missed = !blob
          } else if (renderer === 'image') {
            blob = await cropImage(target, box, scrollOf(target))
            missed = !blob
          }
          const files = blob ? [new File([blob], `page-${box.n}-${stamp()}.png`, { type: 'image/png' })] : []
          const text = buildLine(t, box, { kind: source.kind, url: source.url || '', path: source.path || '' }, box.n)
          const result = await commit({ sessionId, files, text })
          if (!result || result.ok !== true) {
            setError(result && result.code === 'busy' ? t('errBusy') : t('errUnavailable'))
            setBusy(false)
            return
          }
          const pane = anchor
          const entry = {
            order: box.order,
            n: box.n,
            note: box.note,
            line: text,
            box,
            // Kept on the entry: the bead can be reopened long after the shot
            // is gone, and the rewritten line needs the same path as the first.
            source: { kind: source.kind, url: source.url || '', path: source.path || '' },
            live: shot.mode === 'live',
            paneKind: source.kind,
            left: pane ? pane.left : 0,
            top: pane ? pane.top : 0,
            // Draft attachment ids: deleting the bead has to drop the picture as
            // well, otherwise the crop stays attached to the prompt.
            ids: Array.isArray(result.ids) ? result.ids : [],
          }
          // The inserted region leaves the picture; whatever is left renumbers,
          // including the line we just wrote if an older region is still open.
          renumber(sentRef.current.concat(entry), boxesRef.current.filter((item) => item.id !== box.id), null)
          setSelected(null)
          // A page can scroll out of the window between drawing and inserting;
          // the line still locates the spot, but the user should know the
          // picture is missing rather than silently getting a bare note.
          if (missed) setError(t('sbNoCrop'))
        } catch (cause) {
          setError(t('errCrop', { msg: (cause && cause.message) || 'unknown' }))
        } finally {
          writingRef.current = false
          setBusy(false)
        }
      }

      /**
       * Send the pending text selection: no crop, so the note is one line and
       * the draft is the only place it has to land.
       */
      const submitMark = async () => {
        if (!mark || writingRef.current) return
        if (!sessionId) {
          setMark((previous) => (previous ? { ...previous, error: t('sbNeedSession') } : previous))
          return
        }
        writingRef.current = true
        setMark((previous) => (previous ? { ...previous, busy: true, error: '' } : previous))
        try {
          const text = selectionLine(t, mark.value, mark.note)
          const result = await commit({ sessionId, files: [], text })
          if (!result || result.ok !== true) {
            setMark((previous) => (previous
              ? { ...previous, busy: false, error: result && result.code === 'busy' ? t('errBusy') : t('errUnavailable') }
              : previous))
            return
          }
          setMark(null)
        } catch (cause) {
          setMark((previous) => (previous
            ? { ...previous, busy: false, error: t('errAnnotate', { msg: (cause && cause.message) || 'unknown' }) }
            : previous))
        } finally {
          writingRef.current = false
        }
      }

      const closeMark = () => setMark(null)

      /**
       * Rewrite an already inserted line. The composer only exposes a "replace
       * the whole prompt" writer, so the line is swapped inside the current
       * draft text; if the user already edited it by hand the line is appended
       * instead of being lost.
       */
      const commitEdit = async () => {
        if (editing === null) return
        const entry = sent.find((item) => item.order === editing)
        if (!entry || !sessionId) {
          setEditing(null)
          return
        }
        if (writingRef.current) return
        writingRef.current = true
        // The bead remembers what it was drawn on: a session opened later on a
        // different file must not rewrite this line with that file's path.
        const source = shotRef.current
        const shape = entry.source
          || (source
            ? { kind: source.kind, url: source.url || '', path: source.path || '' }
            : { kind: 'document', url: '', path: '' })
        const next = buildLine(t, { ...entry.box, note: entry.note }, shape, entry.n)
        const services = composer()
        setBusy(true)
        try {
          if (next !== entry.line && services && services.input) {
            const draft = readDraft(services)
            if (draft.includes(entry.line)) {
              services.input.setDraft(draft.split(entry.line).join(next))
            } else {
              services.conversation.input.requestDraftInitialization(services.binding, {
                prompt: next,
                whenDraftExists: 'append',
              })
            }
          }
          setSent((previous) => previous.map((item) => (item.order === entry.order ? { ...item, line: next } : item)))
        } catch (cause) {
          setError(t('errCrop', { msg: (cause && cause.message) || 'unknown' }))
        } finally {
          writingRef.current = false
          setBusy(false)
          setEditing(null)
        }
      }

      const selectedBox = selected ? boxes.find((box) => box.id === selected) ?? null : null
      const editingEntry = editing === null ? null : sent.find((item) => item.order === editing) ?? null

      // Beads stay on the page (also after the overlay closes) until the whole
      // draft goes out, so a note can always be found and edited again.
      const beads = sent.map((entry) => {
        const point = bubblePoint(entry)
        return el('button', {
          key: `bead-${entry.order}`,
          type: 'button',
          className: 'dwa-bubble',
          'data-editing': editing === entry.order ? '1' : '0',
          title: entry.note || t('bubbleHint'),
          style: { left: `${Math.round(point.x)}px`, top: `${Math.round(point.y)}px` },
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            setEditing(entry.order)
            setSelected(null)
          },
        }, String(entry.n))
      })

      const viewW = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const viewH = (typeof window !== 'undefined' && window.innerHeight) || 800
      const spotOf = (left, top, width) => ({
        left: Math.min(Math.max(10, Math.round(left)), Math.max(10, viewW - width - 10)),
        top: Math.min(Math.max(10, Math.round(top)), Math.max(10, viewH - 220)),
      })

      /** The card that writes a note: a fresh region, or one already sent. */
      const noteEditor = () => {
        if (editingEntry) {
          return el('textarea', {
            key: `edit-${editingEntry.order}`,
            value: editingEntry.note,
            placeholder: busy ? t('sbInserting') : t('notePlaceholder'),
            readOnly: busy,
            onChange: (event) => updateSentNote(editingEntry.order, event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
              if (event.nativeEvent && event.nativeEvent.isComposing) return
              event.preventDefault()
              void commitEdit()
            },
          })
        }
        if (!selectedBox) return null
        return el('textarea', {
          key: `note-${selectedBox.id}`,
          ref: (node) => {
            if (node) noteRefs.current[selectedBox.id] = node
            else delete noteRefs.current[selectedBox.id]
          },
          value: selectedBox.note,
          placeholder: busy ? t('sbInserting') : t('notePlaceholder'),
          readOnly: busy,
          onChange: (event) => updateNote(selectedBox.id, event.target.value),
          // Enter inserts, Shift+Enter keeps the newline — the card has no
          // button of its own.
          onKeyDown: (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
            if (event.nativeEvent && event.nativeEvent.isComposing) return
            event.preventDefault()
            void insert()
          },
        })
      }

      /**
       * Drop a bead and its line from the composer. The rest renumber, so the
       * numbering keeps matching what is actually on the page (and in the draft).
       */
      const deleteBead = (order) => {
        const entry = sent.find((item) => item.order === order)
        if (!entry) return
        renumber(sentRef.current.filter((item) => item.order !== order), boxesRef.current, entry.line)
        // The line is gone, so its picture has to go too — otherwise the crop
        // stays in the composer and gets sent with nothing pointing at it.
        const services = composer()
        if (services && services.input && Array.isArray(entry.ids)) {
          for (const id of entry.ids) {
            try { services.input.removeAttachment(id) } catch { /* already gone */ }
            try { services.conversation.releaseDraftAttachment(id) } catch { /* already gone */ }
          }
        }
        setEditing(null)
      }

      const closeCard = () => {
        // Closing the card of an inserted region means "I don't want this one":
        // the bead goes away together with the line it put in the composer.
        if (editing !== null) {
          deleteBead(editing)
          return
        }
        cancel()
      }

      if (!shot) {
        const trigger = anchor
          ? el('button', {
            type: 'button',
            className: 'dwa-tool',
            title: t(anchor.kind === 'browser' ? 'sbButtonPage' : 'sbButtonDoc'),
            'aria-label': t(anchor.kind === 'browser' ? 'sbButtonPage' : 'sbButtonDoc'),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => { event.preventDefault(); event.stopPropagation(); void openMarkup() },
          }, el(FrameIcon))
          : null
        const width = Math.min(300, Math.max(232, 260))
        const point = editingEntry ? bubblePoint(editingEntry) : null
        const spot = point ? spotOf(point.x + 16, point.y - 10, width) : { left: 10, top: 10 }
        const card = noteEditor()
        const markWidth = Math.max(232, Math.min(300, Math.round(viewW * 0.28)))
        const markSpot = mark ? spotOf(mark.value.x + 12, mark.value.y + 12, markWidth) : null
        const markSheet = mark
          ? el('div', {
            className: 'dwa-sheet',
            'data-compact': '0',
            style: { left: `${markSpot.left}px`, top: `${markSpot.top}px`, width: `${markWidth}px` },
          },
          el('div', { className: 'dwa-sheet-bar' },
            el('button', { type: 'button', className: 'dwa-x', title: t('close'), onClick: closeMark }, '✕')),
          el('div', { className: 'dwa-quote', title: mark.value.text }, mark.value.quote || mark.value.text),
          el('textarea', {
            autoFocus: true,
            value: mark.note,
            placeholder: mark.busy ? t('sbInserting') : t('notePlaceholder'),
            readOnly: mark.busy,
            onChange: (event) => setMark((previous) => (previous ? { ...previous, note: event.target.value } : previous)),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeMark()
                return
              }
              if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
              if (event.nativeEvent && event.nativeEvent.isComposing) return
              event.preventDefault()
              void submitMark()
            },
          }),
          mark.error ? el('div', { className: 'dwa-error' }, mark.error) : null)
          : null
        return el(React.Fragment, null,
          el('style', null, CSS),
          trigger && slotHost ? createPortal(trigger, slotHost) : null,
          trigger && !slotHost
            ? el('div', {
              className: 'dwa-float',
              style: {
                left: `${Math.max(8, Math.round(anchor.left + anchor.width) - 36)}px`,
                top: `${Math.round(anchor.top) + 6}px`,
              },
            }, trigger)
            : null,
          beads,
          markSheet,
          card
            ? el('div', {
              className: 'dwa-sheet',
              'data-compact': '0',
              style: { left: `${spot.left}px`, top: `${spot.top}px`, width: `${width}px` },
            },
            el('div', { className: 'dwa-sheet-bar' },
              el('button', { type: 'button', className: 'dwa-x', title: editingEntry ? t('bubbleRemove') : t('close'), onClick: closeCard }, '✕')),
            card,
            error ? el('div', { className: 'dwa-error' }, error) : null)
            : null,
          error && anchor && !card
            ? el('div', {
              className: 'dwa-sb-toast',
              style: {
                left: `${Math.max(8, Math.round(anchor.left + anchor.width) - 268)}px`,
                top: `${Math.round(anchor.top) + 46}px`,
              },
            }, error)
            : null)
      }

      const live = shot.mode === 'live'
      // The anchor is the region in viewport pixels: frozen boxes are already
      // relative to the shot, live ones have to lose the current scroll.
      const toViewport = (box) => ({
        x: shot.left + (live ? box.x - scroll.x : box.x),
        y: shot.top + (live ? box.y - scroll.y : box.y),
      })
      const sheetWidth = Math.min(300, Math.max(232, Math.round(shot.width * 0.3)))

      // The editor hugs the region it belongs to: to its right when there is
      // room, else to its left, else above/below — always inside the window.
      function placeSheet(box) {
        const point = toViewport(box)
        const viewW = (typeof window !== 'undefined' && window.innerWidth) || 1280
        const viewH = (typeof window !== 'undefined' && window.innerHeight) || 800
        const gap = 12
        const pad = 10
        const height = 250
        const clampX = (value) => Math.min(Math.max(pad, value), Math.max(pad, viewW - sheetWidth - pad))
        const clampY = (value) => Math.min(Math.max(pad, value), Math.max(pad, viewH - height - pad))
        if (point.x + box.w + gap + sheetWidth <= viewW - pad) {
          return { left: point.x + box.w + gap, top: clampY(point.y) }
        }
        if (point.x - gap - sheetWidth >= pad) {
          return { left: point.x - gap - sheetWidth, top: clampY(point.y) }
        }
        const below = point.y + box.h + gap
        const above = point.y - gap - height
        return {
          left: clampX(point.x),
          top: clampY(below + height <= viewH - pad ? below : above),
        }
      }

      // The note editor only appears once a region exists, and it never sits on
      // top of the picture while a new region is being dragged out.
      // The note editor only appears once a region exists (or a sent bead is
      // reopened), and it never sits on top of the picture while a new region is
      // being dragged out.
      const sheetParts = (!editingEntry && !selectedBox) || dragging
        ? null
        : [
          el('div', { className: 'dwa-sheet-bar' },
            el('button', { type: 'button', className: 'dwa-x', title: editingEntry ? t('bubbleRemove') : t('close'), onClick: closeCard }, '✕')),
          noteEditor(),
          error ? el('div', { className: 'dwa-error' }, error) : null,
        ]

      const frameStyle = {
        left: `${shot.left}px`,
        top: `${shot.top}px`,
        width: `${shot.width}px`,
        height: `${shot.height}px`,
      }
      const stage = el('div', {
        ref: stageRef,
        className: 'dwa-stage',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: () => { dragRef.current = null; setDragging(null) },
        onWheel,
      },
        live ? null : el('img', { src: shot.src, alt: '', draggable: false }),
        boxes.map((box) => {
          // Viewport-relative offset inside the picture; a region drawn flush
          // against the top-left corner would get its badge clipped by the
          // freeze frame, so the badge flips inside for those.
          const boxLeft = live ? box.x - scroll.x : box.x
          const boxTop = live ? box.y - scroll.y : box.y
          return el('div', {
            key: box.id,
            className: 'dwa-sb-box',
            'data-selected': selected === box.id ? '1' : '0',
            'data-inside': boxLeft < 12 || boxTop < 12 ? '1' : '0',
            style: {
              left: `${(boxLeft / Math.max(1, shot.width)) * 100}%`,
              top: `${(boxTop / Math.max(1, shot.height)) * 100}%`,
              width: `${(box.w / Math.max(1, shot.width)) * 100}%`,
              height: `${(box.h / Math.max(1, shot.height)) * 100}%`,
            },
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => { event.stopPropagation(); setEditing(null); setSelected(box.id) },
          },
          el('div', { className: 'dwa-sb-n' }, String(box.n)))
        }),
        dragging
          ? el('div', {
            className: 'dwa-sb-ghost',
            style: {
              left: `${(dragging.x / Math.max(1, shot.width)) * 100}%`,
              top: `${(dragging.y / Math.max(1, shot.height)) * 100}%`,
              width: `${(dragging.w / Math.max(1, shot.width)) * 100}%`,
              height: `${(dragging.h / Math.max(1, shot.height)) * 100}%`,
            },
          })
          : null)

      // A reopened bead is placed by the box it was drawn on; a fresh region by
      // itself. Both live in shot coordinates, so the same placement works.
      const focusBox = editingEntry ? editingEntry.box : selectedBox
      const spot = focusBox ? placeSheet(focusBox) : { left: 10, top: 10 }
      const sheetStyle = {
        left: `${Math.round(spot.left)}px`,
        top: `${Math.round(spot.top)}px`,
        width: `${sheetWidth}px`,
      }

      // A right click anywhere on the picture ends the session, so the user can
      // dismiss it without hunting for the card's close button.
      const surface = el('div', {
        className: 'dwa-freeze',
        'data-mode': shot.mode,
        style: frameStyle,
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          cancel()
        },
      }, stage)

      const sheet = sheetParts
        ? el('div', { className: 'dwa-sheet', 'data-compact': '0', style: sheetStyle }, sheetParts)
        : null

      return createPortal(el(React.Fragment, null, el('style', null, CSS), surface, beads, sheet), document.body)
    }

    return {
      name: 'annotate',
      inject: ['slots', 'contextMenus'],
      apply(ctx) {
        const t = resolveT(undefined)

        // Selected text in a preview normally opens the Electron menu, whose
        // only row is "copy" — it is built in the desktop main process, so no
        // plugin can add to it. The gesture is therefore intercepted before
        // Blink shows it and handed to the harness' own Web menu instead.
        ctx.effect(() => {
          const onContextMenu = (event) => {
            if (!event || (event.button !== undefined && event.button !== 2)) return
            if (event.defaultPrevented) return
            const node = event.target
            if (isTextField(node) || isOwnUi(node)) return
            const root = node && typeof node.closest === 'function' ? node.closest(PREVIEW_ROOT) : null
            const target = documentTarget(root)
            if (!target) return
            const value = selectionInfo(target, event)
            if (!value) return
            // Ours from here on: preventDefault is also what stops the native
            // menu, and the menu plugin listens for the bubble to close itself.
            event.preventDefault()
            event.stopPropagation()
            ctx.contextMenus.open({ kind: SELECTION_TARGET, value }, { x: value.x, y: value.y })
          }
          document.addEventListener('contextmenu', onContextMenu, true)
          return () => document.removeEventListener('contextmenu', onContextMenu, true)
        })

        ctx.effect(() => ctx.contextMenus.register({
          id: 'selection',
          target: SELECTION_TARGET,
          order: 20,
          resolve: (value) => {
            const text = value && value.text ? value.text : ''
            return [
              {
                id: 'copy',
                label: t('menuCopy'),
                failureLabel: t('menuCopyFailed'),
                disabled: !text,
                run: () => copyText(text),
              },
              {
                id: 'annotate',
                label: t('menuAnnotate'),
                run: () => { selectionBus.send({ value }) },
              },
            ]
          },
        }))

        // `shell.overlay` is the frame-wide, click-through layer owned by the
        // shell; the annotator lives there and follows the sidebar pane.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'annotate.page',
          order: 60,
          label: 'Annotate',
        }, (props) => el(SidebarAnnotator, { useSessions: props.useSessions, ctx })))
      },
    }
  },
})
