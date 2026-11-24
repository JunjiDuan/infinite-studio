/**
 * PDF 编辑器界面：页面显示（pdf.js）、缩略图与页面操作、添加 / 编辑对象、表单、撤销重做、保存（writer.js）。
 *
 * 坐标：对象都存在“未旋转的页面”坐标里（单位 pt，左上角为原点，y 向下，相对于 pdf.js 的显示区域）。
 * 页面旋转时，覆盖层整体用 CSS 旋转，所以对象跟着页面内容一起转。
 */
;(function () {
  'use strict'
  var F = window.PdfFonts
  var W = window.PdfWriter
  var CSS_UNITS = 96 / 72
  var t = function (zh, en) {
    return studio.t(zh, en)
  }

  /* ---------------- 状态 ---------------- */

  var S = {
    file: 'document.pdf',
    base: null,
    sources: {}, // 插入的 PDF：id → bytes
    docs: {}, // pdf.js 文档：'base' / id → PDFDocumentProxy
    pages: [], // { key, src, index, rot, baseRot, vx, vy, w, h, objs }
    images: {}, // id → { type, bytes, url }
    form: {},
    meta: null,
    editable: true,
    reason: '',
    tool: 'select',
    sel: null, // { key, id }
    editing: null, // { key, id }
    zoom: 'fit',
    z: 1,
    cur: 0,
    selPages: new Set(),
    history: [],
    hi: -1,
    savedHi: 0,
    clip: null,
    clipText: '',
    lastInk: null,
    loading: false
  }
  /** 每页的运行时数据（DOM、渲染状态），按 key */
  var RT = new Map()
  /** 原有文字的行（编辑原文字 / 高亮吸附）：'src:index' → Promise<lines> */
  var runCache = new Map()
  /** 表单控件：'src:index' → Promise<widgets> */
  var annotCache = new Map()

  var DEFAULT_STYLE = {
    text: { font: 'sans', size: 14, color: '#000000', bold: false, italic: false },
    rect: { stroke: '#e5534b', fill: null, lw: 2, opacity: 1 },
    ellipse: { stroke: '#e5534b', fill: null, lw: 2, opacity: 1 },
    line: { stroke: '#e5534b', lw: 2, opacity: 1 },
    arrow: { stroke: '#e5534b', lw: 2, opacity: 1 },
    pen: { stroke: '#1f4fd1', lw: 2, opacity: 1 },
    highlight: { fill: '#ffe14d', opacity: 0.45 },
    whiteout: { fill: '#ffffff' }
  }
  var style = load('style', DEFAULT_STYLE)
  Object.keys(DEFAULT_STYLE).forEach(function (k) {
    style[k] = Object.assign({}, DEFAULT_STYLE[k], style[k] || {})
  })

  function load(k, d) {
    try {
      var v = JSON.parse(localStorage.getItem('pdf.' + k))
      return v == null ? JSON.parse(JSON.stringify(d)) : v
    } catch (e) {
      return JSON.parse(JSON.stringify(d))
    }
  }
  function store(k, v) {
    try {
      localStorage.setItem('pdf.' + k, JSON.stringify(v))
    } catch (e) {}
  }

  var seq = 0
  var uid = function (p) {
    return p + Date.now().toString(36) + (++seq).toString(36) + Math.random().toString(36).slice(2, 5)
  }

  /* ---------------- DOM 工具 ---------------- */

  var $ = function (id) {
    return document.getElementById(id)
  }
  function h(tag, attrs) {
    var e = tag === 'svg' || tag === 'path' || tag === 'rect' || tag === 'ellipse' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)
    if (attrs)
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null || v === false) continue
        if (k === 'class') e.setAttribute('class', v)
        else if (k === 'style') Object.assign(e.style, v)
        else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2).toLowerCase(), v)
        else if (k === 'html') e.innerHTML = v
        else if (k === 'text') e.textContent = v
        else e.setAttribute(k, v === true ? '' : v)
      }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]
      if (c == null || c === false) continue
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return e
  }
  function clone(o) {
    return JSON.parse(JSON.stringify(o))
  }

  /* ---------------- 图标 ---------------- */

  function ico(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'
  }
  var I = {
    undo: ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    redo: ico('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
    select: ico('<path d="m5 3 14 8-6 2-3 6z"/>'),
    text: ico('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
    edittext: ico('<path d="M4 7V5h10v2M9 5v12M7 17h4"/><path d="m14.5 19.5 6-6-2-2-6 6-.5 2.5z"/>'),
    highlight: ico('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
    whiteout: ico('<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19"/><path d="M22 21H7M5 11l9 9"/>'),
    rect: ico('<rect x="3" y="5" width="18" height="14" rx="1.5"/>'),
    ellipse: ico('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
    line: ico('<path d="M5 19 19 5"/>'),
    arrow: ico('<path d="M5 19 19 5M10 5h9v9"/>'),
    pen: ico('<path d="M3 21c3-1 4-4 6-4s2 3 5 3 4-6 7-7"/><path d="m14 3 4 4-8 8H6v-4z"/>'),
    image: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
    zin: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/>'),
    zout: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>'),
    more: ico('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    rotl: ico('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    rotr: ico('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    dup: ico('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
    del: ico('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    blank: ico('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>'),
    merge: ico('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M14 3v6h6v3M18 15v6M15 18h6"/>'),
    extract: ico('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-7M9 14l3-3 3 3"/>'),
    png: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/>'),
    save: ico('<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8M7 21v-7h10v7"/>'),
    info: ico('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
    font: ico('<path d="M4 20 10 4h1l6 16M6.5 14h8"/><path d="M17 8h4M19 6v4"/>'),
    bold: ico('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
    italic: ico('<path d="M14 5h-4M14 19h-4M15 5l-6 14"/>'),
    trash: ico('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    front: ico('<rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    back: ico('<rect x="4" y="4" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".25"/><path d="M8 16v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-3"/>')
  }

  var TOOLS = [
    { id: 'select', key: 'v', label: ['选择', 'Select'] },
    { id: 'text', key: 't', label: ['添加文字', 'Add text'] },
    { id: 'edittext', key: 'e', label: ['编辑原有文字', 'Edit existing text'] },
    null,
    { id: 'highlight', key: 'h', label: ['高亮', 'Highlight'] },
    { id: 'whiteout', key: 'w', label: ['白色遮盖（擦除）', 'Whiteout (erase)'] },
    null,
    { id: 'rect', key: 'r', label: ['矩形', 'Rectangle'] },
    { id: 'ellipse', key: 'o', label: ['椭圆', 'Ellipse'] },
    { id: 'line', key: 'l', label: ['直线', 'Line'] },
    { id: 'arrow', key: 'a', label: ['箭头', 'Arrow'] },
    { id: 'pen', key: 'p', label: ['画笔 / 签名', 'Pen / signature'] },
    { id: 'image', key: 'i', label: ['插入图片', 'Insert image'] }
  ]
  var HINTS = {
    select: ['点击选中对象，拖动移动；Delete 删除；双击文字修改', 'Click to select, drag to move; Delete removes; double-click text to edit'],
    text: ['在页面上点击添加文字', 'Click on the page to add text'],
    edittext: ['点击页面上原有的文字进行修改（原文字会被遮盖）', 'Click existing text to edit it (the original is covered)'],
    highlight: ['拖动选择要高亮的文字', 'Drag across text to highlight it'],
    whiteout: ['拖出一个区域，用白色盖住', 'Drag a box to cover it with white'],
    rect: ['拖动画矩形', 'Drag to draw a rectangle'],
    ellipse: ['拖动画椭圆', 'Drag to draw an ellipse'],
    line: ['拖动画直线，按住 Shift 保持水平 / 垂直', 'Drag to draw a line; Shift snaps to 45°'],
    arrow: ['拖动画箭头，按住 Shift 保持水平 / 垂直', 'Drag to draw an arrow; Shift snaps to 45°'],
    pen: ['按住拖动手绘（连续画的笔画合成一个对象，适合签名）', 'Drag to draw freehand (quick consecutive strokes become one object)'],
    image: ['在页面上点击放置图片；也可以直接把图片拖进来或粘贴', 'Click to place an image; you can also drop or paste images']
  }

  /* ---------------- pdf.js ---------------- */

  var pdfjsP = null
  function lib() {
    if (!pdfjsP)
      pdfjsP = import('./vendor/pdfjs/pdf.min.mjs').then(function (m) {
        m.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href
        return m
      })
    return pdfjsP
  }

  async function loadPdf(data) {
    var pdfjs = await lib()
    var base = new URL('vendor/pdfjs/', location.href).href
    var task = pdfjs.getDocument({
      data: data,
      cMapUrl: base + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/',
      wasmUrl: base + 'wasm/',
      iccUrl: base + 'iccs/',
      isEvalSupported: false,
      enableXfa: false
    })
    task.onPassword = function (submit, reason) {
      askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then(function (pw) {
        if (pw == null) task.destroy()
        else submit(pw)
      })
    }
    return task.promise
  }

  /** pdf.js 6 的文档对象没有 destroy()，要通过 loadingTask 释放 */
  function destroyDoc(d) {
    try {
      if (d && d.loadingTask) d.loadingTask.destroy()
      else if (d && d.destroy) d.destroy()
    } catch (e) {}
  }

  async function pageInfos(doc) {
    var list = []
    for (var i = 1; i <= doc.numPages; i++) list.push(doc.getPage(i))
    var pages = await Promise.all(list)
    return pages.map(function (p) {
      var v = p.view
      return { w: v[2] - v[0], h: v[3] - v[1], vx: v[0], vy: v[1], rotate: p.rotate || 0 }
    })
  }

  /* ---------------- 页面几何 ---------------- */

  function total(pg) {
    return ((((pg.baseRot || 0) + (pg.rot || 0)) % 360) + 360) % 360
  }
  function dispSize(pg) {
    return total(pg) % 180 ? [pg.h, pg.w] : [pg.w, pg.h]
  }
  /** 屏幕上显示的位置（pt）→ 未旋转的页面坐标 */
  function fromDisp(pg, X, Y) {
    switch (total(pg)) {
      case 90:
        return { x: Y, y: pg.h - X }
      case 180:
        return { x: pg.w - X, y: pg.h - Y }
      case 270:
        return { x: pg.w - Y, y: X }
      default:
        return { x: X, y: Y }
    }
  }
  function toDisp(pg, x, y) {
    switch (total(pg)) {
      case 90:
        return { x: pg.h - y, y: x }
      case 180:
        return { x: pg.w - x, y: pg.h - y }
      case 270:
        return { x: y, y: pg.w - x }
      default:
        return { x: x, y: y }
    }
  }
  /** 新文字 / 图片在旋转过的页面上要反向转，看起来才是正的 */
  function upright(pg) {
    return (360 - total(pg)) % 360
  }
  function pagePoint(pg, e) {
    var r = RT.get(pg.key).el.getBoundingClientRect()
    return fromDisp(pg, (e.clientX - r.left) / S.z, (e.clientY - r.top) / S.z)
  }

  /* ---------------- 对象几何 ---------------- */

  /** 对象在页面上的外框（未旋转页面坐标） */
  function bbox(o) {
    switch (o.type) {
      case 'text':
      case 'image':
        if (o.type === 'text' && !(o.text || '').trim() && o.cover && !(S.editing && S.editing.id === o.id)) return { x: o.cover.x, y: o.cover.y, w: o.cover.w, h: o.cover.h }
        return tbox(o)
      case 'line':
      case 'arrow':
        return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) }
      case 'ink': {
        var x0 = Infinity
        var y0 = Infinity
        var x1 = -Infinity
        var y1 = -Infinity
        ;(o.paths || []).forEach(function (p) {
          for (var i = 0; i < p.length; i += 2) {
            x0 = Math.min(x0, p[i])
            x1 = Math.max(x1, p[i])
            y0 = Math.min(y0, p[i + 1])
            y1 = Math.max(y1, p[i + 1])
          }
        })
        if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
      default:
        return { x: o.x, y: o.y, w: o.w, h: o.h }
    }
  }

  /** 文字 / 图片自己的外框（不算遮盖） */
  function tbox(o) {
    var sw = (o.rot || 0) % 180
    return { x: o.x, y: o.y, w: sw ? o.h : o.w, h: sw ? o.w : o.h }
  }

  function moveObj(o, dx, dy) {
    switch (o.type) {
      case 'line':
      case 'arrow':
        o.x1 += dx
        o.x2 += dx
        o.y1 += dy
        o.y2 += dy
        break
      case 'ink':
        o.paths = o.paths.map(function (p) {
          return p.map(function (v, i) {
            return i % 2 ? v + dy : v + dx
          })
        })
        break
      case 'text':
        if (!(o.text || '').trim() && o.cover) {
          o.cover.x += dx
          o.cover.y += dy
        }
        o.x += dx
        o.y += dy
        break
      default:
        o.x += dx
        o.y += dy
    }
  }

  /** 把对象放进新的外框（缩放） */
  function setBox(o, src, b) {
    switch (o.type) {
      case 'image': {
        var sw = (o.rot || 0) % 180
        o.x = b.x
        o.y = b.y
        o.w = sw ? b.h : b.w
        o.h = sw ? b.w : b.h
        break
      }
      case 'ink': {
        var sb = bbox(src)
        var kx = sb.w ? b.w / sb.w : 1
        var ky = sb.h ? b.h / sb.h : 1
        o.paths = src.paths.map(function (p) {
          return p.map(function (v, i) {
            return i % 2 ? b.y + (v - sb.y) * ky : b.x + (v - sb.x) * kx
          })
        })
        break
      }
      case 'text':
        if (o.cover && !(o.text || '').trim()) {
          o.cover.x = b.x
          o.cover.y = b.y
          o.cover.w = b.w
          o.cover.h = b.h
        }
        break
      default:
        o.x = b.x
        o.y = b.y
        o.w = b.w
        o.h = b.h
    }
  }

  /* ---------------- 文字测量 ---------------- */

  var measurer = null
  function textFont(o) {
    return F.cssFamily(o.font, o.text)
  }
  /** 文字框的大小（pt，未旋转），并保持文字起点不动 */
  function measure(o) {
    if (!measurer) {
      measurer = h('div', { class: 'measure' })
      document.body.appendChild(measurer)
    }
    var text = o.text || ''
    measurer.style.fontFamily = textFont(o)
    measurer.style.fontSize = o.size + 'px'
    measurer.style.fontWeight = o.bold ? '700' : '400'
    measurer.style.fontStyle = o.italic ? 'italic' : 'normal'
    measurer.style.lineHeight = F.LINE
    measurer.textContent = text.replace(/\n$/, '\n ') || ' '
    var w = Math.max(measurer.getBoundingClientRect().width, o.size * 0.4)
    var lines = text.split('\n').length
    resizeText(o, Math.ceil(w * 10) / 10, lines * F.LINE * o.size)
  }
  function resizeText(o, w, hh) {
    if (o.w === w && o.h === hh) return
    if (o.w == null) {
      o.w = w
      o.h = hh
      return
    }
    var p0 = W.local(o, 0, 0)
    o.w = w
    o.h = hh
    var p1 = W.local(o, 0, 0)
    o.x += p0[0] - p1[0]
    o.y += p0[1] - p1[1]
  }

  /* ---------------- 历史 ---------------- */

  function snapshot() {
    return JSON.stringify({ pages: S.pages, form: S.form, meta: S.meta })
  }
  function resetHistory() {
    S.history = [snapshot()]
    S.hi = 0
    S.savedHi = 0
  }
  function commit() {
    var snap = snapshot()
    if (S.history[S.hi] === snap) return
    S.history.length = S.hi + 1
    S.history.push(snap)
    if (S.history.length > 200) {
      S.history.shift()
      S.savedHi--
    }
    S.hi = S.history.length - 1
    dirty()
    updateBar()
  }
  function dirty() {
    studio.setDirty(S.hi !== S.savedHi)
  }
  function restore(i) {
    finishEdit(true)
    var v = JSON.parse(S.history[i])
    S.hi = i
    S.pages = v.pages
    S.form = v.form || {}
    S.meta = v.meta
    if (S.sel && !findObj(S.sel)) S.sel = null
    S.cur = Math.min(S.cur, S.pages.length - 1)
    layout()
    dirty()
  }
  function undo() {
    if (S.hi > 0) restore(S.hi - 1)
  }
  function redo() {
    if (S.hi < S.history.length - 1) restore(S.hi + 1)
  }

  /* ---------------- 查找 ---------------- */

  function pageByKey(key) {
    for (var i = 0; i < S.pages.length; i++) if (S.pages[i].key === key) return S.pages[i]
    return null
  }
  function findObj(ref) {
    var pg = ref && pageByKey(ref.key)
    if (!pg) return null
    for (var i = 0; i < pg.objs.length; i++) if (pg.objs[i].id === ref.id) return { pg: pg, o: pg.objs[i], i: i }
    return null
  }
  function selected() {
    return findObj(S.sel)
  }

  /* ---------------- 打开 ---------------- */

  async function open(bytes, info) {
    S.loading = true
    busy(t('正在打开…', 'Opening…'))
    $('error').hidden = true
    Object.keys(S.docs).forEach(function (k) {
      destroyDoc(S.docs[k])
    })
    Object.keys(S.images).forEach(function (k) {
      if (S.images[k].url) URL.revokeObjectURL(S.images[k].url)
    })
    RT.clear()
    runCache.clear()
    annotCache.clear()
    S.docs = {}
    S.sources = {}
    S.images = {}
    S.form = {}
    S.sel = null
    S.editing = null
    S.selPages = new Set()
    S.cur = 0
    S.file = (info && info.fileName) || S.file
    S.pages = []
    var fresh = false
    // 又来了一次 load（文件在磁盘上变了）：旧的这次作废，不能再改状态
    var gen = ++openGen
    try {
      if (!bytes.byteLength) {
        bytes = await W.blank()
        fresh = true
      }
      var prep = await W.prepare(bytes)
      if (gen !== openGen) return
      var base = await loadPdf(prep.base.slice())
      if (gen !== openGen) return destroyDoc(base)
      var infos = await pageInfos(base)
      if (gen !== openGen) return destroyDoc(base)
      S.editable = prep.editable
      S.reason = prep.reason || ''
      S.base = prep.base
      S.meta = prep.meta
      S.docs.base = base
      S.pages = infos.map(function (p, i) {
        return newPage('base', i, p, prep.overlays[i])
      })
      resetHistory()
      if (S.tool !== 'select') setTool('select')
      if (fresh) {
        S.savedHi = -1
        dirty()
      } else studio.setDirty(false)
      busy(false)
      S.loading = false
      layout()
      $('view').scrollTop = 0
    } catch (e) {
      if (gen !== openGen) return
      busy(false)
      S.loading = false
      showError(e)
    }
  }
  var openGen = 0

  function newPage(src, index, p, overlay) {
    var objs = []
    if (overlay) {
      Object.keys(overlay.images || {}).forEach(function (id) {
        addImageData(id, overlay.images[id].type, overlay.images[id].bytes)
      })
      objs = overlay.objs || []
    }
    return { key: uid('p'), src: src, index: index, rot: 0, baseRot: p.rotate, vx: p.vx, vy: p.vy, w: p.w, h: p.h, objs: objs }
  }

  function addImageData(id, type, bytes) {
    if (S.images[id]) return
    S.images[id] = { type: type, bytes: bytes, url: URL.createObjectURL(new Blob([bytes], { type: type === 'png' ? 'image/png' : 'image/jpeg' })) }
  }

  function showError(e) {
    console.error(e)
    var el = $('error')
    el.replaceChildren(h('b', { text: t('无法打开这个 PDF', 'Cannot open this PDF') }), h('div', { text: String((e && e.message) || e) }))
    el.hidden = false
  }

  /* ---------------- 保存 ---------------- */

  function model(pages) {
    return {
      base: S.base,
      sources: S.sources,
      pages: pages || S.pages,
      images: S.images,
      form: S.form,
      meta: S.meta
    }
  }

  async function buildBytes(pages) {
    finishEdit()
    return W.build(model(pages))
  }

  function needsFont() {
    if (F.get()) return false
    return S.pages.some(function (pg) {
      return pg.objs.some(function (o) {
        return o.type === 'text' && !F.isWinAnsi(o.text || '')
      })
    })
  }

  studio.onSave(async function () {
    if (!S.editable) throw new Error(t('这个 PDF 只能查看，不能保存修改', 'This PDF is view-only'))
    var bytes = await buildBytes()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })
  studio.onSaved(function () {
    S.savedHi = S.hi
  })

  function baseName() {
    return S.file.replace(/\.pdf$/i, '')
  }

  async function saveAs() {
    if (!S.editable) return
    try {
      var bytes = await buildBytes()
      await studio.dialog.save(S.file, new Blob([bytes], { type: 'application/pdf' }))
    } catch (e) {
      studio.toast(String((e && e.message) || e))
    }
  }

  async function exportSelected() {
    var pages = S.pages.filter(function (pg) {
      return selPageKeys().indexOf(pg.key) >= 0
    })
    if (!pages.length || !S.editable) return
    try {
      busy(t('正在导出…', 'Exporting…'))
      var bytes = await buildBytes(pages)
      busy(false)
      var first = S.pages.indexOf(pages[0]) + 1
      var name = baseName() + (pages.length === 1 ? '-p' + first : '-' + pages.length + 'p') + '.pdf'
      await studio.dialog.save(name, new Blob([bytes], { type: 'application/pdf' }))
    } catch (e) {
      busy(false)
      studio.toast(String((e && e.message) || e))
    }
  }

  async function exportPng() {
    var pg = S.pages[S.cur]
    if (!pg) return
    try {
      busy(t('正在导出…', 'Exporting…'))
      var bytes = S.editable ? await buildBytes([pg]) : null
      var doc = bytes ? await loadPdf(bytes) : S.docs[pg.src]
      var page = await doc.getPage(bytes ? 1 : pg.index + 1)
      var vp = page.getViewport({ scale: 2 * CSS_UNITS, rotation: bytes ? page.rotate : total(pg) })
      var canvas = h('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      var ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, canvas: canvas, viewport: vp }).promise
      if (bytes) destroyDoc(doc)
      var blob = await new Promise(function (r) {
        canvas.toBlob(r, 'image/png')
      })
      busy(false)
      await studio.dialog.save(baseName() + '-p' + (S.cur + 1) + '.png', blob)
    } catch (e) {
      busy(false)
      studio.toast(String((e && e.message) || e))
    }
  }

  /* ---------------- 布局与渲染 ---------------- */

  var io = null
  var thumbIo = null
  var visible = new Set()

  function rtFor(pg) {
    var rt = RT.get(pg.key)
    if (rt) return rt
    var el = h('div', { class: 'page', 'data-key': pg.key })
    var ov = h('div', { class: 'ov' })
    var covers = h('div', { class: 'covers' })
    var runs = h('div', { class: 'runs' })
    var forms = h('div', { class: 'forms' })
    var objs = h('div', { class: 'objs' })
    var ui = h('div', { class: 'ui', style: { pointerEvents: 'none' } })
    ov.append(covers, runs, forms, objs, ui)
    el.appendChild(ov)
    rt = { el: el, ov: ov, covers: covers, runs: runs, forms: forms, objs: objs, ui: ui, canvas: null, sig: '', task: null, thumb: null, thumbSig: '' }
    RT.set(pg.key, rt)
    return rt
  }

  function computeZoom() {
    if (S.zoom !== 'fit') return S.zoom * CSS_UNITS
    var pg = S.pages[S.cur] || S.pages[0]
    if (!pg) return CSS_UNITS
    var avail = $('view').clientWidth - 48
    var maxW = 0
    S.pages.forEach(function (p) {
      maxW = Math.max(maxW, dispSize(p)[0])
    })
    return Math.max(0.1, Math.min(4 * CSS_UNITS, avail / (maxW || dispSize(pg)[0])))
  }

  function layout() {
    S.z = computeZoom()
    var host = $('pages')
    var keys = new Set()
    var frag = document.createDocumentFragment()
    S.pages.forEach(function (pg, i) {
      keys.add(pg.key)
      var rt = rtFor(pg)
      rt.el.classList.toggle('cur', i === S.cur)
      sizePage(pg, rt)
      frag.appendChild(rt.el)
    })
    host.replaceChildren(frag)
    RT.forEach(function (rt, k) {
      if (!keys.has(k)) {
        if (rt.task) rt.task.cancel()
        RT.delete(k)
      }
    })
    S.pages.forEach(function (pg) {
      drawPageFull(pg)
    })
    observe()
    renderThumbs()
    updateBar()
    updateProps()
    status()
  }

  function sizePage(pg, rt) {
    var d = dispSize(pg)
    var z = S.z
    rt.el.style.width = Math.round(d[0] * z) + 'px'
    rt.el.style.height = Math.round(d[1] * z) + 'px'
    var W0 = pg.w * z
    var H0 = pg.h * z
    rt.ov.style.width = W0 + 'px'
    rt.ov.style.height = H0 + 'px'
    var r = total(pg)
    rt.ov.style.transform = r === 90 ? 'translate(' + H0 + 'px,0) rotate(90deg)' : r === 180 ? 'translate(' + W0 + 'px,' + H0 + 'px) rotate(180deg)' : r === 270 ? 'translate(0,' + W0 + 'px) rotate(270deg)' : ''
  }

  /** 覆盖层：遮盖、对象、表单、原文字框、选择框 */
  function drawPage(pg) {
    var rt = RT.get(pg.key)
    if (!rt) return
    var z = S.z
    rt.covers.replaceChildren()
    rt.objs.replaceChildren()
    pg.objs.forEach(function (o) {
      if (o.type === 'text' && o.cover) {
        var c = o.cover
        rt.covers.appendChild(h('div', { class: 'cover', style: { left: c.x * z + 'px', top: c.y * z + 'px', width: c.w * z + 'px', height: c.h * z + 'px', background: c.color || '#fff' } }))
      }
      var el = objEl(pg, o)
      if (el) rt.objs.appendChild(el)
    })
    drawUi(pg)
    if (S.editing && S.editing.key === pg.key) bindEditor(pg)
  }

  /** 连同原文字框和表单一起重画（缩放、页面布局变化时） */
  function drawPageFull(pg) {
    drawPage(pg)
    if (visible.has(pg.key)) {
      drawRuns(pg)
      drawForms(pg)
    }
  }

  function objEl(pg, o) {
    var z = S.z
    var op = o.opacity == null ? 1 : o.opacity
    var px = function (v) {
      return v * z + 'px'
    }
    switch (o.type) {
      case 'text': {
        var empty = !(o.text || '').trim()
        if (o.w == null) measure(o)
        var b = bbox(o)
        if (empty && o.cover && !(S.editing && S.editing.id === o.id)) {
          return h('div', { class: 'obj cover-only', 'data-id': o.id, style: { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) } })
        }
        var wrap = h('div', { class: 'obj text', 'data-id': o.id })
        var tx = h('div', { class: 'tx' })
        tx.textContent = o.text || ''
        wrap.appendChild(tx)
        styleText(wrap, tx, o)
        return wrap
      }
      case 'image': {
        var img = S.images[o.img]
        var bi = bbox(o)
        var w = h('div', { class: 'obj image', 'data-id': o.id, style: { left: px(bi.x), top: px(bi.y), width: px(bi.w), height: px(bi.h), opacity: op } })
        if (img)
          w.appendChild(
            h('img', {
              src: img.url,
              draggable: 'false',
              style: { width: px(o.w), height: px(o.h), left: px((bi.w - o.w) / 2), top: px((bi.h - o.h) / 2), transform: o.rot ? 'rotate(' + o.rot + 'deg)' : '' }
            })
          )
        return w
      }
      default:
        return shapeEl(o)
    }
  }

  function styleText(wrap, tx, o) {
    var z = S.z
    var b = tbox(o)
    var fam = textFont(o)
    wrap.style.left = b.x * z + 'px'
    wrap.style.top = b.y * z + 'px'
    wrap.style.width = b.w * z + 'px'
    wrap.style.height = b.h * z + 'px'
    var shift = F.cssShift(fam) * o.size * z
    tx.style.fontFamily = fam
    tx.style.fontSize = o.size * z + 'px'
    tx.style.lineHeight = F.LINE
    tx.style.fontWeight = o.bold ? '700' : '400'
    tx.style.fontStyle = o.italic ? 'italic' : 'normal'
    tx.style.color = o.color || '#000'
    tx.style.opacity = o.opacity == null ? 1 : o.opacity
    tx.style.width = o.w * z + 'px'
    tx.style.height = o.h * z + 'px'
    tx.style.left = ((b.w - o.w) / 2) * z + 'px'
    tx.style.top = ((b.h - o.h) / 2) * z + 'px'
    tx.style.transform = (o.rot ? 'rotate(' + o.rot + 'deg) ' : '') + 'translateY(' + shift + 'px)'
  }

  function shapeEl(o) {
    var z = S.z
    var b = bbox(o)
    var pad = (o.lw || 0) + 10
    var svg = h('svg', {
      class: 'obj',
      'data-id': o.id,
      viewBox: [b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad].join(' '),
      style: { position: 'absolute', left: (b.x - pad) * z + 'px', top: (b.y - pad) * z + 'px', width: (b.w + 2 * pad) * z + 'px', height: (b.h + 2 * pad) * z + 'px' }
    })
    var op = o.opacity == null ? 1 : o.opacity
    var hitW = Math.max(o.lw || 0, 8 / z)
    switch (o.type) {
      case 'rect':
      case 'highlight': {
        var hl = o.type === 'highlight'
        var r = h('rect', {
          x: o.x,
          y: o.y,
          width: o.w,
          height: o.h,
          class: 'fillhit',
          fill: hl ? o.fill || '#ffe14d' : o.fill || 'none',
          'fill-opacity': op,
          stroke: !hl && o.stroke && o.lw > 0 ? o.stroke : 'none',
          'stroke-width': o.lw || 0,
          'stroke-opacity': op
        })
        if (hl) svg.style.mixBlendMode = 'multiply'
        svg.appendChild(r)
        break
      }
      case 'ellipse':
        svg.appendChild(
          h('ellipse', {
            cx: o.x + o.w / 2,
            cy: o.y + o.h / 2,
            rx: o.w / 2,
            ry: o.h / 2,
            class: 'fillhit',
            fill: o.fill || 'none',
            'fill-opacity': op,
            stroke: o.stroke && o.lw > 0 ? o.stroke : 'none',
            'stroke-width': o.lw || 0,
            'stroke-opacity': op
          })
        )
        break
      case 'line':
      case 'arrow':
      case 'ink': {
        var d
        if (o.type === 'ink') d = W.inkPath(o.paths || [])
        else {
          d = 'M' + o.x1 + ' ' + o.y1 + 'L' + o.x2 + ' ' + o.y2
          if (o.type === 'arrow') {
            var hd = W.arrowHead(o)
            d += 'M' + hd[0] + ' ' + hd[1] + 'L' + o.x2 + ' ' + o.y2 + 'L' + hd[2] + ' ' + hd[3]
          }
        }
        svg.appendChild(h('path', { d: d, fill: 'none', stroke: o.stroke, 'stroke-width': o.lw || 2, 'stroke-opacity': op, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
        svg.appendChild(h('path', { d: d, class: 'hit', fill: 'none', stroke: 'transparent', 'stroke-width': hitW, 'stroke-linecap': 'round' }))
        break
      }
    }
    return svg
  }

  /** 选择框和控制点 */
  function drawUi(pg) {
    var rt = RT.get(pg.key)
    if (!rt) return
    rt.ui.replaceChildren()
    var f = S.sel && S.sel.key === pg.key ? selected() : null
    if (!f || (S.editing && S.editing.id === f.o.id)) return
    var o = f.o
    var z = S.z
    var b = bbox(o)
    if (o.type === 'line' || o.type === 'arrow') {
      rt.ui.append(handle('p1', o.x1 * z, o.y1 * z), handle('p2', o.x2 * z, o.y2 * z))
      return
    }
    var box = h('div', { class: 'selbox', style: { left: b.x * z + 'px', top: b.y * z + 'px', width: b.w * z + 'px', height: b.h * z + 'px' } })
    rt.ui.appendChild(box)
    if (!S.editable) return
    var hs = o.type === 'text' && (o.text || '').trim() ? ['se'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    hs.forEach(function (k) {
      var x = k.indexOf('w') >= 0 ? b.x : k.indexOf('e') >= 0 ? b.x + b.w : b.x + b.w / 2
      var y = k.indexOf('n') >= 0 ? b.y : k.indexOf('s') >= 0 ? b.y + b.h : b.y + b.h / 2
      rt.ui.appendChild(handle(k, x * z, y * z))
    })
  }
  function handle(k, x, y) {
    return h('div', { class: 'hd', 'data-h': k, style: { left: x + 'px', top: y + 'px' } })
  }

  /* ---------- 画布渲染 ---------- */

  function observe() {
    if (io) io.disconnect()
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          var key = en.target.dataset.key
          if (en.isIntersecting) {
            visible.add(key)
            var pg = pageByKey(key)
            if (pg) {
              renderPage(pg)
              drawRuns(pg)
              drawForms(pg)
            }
          } else {
            visible.delete(key)
            scheduleDrop(key)
          }
        })
      },
      { root: $('view'), rootMargin: '400px 0px' }
    )
    RT.forEach(function (rt) {
      io.observe(rt.el)
    })
  }

  var dropTimers = {}
  function scheduleDrop(key) {
    clearTimeout(dropTimers[key])
    dropTimers[key] = setTimeout(function () {
      if (visible.has(key)) return
      var rt = RT.get(key)
      if (!rt || !rt.canvas) return
      if (rt.task) rt.task.cancel()
      rt.canvas.remove()
      rt.canvas = null
      rt.sig = ''
    }, 4000)
  }

  async function hasForms(pg) {
    if (pg.src !== 'base') return false
    var list = await widgets(pg)
    return list.length > 0
  }

  async function renderPage(pg) {
    var rt = RT.get(pg.key)
    if (!rt || !pg.src) return
    var dpr = Math.min(3, window.devicePixelRatio || 1)
    var pdfjs = await lib()
    var forms = await hasForms(pg)
    var sig = S.z * dpr + '|' + total(pg) + '|' + forms
    if (rt.sig === sig) return
    rt.sig = sig
    if (rt.task) rt.task.cancel()
    var doc = S.docs[pg.src]
    if (!doc) return
    var page = await doc.getPage(pg.index + 1)
    var vp = page.getViewport({ scale: S.z * dpr, rotation: total(pg) })
    var canvas = h('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    var task = page.render({
      canvasContext: canvas.getContext('2d'),
      canvas: canvas,
      viewport: vp,
      annotationMode: forms ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE
    })
    rt.task = task
    try {
      await task.promise
    } catch (e) {
      if (e && e.name !== 'RenderingCancelledException') console.warn(e)
      if (rt.sig === sig) rt.sig = ''
      return
    }
    if (rt.task === task) rt.task = null
    if (rt.sig !== sig || RT.get(pg.key) !== rt) return
    if (rt.canvas) rt.canvas.replaceWith(canvas)
    else rt.el.insertBefore(canvas, rt.ov)
    rt.canvas = canvas
  }

  var rerenderTimer = 0
  function rerenderVisible(delay) {
    clearTimeout(rerenderTimer)
    rerenderTimer = setTimeout(function () {
      visible.forEach(function (k) {
        var pg = pageByKey(k)
        if (pg) renderPage(pg)
      })
    }, delay || 0)
  }

  /* ---------- 缩略图 ---------- */

  function renderThumbs() {
    var host = $('thumbs')
    if (thumbIo) thumbIo.disconnect()
    thumbIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) renderThumb(pageByKey(en.target.dataset.key))
        })
      },
      { root: host, rootMargin: '300px 0px' }
    )
    var keys = selPageKeys()
    var frag = document.createDocumentFragment()
    S.pages.forEach(function (pg, i) {
      var rt = RT.get(pg.key)
      var d = dispSize(pg)
      var tw = 120
      var th = Math.round((tw * d[1]) / d[0])
      if (th > 170) {
        th = 170
        tw = Math.round((170 * d[0]) / d[1])
      }
      if (!rt.thumb) {
        rt.thumb = h('div', { class: 'thumb', 'data-key': pg.key, draggable: 'true' }, h('div', { class: 'tpage' }), h('div', { class: 'num' }))
      }
      var tp = rt.thumb.firstChild
      tp.style.width = tw + 'px'
      tp.style.height = th + 'px'
      rt.thumb.lastChild.textContent = String(i + 1)
      rt.thumb.classList.toggle('cur', i === S.cur)
      rt.thumb.classList.toggle('sel', keys.indexOf(pg.key) >= 0 && keys.length > 1)
      var badge = tp.querySelector('.badge')
      if (pg.objs.length && !badge) tp.appendChild(h('div', { class: 'badge', title: t('有添加的内容', 'Has added content') }))
      else if (!pg.objs.length && badge) badge.remove()
      frag.appendChild(rt.thumb)
      thumbIo.observe(rt.thumb)
    })
    host.replaceChildren(frag)
  }

  async function renderThumb(pg) {
    if (!pg || !pg.src) return
    var rt = RT.get(pg.key)
    var sig = total(pg) + ''
    if (!rt || rt.thumbSig === sig) return
    rt.thumbSig = sig
    var doc = S.docs[pg.src]
    var page = await doc.getPage(pg.index + 1)
    var d = dispSize(pg)
    var dpr = Math.min(2, window.devicePixelRatio || 1)
    var vp = page.getViewport({ scale: (140 / Math.max(d[0], d[1] * 0.7)) * dpr, rotation: total(pg) })
    var canvas = h('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    try {
      await page.render({ canvasContext: canvas.getContext('2d'), canvas: canvas, viewport: vp }).promise
    } catch (e) {
      rt.thumbSig = ''
      return
    }
    if (rt.thumbSig !== sig) return
    var tp = rt.thumb.firstChild
    var old = tp.querySelector('canvas')
    if (old) old.replaceWith(canvas)
    else tp.insertBefore(canvas, tp.firstChild)
  }

  /* ---------------- 原有文字 ---------------- */

  function runKey(pg) {
    return pg.src + ':' + pg.index
  }

  function textRuns(pg) {
    if (!pg.src) return Promise.resolve([])
    var k = runKey(pg)
    if (!runCache.has(k)) runCache.set(k, loadRuns(pg))
    return runCache.get(k)
  }

  async function loadRuns(pg) {
    var pdfjs = await lib()
    var page = await S.docs[pg.src].getPage(pg.index + 1)
    var tc = await page.getTextContent()
    var vp = page.getViewport({ scale: 1, rotation: 0 })
    var items = []
    tc.items.forEach(function (it) {
      if (!it.str || !it.transform) return
      var tx = pdfjs.Util.transform(vp.transform, it.transform)
      var fs = Math.hypot(tx[2], tx[3])
      if (fs < 1 || tx[0] <= 0 || Math.abs(tx[1]) > fs * 0.02 || Math.abs(tx[2]) > fs * 0.02) return
      var st = tc.styles[it.fontName] || {}
      var asc = st.ascent || 0.8
      var desc = st.descent || -0.2
      if (asc - desc < 0.6) {
        asc = 0.8
        desc = -0.2
      }
      var fo = null
      try {
        if (page.commonObjs.has(it.fontName)) fo = page.commonObjs.get(it.fontName)
      } catch (e) {}
      var name = ((fo && fo.name) || '') + ' ' + (st.fontFamily || '')
      items.push({
        str: it.str,
        x: tx[4],
        base: tx[5],
        w: it.width,
        fs: fs,
        asc: asc,
        desc: desc,
        family: /mono|courier|consol/i.test(name) ? 'mono' : /serif|times|song|ming|roman|georgia|garamond|cambria/i.test(name) && !/sans/i.test(name) ? 'serif' : 'sans',
        bold: !!(fo && (fo.bold || fo.black)) || /bold|black|heavy|semibold|demi/i.test(name),
        italic: !!(fo && fo.italic) || /italic|oblique/i.test(name)
      })
    })
    // 同一行上挨着的片段合成一行
    var lines = []
    var cur = null
    items.forEach(function (it) {
      if (!it.str.trim() && !cur) return
      if (cur && Math.abs(it.base - cur.base) < cur.fs * 0.25 && Math.abs(it.fs - cur.fs) < cur.fs * 0.2) {
        var gap = it.x - (cur.x + cur.w)
        if (gap > -cur.fs * 0.5 && gap < cur.fs * 1.2) {
          var sp = gap > cur.fs * 0.18 && !/\s$/.test(cur.str) && !/^\s/.test(it.str)
          cur.str += (sp ? ' ' : '') + it.str
          cur.w = Math.max(cur.w, it.x + it.w - cur.x)
          return
        }
      }
      if (!it.str.trim()) return
      cur = Object.assign({}, it)
      lines.push(cur)
    })
    return lines
      .map(function (l) {
        l.str = l.str.replace(/\s+$/, '')
        l.y = l.base - l.asc * l.fs
        l.h = (l.asc - l.desc) * l.fs
        return l
      })
      .filter(function (l) {
        return l.str && l.w > 0
      })
  }

  function drawRuns(pg) {
    var rt = RT.get(pg.key)
    if (!rt) return
    if (S.tool !== 'edittext' || !S.editable) {
      if (rt.runs.firstChild) rt.runs.replaceChildren()
      return
    }
    textRuns(pg).then(function (lines) {
      if (S.tool !== 'edittext' || RT.get(pg.key) !== rt) return
      var z = S.z
      // 已经改过的原文字（被遮盖的）不再显示框
      var covered = pg.objs
        .filter(function (o) {
          return o.cover
        })
        .map(function (o) {
          return o.cover
        })
      rt.runs.replaceChildren()
      lines.forEach(function (l, i) {
        var hidden = covered.some(function (c) {
          return l.x >= c.x - 1 && l.y >= c.y - 1 && l.x + l.w <= c.x + c.w + 1 && l.y + l.h <= c.y + c.h + 1
        })
        if (hidden) return
        rt.runs.appendChild(h('div', { class: 'run', 'data-run': String(i), style: { left: l.x * z + 'px', top: l.y * z + 'px', width: l.w * z + 'px', height: l.h * z + 'px' } }))
      })
    })
  }

  /** 从画布上取颜色：原文字的颜色和背景色 */
  function sampleColors(pg, l) {
    var rt = RT.get(pg.key)
    var res = { bg: '#ffffff', fg: '#000000' }
    if (!rt || !rt.canvas) return res
    try {
      var c = rt.canvas
      var d = dispSize(pg)
      var k = c.width / d[0]
      var ctx = c.getContext('2d', { willReadFrequently: true })
      var px = function (x, y) {
        var p = toDisp(pg, x, y)
        var X = Math.max(0, Math.min(c.width - 1, Math.round(p.x * k)))
        var Y = Math.max(0, Math.min(c.height - 1, Math.round(p.y * k)))
        var v = ctx.getImageData(X, Y, 1, 1).data
        return [v[0], v[1], v[2]]
      }
      var m = 1.5
      var bgs = [px(l.x - m, l.y - m), px(l.x + l.w + m, l.y - m), px(l.x - m, l.y + l.h + m), px(l.x + l.w + m, l.y + l.h + m), px(l.x + l.w / 2, l.y - m), px(l.x + l.w / 2, l.y + l.h + m)]
      var lum = function (v) {
        return v[0] * 0.299 + v[1] * 0.587 + v[2] * 0.114
      }
      bgs.sort(function (a, b) {
        return lum(a) - lum(b)
      })
      var bg = bgs[Math.floor(bgs.length / 2)]
      // 文字的颜色：框内和背景差别最大的像素（逐像素扫，抗锯齿的边缘偏浅，只有笔画中心是真实颜色）
      var a = toDisp(pg, l.x, l.y)
      var b = toDisp(pg, l.x + l.w, l.y + l.h)
      var X0 = Math.max(0, Math.floor(Math.min(a.x, b.x) * k))
      var Y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) * k))
      var X1 = Math.min(c.width, Math.ceil(Math.max(a.x, b.x) * k))
      var Y1 = Math.min(c.height, Math.ceil(Math.max(a.y, b.y) * k))
      var best = null
      var bestD = 60
      if (X1 > X0 && Y1 > Y0) {
        var data = ctx.getImageData(X0, Y0, X1 - X0, Y1 - Y0).data
        for (var q = 0; q < data.length; q += 4) {
          var dd = Math.abs(data[q] - bg[0]) + Math.abs(data[q + 1] - bg[1]) + Math.abs(data[q + 2] - bg[2])
          if (dd > bestD) {
            bestD = dd
            best = [data[q], data[q + 1], data[q + 2]]
          }
        }
      }
      var toHex = function (v) {
        return (
          '#' +
          v
            .map(function (n) {
              return ('0' + n.toString(16)).slice(-2)
            })
            .join('')
        )
      }
      res.bg = toHex(bg)
      if (best) {
        // 抗锯齿的像素偏浅，接近黑色时直接用黑色
        res.fg = lum(best) < 70 && Math.max(best[0], best[1], best[2]) - Math.min(best[0], best[1], best[2]) < 40 ? '#000000' : toHex(best)
      }
    } catch (e) {}
    return res
  }

  function convertRun(pg, l, at) {
    var col = sampleColors(pg, l)
    var size = Math.round(l.fs * 2) / 2
    var o = {
      id: uid('o'),
      type: 'text',
      text: l.str,
      size: size,
      font: l.family,
      bold: l.bold,
      italic: l.italic,
      color: col.fg,
      rot: 0,
      x: l.x,
      y: l.base - F.BASELINE * size,
      cover: { x: l.x - 1, y: l.y - 1, w: l.w + 2, h: l.h + 2, color: col.bg }
    }
    measure(o)
    pg.objs.push(o)
    startEdit(pg, o, false, at)
    drawRuns(pg)
  }

  /* ---------------- 表单 ---------------- */

  function widgets(pg) {
    if (pg.src !== 'base') return Promise.resolve([])
    var k = runKey(pg)
    if (!annotCache.has(k)) {
      annotCache.set(
        k,
        S.docs.base
          .getPage(pg.index + 1)
          .then(function (page) {
            return page.getAnnotations({ intent: 'display' }).then(function (list) {
              var vp = page.getViewport({ scale: 1, rotation: 0 })
              return list
                .filter(function (a) {
                  return a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton && (a.fieldType === 'Tx' || a.fieldType === 'Btn' || a.fieldType === 'Ch')
                })
                .map(function (a) {
                  // pdf.js 6 去掉了 convertToViewportRectangle：用两个角换算
                  var p1 = vp.convertToViewportPoint(a.rect[0], a.rect[1])
                  var p2 = vp.convertToViewportPoint(a.rect[2], a.rect[3])
                  a.box = { x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]) }
                  return a
                })
            })
          })
          .catch(function () {
            return []
          })
      )
    }
    return annotCache.get(k)
  }

  function fieldValue(a) {
    if (Object.prototype.hasOwnProperty.call(S.form, a.fieldName)) return S.form[a.fieldName]
    if (a.fieldType === 'Btn' && a.checkBox) return !!a.fieldValue && a.fieldValue !== 'Off'
    return a.fieldValue
  }

  function drawForms(pg) {
    var rt = RT.get(pg.key)
    if (!rt) return
    widgets(pg).then(function (list) {
      if (RT.get(pg.key) !== rt) return
      if (!list.length) return
      var z = S.z
      rt.forms.replaceChildren()
      list.forEach(function (a) {
        var b = a.box
        var st = { left: b.x * z + 'px', top: b.y * z + 'px', width: b.w * z + 'px', height: b.h * z + 'px' }
        var v = fieldValue(a)
        var el
        var ro = a.readOnly || !S.editable
        if (a.fieldType === 'Tx') {
          var fsz = (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || 0
          if (!fsz) fsz = a.multiLine ? 10 : Math.max(6, Math.min(14, b.h * 0.65))
          st.fontSize = fsz * z + 'px'
          if (a.textAlignment === 1) st.textAlign = 'center'
          else if (a.textAlignment === 2) st.textAlign = 'right'
          el = a.multiLine ? h('textarea', { class: 'field', style: st }) : h('input', { class: 'field', type: a.password ? 'password' : 'text', style: st })
          el.value = v == null ? '' : String(v)
          if (a.maxLen) el.maxLength = a.maxLen
          el.addEventListener('input', function () {
            setField(a.fieldName, el.value, el, false)
          })
          el.addEventListener('change', function () {
            commit()
          })
        } else if (a.fieldType === 'Btn') {
          if (a.radioButton) {
            el = h('input', { class: 'field', type: 'radio', name: pg.key + ':' + a.fieldName, style: st })
            el.checked = v === a.buttonValue
            el.addEventListener('change', function () {
              setField(a.fieldName, a.buttonValue, el, true)
            })
          } else {
            el = h('input', { class: 'field', type: 'checkbox', style: st })
            el.checked = !!v
            el.addEventListener('change', function () {
              setField(a.fieldName, el.checked, el, true)
            })
          }
        } else {
          st.fontSize = Math.max(8, Math.min(13, b.h * 0.6)) * z + 'px'
          el = h('select', { class: 'field', style: st })
          if (a.multiSelect) el.multiple = true
          if (a.combo && !a.multiSelect) el.appendChild(h('option', { value: '', text: '' }))
          var vals = Array.isArray(v) ? v : [v]
          ;(a.options || []).forEach(function (op) {
            var o = h('option', { value: op.exportValue, text: op.displayValue })
            o.selected = vals.indexOf(op.exportValue) >= 0 || vals.indexOf(op.displayValue) >= 0
            el.appendChild(o)
          })
          el.addEventListener('change', function () {
            var sel = Array.prototype.filter
              .call(el.options, function (o) {
                return o.selected
              })
              .map(function (o) {
                return o.value
              })
            setField(a.fieldName, a.multiSelect ? sel : sel[0] || '', el, true)
          })
        }
        el.dataset.field = a.fieldName
        el.dataset.btn = a.buttonValue || ''
        if (ro) el.disabled = true
        rt.forms.appendChild(el)
      })
    })
  }

  function setField(name, value, from, doCommit) {
    S.form[name] = value
    // 同名字段（多处出现的同一个字段）一起更新
    document.querySelectorAll('.field').forEach(function (el) {
      if (el === from || el.dataset.field !== name) return
      if (el.type === 'checkbox') el.checked = !!value
      else if (el.type === 'radio') el.checked = el.dataset.btn === value
      else if (el.tagName !== 'SELECT') el.value = value
    })
    if (doCommit) commit()
    else studio.setDirty(true)
  }

  /* ---------------- 选择与编辑 ---------------- */

  function select(pg, id) {
    var prev = S.sel && pageByKey(S.sel.key)
    S.sel = pg && id ? { key: pg.key, id: id } : null
    if (prev && prev !== pg) drawUi(prev)
    if (pg) drawUi(pg)
    updateProps()
  }

  /** 开始编辑文字：selectAll 全选；at（屏幕坐标）把光标放到点击的位置；都没有时光标在末尾 */
  function startEdit(pg, o, selectAll, at) {
    if (!S.editable) return
    finishEdit()
    S.editing = { key: pg.key, id: o.id }
    S.sel = { key: pg.key, id: o.id }
    drawPage(pg)
    var tx = editorEl(pg, o)
    var range = null
    if (tx && selectAll) {
      range = document.createRange()
      range.selectNodeContents(tx)
    } else if (tx && at && document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(at.x, at.y)
      if (r && tx.contains(r.startContainer)) range = r
    }
    if (range) {
      var s = window.getSelection()
      s.removeAllRanges()
      s.addRange(range)
    }
    updateProps()
  }

  function editorEl(pg, o) {
    var rt = RT.get(pg.key)
    var wrap = rt && rt.objs.querySelector('[data-id="' + o.id + '"]')
    return wrap && wrap.querySelector('.tx')
  }

  /** 正在编辑的文字：页面每次重画后让新的元素继续可编辑（光标放到末尾） */
  function bindEditor(pg) {
    var f = findObj(S.editing)
    if (!f) return
    var o = f.o
    var tx = editorEl(pg, o)
    if (!tx) return
    var wrap = tx.parentNode
    wrap.classList.add('editing')
    try {
      tx.contentEditable = 'plaintext-only'
    } catch (e) {
      tx.contentEditable = 'true'
    }
    tx.spellcheck = false
    tx.focus()
    var range = document.createRange()
    range.selectNodeContents(tx)
    range.collapse(false)
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    tx.addEventListener('input', function () {
      o.text = tx.innerText.replace(/\n$/, '')
      measure(o)
      styleText(wrap, tx, o)
    })
    tx.addEventListener('blur', function () {
      setTimeout(function () {
        if (!S.editing || S.editing.id !== o.id) return
        var a = document.activeElement
        if (a && a.closest && a.closest('[data-id="' + o.id + '"]')) return
        finishEdit()
      })
    })
  }

  function finishEdit(silent) {
    if (!S.editing) return
    var f = findObj(S.editing)
    if (!f) {
      S.editing = null
      return
    }
    var o = f.o
    var tx = editorEl(f.pg, o)
    if (tx && tx.isContentEditable) o.text = tx.innerText.replace(/\n$/, '')
    S.editing = null
    if (!(o.text || '').trim() && !o.cover) {
      f.pg.objs.splice(f.i, 1)
      if (S.sel && S.sel.id === o.id) S.sel = null
    } else measure(o)
    drawPage(f.pg)
    renderThumbs()
    if (!silent) commit()
    updateProps()
  }

  function deleteSelected() {
    var f = selected()
    if (!f || !S.editable) return
    f.pg.objs.splice(f.i, 1)
    S.sel = null
    drawPage(f.pg)
    renderThumbs()
    commit()
    updateProps()
  }

  function reorderSelected(front) {
    var f = selected()
    if (!f) return
    f.pg.objs.splice(f.i, 1)
    if (front) f.pg.objs.push(f.o)
    else f.pg.objs.unshift(f.o)
    drawPage(f.pg)
    commit()
  }

  function addObj(pg, o, noSelect) {
    o.id = o.id || uid('o')
    pg.objs.push(o)
    if (!noSelect) S.sel = { key: pg.key, id: o.id }
    drawPage(pg)
    renderThumbs()
    commit()
    updateProps()
  }

  function duplicateSelected() {
    var f = selected()
    if (!f || !S.editable) return
    var o = clone(f.o)
    o.id = uid('o')
    delete o.cover
    moveObj(o, 10, 10)
    addObj(f.pg, o)
  }

  /* ---------------- 指针操作 ---------------- */

  function onPointerDown(e) {
    if (e.button !== 0) return
    var pageEl = e.target.closest('.page')
    if (!pageEl) {
      if (e.target === $('view') || e.target === $('pages')) {
        finishEdit()
        select(null)
      }
      return
    }
    var pg = pageByKey(pageEl.dataset.key)
    if (!pg) return
    setCur(S.pages.indexOf(pg), false)
    if (e.target.closest('.field')) return
    if (S.editing) {
      var ed = e.target.closest('.obj.text.editing')
      if (ed) return
      finishEdit()
    }
    if (!S.editable) return
    var p = pagePoint(pg, e)
    var hd = e.target.closest('.hd')
    var objElm = e.target.closest('[data-id]')
    var f = objElm ? findObj({ key: pg.key, id: objElm.getAttribute('data-id') }) : null
    if (hd && selected()) {
      e.preventDefault()
      return dragResize(pg, selected().o, hd.dataset.h, p, e)
    }
    switch (S.tool) {
      case 'select':
        if (f) {
          e.preventDefault()
          select(pg, f.o.id)
          dragMove(pg, f.o, p, e)
        } else select(null)
        break
      case 'text':
        e.preventDefault()
        if (f && f.o.type === 'text') startEdit(pg, f.o, false, { x: e.clientX, y: e.clientY })
        else createText(pg, p)
        break
      case 'edittext': {
        e.preventDefault()
        if (f && f.o.type === 'text') {
          startEdit(pg, f.o, false, { x: e.clientX, y: e.clientY })
          break
        }
        var at = { x: e.clientX, y: e.clientY }
        var runEl = e.target.closest('.run')
        if (runEl)
          textRuns(pg).then(function (lines) {
            var l = lines[+runEl.dataset.run]
            if (l) convertRun(pg, l, at)
          })
        else select(null)
        break
      }
      case 'highlight':
      case 'whiteout':
      case 'rect':
      case 'ellipse':
        e.preventDefault()
        dragBox(pg, p, e)
        break
      case 'line':
      case 'arrow':
        e.preventDefault()
        dragLine(pg, p, e)
        break
      case 'pen':
        e.preventDefault()
        dragInk(pg, p, e)
        break
      case 'image':
        e.preventDefault()
        pickImage(pg, p)
        break
    }
  }

  function onDblClick(e) {
    var pageEl = e.target.closest('.page')
    if (!pageEl || !S.editable) return
    var pg = pageByKey(pageEl.dataset.key)
    var objElm = e.target.closest('[data-id]')
    var f = objElm && findObj({ key: pg.key, id: objElm.getAttribute('data-id') })
    if (f && f.o.type === 'text') startEdit(pg, f.o, false, { x: e.clientX, y: e.clientY })
  }

  /** 拖动：move(p, e) 每次移动时调用，返回 false 时取消；up(moved) 松开时调用 */
  function drag(pg, e, move, up) {
    var moved = false
    var sx = e.clientX
    var sy = e.clientY
    function mm(ev) {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return
      moved = true
      move(pagePoint(pg, ev), ev)
    }
    function mu(ev) {
      window.removeEventListener('pointermove', mm)
      window.removeEventListener('pointerup', mu)
      window.removeEventListener('pointercancel', mu)
      up(moved, pagePoint(pg, ev), ev)
    }
    window.addEventListener('pointermove', mm)
    window.addEventListener('pointerup', mu)
    window.addEventListener('pointercancel', mu)
  }

  function dragMove(pg, o, p0, e) {
    var orig = clone(o)
    drag(
      pg,
      e,
      function (p) {
        Object.assign(o, clone(orig))
        moveObj(o, p.x - p0.x, p.y - p0.y)
        drawPage(pg)
      },
      function (moved) {
        if (moved) commit()
      }
    )
  }

  function dragResize(pg, o, k, p0, e) {
    var orig = clone(o)
    var b0 = bbox(orig)
    drag(
      pg,
      e,
      function (p, ev) {
        Object.assign(o, clone(orig))
        if (k === 'p1' || k === 'p2') {
          var q = ev.shiftKey ? snap45(k === 'p1' ? orig.x2 : orig.x1, k === 'p1' ? orig.y2 : orig.y1, p) : p
          o[k === 'p1' ? 'x1' : 'x2'] = q.x
          o[k === 'p1' ? 'y1' : 'y2'] = q.y
        } else if (o.type === 'text') {
          // 文字只有右下角：按高度等比改字号
          var nh = Math.max(4, p.y - b0.y)
          o.size = Math.max(4, Math.round(orig.size * (nh / b0.h) * 2) / 2)
          o.w = null
          o.x = orig.x
          o.y = orig.y
          measure(o)
        } else {
          var x0 = b0.x
          var y0 = b0.y
          var x1 = b0.x + b0.w
          var y1 = b0.y + b0.h
          if (k.indexOf('w') >= 0) x0 = Math.min(p.x, x1 - 2)
          if (k.indexOf('e') >= 0) x1 = Math.max(p.x, x0 + 2)
          if (k.indexOf('n') >= 0) y0 = Math.min(p.y, y1 - 2)
          if (k.indexOf('s') >= 0) y1 = Math.max(p.y, y0 + 2)
          // 图片拖角时保持比例（按住 Shift 自由缩放）
          if (o.type === 'image' && k.length === 2 && !ev.shiftKey && b0.w && b0.h) {
            var ratio = b0.w / b0.h
            var nw = x1 - x0
            var nh2 = y1 - y0
            if (nw / nh2 > ratio) nw = nh2 * ratio
            else nh2 = nw / ratio
            if (k.indexOf('w') >= 0) x0 = x1 - nw
            else x1 = x0 + nw
            if (k.indexOf('n') >= 0) y0 = y1 - nh2
            else y1 = y0 + nh2
          }
          setBox(o, orig, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
        }
        drawPage(pg)
      },
      function (moved) {
        if (moved) {
          commit()
          updateProps()
        }
      }
    )
  }

  function snap45(x0, y0, p) {
    var dx = p.x - x0
    var dy = p.y - y0
    var ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    var len = Math.hypot(dx, dy)
    return { x: x0 + Math.cos(ang) * len, y: y0 + Math.sin(ang) * len }
  }

  function dragBox(pg, p0, e) {
    var tool = S.tool
    var st = style[tool]
    var o = { id: uid('o'), type: tool === 'whiteout' ? 'rect' : tool, x: p0.x, y: p0.y, w: 0, h: 0 }
    if (tool === 'whiteout') Object.assign(o, { fill: st.fill, stroke: null, lw: 0, opacity: 1 })
    else if (tool === 'highlight') Object.assign(o, { fill: st.fill, opacity: st.opacity })
    else Object.assign(o, { stroke: st.stroke, fill: st.fill, lw: st.lw, opacity: st.opacity })
    pg.objs.push(o)
    drag(
      pg,
      e,
      function (p, ev) {
        var x1 = p.x
        var y1 = p.y
        if (ev.shiftKey && tool !== 'highlight') {
          var s = Math.max(Math.abs(x1 - p0.x), Math.abs(y1 - p0.y))
          x1 = p0.x + Math.sign(x1 - p0.x || 1) * s
          y1 = p0.y + Math.sign(y1 - p0.y || 1) * s
        }
        o.x = Math.min(p0.x, x1)
        o.y = Math.min(p0.y, y1)
        o.w = Math.abs(x1 - p0.x)
        o.h = Math.abs(y1 - p0.y)
        drawPage(pg)
      },
      function (moved) {
        pg.objs.splice(pg.objs.indexOf(o), 1)
        if (tool === 'highlight') {
          textRuns(pg).then(function (lines) {
            var rects = highlightRects(lines, o, moved)
            if (!rects.length && moved && o.w > 2 && o.h > 2) rects = [{ x: o.x, y: o.y, w: o.w, h: o.h }]
            if (!rects.length) return drawPage(pg)
            rects.forEach(function (r) {
              pg.objs.push({ id: uid('o'), type: 'highlight', x: r.x, y: r.y, w: r.w, h: r.h, fill: o.fill, opacity: o.opacity })
            })
            S.sel = { key: pg.key, id: pg.objs[pg.objs.length - 1].id }
            drawPage(pg)
            renderThumbs()
            commit()
            updateProps()
          })
          return
        }
        if (!moved || o.w < 3 || o.h < 3) {
          if (tool === 'rect' || tool === 'ellipse') {
            o.w = 120
            o.h = 80
          } else {
            drawPage(pg)
            return
          }
        }
        addObj(pg, o)
      }
    )
  }

  /** 高亮吸附到原有文字：选区覆盖到的每一行 */
  function highlightRects(lines, r, moved) {
    var out = []
    if (!moved) {
      // 单击：高亮点到的那一行
      lines.forEach(function (l) {
        if (r.x >= l.x && r.x <= l.x + l.w && r.y >= l.y && r.y <= l.y + l.h) out.push({ x: l.x, y: l.y, w: l.w, h: l.h })
      })
      return out.slice(0, 1)
    }
    var y0 = r.y
    var y1 = r.y + r.h
    var hits = lines.filter(function (l) {
      var cy = l.y + l.h / 2
      return cy >= y0 - l.h * 0.3 && cy <= y1 + l.h * 0.3 && l.x < r.x + r.w && l.x + l.w > r.x
    })
    if (!hits.length) return out
    hits.sort(function (a, b) {
      return a.y - b.y || a.x - b.x
    })
    var multi = hits[hits.length - 1].y - hits[0].y > hits[0].h * 0.5
    hits.forEach(function (l, i) {
      var x0 = l.x
      var x1 = l.x + l.w
      // 像选中文字一样：首行从起点开始，末行到终点结束，中间整行
      if (!multi) {
        x0 = Math.max(l.x, r.x)
        x1 = Math.min(l.x + l.w, r.x + r.w)
      } else {
        if (i === 0 || Math.abs(l.y - hits[0].y) < l.h * 0.5) x0 = Math.max(l.x, r.x)
        if (i === hits.length - 1 || Math.abs(l.y - hits[hits.length - 1].y) < l.h * 0.5) x1 = Math.min(l.x + l.w, r.x + r.w)
      }
      if (x1 - x0 > 1) out.push({ x: x0, y: l.y, w: x1 - x0, h: l.h })
    })
    return out
  }

  function dragLine(pg, p0, e) {
    var st = style[S.tool]
    var o = { id: uid('o'), type: S.tool, x1: p0.x, y1: p0.y, x2: p0.x, y2: p0.y, stroke: st.stroke, lw: st.lw, opacity: st.opacity }
    pg.objs.push(o)
    drag(
      pg,
      e,
      function (p, ev) {
        var q = ev.shiftKey ? snap45(p0.x, p0.y, p) : p
        o.x2 = q.x
        o.y2 = q.y
        drawPage(pg)
      },
      function (moved) {
        pg.objs.splice(pg.objs.indexOf(o), 1)
        if (!moved || Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3) {
          drawPage(pg)
          return
        }
        addObj(pg, o)
      }
    )
  }

  function dragInk(pg, p0, e) {
    var st = style.pen
    var now = Date.now()
    var last = S.lastInk && findObj(S.lastInk.ref)
    var merge = last && last.pg === pg && now - S.lastInk.time < 1500 && last.o.stroke === st.stroke && last.o.lw === st.lw
    var o = merge ? last.o : { id: uid('o'), type: 'ink', paths: [], stroke: st.stroke, lw: st.lw, opacity: st.opacity }
    var path = [round(p0.x), round(p0.y)]
    o.paths.push(path)
    if (!merge) pg.objs.push(o)
    var minD = 0.8 / S.z
    drawPage(pg)
    drag(
      pg,
      e,
      function (p) {
        var lx = path[path.length - 2]
        var ly = path[path.length - 1]
        if (Math.hypot(p.x - lx, p.y - ly) < minD) return
        path.push(round(p.x), round(p.y))
        drawPage(pg)
      },
      function () {
        S.lastInk = { ref: { key: pg.key, id: o.id }, time: Date.now() }
        S.sel = null
        drawPage(pg)
        renderThumbs()
        commit()
      }
    )
  }
  function round(v) {
    return Math.round(v * 100) / 100
  }

  function createText(pg, p) {
    var st = style.text
    var o = { id: uid('o'), type: 'text', text: '', size: st.size, font: st.font, bold: st.bold, italic: st.italic, color: st.color, rot: upright(pg), x: p.x, y: p.y }
    measure(o)
    // 让点击的位置落在第一行的中间
    var p0 = W.local(o, 0, (F.LINE * o.size) / 2)
    o.x += p.x - p0[0]
    o.y += p.y - p0[1]
    pg.objs.push(o)
    setTool('select', true)
    startEdit(pg, o)
  }

  /* ---------------- 图片 ---------------- */

  async function pickImage(pg, p) {
    try {
      var files = await studio.dialog.open({ title: t('选择图片', 'Choose an image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] })
      if (!files || !files.length) return
      await placeImage(pg, files[0].data, p)
      setTool('select')
    } catch (e) {
      studio.toast(String((e && e.message) || e))
    }
  }

  /** 图片字节 → PNG / JPEG（其他格式先转成 PNG） */
  async function normalizeImage(data) {
    var bytes = new Uint8Array(data)
    var type = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : null
    var bmp = await createImageBitmap(new Blob([bytes]))
    var size = { w: bmp.width, h: bmp.height }
    if (!type) {
      var c = h('canvas')
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d').drawImage(bmp, 0, 0)
      var blob = await new Promise(function (r) {
        c.toBlob(r, 'image/png')
      })
      bytes = new Uint8Array(await blob.arrayBuffer())
      type = 'png'
    }
    bmp.close()
    return { type: type, bytes: bytes, w: size.w, h: size.h }
  }

  async function placeImage(pg, data, p) {
    var img = await normalizeImage(data)
    var id = uid('i')
    addImageData(id, img.type, img.bytes)
    var w = img.w * 0.75
    var hh = img.h * 0.75
    var rot = upright(pg)
    var d = dispSize(pg)
    var k = Math.min(1, (d[0] * 0.6) / w, (d[1] * 0.6) / hh)
    w *= k
    hh *= k
    var sw = rot % 180
    var bw = sw ? hh : w
    var bh = sw ? w : hh
    var c = p || { x: pg.w / 2, y: pg.h / 2 }
    addObj(pg, { type: 'image', img: id, x: c.x - bw / 2, y: c.y - bh / 2, w: w, h: hh, rot: rot, opacity: 1 })
  }

  /* ---------------- 页面操作 ---------------- */

  function selPageKeys() {
    if (S.selPages.size) {
      var keys = S.pages
        .filter(function (pg) {
          return S.selPages.has(pg.key)
        })
        .map(function (pg) {
          return pg.key
        })
      if (keys.length) return keys
    }
    return S.pages[S.cur] ? [S.pages[S.cur].key] : []
  }

  function rotatePages(d) {
    if (!S.editable) return
    var keys = selPageKeys()
    S.pages.forEach(function (pg) {
      if (keys.indexOf(pg.key) >= 0) pg.rot = (((pg.rot || 0) + d) % 360 + 360) % 360
    })
    commit()
    layout()
    rerenderVisible()
  }

  function deletePages() {
    if (!S.editable) return
    var keys = selPageKeys()
    if (keys.length >= S.pages.length) {
      studio.toast(t('至少要保留一页', 'A PDF needs at least one page'))
      return
    }
    S.pages = S.pages.filter(function (pg) {
      return keys.indexOf(pg.key) < 0
    })
    S.selPages.clear()
    if (S.sel && !findObj(S.sel)) S.sel = null
    S.cur = Math.min(S.cur, S.pages.length - 1)
    commit()
    layout()
  }

  function copyPage(pg) {
    var c = clone(pg)
    c.key = uid('p')
    c.objs.forEach(function (o) {
      o.id = uid('o')
    })
    return c
  }

  function duplicatePages() {
    if (!S.editable) return
    var keys = selPageKeys()
    var last = 0
    var copies = []
    S.pages.forEach(function (pg, i) {
      if (keys.indexOf(pg.key) >= 0) {
        copies.push(copyPage(pg))
        last = i
      }
    })
    S.pages.splice.apply(S.pages, [last + 1, 0].concat(copies))
    S.selPages = new Set(
      copies.map(function (c) {
        return c.key
      })
    )
    S.cur = last + 1
    commit()
    layout()
    scrollToPage(S.cur)
  }

  function insertBlank() {
    if (!S.editable) return
    var cur = S.pages[S.cur]
    var d = cur ? dispSize(cur) : [595.28, 841.89]
    var pg = { key: uid('p'), src: null, index: 0, rot: 0, baseRot: 0, vx: 0, vy: 0, w: d[0], h: d[1], objs: [] }
    S.pages.splice(S.cur + 1, 0, pg)
    S.cur = S.cur + 1
    S.selPages.clear()
    commit()
    layout()
    scrollToPage(S.cur)
  }

  async function insertPdfFiles(files, at) {
    if (!S.editable) return
    var added = []
    busy(t('正在插入…', 'Inserting…'))
    try {
      for (var i = 0; i < files.length; i++) {
        var bytes = new Uint8Array(files[i].data)
        var prep = await W.prepare(bytes)
        if (!prep.editable) {
          studio.toast(t('跳过（加密或无法解析）：', 'Skipped (encrypted or unreadable): ') + files[i].name)
          continue
        }
        var id = uid('s')
        S.sources[id] = prep.base
        S.docs[id] = await loadPdf(prep.base.slice())
        var infos = await pageInfos(S.docs[id])
        infos.forEach(function (p, j) {
          added.push(newPage(id, j, p, prep.overlays[j]))
        })
      }
    } catch (e) {
      studio.toast(String((e && e.message) || e))
    }
    busy(false)
    if (!added.length) return
    var pos = at == null ? S.cur + 1 : at
    S.pages.splice.apply(S.pages, [pos, 0].concat(added))
    S.cur = pos
    S.selPages.clear()
    commit()
    layout()
    scrollToPage(pos)
    studio.toast(t('已插入 {0} 页', 'Inserted {0} page(s)').replace('{0}', added.length))
  }

  async function insertPdf() {
    try {
      var files = await studio.dialog.open({ title: t('选择要插入的 PDF', 'Choose PDFs to insert'), extensions: ['pdf'], multiple: true })
      if (files && files.length) await insertPdfFiles(files)
    } catch (e) {
      studio.toast(String((e && e.message) || e))
    }
  }

  function movePages(keys, toIndex) {
    var moving = S.pages.filter(function (pg) {
      return keys.indexOf(pg.key) >= 0
    })
    var before = S.pages.slice(0, toIndex).filter(function (pg) {
      return keys.indexOf(pg.key) < 0
    }).length
    var rest = S.pages.filter(function (pg) {
      return keys.indexOf(pg.key) < 0
    })
    rest.splice.apply(rest, [before, 0].concat(moving))
    var changed = rest.some(function (pg, i) {
      return pg !== S.pages[i]
    })
    if (!changed) return
    S.pages = rest
    S.cur = before
    commit()
    layout()
    scrollToPage(S.cur)
  }

  function setCur(i, scroll) {
    if (i < 0 || i >= S.pages.length) return
    if (S.cur !== i) {
      var old = S.pages[S.cur] && RT.get(S.pages[S.cur].key)
      if (old) {
        old.el.classList.remove('cur')
        if (old.thumb) old.thumb.classList.remove('cur')
      }
      S.cur = i
      var rt = RT.get(S.pages[i].key)
      rt.el.classList.add('cur')
      if (rt.thumb) {
        rt.thumb.classList.add('cur')
        if (!S.selPages.size) rt.thumb.scrollIntoView({ block: 'nearest' })
      }
      status()
    }
    if (scroll) scrollToPage(i)
  }

  function scrollToPage(i) {
    var pg = S.pages[i]
    var rt = pg && RT.get(pg.key)
    if (!rt) return
    var view = $('view')
    view.scrollTop = rt.el.offsetTop - 12
  }

  /* ---------------- 缩放 ---------------- */

  var ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
  function setZoom(z, anchor) {
    var view = $('view')
    var oldZ = S.z
    var ax = anchor ? anchor.x : view.clientWidth / 2
    var ay = anchor ? anchor.y : view.clientHeight / 2
    var cx = view.scrollLeft + ax
    var cy = view.scrollTop + ay
    S.zoom = z
    S.z = computeZoom()
    S.pages.forEach(function (pg) {
      var rt = RT.get(pg.key)
      if (rt) sizePage(pg, rt)
      drawPageFull(pg)
    })
    var k = S.z / oldZ
    view.scrollLeft = cx * k - ax
    view.scrollTop = cy * k - ay
    updateBar()
    rerenderVisible(120)
  }
  function zoomStep(dir, anchor) {
    var curZ = S.z / CSS_UNITS
    var next = dir > 0 ? ZOOMS.find((v) => v > curZ + 0.001) : ZOOMS.slice().reverse().find((v) => v < curZ - 0.001)
    if (next) setZoom(next, anchor)
  }

  /* ---------------- 工具栏 ---------------- */

  function setTool(id, keepSel) {
    finishEdit()
    S.tool = id
    document.body.className = 'tool-' + id
    if (!keepSel && id !== 'select') select(null)
    S.pages.forEach(function (pg) {
      if (visible.has(pg.key)) drawRuns(pg)
    })
    updateBar()
    updateProps()
    $('hint').textContent = HINTS[id] ? t(HINTS[id][0], HINTS[id][1]) : ''
  }

  function tb(icon, title, fn, opts) {
    opts = opts || {}
    return h('button', { class: 'tb-btn' + (opts.cls ? ' ' + opts.cls : ''), title: title, html: icon + (opts.label ? '<span>' + opts.label + '</span>' : ''), onClick: fn, 'data-act': opts.act })
  }

  function buildBar() {
    var bar = $('bar')
    bar.replaceChildren(tb(I.undo, t('撤销 (Ctrl Z)', 'Undo (Ctrl Z)'), undo, { act: 'undo' }), tb(I.redo, t('重做 (Ctrl Y)', 'Redo (Ctrl Y)'), redo, { act: 'redo' }), h('div', { class: 'sep' }))
    TOOLS.forEach(function (tool) {
      if (!tool) return bar.appendChild(h('div', { class: 'sep' }))
      bar.appendChild(
        tb(
          I[tool.id],
          t(tool.label[0], tool.label[1]) + ' (' + tool.key.toUpperCase() + ')',
          function () {
            setTool(tool.id)
          },
          { act: 'tool-' + tool.id }
        )
      )
    })
    bar.append(
      h('div', { class: 'grow' }),
      tb(I.zout, t('缩小', 'Zoom out'), function () {
        zoomStep(-1)
      }),
      tb(
        '',
        t('适应宽度', 'Fit width'),
        function () {
          setZoom('fit')
        },
        { cls: 'zoom', act: 'zoom' }
      ),
      tb(I.zin, t('放大', 'Zoom in'), function () {
        zoomStep(1)
      }),
      h('div', { class: 'sep' }),
      tb(I.more, t('更多', 'More'), function (e) {
        showMenu(e.currentTarget)
      })
    )
    var side = $('sideBar')
    side.replaceChildren(
      tb(I.rotl, t('向左旋转', 'Rotate left'), function () {
        rotatePages(-90)
      }, { act: 'pg' }),
      tb(I.rotr, t('向右旋转', 'Rotate right'), function () {
        rotatePages(90)
      }, { act: 'pg' }),
      tb(I.dup, t('复制页面', 'Duplicate page'), duplicatePages, { act: 'pg' }),
      tb(I.blank, t('插入空白页', 'Insert blank page'), insertBlank, { act: 'pg' }),
      tb(I.merge, t('插入 PDF 文件…', 'Insert PDF file…'), insertPdf, { act: 'pg' }),
      tb(I.del, t('删除页面', 'Delete page'), deletePages, { act: 'pg' })
    )
  }

  function updateBar() {
    document.querySelectorAll('[data-act]').forEach(function (b) {
      var a = b.dataset.act
      if (a === 'undo') b.disabled = S.hi <= 0
      else if (a === 'redo') b.disabled = S.hi >= S.history.length - 1
      else if (a === 'zoom') b.textContent = Math.round((S.z / CSS_UNITS) * 100) + '%'
      else if (a === 'pg') b.disabled = !S.editable
      else if (a.indexOf('tool-') === 0) {
        var id = a.slice(5)
        b.classList.toggle('on', S.tool === id)
        b.disabled = id !== 'select' && !S.editable
      }
    })
  }

  /* ---------- 属性栏 ---------- */

  function colorInput(value, onChange, allowNone, title) {
    var none = value == null
    var wrap = h('label', { class: 'swatch' + (none ? ' none' : ''), title: title || '' })
    var input = h('input', { type: 'color', value: value || '#ffffff' })
    input.addEventListener('input', function () {
      wrap.classList.remove('none')
      onChange(input.value, false)
    })
    input.addEventListener('change', function () {
      onChange(input.value, true)
    })
    wrap.appendChild(input)
    if (!allowNone) return wrap
    var noneBtn = h('button', { class: 'tb-btn', title: t('无', 'None'), text: '∅' })
    noneBtn.addEventListener('click', function () {
      wrap.classList.add('none')
      onChange(null, true)
    })
    return h('span', { style: { display: 'inline-flex', alignItems: 'center' } }, wrap, noneBtn)
  }

  function updateProps() {
    var host = $('props')
    host.replaceChildren()
    var f = selected()
    var o = f && f.o
    var kind = o ? (o.type === 'rect' && !o.stroke && o.lw === 0 && o.fill ? 'whiteout' : o.type === 'ink' ? 'pen' : o.type) : S.tool
    var target = o || style[kind]
    var apply = function (prop, v, final) {
      if (o) {
        o[prop] = v
        if (o.type === 'text') measure(o)
        drawPage(f.pg)
        if (final) commit()
      }
      if (style[kind]) {
        style[kind][prop] = v
        store('style', style)
      }
    }
    var parts = []
    if (target && (kind === 'text' || kind === 'edittext')) {
      var ts = o || style.text
      var fam = h('select', { title: t('字体', 'Font') })
      ;[
        ['sans', t('无衬线（Helvetica）', 'Sans (Helvetica)')],
        ['serif', t('衬线（Times）', 'Serif (Times)')],
        ['mono', t('等宽（Courier）', 'Mono (Courier)')]
      ].forEach(function (x) {
        fam.appendChild(h('option', { value: x[0], text: x[1], selected: ts.font === x[0] }))
      })
      fam.addEventListener('change', function () {
        apply('font', fam.value, true)
      })
      var size = h('input', { type: 'number', min: '4', max: '400', step: '0.5', value: String(ts.size), title: t('字号（pt）', 'Size (pt)') })
      size.addEventListener('change', function () {
        var v = Math.max(4, Math.min(400, parseFloat(size.value) || 12))
        apply('size', v, true)
      })
      var bold = tb(I.bold, t('粗体', 'Bold'), function () {
        apply('bold', !ts.bold, true)
        bold.classList.toggle('on', !!ts.bold)
      })
      bold.classList.toggle('on', !!ts.bold)
      var italic = tb(I.italic, t('斜体', 'Italic'), function () {
        apply('italic', !ts.italic, true)
        italic.classList.toggle('on', !!ts.italic)
      })
      italic.classList.toggle('on', !!ts.italic)
      parts.push(
        fam,
        size,
        bold,
        italic,
        colorInput(ts.color, function (v, fin) {
          apply('color', v, fin)
        }, false, t('文字颜色', 'Text color'))
      )
      if (o && o.cover)
        parts.push(
          h('div', { class: 'sep' }),
          h('label', {}, t('遮盖', 'Cover'), colorInput(o.cover.color, function (v, fin) {
            o.cover.color = v || '#ffffff'
            drawPage(f.pg)
            if (fin) commit()
          }, false, t('遮盖原文字的颜色', 'Color covering the original text')))
        )
    } else if (kind === 'rect' || kind === 'ellipse') {
      parts.push(
        h('label', {}, t('边框', 'Stroke'), colorInput(target.stroke, function (v, fin) {
          apply('stroke', v, fin)
        }, true)),
        h('label', {}, t('填充', 'Fill'), colorInput(target.fill, function (v, fin) {
          apply('fill', v, fin)
        }, true)),
        widthInput(target, apply),
        opacityInput(target, apply)
      )
    } else if (kind === 'line' || kind === 'arrow' || kind === 'pen') {
      parts.push(
        h('label', {}, t('颜色', 'Color'), colorInput(target.stroke, function (v, fin) {
          apply('stroke', v, fin)
        })),
        widthInput(target, apply),
        opacityInput(target, apply)
      )
    } else if (kind === 'highlight') {
      parts.push(
        h('label', {}, t('颜色', 'Color'), colorInput(target.fill, function (v, fin) {
          apply('fill', v, fin)
        })),
        opacityInput(target, apply)
      )
    } else if (kind === 'whiteout') {
      parts.push(
        h('label', {}, t('颜色', 'Color'), colorInput(target.fill, function (v, fin) {
          apply('fill', v, fin)
        }))
      )
    } else if (o && o.type === 'image') {
      parts.push(opacityInput(o, apply))
    }
    if (o && S.editable) {
      parts.push(
        h('div', { class: 'sep' }),
        tb(I.front, t('置于顶层', 'Bring to front'), function () {
          reorderSelected(true)
        }),
        tb(I.back, t('置于底层', 'Send to back'), function () {
          reorderSelected(false)
        }),
        tb(I.dup, t('复制 (Ctrl D)', 'Duplicate (Ctrl D)'), duplicateSelected),
        tb(I.trash, t('删除 (Delete)', 'Delete (Delete)'), deleteSelected)
      )
    }
    if (needsFont()) {
      parts.push(
        h('div', { class: 'grow' }),
        h(
          'span',
          { class: 'notice' },
          t('文字里有中文等字符，保存前需要选择一个字体文件', 'Some text needs a Unicode font before saving'),
          h('button', { class: 'link-btn', text: t('选择字体…', 'Choose font…'), onClick: pickFont })
        )
      )
    }
    if (!S.editable && S.reason) {
      parts = [
        h(
          'span',
          { class: 'notice' },
          S.reason === 'encrypted'
            ? t('这个 PDF 已加密，只能查看，不能编辑', 'This PDF is encrypted and can only be viewed')
            : t('这个 PDF 结构无法解析，只能查看，不能编辑', 'This PDF cannot be parsed for editing; view only')
        )
      ]
    }
    if (parts.length) host.append.apply(host, parts)
  }

  function widthInput(target, apply) {
    var input = h('input', { type: 'number', min: '0', max: '50', step: '0.5', value: String(target.lw == null ? 2 : target.lw), title: t('线宽（pt）', 'Width (pt)') })
    input.addEventListener('change', function () {
      apply('lw', Math.max(0, Math.min(50, parseFloat(input.value) || 0)), true)
    })
    return h('label', {}, t('线宽', 'Width'), input)
  }
  function opacityInput(target, apply) {
    var input = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(target.opacity == null ? 1 : target.opacity) })
    input.addEventListener('input', function () {
      apply('opacity', parseFloat(input.value), false)
    })
    input.addEventListener('change', function () {
      apply('opacity', parseFloat(input.value), true)
    })
    return h('label', { title: t('不透明度', 'Opacity') }, t('透明度', 'Opacity'), input)
  }

  /* ---------- 菜单 / 对话框 ---------- */

  function showMenu(anchor) {
    var menu = $('menu')
    var f = F.get()
    var item = function (icon, label, fn, disabled) {
      return h(
        'button',
        {
          class: 'mi',
          html: icon,
          disabled: disabled,
          onClick: function () {
            hideMenu()
            fn()
          }
        },
        h('span', { text: label })
      )
    }
    var items = [
      item(I.blank, t('插入空白页', 'Insert blank page'), insertBlank, !S.editable),
      item(I.merge, t('插入 PDF 文件…', 'Insert PDF file…'), insertPdf, !S.editable),
      item(I.image, t('插入图片…', 'Insert image…'), function () {
        var pg = S.pages[S.cur]
        if (pg) pickImage(pg, null)
      }, !S.editable),
      h('div', { class: 'msep' }),
      item(I.extract, t('导出选中页为 PDF…', 'Export selected pages as PDF…'), exportSelected, !S.editable),
      item(I.png, t('导出当前页为 PNG…', 'Export current page as PNG…'), exportPng),
      item(I.save, t('另存为…', 'Save as…'), saveAs, !S.editable),
      h('div', { class: 'msep' }),
      item(I.info, t('文档属性…', 'Document properties…'), showProps, !S.editable || !S.meta),
      item(I.font, f ? t('中文字体：', 'Unicode font: ') + f.name : t('选择中文字体…', 'Choose Unicode font…'), pickFont)
    ]
    menu.replaceChildren.apply(menu, items)
    menu.hidden = false
    var r = anchor.getBoundingClientRect()
    var mw = menu.offsetWidth
    menu.style.left = Math.max(4, Math.min(window.innerWidth - mw - 4, r.right - mw)) + 'px'
    menu.style.top = r.bottom + 4 + 'px'
    setTimeout(function () {
      document.addEventListener('pointerdown', outside, true)
    })
    function outside(e) {
      if (menu.contains(e.target)) return
      hideMenu()
    }
    menu._outside = outside
  }
  function hideMenu() {
    var menu = $('menu')
    menu.hidden = true
    if (menu._outside) document.removeEventListener('pointerdown', menu._outside, true)
  }

  function dialog(title, body, actions) {
    var modal = $('modal')
    return new Promise(function (resolve) {
      var close = function (v) {
        modal.hidden = true
        modal.replaceChildren()
        document.removeEventListener('keydown', onKey, true)
        resolve(v)
      }
      var onKey = function (e) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close(null)
        } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          e.preventDefault()
          e.stopPropagation()
          close(actions.ok())
        }
      }
      document.addEventListener('keydown', onKey, true)
      var dlg = h(
        'div',
        { class: 'dlg' },
        h('h3', { text: title }),
        body,
        h(
          'div',
          { class: 'acts' },
          h('button', {
            class: 'btn',
            text: t('取消', 'Cancel'),
            onClick: function () {
              close(null)
            }
          }),
          h('button', {
            class: 'btn primary',
            text: actions.label || t('确定', 'OK'),
            onClick: function () {
              close(actions.ok())
            }
          })
        )
      )
      modal.replaceChildren(dlg)
      modal.hidden = false
      var first = dlg.querySelector('input')
      if (first) first.focus()
    })
  }

  function askPassword(wrong) {
    busy(false)
    var input = h('input', { type: 'password' })
    var body = h('div', {}, h('p', { text: wrong ? t('密码不正确，请重试。', 'Incorrect password, try again.') : t('打开这个 PDF 需要密码。加密的 PDF 只能查看，不能编辑。', 'This PDF needs a password. Encrypted PDFs are view-only.') }), input)
    return dialog(t('PDF 密码', 'PDF password'), body, {
      label: t('打开', 'Open'),
      ok: function () {
        return input.value
      }
    })
  }

  async function showProps() {
    var m = S.meta || {}
    var fields = [
      ['title', t('标题', 'Title')],
      ['author', t('作者', 'Author')],
      ['subject', t('主题', 'Subject')],
      ['keywords', t('关键词', 'Keywords')]
    ]
    var inputs = {}
    var body = h(
      'div',
      {},
      h('p', { text: t('页数：', 'Pages: ') + S.pages.length + (m.creator ? '  ·  ' + t('创建工具：', 'Creator: ') + m.creator : '') })
    )
    fields.forEach(function (f) {
      inputs[f[0]] = h('input', { type: 'text', value: m[f[0]] || '' })
      body.appendChild(h('div', { class: 'row' }, h('label', { text: f[1] }), inputs[f[0]]))
    })
    var res = await dialog(t('文档属性', 'Document properties'), body, {
      ok: function () {
        var out = Object.assign({}, m)
        fields.forEach(function (f) {
          out[f[0]] = inputs[f[0]].value
        })
        return out
      }
    })
    if (!res) return
    S.meta = res
    commit()
  }

  async function pickFont() {
    try {
      var files = await studio.dialog.open({
        title: t('选择支持中文的字体文件（例如 C:\\Windows\\Fonts\\simhei.ttf、msyh.ttc）', 'Choose a Unicode font file (e.g. C:\\Windows\\Fonts\\arialuni.ttf, msyh.ttc)'),
        extensions: ['ttf', 'otf', 'ttc']
      })
      if (!files || !files.length) return
      busy(t('正在读取字体…', 'Loading font…'))
      var f = await F.set(files[0].name, files[0].data)
      busy(false)
      studio.toast(t('已使用字体：', 'Using font: ') + f.name)
    } catch (e) {
      busy(false)
      studio.toast(t('无法使用这个字体：', 'Cannot use this font: ') + String((e && e.message) || e))
    }
  }

  function busy(text) {
    var b = $('busy')
    if (text === false) {
      b.hidden = true
      return
    }
    b.querySelector('span').textContent = text
    b.hidden = false
  }

  function status() {
    var el = $('status')
    var n = S.pages.length
    var parts = [t('第 {0} / {1} 页', 'Page {0} / {1}').replace('{0}', n ? S.cur + 1 : 0).replace('{1}', n)]
    var keys = S.selPages.size
    if (keys > 1) parts.push(t('选中 {0} 页', '{0} pages selected').replace('{0}', keys))
    el.textContent = parts.join('  ·  ')
    if (!S.editable) el.appendChild(h('span', { class: 'ro', text: '  ·  ' + t('只读', 'Read-only') }))
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    var view = $('view')
    var pagesEl = $('pages')
    view.addEventListener('pointerdown', onPointerDown)
    pagesEl.addEventListener('dblclick', onDblClick)

    var scrollRaf = 0
    view.addEventListener('scroll', function () {
      if (scrollRaf) return
      scrollRaf = requestAnimationFrame(function () {
        scrollRaf = 0
        var mid = view.scrollTop + view.clientHeight * 0.35
        for (var i = 0; i < S.pages.length; i++) {
          var rt = RT.get(S.pages[i].key)
          if (rt && rt.el.offsetTop + rt.el.offsetHeight > mid) {
            setCur(i, false)
            break
          }
        }
      })
    })

    view.addEventListener(
      'wheel',
      function (e) {
        if (!e.ctrlKey) return
        e.preventDefault()
        var r = view.getBoundingClientRect()
        var curZ = S.z / CSS_UNITS
        var next = Math.max(0.1, Math.min(5, curZ * Math.exp(-e.deltaY * 0.0025)))
        setZoom(Math.round(next * 100) / 100, { x: e.clientX - r.left, y: e.clientY - r.top })
      },
      { passive: false }
    )

    var lastW = 0
    new ResizeObserver(function () {
      var w = view.clientWidth
      if (w === lastW) return
      lastW = w
      if (S.zoom === 'fit' && S.pages.length) setZoom('fit')
    }).observe(view)

    // 缩略图：点击选页（Ctrl 多选，Shift 连选），拖动排序
    var thumbs = $('thumbs')
    var anchorIdx = 0
    thumbs.addEventListener('click', function (e) {
      var th = e.target.closest('.thumb')
      if (!th) return
      var i = S.pages.findIndex(function (pg) {
        return pg.key === th.dataset.key
      })
      if (i < 0) return
      if (e.ctrlKey || e.metaKey) {
        if (!S.selPages.size) S.selPages.add(S.pages[S.cur].key)
        if (S.selPages.has(th.dataset.key) && S.selPages.size > 1) S.selPages.delete(th.dataset.key)
        else S.selPages.add(th.dataset.key)
      } else if (e.shiftKey) {
        S.selPages.clear()
        var a = Math.min(anchorIdx, i)
        var b = Math.max(anchorIdx, i)
        for (var k = a; k <= b; k++) S.selPages.add(S.pages[k].key)
      } else {
        S.selPages.clear()
        anchorIdx = i
      }
      setCur(i, true)
      renderThumbs()
      status()
      $('side').focus()
    })

    var dragKeys = null
    var dropLine = h('div', { class: 'drop-line' })
    var dropIndex = -1
    thumbs.addEventListener('dragstart', function (e) {
      var th = e.target.closest('.thumb')
      if (!th || !S.editable) return e.preventDefault()
      var keys = selPageKeys()
      dragKeys = keys.indexOf(th.dataset.key) >= 0 ? keys : [th.dataset.key]
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/x-pdf-pages', dragKeys.join(','))
      th.classList.add('dragging')
    })
    thumbs.addEventListener('dragend', function () {
      dragKeys = null
      dropLine.remove()
      document.querySelectorAll('.thumb.dragging').forEach(function (el) {
        el.classList.remove('dragging')
      })
    })
    function thumbDropIndex(e) {
      var list = Array.prototype.slice.call(thumbs.querySelectorAll('.thumb'))
      for (var i = 0; i < list.length; i++) {
        var r = list[i].getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) return i
      }
      return list.length
    }
    thumbs.addEventListener('dragover', function (e) {
      var files = e.dataTransfer.types.indexOf('Files') >= 0
      if (!dragKeys && !files) return
      e.preventDefault()
      e.dataTransfer.dropEffect = dragKeys ? 'move' : 'copy'
      dropIndex = thumbDropIndex(e)
      var list = thumbs.querySelectorAll('.thumb')
      if (dropIndex < list.length) thumbs.insertBefore(dropLine, list[dropIndex])
      else thumbs.appendChild(dropLine)
    })
    thumbs.addEventListener('dragleave', function (e) {
      if (!thumbs.contains(e.relatedTarget)) dropLine.remove()
    })
    thumbs.addEventListener('drop', function (e) {
      e.preventDefault()
      dropLine.remove()
      var idx = thumbDropIndex(e)
      if (dragKeys) {
        var keys = dragKeys
        dragKeys = null
        movePages(keys, idx)
        return
      }
      dropFiles(e.dataTransfer.files, null, idx)
    })

    // 页面区：拖入图片放到页面上，拖入 PDF 插入到当前页之后
    view.addEventListener('dragover', function (e) {
      if (e.dataTransfer.types.indexOf('Files') < 0 || !S.editable) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    })
    view.addEventListener('drop', function (e) {
      if (!e.dataTransfer.files.length) return
      e.preventDefault()
      var pageEl = e.target.closest('.page')
      var pg = pageEl ? pageByKey(pageEl.dataset.key) : S.pages[S.cur]
      var p = pageEl ? pagePoint(pg, e) : null
      dropFiles(e.dataTransfer.files, { pg: pg, p: p }, null)
    })

    document.addEventListener('keydown', onKey)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', function (e) {
      if (onCopy(e)) deleteSelected()
    })
    document.addEventListener('paste', onPaste)
  }

  async function dropFiles(fileList, target, index) {
    if (!S.editable) return
    var pdfs = []
    var imgs = []
    Array.prototype.forEach.call(fileList, function (f) {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') pdfs.push(f)
      else if (/^image\//.test(f.type)) imgs.push(f)
    })
    if (pdfs.length) {
      var files = await Promise.all(
        pdfs.map(async function (f) {
          return { name: f.name, data: await f.arrayBuffer() }
        })
      )
      await insertPdfFiles(files, index == null ? null : index)
    }
    var pg = (target && target.pg) || S.pages[S.cur]
    for (var i = 0; i < imgs.length && pg; i++) {
      try {
        var p = target && target.p ? { x: target.p.x + i * 12, y: target.p.y + i * 12 } : null
        await placeImage(pg, await imgs[i].arrayBuffer(), p)
      } catch (e) {
        studio.toast(String((e && e.message) || e))
      }
    }
    if (imgs.length) setTool('select')
  }

  function isTyping(e) {
    var el = e.target
    return el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
  }

  function onKey(e) {
    if (!$('modal').hidden) return
    var mod = e.ctrlKey || e.metaKey
    var key = e.key
    if (S.editing && key === 'Escape') {
      e.preventDefault()
      finishEdit()
      return
    }
    if (isTyping(e)) return
    if (mod && !e.altKey) {
      var k = key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        redo()
      } else if (k === 'd') {
        e.preventDefault()
        duplicateSelected()
      } else if (key === '=' || key === '+') {
        e.preventDefault()
        zoomStep(1)
      } else if (key === '-') {
        e.preventDefault()
        zoomStep(-1)
      } else if (key === '0') {
        e.preventDefault()
        setZoom(1)
      }
      return
    }
    if (e.altKey) return
    if (key === 'Delete' || key === 'Backspace') {
      if (S.sel) {
        e.preventDefault()
        deleteSelected()
      } else if (document.activeElement === $('side')) {
        e.preventDefault()
        deletePages()
      }
      return
    }
    if (key === 'Escape') {
      hideMenu()
      if (S.sel) select(null)
      else if (S.tool !== 'select') setTool('select')
      return
    }
    if (key === 'Enter' && S.sel) {
      var f = selected()
      if (f && f.o.type === 'text') {
        e.preventDefault()
        startEdit(f.pg, f.o, true)
      }
      return
    }
    if (key.indexOf('Arrow') === 0 && S.sel && S.editable) {
      var g = selected()
      if (!g) return
      e.preventDefault()
      var step = e.shiftKey ? 10 : 1
      var d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key]
      // 方向键按屏幕方向移动：换算到未旋转的页面坐标
      var a = fromDisp(g.pg, 0, 0)
      var b = fromDisp(g.pg, d[0], d[1])
      moveObj(g.o, b.x - a.x, b.y - a.y)
      drawPage(g.pg)
      clearTimeout(onKey.timer)
      onKey.timer = setTimeout(commit, 400)
      return
    }
    if (key === 'PageDown' || key === 'PageUp') {
      if (document.activeElement === $('side')) {
        e.preventDefault()
        setCur(S.cur + (key === 'PageDown' ? 1 : -1), true)
      }
      return
    }
    if (key.length === 1) {
      var tool = TOOLS.find(function (x) {
        return x && x.key === key.toLowerCase()
      })
      if (tool && (S.editable || tool.id === 'select')) {
        e.preventDefault()
        setTool(tool.id)
      }
    }
  }

  var CLIP_MARK = '\u2063pdf-object\u2063'
  function onCopy(e) {
    if (isTyping(e) || S.editing) return false
    var f = selected()
    if (!f) return false
    e.preventDefault()
    S.clip = clone(f.o)
    S.clipText = f.o.type === 'text' && (f.o.text || '').trim() ? f.o.text : CLIP_MARK
    e.clipboardData.setData('text/plain', S.clipText)
    return true
  }

  function onPaste(e) {
    if (isTyping(e) || S.editing || !S.editable) return
    var pg = S.pages[S.cur]
    if (!pg) return
    var items = Array.prototype.slice.call(e.clipboardData.items || [])
    var img = items.find(function (it) {
      return it.kind === 'file' && /^image\//.test(it.type)
    })
    if (img) {
      e.preventDefault()
      img
        .getAsFile()
        .arrayBuffer()
        .then(function (buf) {
          return placeImage(pg, buf, null)
        })
        .catch(function (err) {
          studio.toast(String((err && err.message) || err))
        })
      return
    }
    var text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    if (S.clip && text === S.clipText) {
      var o = clone(S.clip)
      o.id = uid('o')
      delete o.cover
      var samePage = S.sel && S.sel.key === pg.key
      if (samePage) moveObj(o, 10, 10)
      addObj(pg, o)
      S.clip = clone(o)
      return
    }
    var st = style.text
    var t0 = { id: uid('o'), type: 'text', text: text.replace(/\r\n?/g, '\n'), size: st.size, font: st.font, bold: st.bold, italic: st.italic, color: st.color, rot: upright(pg), x: 0, y: 0 }
    measure(t0)
    var b = bbox(t0)
    t0.x = Math.max(0, (pg.w - b.w) / 2)
    t0.y = Math.max(0, (pg.h - b.h) / 2)
    addObj(pg, t0)
  }

  /* ---------------- 启动 ---------------- */

  F.onChange(function () {
    S.pages.forEach(function (pg) {
      pg.objs.forEach(function (o) {
        if (o.type === 'text') measure(o)
      })
      drawPage(pg)
    })
    updateProps()
  })

  /* ---------------- AI 工具（IDE 里的 AI 助手调用） ----------------
   * 坐标都是“显示出来的页面”上的 pt（1/72 英寸），左上角为原点，y 向下（和截图看到的方向一致）；页码从 1 开始。
   */

  function r1(v) {
    return Math.round(v * 10) / 10
  }
  function needPdf() {
    if (S.loading) throw new Error('The PDF is still loading')
    if (!S.pages.length) {
      var shown = $('error')
      throw new Error('The PDF could not be opened' + (shown && !shown.hidden && shown.textContent ? ': ' + shown.textContent : ''))
    }
  }
  function needEditable() {
    needPdf()
    if (!S.editable) throw new Error('This PDF is view-only (' + (S.reason || 'encrypted or unsupported') + '); it cannot be modified')
  }
  function pageArg(n) {
    var i = Math.floor(Number(n)) - 1
    if (!(i >= 0 && i < S.pages.length)) throw new Error('Page ' + n + ' does not exist (the PDF has ' + S.pages.length + ' pages)')
    return S.pages[i]
  }
  /** "1-3,5" / [1, 2] / 3 → 页面列表；空时为全部 */
  function pagesArg(v) {
    if (v == null || v === '') return S.pages.slice()
    var nums = []
    ;(Array.isArray(v) ? v : String(v).split(',')).forEach(function (x) {
      var m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(String(x))
      if (!m) throw new Error('Invalid page list: ' + v)
      var a = +m[1]
      var b = m[2] ? +m[2] : a
      for (var i = Math.min(a, b); i <= Math.max(a, b); i++) nums.push(i)
    })
    var out = []
    nums.forEach(function (n) {
      var pg = pageArg(n)
      if (out.indexOf(pg) < 0) out.push(pg)
    })
    return out
  }
  function pageNo(pg) {
    return S.pages.indexOf(pg) + 1
  }
  /** 未旋转的页面坐标里的框 → 显示坐标里的框 */
  function toDispBox(pg, b) {
    var a = toDisp(pg, b.x, b.y)
    var c = toDisp(pg, b.x + b.w, b.y + b.h)
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) }
  }
  function fromDispBox(pg, b) {
    var a = fromDisp(pg, b.x, b.y)
    var c = fromDisp(pg, b.x + b.w, b.y + b.h)
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) }
  }
  function roundBox(b) {
    return { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) }
  }
  function num(v, d) {
    var n = Number(v)
    return v != null && v !== '' && isFinite(n) ? n : d
  }
  function color(v, d) {
    if (v === null || v === 'none' || v === 'transparent') return null
    if (typeof v !== 'string') return d
    var s = v.trim()
    if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : d
  }
  function toolPath(p) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('`path` is required')
    return '/' + p.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  }
  /** 非拉丁文字需要先选一个 Unicode 字体（会弹出对话框让用户选） */
  async function ensureFontFor(text) {
    if (F.isWinAnsi(text || '') || F.get()) return
    studio.toast(t('要写入中文等文字，请选择一个支持它的字体文件', 'Choose a font file that supports this text'))
    await pickFont()
    if (!F.get()) throw new Error('This text needs a Unicode font, and the user did not choose one. Ask the user to run "PDF: Choose Unicode font…" from the command palette (e.g. C:\\Windows\\Fonts\\msyh.ttc), then try again.')
  }
  function afterChange(pages) {
    pages.forEach(function (pg) {
      drawPage(pg)
    })
    renderThumbs()
    commit()
    updateProps()
  }
  function describeObj(pg, o) {
    var d = { id: o.id, type: o.type === 'rect' && o.fill === '#ffffff' && !o.stroke ? 'whiteout' : o.type, box: roundBox(toDispBox(pg, bbox(o))) }
    if (o.type === 'text') {
      d.text = o.text
      d.size = o.size
      d.color = o.color
      d.font = o.font
      if (o.bold) d.bold = true
      if (o.italic) d.italic = true
      if (o.cover) d.replacesOriginalText = true
    }
    if (o.stroke) d.stroke = o.stroke
    if (o.fill && o.type !== 'text') d.fill = o.fill
    if (o.lw) d.lineWidth = o.lw
    if (o.opacity != null && o.opacity !== 1) d.opacity = o.opacity
    return d
  }
  function findIn(str, find, caseSensitive) {
    return caseSensitive ? str.indexOf(find) : str.toLowerCase().indexOf(find.toLowerCase())
  }
  /** 页面上所有出现 find 的位置（未旋转坐标的框，按字符数估算） */
  async function findBoxes(pg, find, caseSensitive) {
    var lines = await textRuns(pg)
    var out = []
    lines.forEach(function (l) {
      var from = 0
      var i
      while ((i = findIn(l.str.slice(from), find, caseSensitive)) >= 0) {
        var at = from + i
        var k = l.w / Math.max(1, l.str.length)
        out.push({ line: l, x: l.x + at * k, y: l.y, w: Math.max(1, find.length * k), h: l.h })
        from = at + find.length
      }
    })
    return out
  }

  function newTextObj(pg, a) {
    var size = num(a.size, style.text.size)
    var o = {
      id: uid('o'),
      type: 'text',
      text: String(a.text == null ? '' : a.text),
      size: Math.max(2, Math.min(400, size)),
      font: a.font === 'serif' || a.font === 'mono' ? a.font : 'sans',
      bold: !!a.bold,
      italic: !!a.italic,
      color: color(a.color, '#000000') || '#000000',
      rot: upright(pg)
    }
    o.x = 0
    o.y = 0
    measure(o)
    // (x, y) 是文字框（显示出来的）左上角：把框的显示位置挪过去
    var b = toDispBox(pg, tbox(o))
    var want = fromDisp(pg, num(a.x, 72), num(a.y, 72))
    var have = fromDisp(pg, b.x, b.y)
    o.x += want.x - have.x
    o.y += want.y - have.y
    return o
  }

  async function newObj(pg, a) {
    var type = String(a.type || '')
    if (type === 'text') {
      if (!String(a.text || '').trim()) throw new Error('text objects need `text`')
      await ensureFontFor(a.text)
      return [newTextObj(pg, a)]
    }
    if (type === 'rect' || type === 'ellipse' || type === 'whiteout') {
      var b = fromDispBox(pg, { x: num(a.x, 72), y: num(a.y, 72), w: Math.max(1, num(a.w, 120)), h: Math.max(1, num(a.h, 80)) })
      if (type === 'whiteout') return [Object.assign({ id: uid('o'), type: 'rect', fill: color(a.color, '#ffffff') || '#ffffff', stroke: null, lw: 0, opacity: 1 }, b)]
      var st = style[type]
      return [Object.assign({ id: uid('o'), type: type, stroke: color(a.stroke, st.stroke), fill: color(a.fill, null), lw: Math.max(0, num(a.lineWidth, st.lw)), opacity: Math.max(0.05, Math.min(1, num(a.opacity, 1))) }, b)]
    }
    if (type === 'line' || type === 'arrow') {
      var p1 = fromDisp(pg, num(a.x1, 72), num(a.y1, 72))
      var p2 = fromDisp(pg, num(a.x2, 200), num(a.y2, 72))
      var ls = style[type]
      return [{ id: uid('o'), type: type, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: color(a.stroke, ls.stroke) || ls.stroke, lw: Math.max(0.2, num(a.lineWidth, ls.lw)), opacity: Math.max(0.05, Math.min(1, num(a.opacity, 1))) }]
    }
    if (type === 'highlight') {
      var fill = color(a.color, style.highlight.fill) || style.highlight.fill
      var op = Math.max(0.05, Math.min(1, num(a.opacity, style.highlight.opacity)))
      var rects
      if (typeof a.find === 'string' && a.find) {
        var hits = await findBoxes(pg, a.find, !!a.caseSensitive)
        if (!hits.length) throw new Error('"' + a.find + '" was not found on page ' + pageNo(pg) + ' (text split across lines cannot be matched; try a shorter phrase)')
        rects = a.all ? hits : hits.slice(0, 1)
      } else rects = [fromDispBox(pg, { x: num(a.x, 72), y: num(a.y, 72), w: Math.max(1, num(a.w, 100)), h: Math.max(1, num(a.h, 14)) })]
      return rects.map(function (r) {
        return { id: uid('o'), type: 'highlight', x: r.x, y: r.y, w: r.w, h: r.h, fill: fill, opacity: op }
      })
    }
    if (type === 'image') {
      var data = await studio.fs.read(toolPath(a.path))
      var img = await normalizeImage(data)
      var id = uid('i')
      addImageData(id, img.type, img.bytes)
      var w = img.w * 0.75
      var hh = img.h * 0.75
      if (a.w && a.h) {
        w = num(a.w, w)
        hh = num(a.h, hh)
      } else if (a.w) {
        hh = (hh * num(a.w, w)) / w
        w = num(a.w, w)
      } else if (a.h) {
        w = (w * num(a.h, hh)) / hh
        hh = num(a.h, hh)
      } else {
        var dd = dispSize(pg)
        var k = Math.min(1, (dd[0] * 0.6) / w, (dd[1] * 0.6) / hh)
        w *= k
        hh *= k
      }
      var rot = upright(pg)
      var dsz = dispSize(pg)
      var x = a.x != null ? num(a.x, 0) : (dsz[0] - w) / 2
      var y = a.y != null ? num(a.y, 0) : (dsz[1] - hh) / 2
      var bx = fromDispBox(pg, { x: x, y: y, w: w, h: hh })
      var sw = rot % 180
      return [{ id: uid('o'), type: 'image', img: id, x: bx.x, y: bx.y, w: sw ? bx.h : bx.w, h: sw ? bx.w : bx.h, rot: rot, opacity: Math.max(0.05, Math.min(1, num(a.opacity, 1))) }]
    }
    throw new Error('Unknown object type "' + type + '" (use text, rect, ellipse, line, arrow, highlight, whiteout or image)')
  }

  studio.tools.register('getInfo', async function () {
    needPdf()
    var fields = 0
    var pages = await Promise.all(
      S.pages.map(async function (pg, i) {
        var d = dispSize(pg)
        var list = await widgets(pg)
        fields += list.length
        var o = { page: i + 1, width: r1(d[0]), height: r1(d[1]) }
        if (total(pg)) o.rotation = total(pg)
        if (pg.objs.length) o.addedObjects = pg.objs.length
        if (!pg.src) o.blank = true
        return o
      })
    )
    return {
      file: S.file,
      pageCount: S.pages.length,
      editable: S.editable,
      reason: S.editable ? undefined : S.reason,
      properties: S.meta ? { title: S.meta.title || '', author: S.meta.author || '', subject: S.meta.subject || '', keywords: S.meta.keywords || '', creator: S.meta.creator || '' } : null,
      formFields: fields,
      unicodeFont: F.get() ? F.get().name : null,
      currentPage: S.cur + 1,
      pages: pages,
      units: 'pt (1/72 inch); origin at the top-left of the page as displayed, y grows downward'
    }
  })

  studio.tools.register('getText', async function (a) {
    needPdf()
    var list = pagesArg(a.pages)
    var out = []
    var budget = 200000
    for (var i = 0; i < list.length; i++) {
      var pg = list[i]
      var lines = await textRuns(pg)
      var d = dispSize(pg)
      var p = { page: pageNo(pg), width: r1(d[0]), height: r1(d[1]) }
      if (a.positions) {
        p.lines = lines.map(function (l) {
          var b = roundBox(toDispBox(pg, l))
          return { text: l.str, x: b.x, y: b.y, w: b.w, h: b.h, size: r1(l.fs) }
        })
      } else
        p.text = lines
          .map(function (l) {
            return l.str
          })
          .join('\n')
      var added = pg.objs.filter(function (o) {
        return o.type === 'text' && (o.text || '').trim()
      })
      if (added.length)
        p.addedText = added.map(function (o) {
          return { id: o.id, text: o.text }
        })
      if (!lines.length && pg.src) p.note = 'No text layer (scanned image?)'
      var size = JSON.stringify(p).length
      if (size > budget) {
        out.push({ page: p.page, truncated: true, note: 'Output limit reached; request fewer pages' })
        break
      }
      budget -= size
      out.push(p)
    }
    return { pages: out }
  })

  studio.tools.register('renderPage', async function (a) {
    needPdf()
    var pg = pageArg(a.page == null ? S.cur + 1 : a.page)
    var scale = Math.max(0.5, Math.min(3, num(a.scale, 1.5)))
    var bytes = S.editable ? await buildBytes([pg]) : null
    var doc = bytes ? await loadPdf(bytes) : S.docs[pg.src]
    if (!doc) throw new Error('This page cannot be rendered')
    try {
      var page = await doc.getPage(bytes ? 1 : pg.index + 1)
      var vp = page.getViewport({ scale: scale, rotation: bytes ? page.rotate : total(pg) })
      var k = Math.min(1, 2000 / vp.width, 2000 / vp.height)
      if (k < 1) vp = page.getViewport({ scale: scale * k, rotation: bytes ? page.rotate : total(pg) })
      var canvas = h('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      var ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, canvas: canvas, viewport: vp }).promise
      var d = dispSize(pg)
      return studio.tools.image(canvas, 'Page ' + pageNo(pg) + ' of ' + S.pages.length + ' (' + r1(d[0]) + ' × ' + r1(d[1]) + ' pt; 1 pt = ' + r1(canvas.width / d[0]) + ' px in this image)')
    } finally {
      if (bytes) destroyDoc(doc)
    }
  })

  studio.tools.register('listObjects', function (a) {
    needPdf()
    var list = a.page != null ? [pageArg(a.page)] : S.pages
    return {
      pages: list
        .filter(function (pg) {
          return pg.objs.length || a.page != null
        })
        .map(function (pg) {
          return {
            page: pageNo(pg),
            objects: pg.objs.map(function (o) {
              return describeObj(pg, o)
            })
          }
        })
    }
  })

  studio.tools.register('addObjects', async function (a) {
    needEditable()
    var pg = pageArg(a.page)
    var list = Array.isArray(a.objects) ? a.objects : [a]
    var made = []
    for (var i = 0; i < list.length; i++) made = made.concat(await newObj(pg, list[i] || {}))
    made.forEach(function (o) {
      pg.objs.push(o)
    })
    afterChange([pg])
    return {
      page: pageNo(pg),
      added: made.map(function (o) {
        return describeObj(pg, o)
      })
    }
  })

  studio.tools.register('editObject', async function (a) {
    needEditable()
    var pg = pageArg(a.page)
    var f = findObj({ key: pg.key, id: String(a.id || '') })
    if (!f) throw new Error('No object "' + a.id + '" on page ' + pageNo(pg) + '. Call pdf_listObjects to see the ids.')
    var o = f.o
    if (a.delete) {
      if (S.editing && S.editing.id === o.id) finishEdit(true)
      pg.objs.splice(f.i, 1)
      if (S.sel && S.sel.id === o.id) S.sel = null
      afterChange([pg])
      return 'Deleted ' + o.id
    }
    if (o.type === 'text') {
      if (typeof a.text === 'string') {
        await ensureFontFor(a.text)
        o.text = a.text
      }
      if (a.size != null) o.size = Math.max(2, Math.min(400, num(a.size, o.size)))
      if (a.color != null) o.color = color(a.color, o.color) || o.color
      if (a.font === 'sans' || a.font === 'serif' || a.font === 'mono') o.font = a.font
      if (a.bold != null) o.bold = !!a.bold
      if (a.italic != null) o.italic = !!a.italic
      measure(o)
    } else {
      if (a.stroke !== undefined && o.type !== 'highlight' && o.type !== 'image') o.stroke = color(a.stroke, o.stroke)
      if (a.fill !== undefined && o.type !== 'line' && o.type !== 'arrow' && o.type !== 'image') o.fill = color(a.fill, o.fill)
      if (a.color !== undefined && (o.type === 'highlight' || (o.type === 'rect' && !o.stroke))) o.fill = color(a.color, o.fill)
      if (a.lineWidth != null) o.lw = Math.max(0, num(a.lineWidth, o.lw))
    }
    if (a.opacity != null && o.type !== 'text') o.opacity = Math.max(0.05, Math.min(1, num(a.opacity, 1)))
    if (o.type === 'line' || o.type === 'arrow') {
      if (a.x1 != null || a.y1 != null) {
        var c1 = toDisp(pg, o.x1, o.y1)
        var n1 = fromDisp(pg, num(a.x1, c1.x), num(a.y1, c1.y))
        o.x1 = n1.x
        o.y1 = n1.y
      }
      if (a.x2 != null || a.y2 != null) {
        var c2 = toDisp(pg, o.x2, o.y2)
        var n2 = fromDisp(pg, num(a.x2, c2.x), num(a.y2, c2.y))
        o.x2 = n2.x
        o.y2 = n2.y
      }
    } else if (a.x != null || a.y != null || a.w != null || a.h != null) {
      var cur = toDispBox(pg, bbox(o))
      var nb = fromDispBox(pg, { x: num(a.x, cur.x), y: num(a.y, cur.y), w: Math.max(1, num(a.w, cur.w)), h: Math.max(1, num(a.h, cur.h)) })
      var ob = bbox(o)
      var resized = (a.w != null || a.h != null) && o.type !== 'text'
      if (resized) setBox(o, clone(o), nb)
      else moveObj(o, nb.x - ob.x, nb.y - ob.y)
    }
    afterChange([pg])
    return describeObj(pg, o)
  })

  studio.tools.register('replaceText', async function (a) {
    needEditable()
    var find = String(a.find || '')
    if (!find) throw new Error('`find` is required')
    var repl = String(a.replace == null ? '' : a.replace)
    await ensureFontFor(repl)
    var list = pagesArg(a.pages)
    var done = []
    var changed = []
    for (var i = 0; i < list.length; i++) {
      var pg = list[i]
      var lines = await textRuns(pg)
      var covered = pg.objs.filter(function (o) {
        return o.cover
      })
      var hits = lines.filter(function (l) {
        if (findIn(l.str, find, !!a.caseSensitive) < 0) return false
        return !covered.some(function (o) {
          var c = o.cover
          return l.x >= c.x - 1 && l.y >= c.y - 1 && l.x + l.w <= c.x + c.w + 1 && l.y + l.h <= c.y + c.h + 1
        })
      })
      if (!hits.length) continue
      // 取原文字的颜色和背景色要用渲染好的页面
      await renderPage(pg).catch(function () {})
      for (var j = 0; j < hits.length; j++) {
        var l = hits[j]
        var re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), a.caseSensitive ? 'g' : 'gi')
        var newText = a.all === false ? l.str.replace(new RegExp(re.source, re.flags.replace('g', '')), repl) : l.str.replace(re, function () {
          return repl
        })
        var col = sampleColors(pg, l)
        var size = Math.round(l.fs * 2) / 2
        var o = { id: uid('o'), type: 'text', text: newText, size: size, font: l.family, bold: l.bold, italic: l.italic, color: col.fg, rot: 0, x: l.x, y: l.base - F.BASELINE * size, cover: { x: l.x - 1, y: l.y - 1, w: l.w + 2, h: l.h + 2, color: col.bg } }
        measure(o)
        pg.objs.push(o)
        done.push({ page: pageNo(pg), id: o.id, before: l.str, after: newText })
        if (a.all === false) break
      }
      changed.push(pg)
      if (a.all === false && done.length) break
    }
    if (!done.length) throw new Error('"' + find + '" was not found' + (a.pages ? ' on the given pages' : '') + '. Text split across lines cannot be matched; use pdf_getText to see how the text is laid out.')
    afterChange(changed)
    return { replacedLines: done, note: 'Each changed line is covered and retyped with a similar standard font; use pdf_renderPage to check how it looks.' }
  })

  studio.tools.register('getFormFields', async function () {
    needPdf()
    var out = []
    var seen = {}
    for (var i = 0; i < S.pages.length; i++) {
      var list = await widgets(S.pages[i])
      list.forEach(function (w) {
        var type = w.fieldType === 'Tx' ? 'text' : w.fieldType === 'Ch' ? 'choice' : w.radioButton ? 'radio' : 'checkbox'
        var v = fieldValue(w)
        if (seen[w.fieldName]) {
          if (type === 'radio' && w.buttonValue && seen[w.fieldName].options.indexOf(w.buttonValue) < 0) seen[w.fieldName].options.push(w.buttonValue)
          return
        }
        var f = { name: w.fieldName, type: type, page: i + 1, value: type === 'radio' ? (typeof v === 'string' ? v : null) : v == null ? '' : v }
        if (type === 'radio') f.options = w.buttonValue ? [w.buttonValue] : []
        if (type === 'choice')
          f.options = (w.options || []).map(function (o) {
            return o.exportValue
          })
        if (type === 'choice' && w.multiSelect) f.multiple = true
        if (w.readOnly) f.readOnly = true
        if (w.alternativeText) f.label = w.alternativeText
        seen[w.fieldName] = f
        out.push(f)
      })
    }
    return { fields: out }
  })

  studio.tools.register('fillForm', async function (a) {
    needEditable()
    var values = a.values && typeof a.values === 'object' ? a.values : null
    if (!values) throw new Error('`values` is required: { fieldName: value }')
    var known = {}
    for (var i = 0; i < S.pages.length; i++) {
      ;(await widgets(S.pages[i])).forEach(function (w) {
        known[w.fieldName] = w
      })
    }
    var missing = Object.keys(values).filter(function (k) {
      return !known[k]
    })
    if (missing.length) throw new Error('Unknown field(s): ' + missing.join(', ') + '. Call pdf_getFormFields to see the names.')
    var text = Object.keys(values)
      .map(function (k) {
        return typeof values[k] === 'string' ? values[k] : ''
      })
      .join('')
    await ensureFontFor(text)
    Object.keys(values).forEach(function (k) {
      var w = known[k]
      var v = values[k]
      if (w.fieldType === 'Btn' && !w.radioButton) v = v === true || v === 'true' || v === 'Yes' || v === 'On' || v === 1
      else if (w.fieldType === 'Ch' && w.multiSelect) v = Array.isArray(v) ? v.map(String) : [String(v)]
      else v = v == null ? '' : String(v)
      setField(k, v, null, false)
    })
    S.pages.forEach(function (pg) {
      drawForms(pg)
    })
    commit()
    return { filled: Object.keys(values).length }
  })

  studio.tools.register('editPages', async function (a) {
    needEditable()
    var action = String(a.action || '')
    var before = S.pages.length
    if (action === 'insertBlank') {
      var after = Math.max(0, Math.min(S.pages.length, Math.floor(num(a.after, S.pages.length))))
      var ref = S.pages[Math.max(0, after - 1)]
      var d = ref ? dispSize(ref) : [595.28, 841.89]
      var w = Math.max(36, num(a.width, d[0]))
      var hh = Math.max(36, num(a.height, d[1]))
      var count = Math.max(1, Math.min(100, Math.floor(num(a.count, 1))))
      var blanks = []
      for (var i = 0; i < count; i++) blanks.push({ key: uid('p'), src: null, index: 0, rot: 0, baseRot: 0, vx: 0, vy: 0, w: w, h: hh, objs: [] })
      S.pages.splice.apply(S.pages, [after, 0].concat(blanks))
      S.cur = after
    } else if (action === 'insertPdf') {
      var data = await studio.fs.read(toolPath(a.path))
      var at = a.after == null ? S.pages.length : Math.max(0, Math.min(S.pages.length, Math.floor(num(a.after, S.pages.length))))
      await insertPdfFiles([{ name: String(a.path), data: data }], at)
      if (S.pages.length === before) throw new Error('Nothing was inserted (the PDF may be encrypted or unreadable)')
      return { inserted: S.pages.length - before, pageCount: S.pages.length }
    } else {
      var list = pagesArg(a.pages)
      if (!list.length) throw new Error('`pages` is required')
      if (action === 'rotate') {
        var deg = num(a.angle, 90)
        if (deg % 90) throw new Error('angle must be a multiple of 90')
        list.forEach(function (pg) {
          pg.rot = ((((pg.rot || 0) + deg) % 360) + 360) % 360
        })
        rerenderVisible()
      } else if (action === 'delete') {
        if (list.length >= S.pages.length) throw new Error('A PDF needs at least one page')
        S.pages = S.pages.filter(function (pg) {
          return list.indexOf(pg) < 0
        })
        if (S.sel && !findObj(S.sel)) S.sel = null
      } else if (action === 'duplicate') {
        var last = Math.max.apply(
          null,
          list.map(function (pg) {
            return S.pages.indexOf(pg)
          })
        )
        S.pages.splice.apply(S.pages, [last + 1, 0].concat(list.map(copyPage)))
      } else if (action === 'move') {
        var rest = S.pages.filter(function (pg) {
          return list.indexOf(pg) < 0
        })
        var to = Math.max(1, Math.min(rest.length + 1, Math.floor(num(a.to, 1))))
        rest.splice.apply(rest, [to - 1, 0].concat(list))
        S.pages = rest
      } else throw new Error('Unknown action "' + action + '" (rotate, delete, duplicate, move, insertBlank, insertPdf)')
    }
    S.selPages.clear()
    S.cur = Math.min(Math.max(0, S.cur), S.pages.length - 1)
    commit()
    layout()
    return { pageCount: S.pages.length }
  })

  studio.tools.register('exportPages', async function (a) {
    needEditable()
    var list = pagesArg(a.pages)
    var out = toolPath(a.path)
    if (!/\.pdf$/i.test(out)) throw new Error('`path` must end with .pdf')
    var bytes = await buildBytes(list)
    await studio.fs.write(out, bytes)
    return 'Wrote ' + list.length + ' page(s) to ' + out.slice(1)
  })

  studio.tools.register('setProperties', function (a) {
    needEditable()
    var m = Object.assign({}, S.meta || {})
    ;['title', 'author', 'subject', 'keywords'].forEach(function (k) {
      if (typeof a[k] === 'string') m[k] = a[k]
    })
    S.meta = m
    commit()
    return { title: m.title || '', author: m.author || '', subject: m.subject || '', keywords: m.keywords || '' }
  })

  studio.tools.register('screenshot', async function (a) {
    needPdf()
    var pg = pageArg(a.page == null ? S.cur + 1 : a.page)
    var i = S.pages.indexOf(pg)
    setCur(i, true)
    await renderPage(pg).catch(function () {})
    return 'Page ' + (i + 1) + ' of ' + S.pages.length
  })

  async function askAi() {
    var pg = S.pages[S.cur]
    if (!pg) return
    var lines = await textRuns(pg).catch(function () {
      return []
    })
    var text = lines
      .map(function (l) {
        return l.str
      })
      .join('\n')
    var head = t('（第 {0} 页）', '(page {0})').replace('{0}', S.cur + 1)
    studio.agent.send(head + (text ? '\n' + text : ''), { file: true }).catch(function (e) {
      studio.toast(e.message)
    })
  }

  var registered = false
  function registerCommands() {
    if (registered || !studio.has('commands.register')) return
    registered = true
    ;[
      ['insert-blank', t('插入空白页', 'Insert blank page'), insertBlank],
      ['insert-pdf', t('插入 PDF 文件…', 'Insert PDF file…'), insertPdf],
      ['export-pages', t('导出选中页为 PDF…', 'Export selected pages as PDF…'), exportSelected],
      ['export-png', t('导出当前页为 PNG…', 'Export current page as PNG…'), exportPng],
      ['properties', t('文档属性…', 'Document properties…'), showProps],
      ['unicode-font', t('选择中文字体…', 'Choose Unicode font…'), pickFont]
    ]
      .concat(studio.has('agent.send') ? [['ask-ai', t('把当前页的文字发给 AI 助手', 'Send the current page text to the AI assistant'), askAi]] : [])
      .forEach(function (c) {
        studio.commands.register(c[0], c[1], c[2]).catch(function () {})
      })
  }

  studio.onLoad(function (content, info) {
    var bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(0)
    registerCommands()
    return open(bytes, info)
  })

  buildBar()
  bind()
  setTool('select')
  F.init()
})()
