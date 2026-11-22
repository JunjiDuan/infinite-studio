/**
 * 演示文稿编辑器界面：工具栏、缩略图、画布（选中 / 移动 / 缩放 / 旋转 / 文字编辑）、备注、放映。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var Render = window.Render
  var Doc = window.Doc
  var EMU = 9525
  var t = function (zh, en) {
    return studio.t(zh, en)
  }

  var S = {
    pkg: null,
    doc: null,
    cur: 0,
    items: [],
    sel: null, // 选中元素的 XML
    editing: null,
    zoom: 0, // 0 = 适应窗口
    fit: 1,
    history: [],
    hi: -1,
    clip: null,
    noPrompt: null,
    fileName: '',
    readOnly: false
  }

  // #sel / #guides 会被移进画布，画布清空时就不在文档里了，所以先记住
  var keep = {}
  var $ = function (id) {
    return keep[id] || document.getElementById(id)
  }
  function h(tag, attrs) {
    var e = document.createElement(tag)
    if (attrs)
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null || v === false) continue
        if (k === 'class') e.className = v
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

  /* ---------------- 图标 ---------------- */

  function ico(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'
  }
  var I = {
    add: ico('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 9v6M9 12h6"/>'),
    dup: ico('<rect x="8" y="8" width="13" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>'),
    del: ico('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    undo: ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    redo: ico('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
    text: ico('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
    shape: ico('<rect x="3" y="11" width="9" height="9" rx="1"/><circle cx="16" cy="8" r="5"/>'),
    image: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
    table: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>'),
    bold: ico('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
    italic: ico('<path d="M14 5h-4M14 19h-4M15 5l-6 14"/>'),
    underline: ico('<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>'),
    color: ico('<path d="m6 16 6-12 6 12M8 12h8"/><path d="M4 20h16" stroke-width="3" class="swatch"/>'),
    left: ico('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    center: ico('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    right: ico('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
    fill: ico('<path d="m5 12 7-7 7 7-7 7z"/><path d="M19 15s2 2.2 2 3.5a2 2 0 0 1-4 0c0-1.3 2-3.5 2-3.5z"/><path d="M3 22h18" stroke-width="3" class="swatch"/>'),
    line: ico('<path d="M4 18 18 4"/><path d="M3 22h18" stroke-width="3" class="swatch"/>'),
    layer: ico('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
    zoomIn: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>'),
    zoomOut: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>'),
    fit: ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    play: ico('<path d="M7 4v16l13-8z"/>'),
    help: ico('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>'),
    notes: ico('<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>'),
    caret: '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 10 5 5 5-5"/></svg>',
    fontUp: ico('<path d="m3 18 5-12 5 12M5 14h6M17 10V4M14 7h6"/>'),
    fontDown: ico('<path d="m3 18 5-12 5 12M5 14h6M14 7h6"/>'),
    export: ico('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>')
  }

  /* ---------------- 载入 ---------------- */

  async function load(content, info) {
    S.fileName = (info && info.fileName) || ''
    var buf = content
    var fresh = false
    if (!buf || !buf.byteLength) {
      // 新建的空文件：生成空白演示文稿
      var files = Blank.files(t)
      var list = []
      var enc = new TextEncoder()
      files.forEach(function (v, k) {
        list.push({ name: k, data: enc.encode(v) })
      })
      buf = (await Zip.write(list)).buffer
      fresh = true
    }
    try {
      var pkg = new OX.Pkg()
      await pkg.load(buf)
      S.pkg = pkg
      S.doc = new Doc(pkg)
    } catch (e) {
      console.error(e)
      showError(/encrypted/.test(String(e && e.message)) ? t('这个文件有密码保护，无法打开。', 'This file is password protected.') : t('无法打开这个文件：它不是有效的 PowerPoint（.pptx）文件。', 'Cannot open this file: it is not a valid PowerPoint (.pptx) file.'))
      return
    }
    $('error').hidden = true
    S.cur = Math.min(S.cur, Math.max(0, S.doc.slides().length - 1))
    S.sel = null
    S.editing = null
    S.history = [S.pkg.snapshot()]
    S.hi = 0
    renderAll()
    if (fresh) {
      studio.setDirty(true)
      studio.save()
    } else studio.setDirty(false)
  }

  function showError(msg) {
    var e = $('error')
    e.textContent = msg
    e.hidden = false
  }

  /* ---------------- 历史 ---------------- */

  function commit(opts) {
    opts = opts || {}
    S.history = S.history.slice(0, S.hi + 1)
    S.history.push(S.pkg.snapshot())
    if (S.history.length > 100) S.history.shift()
    S.hi = S.history.length - 1
    studio.setDirty(true)
    if (opts.structure) renderAll()
    else {
      renderCurrent()
      renderThumb(S.cur)
    }
    updateBar()
  }
  function undo() {
    if (S.hi <= 0) return
    endEdit(false)
    S.hi--
    S.pkg.restore(S.history[S.hi])
    afterRestore()
  }
  function redo() {
    if (S.hi >= S.history.length - 1) return
    endEdit(false)
    S.hi++
    S.pkg.restore(S.history[S.hi])
    afterRestore()
  }
  function afterRestore() {
    S.doc = new Doc(S.pkg)
    var n = S.doc.slides().length
    if (S.cur >= n) S.cur = Math.max(0, n - 1)
    S.sel = null
    studio.setDirty(true)
    renderAll()
  }

  /* ---------------- 渲染 ---------------- */

  function slidePath(i) {
    var s = S.doc.slides()[i == null ? S.cur : i]
    return s ? s.path : null
  }

  function renderAll() {
    renderThumbs()
    renderCurrent()
    updateBar()
  }

  function renderThumbs() {
    var side = $('side')
    side.textContent = ''
    var slides = S.doc.slides()
    var secs = S.doc.sectionNames()
    var tw = 168
    var scale = tw / (S.doc.pres.cx / EMU)
    slides.forEach(function (s, i) {
      secs.forEach(function (sec) {
        if (sec.first === i) side.appendChild(h('div', { class: 'section', text: sec.name || t('无标题节', 'Untitled Section') }))
      })
      var box = h('div', { class: 'thumb' + (i === S.cur ? ' cur' : '') + (S.doc.isHidden(i) ? ' hidden-slide' : ''), draggable: 'true', 'data-i': i })
      box.appendChild(h('div', { class: 'num', text: String(i + 1) }))
      var frame = h('div', { class: 'tframe', style: { width: tw + 'px', height: (S.doc.pres.cy / EMU) * scale + 'px' } })
      box.appendChild(frame)
      side.appendChild(box)
      fillThumb(frame, i, scale)
    })
    side.appendChild(h('button', { class: 'add-slide', title: t('新建幻灯片', 'New slide'), html: I.add, onClick: function (e) { layoutMenu(e.currentTarget, S.cur + 1) } }))
    var cur = side.querySelector('.thumb.cur')
    if (cur) cur.scrollIntoView({ block: 'nearest' })
  }
  function fillThumb(frame, i, scale) {
    frame.textContent = ''
    try {
      var r = Render.renderSlide(S.doc.pres, slidePath(i), { slideNum: i + 1 })
      r.el.style.transform = 'scale(' + scale + ')'
      frame.appendChild(r.el)
    } catch (e) {
      console.error(e)
    }
  }
  function renderThumb(i) {
    var box = $('side').querySelector('.thumb[data-i="' + i + '"] .tframe')
    if (!box) return renderThumbs()
    fillThumb(box, i, box.clientWidth / (S.doc.pres.cx / EMU))
  }

  function renderCurrent() {
    var canvas = $('canvas')
    canvas.textContent = ''
    S.items = []
    var path = slidePath()
    if (!path) {
      $('empty').hidden = false
      $('sel').hidden = true
      layoutStage()
      return
    }
    $('empty').hidden = true
    var r = Render.renderSlide(S.doc.pres, path, { slideNum: S.cur + 1, prompts: true, noPrompt: S.noPrompt })
    S.items = r.items
    S.slideEl = r.el
    canvas.appendChild(r.el)
    canvas.appendChild($('sel'))
    canvas.appendChild($('guides'))
    if (S.sel && !itemOf(S.sel)) S.sel = null
    layoutStage()
    drawSel()
    renderNotes()
  }

  function itemOf(xml) {
    for (var i = 0; i < S.items.length; i++) if (S.items[i].xml === xml) return S.items[i]
    return null
  }

  /* ---------------- 缩放 ---------------- */

  function layoutStage() {
    var stage = $('stage')
    var W = S.doc ? S.doc.pres.cx / EMU : 1280
    var H = S.doc ? S.doc.pres.cy / EMU : 720
    var pad = 40
    S.fit = Math.max(0.05, Math.min((stage.clientWidth - pad * 2) / W, (stage.clientHeight - pad * 2) / H))
    var z = S.zoom || S.fit
    var canvas = $('canvas')
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    canvas.style.transform = 'scale(' + z + ')'
    var wrap = $('wrap')
    wrap.style.width = Math.max(stage.clientWidth, W * z + pad * 2) + 'px'
    wrap.style.height = Math.max(stage.clientHeight, H * z + pad * 2) + 'px'
    canvas.style.left = Math.max(pad, (wrap.clientWidth - W * z) / 2) + 'px'
    canvas.style.top = Math.max(pad, (wrap.clientHeight - H * z) / 2) + 'px'
    document.documentElement.style.setProperty('--z', z)
    var zl = document.querySelector('#bar .zoom')
    if (zl) zl.textContent = Math.round(z * 100) + '%'
  }
  function zoomBy(f, cx, cy) {
    var stage = $('stage')
    var old = S.zoom || S.fit
    var z = Math.max(0.1, Math.min(4, old * f))
    var rect = stage.getBoundingClientRect()
    var px = cx == null ? stage.clientWidth / 2 : cx - rect.left
    var py = cy == null ? stage.clientHeight / 2 : cy - rect.top
    var sx = (stage.scrollLeft + px) / old
    var sy = (stage.scrollTop + py) / old
    S.zoom = z
    layoutStage()
    stage.scrollLeft = sx * z - px
    stage.scrollTop = sy * z - py
  }

  function toSlide(e) {
    var r = $('canvas').getBoundingClientRect()
    var z = S.zoom || S.fit
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z }
  }

  /* ---------------- 选中框 ---------------- */

  function drawSel() {
    var sel = $('sel')
    var it = S.sel ? itemOf(S.sel) : null
    if (!it || S.readOnly) {
      sel.hidden = true
      updateBar()
      return
    }
    var b = it.box
    sel.hidden = false
    sel.classList.toggle('editing', !!S.editing)
    sel.classList.toggle('line', isLine(it))
    Object.assign(sel.style, { left: b.x + 'px', top: b.y + 'px', width: Math.max(b.w, 0) + 'px', height: Math.max(b.h, 0) + 'px', transform: b.rot ? 'rotate(' + b.rot + 'deg)' : '' })
    updateBar()
  }
  function isLine(it) {
    var g = OX.path(it.target, 'spPr', 'prstGeom')
    return it.target.localName === 'cxnSp' || (g && /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/.test(OX.attr(g, 'prst')))
  }

  function select(xml) {
    S.sel = xml
    drawSel()
  }

  /* ---------------- 指针交互 ---------------- */

  var drag = null

  function onDown(e) {
    if (e.button === 2) return
    if (!S.doc || !slidePath()) return
    var hit = e.target
    if (S.editing && S.editing.tb.contains(hit)) return
    if (S.editing) endEdit(true)
    var handle = hit.dataset && hit.dataset.h
    var it = S.sel ? itemOf(S.sel) : null
    var p = toSlide(e)
    if (handle && it) {
      e.preventDefault()
      startDrag(handle === 'rot' ? 'rot' : 'resize', it, p, e, handle)
      return
    }
    var node = hit.closest && hit.closest('.layer > [data-k]')
    if (node) {
      var item = S.items[Number(node.dataset.k)]
      e.preventDefault()
      $('stage').focus({ preventScroll: true })
      select(item.xml)
      startDrag('move', item, p, e)
      return
    }
    if (hit.closest && hit.closest('#sel') && it) {
      e.preventDefault()
      startDrag('move', it, p, e)
      return
    }
    select(null)
    $('stage').focus({ preventScroll: true })
  }

  function startDrag(kind, it, p, e, handle) {
    drag = { kind: kind, it: it, start: p, box: Object.assign({}, it.box), handle: handle, moved: false, shift: e.shiftKey, id: e.pointerId }
    $('stage').setPointerCapture(e.pointerId)
  }

  function snapMove(b, dx, dy) {
    var W = S.doc.pres.cx / EMU, H = S.doc.pres.cy / EMU
    var th = 5 / (S.zoom || S.fit)
    var xs = [0, W / 2, W], ys = [0, H / 2, H]
    S.items.forEach(function (o) {
      if (o === drag.it) return
      xs.push(o.box.x, o.box.x + o.box.w / 2, o.box.x + o.box.w)
      ys.push(o.box.y, o.box.y + o.box.h / 2, o.box.y + o.box.h)
    })
    var nx = b.x + dx, ny = b.y + dy
    var gx = null, gy = null
    var best = th
    ;[0, b.w / 2, b.w].forEach(function (o) {
      xs.forEach(function (x) {
        var d = Math.abs(nx + o - x)
        if (d < best) (best = d), (gx = x), (dx = x - o - b.x)
      })
    })
    best = th
    ;[0, b.h / 2, b.h].forEach(function (o) {
      ys.forEach(function (y) {
        var d = Math.abs(ny + o - y)
        if (d < best) (best = d), (gy = y), (dy = y - o - b.y)
      })
    })
    var g = $('guides')
    g.textContent = ''
    if (gx != null) g.appendChild(h('div', { class: 'gv', style: { left: gx + 'px' } }))
    if (gy != null) g.appendChild(h('div', { class: 'gh', style: { top: gy + 'px' } }))
    return { dx: dx, dy: dy }
  }

  function onMove(e) {
    if (!drag) return
    var p = toSlide(e)
    var dx = p.x - drag.start.x, dy = p.y - drag.start.y
    if (!drag.moved && Math.hypot(dx, dy) * (S.zoom || S.fit) < 3) return
    drag.moved = true
    var b0 = drag.box
    var nb = Object.assign({}, b0)
    if (drag.kind === 'move') {
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
      var s = e.altKey ? { dx: dx, dy: dy } : snapMove(b0, dx, dy)
      nb.x = b0.x + s.dx
      nb.y = b0.y + s.dy
    } else if (drag.kind === 'resize') {
      nb = resizeBox(b0, drag.handle, dx, dy, e.shiftKey || isPic(drag.it), isLine(drag.it))
    } else if (drag.kind === 'rot') {
      var cx = b0.x + b0.w / 2, cy = b0.y + b0.h / 2
      var a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90
      if (e.shiftKey) a = Math.round(a / 15) * 15
      nb.rot = ((a % 360) + 360) % 360
    }
    drag.nb = nb
    // 实时预览
    var node = drag.it.node
    node.style.left = nb.x + 'px'
    node.style.top = nb.y + 'px'
    node.style.width = nb.w + 'px'
    node.style.height = nb.h + 'px'
    node.style.transform = nb.rot ? 'rotate(' + nb.rot + 'deg)' : ''
    var svg = node.querySelector(':scope > svg.geo')
    if (svg && drag.kind === 'resize') {
      svg.setAttribute('preserveAspectRatio', 'none')
      svg.style.width = '100%'
      svg.style.height = '100%'
    }
    drag.it.box = nb
    drawSel()
  }

  function isPic(it) {
    return it.target.localName === 'pic'
  }

  /** 在形状自身（旋转后）的坐标系里缩放 */
  function resizeBox(b, hd, dx, dy, keep, line) {
    var r = ((b.rot || 0) * Math.PI) / 180
    var cos = Math.cos(r), sin = Math.sin(r)
    var lx = dx * cos + dy * sin
    var ly = -dx * sin + dy * cos
    var w = b.w, hh = b.h
    var sx = hd.indexOf('e') >= 0 ? 1 : hd.indexOf('w') >= 0 ? -1 : 0
    var sy = hd.indexOf('s') >= 0 ? 1 : hd.indexOf('n') >= 0 ? -1 : 0
    var nw = Math.max(line ? 0 : 4, w + sx * lx)
    var nh = Math.max(line ? 0 : 4, hh + sy * ly)
    if (keep && sx && sy && w && hh) {
      var k = Math.max(nw / w, nh / hh)
      nw = w * k
      nh = hh * k
    }
    // 对边（或对角）保持不动
    var ax = -sx * (w / 2), ay = -sy * (hh / 2)
    var cx = b.x + w / 2, cy = b.y + hh / 2
    var wx = cx + ax * cos - ay * sin
    var wy = cy + ax * sin + ay * cos
    var nax = -sx * (nw / 2), nay = -sy * (nh / 2)
    var ncx = wx - (nax * cos - nay * sin)
    var ncy = wy - (nax * sin + nay * cos)
    return { x: ncx - nw / 2, y: ncy - nh / 2, w: nw, h: nh, rot: b.rot, flipH: b.flipH, flipV: b.flipV }
  }

  function onUp(e) {
    if (!drag) return
    var d = drag
    drag = null
    $('guides').textContent = ''
    try {
      $('stage').releasePointerCapture(e.pointerId)
    } catch (err) {}
    if (!d.moved || !d.nb) return
    var nb = d.nb
    var cur = { x: d.box.x * EMU, y: d.box.y * EMU, w: d.box.w * EMU, h: d.box.h * EMU }
    S.doc.setBox(slidePath(), d.it.xml, { x: nb.x * EMU, y: nb.y * EMU, w: nb.w * EMU, h: nb.h * EMU, rot: nb.rot || 0 }, cur)
    commit()
  }

  function onDbl(e) {
    if (!S.doc || S.readOnly) return
    var node = e.target.closest && e.target.closest('.layer > [data-k]')
    if (!node) return
    var it = S.items[Number(node.dataset.k)]
    startEdit(it, e)
  }

  /* ---------------- 文字编辑 ---------------- */

  function startEdit(it, e, selectAll) {
    if (!it || it.xml !== it.target) return
    var part = slidePath()
    var el = it.target
    var tbEl = null
    if (el.localName === 'graphicFrame') {
      var td = e && e.target.closest ? e.target.closest('td') : null
      if (!td) {
        td = it.node.querySelector('td')
      }
      tbEl = td ? td.querySelector('.tb') : null
      if (!tbEl) return
    } else {
      if (el.localName !== 'sp') return
      var needRender = false
      if (!OX.kid(el, 'txBody')) {
        S.doc.ensureTxBody(part, el)
        needRender = true
      }
      if (OX.phOf(el) && !Render.hasText(OX.kid(el, 'txBody'))) {
        S.noPrompt = el
        needRender = true
      }
      if (needRender) {
        renderCurrent()
        it = itemOf(el)
        if (!it) return
      }
      tbEl = it.node.querySelector(':scope > .tx > .tb')
      if (!tbEl) return
    }
    var info = Render.textMap.get(tbEl)
    if (!info) return
    S.sel = it.xml
    S.editing = { it: it, tb: tbEl, info: info, before: tbEl.innerHTML, part: part }
    it.node.classList.add('editing')
    tbEl.contentEditable = 'true'
    tbEl.spellcheck = false
    tbEl.focus({ preventScroll: true })
    document.execCommand('styleWithCSS', false, true)
    var sel = window.getSelection()
    var range = null
    if (e && e.clientX != null && !selectAll) range = document.caretRangeFromPoint(e.clientX, e.clientY)
    if (!range || !tbEl.contains(range.startContainer)) {
      range = document.createRange()
      range.selectNodeContents(tbEl)
      if (!selectAll) range.collapse(false)
    }
    sel.removeAllRanges()
    sel.addRange(range)
    drawSel()
  }

  function endEdit(save) {
    var ed = S.editing
    if (!ed) return
    S.editing = null
    ed.tb.contentEditable = 'false'
    ed.it.node.classList.remove('editing')
    window.getSelection().removeAllRanges()
    var changed = ed.tb.innerHTML !== ed.before
    var hadPrompt = S.noPrompt
    S.noPrompt = null
    if (save && changed) {
      S.doc.commitText(ed.part, ed.tb, ed.info)
      // 新建的文本框没写字就删掉
      var el = ed.it.xml
      if (OX.desc(el, 'cNvSpPr').some(function (c) { return OX.attr(c, 'txBox') === '1' }) && !Render.hasText(OX.kid(el, 'txBody'))) {
        S.doc.remove(ed.part, el)
        S.sel = null
      }
      commit()
    } else {
      if (ed.fresh) {
        S.doc.remove(ed.part, ed.it.xml)
        S.sel = null
        commit()
        return
      }
      if (hadPrompt || changed) renderCurrent()
      else drawSel()
    }
  }

  function editKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      endEdit(true)
      return true
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      paraInSelection().forEach(function (p) {
        var lvl = Number(p.dataset.lvl != null ? p.dataset.lvl : p.dataset.origLvl || 0)
        if (p.dataset.lvl == null) {
          var i = Number(p.dataset.p)
          var op = OX.kids(S.editing.info.txBody, 'p')[i]
          lvl = OX.num(OX.kid(op, 'pPr'), 'lvl', 0)
        }
        var nl = Math.max(0, Math.min(8, lvl + (e.shiftKey ? -1 : 1)))
        if (nl === lvl) return
        p.dataset.lvl = nl
        p.style.paddingLeft = (parseFloat(p.style.paddingLeft) || 0) + (nl - lvl) * 48 + 'px'
      })
      return true
    }
    var mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      var k = e.key.toLowerCase()
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault()
        document.execCommand(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline')
        return true
      }
      if (k === 'e' || k === 'l' || k === 'r') {
        e.preventDefault()
        align(k === 'e' ? 'ctr' : k)
        return true
      }
    }
    return false
  }

  function paraInSelection() {
    var ed = S.editing
    if (!ed) return []
    var sel = window.getSelection()
    if (!sel.rangeCount) return []
    var r = sel.getRangeAt(0)
    return Array.prototype.slice.call(ed.tb.children).filter(function (p) {
      return r.intersectsNode(p)
    })
  }

  /* ---------------- 格式 ---------------- */

  function selItem() {
    return S.sel ? itemOf(S.sel) : null
  }
  /** 渲染出来的 run 当前字号（pt） */
  function sizeOf(it) {
    return function (rPr) {
      var sz = rPr.getAttribute('sz')
      if (sz) return Number(sz) / 100
      var span = it.node.querySelector('span.r')
      return span ? Number(span.dataset.z) || 18 : 18
    }
  }

  function fmt(f) {
    if (S.editing) {
      if (f.b != null) document.execCommand('bold')
      if (f.i != null) document.execCommand('italic')
      if (f.u != null) document.execCommand('underline')
      if (f.color !== undefined && f.color) document.execCommand('foreColor', false, f.color)
      if (f.sz != null || f.sizeStep) setEditSize(f)
      if (f.algn) align(f.algn)
      return
    }
    var it = selItem()
    if (!it) return
    if (S.doc.formatShape(slidePath(), it.target, f, sizeOf(it))) commit()
  }
  function setEditSize(f) {
    var ed = S.editing
    var sel = window.getSelection()
    if (!sel.rangeCount) return
    if (sel.isCollapsed) {
      var r = document.createRange()
      r.selectNodeContents(ed.tb)
      sel.removeAllRanges()
      sel.addRange(r)
    }
    var cur = 18
    var node = sel.anchorNode && (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode)
    if (node) cur = (parseFloat(getComputedStyle(node).fontSize) * 0.75) / (ed.info.fontScale || 1)
    var pt = f.sz != null ? f.sz : stepSize(cur, f.sizeStep)
    document.execCommand('fontSize', false, '7')
    var px = ((pt * 4) / 3) * (ed.info.fontScale || 1) + 'px'
    ed.tb.querySelectorAll('font[size="7"]').forEach(function (fe) {
      var s = document.createElement('span')
      s.style.fontSize = px
      while (fe.firstChild) s.appendChild(fe.firstChild)
      fe.parentNode.replaceChild(s, fe)
    })
    ed.tb.querySelectorAll('[style]').forEach(function (x) {
      if (x.style.fontSize === 'xxx-large' || x.style.fontSize === '-webkit-xxx-large') x.style.fontSize = px
    })
  }
  var SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96]
  function stepSize(cur, dir) {
    if (dir > 0) {
      for (var i = 0; i < SIZES.length; i++) if (SIZES[i] > cur + 0.01) return SIZES[i]
      return cur + 8
    }
    for (var j = SIZES.length - 1; j >= 0; j--) if (SIZES[j] < cur - 0.01) return SIZES[j]
    return Math.max(1, cur - 1)
  }
  function align(a) {
    var css = { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[a]
    if (S.editing) {
      paraInSelection().forEach(function (p) {
        p.style.textAlign = css
        p.dataset.algn = a
      })
      return
    }
    fmt({ algn: a })
  }

  /* ---------------- 插入 ---------------- */

  function center(w, h) {
    var W = S.doc.pres.cx, H = S.doc.pres.cy
    return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h }
  }

  function insertTextBox() {
    var part = slidePath()
    if (!part) return
    var W = S.doc.pres.cx
    var el = S.doc.addTextBox(part, center(W * 0.4, 523220), t('文本框', 'TextBox'))
    commit()
    var it = itemOf(el)
    select(el)
    startEdit(it, null)
    if (S.editing) S.editing.fresh = true
  }

  var SHAPES = [
    ['rect', '矩形', 'Rectangle'], ['roundRect', '圆角矩形', 'Rounded Rectangle'], ['ellipse', '椭圆', 'Oval'], ['triangle', '三角形', 'Triangle'],
    ['rtTriangle', '直角三角形', 'Right Triangle'], ['diamond', '菱形', 'Diamond'], ['parallelogram', '平行四边形', 'Parallelogram'], ['trapezoid', '梯形', 'Trapezoid'],
    ['pentagon', '五边形', 'Pentagon'], ['hexagon', '六边形', 'Hexagon'], ['octagon', '八边形', 'Octagon'], ['donut', '圆环', 'Donut'],
    ['rightArrow', '右箭头', 'Right Arrow'], ['leftArrow', '左箭头', 'Left Arrow'], ['upArrow', '上箭头', 'Up Arrow'], ['downArrow', '下箭头', 'Down Arrow'],
    ['leftRightArrow', '左右箭头', 'Left-Right Arrow'], ['chevron', 'V 形', 'Chevron'], ['homePlate', '五边形箭头', 'Pentagon Arrow'], ['plus', '十字形', 'Cross'],
    ['star5', '五角星', '5-Point Star'], ['star6', '六角星', '6-Point Star'], ['heart', '心形', 'Heart'], ['lightningBolt', '闪电', 'Lightning Bolt'],
    ['wedgeRectCallout', '矩形标注', 'Rectangular Callout'], ['wedgeEllipseCallout', '椭圆标注', 'Oval Callout'], ['cloud', '云形', 'Cloud'], ['can', '圆柱', 'Can'],
    ['cube', '立方体', 'Cube'], ['flowChartDecision', '决策', 'Decision'], ['flowChartTerminator', '终止', 'Terminator'], ['flowChartDocument', '文档', 'Document'],
    ['line', '直线', 'Line'], ['straightConnector1', '箭头线', 'Arrow']
  ]

  function insertShape(prst, name) {
    var part = slidePath()
    if (!part) return
    var line = prst === 'line' || prst === 'straightConnector1'
    var el = S.doc.addShape(part, prst, line ? center(2438400, 0) : center(1828800, prst === 'rect' || prst === 'roundRect' ? 1219200 : 1828800), name)
    commit()
    select(el)
  }

  function pickImage() {
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/bmp,image/svg+xml,image/webp' })
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) insertImageFile(input.files[0])
    })
    input.click()
  }

  function extForType(type, name) {
    var m = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/webp': 'png' }
    if (m[type]) return m[type]
    var e = OX.extOf(name || '')
    return e === 'jpg' ? 'jpeg' : e || 'png'
  }

  async function insertImageFile(file, at) {
    var part = slidePath()
    if (!part) return
    var bytes = new Uint8Array(await file.arrayBuffer())
    var ext = extForType(file.type, file.name)
    // WebP 在旧版 PowerPoint 里打不开，转成 PNG
    if (file.type === 'image/webp') bytes = await toPng(file)
    var url = URL.createObjectURL(new Blob([bytes], { type: OX.MIME[ext] }))
    var size = await new Promise(function (res) {
      var img = new Image()
      img.onload = function () {
        res({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 })
      }
      img.onerror = function () {
        res({ w: 400, h: 300 })
      }
      img.src = url
    })
    URL.revokeObjectURL(url)
    var W = S.doc.pres.cx, H = S.doc.pres.cy
    var w = size.w * EMU, hh = size.h * EMU
    var k = Math.min(1, (W * 0.8) / w, (H * 0.8) / hh)
    w *= k
    hh *= k
    var b = center(w, hh)
    if (at) {
      b.x = Math.max(0, Math.min(W - w, at.x * EMU - w / 2))
      b.y = Math.max(0, Math.min(H - hh, at.y * EMU - hh / 2))
    }
    var el = S.doc.addPicture(part, bytes, ext, b, t('图片', 'Picture'))
    commit()
    select(el)
  }
  async function toPng(file) {
    var bmp = await createImageBitmap(file)
    var c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    c.getContext('2d').drawImage(bmp, 0, 0)
    var blob = await new Promise(function (res) {
      c.toBlob(res, 'image/png')
    })
    return new Uint8Array(await blob.arrayBuffer())
  }

  function insertTable(rows, cols) {
    var part = slidePath()
    if (!part) return
    var W = S.doc.pres.cx
    var w = Math.min(W * 0.8, cols * 1828800)
    var el = S.doc.addTable(part, rows, cols, center(w, rows * 370840), t('表格', 'Table'))
    commit()
    select(el)
  }

  /* ---------------- 幻灯片 ---------------- */

  function go(i) {
    var n = S.doc.slides().length
    if (!n) return
    i = Math.max(0, Math.min(n - 1, i))
    if (S.editing) endEdit(true)
    if (i === S.cur) return
    S.cur = i
    S.sel = null
    $('side')
      .querySelectorAll('.thumb')
      .forEach(function (th) {
        th.classList.toggle('cur', Number(th.dataset.i) === i)
      })
    var cur = $('side').querySelector('.thumb.cur')
    if (cur) cur.scrollIntoView({ block: 'nearest' })
    renderCurrent()
    updateBar()
  }

  function newSlide(layoutPath, index) {
    endEdit(true)
    var slides = S.doc.slides()
    if (!layoutPath) {
      // 默认：当前幻灯片用的版式；标题页之后用“标题和内容”
      var layouts = S.doc.pres.layouts()
      var curLayout = slides[S.cur] ? S.pkg.relOfType(slides[S.cur].path, OX.REL.layout) : null
      layoutPath = curLayout ? curLayout.target : layouts[0] && layouts[0].path
      var lt = layouts.filter(function (l) {
        return l.path === layoutPath
      })[0]
      if (lt && lt.type === 'title') {
        var obj = layouts.filter(function (l) {
          return l.type === 'obj' && l.master === lt.master
        })[0]
        if (obj) layoutPath = obj.path
      }
    }
    if (!layoutPath) return
    if (index == null) index = S.cur + 1
    var ref = slides[index - 1] || slides[index]
    S.doc.addSlide(layoutPath, index, ref ? ref.id : null)
    S.cur = index
    S.sel = null
    commit({ structure: true })
  }
  function duplicateSlide(i) {
    endEdit(true)
    if (S.doc.duplicateSlide(i)) {
      S.cur = i + 1
      S.sel = null
      commit({ structure: true })
    }
  }
  function deleteSlide(i) {
    endEdit(true)
    S.doc.deleteSlide(i)
    var n = S.doc.slides().length
    S.cur = Math.min(i, Math.max(0, n - 1))
    S.sel = null
    commit({ structure: true })
  }
  function moveSlide(from, to) {
    if (S.doc.moveSlide(from, to)) {
      S.cur = to
      commit({ structure: true })
    }
  }

  /* ---------------- 剪贴板 ---------------- */

  function copySel(cut) {
    var it = selItem()
    if (!it) return false
    S.clip = S.doc.copy(slidePath(), it.xml)
    S.clip.pastes = 0
    if (cut) {
      S.doc.remove(slidePath(), it.xml)
      S.sel = null
      commit()
    }
    return true
  }
  function pasteClip() {
    if (!S.clip || !slidePath()) return false
    S.clip.pastes = S.clip.part === slidePath() ? (S.clip.pastes || 0) + 1 : 0
    var el = S.doc.paste(slidePath(), S.clip, S.clip.pastes * 182880)
    commit()
    select(el)
    return true
  }
  function deleteSel() {
    var it = selItem()
    if (!it) return
    S.doc.remove(slidePath(), it.xml)
    S.sel = null
    commit()
  }
  function nudge(dx, dy) {
    var it = selItem()
    if (!it) return
    var b = it.box
    S.doc.setBox(slidePath(), it.xml, { x: (b.x + dx) * EMU, y: (b.y + dy) * EMU, w: b.w * EMU, h: b.h * EMU }, { x: b.x * EMU, y: b.y * EMU, w: b.w * EMU, h: b.h * EMU })
    commit()
  }

  /* ---------------- 键盘 ---------------- */

  function onKey(e) {
    if ($('show') && !$('show').hidden) return showKey(e)
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return
    closePop()
    if (S.editing) {
      editKey(e)
      return
    }
    if (!S.doc) return
    var mod = e.ctrlKey || e.metaKey
    var k = e.key
    var lower = k.length === 1 ? k.toLowerCase() : k
    if (mod && !e.altKey) {
      if (lower === 'z' && !e.shiftKey) return stop(e, undo)
      if (lower === 'y' || (lower === 'z' && e.shiftKey)) return stop(e, redo)
      if (lower === 'c') return copySel(false) && e.preventDefault()
      if (lower === 'x') return copySel(true) && e.preventDefault()
      if (lower === 'd') {
        e.preventDefault()
        if (copySel(false)) pasteClip()
        return
      }
      if (lower === 'm') return stop(e, function () { newSlide() })
      if (lower === 'b' || lower === 'i' || lower === 'u') {
        if (!selItem()) return
        e.preventDefault()
        var cur = selItem().node.querySelector('span.r')
        var f = {}
        f[lower] = cur ? cur.dataset[lower] !== '1' : true
        fmt(f)
        return
      }
      if (lower === '=' || lower === '+') return stop(e, function () { zoomBy(1.2) })
      if (lower === '-') return stop(e, function () { zoomBy(1 / 1.2) })
      if (lower === '0') return stop(e, function () { S.zoom = 0; layoutStage() })
      return
    }
    var it = selItem()
    var step = e.shiftKey ? 10 : 1
    switch (k) {
      case 'Delete':
      case 'Backspace':
        if (it) return stop(e, deleteSel)
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#side')) return stop(e, function () { deleteSlide(S.cur) })
        return
      case 'Escape':
        if (it) return stop(e, function () { select(null) })
        return
      case 'Enter':
      case 'F2':
        if (it) return stop(e, function () { startEdit(it, null, k === 'F2' ? false : true) })
        return
      case 'F5':
        return stop(e, function () { present(e.shiftKey ? S.cur : 0) })
      case 'ArrowLeft':
        if (it) return stop(e, function () { nudge(-step, 0) })
        return stop(e, function () { go(S.cur - 1) })
      case 'ArrowRight':
        if (it) return stop(e, function () { nudge(step, 0) })
        return stop(e, function () { go(S.cur + 1) })
      case 'ArrowUp':
        if (it) return stop(e, function () { nudge(0, -step) })
        return stop(e, function () { go(S.cur - 1) })
      case 'ArrowDown':
        if (it) return stop(e, function () { nudge(0, step) })
        return stop(e, function () { go(S.cur + 1) })
      case 'PageUp':
        return stop(e, function () { go(S.cur - 1) })
      case 'PageDown':
        return stop(e, function () { go(S.cur + 1) })
      case 'Home':
        return stop(e, function () { go(0) })
      case 'End':
        return stop(e, function () { go(S.doc.slides().length - 1) })
      case 'Tab':
        if (S.items.length) {
          e.preventDefault()
          var idx = it ? S.items.indexOf(it) : -1
          var n = S.items.length
          select(S.items[(idx + (e.shiftKey ? n - 1 : 1)) % n].xml)
        }
        return
    }
    // 选中形状后直接打字：进入编辑并替换文字（和 PowerPoint 一样）
    if (it && k.length === 1 && !e.altKey) {
      startEdit(it, null, true)
    }
  }
  function stop(e, fn) {
    e.preventDefault()
    fn()
  }

  /* ---------------- 粘贴 / 拖放 ---------------- */

  function onPaste(e) {
    if (S.editing) {
      // 只粘贴纯文本，避免把网页样式带进来
      e.preventDefault()
      var text = e.clipboardData.getData('text/plain')
      document.execCommand('insertText', false, text)
      return
    }
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return
    if (!S.doc || !slidePath()) return
    var files = Array.prototype.slice.call(e.clipboardData.files || []).filter(function (f) {
      return /^image\//.test(f.type)
    })
    if (files.length) {
      e.preventDefault()
      insertImageFile(files[0])
      return
    }
    var text2 = e.clipboardData.getData('text/plain')
    // 内部剪贴板的内容优先（复制形状后系统剪贴板没变）
    if (S.clip && (!text2 || S.clip.text === text2)) {
      e.preventDefault()
      pasteClip()
      return
    }
    if (text2) {
      e.preventDefault()
      var W = S.doc.pres.cx
      var el = S.doc.addTextBox(slidePath(), center(W * 0.5, 523220), t('文本框', 'TextBox'), text2)
      commit()
      select(el)
    }
  }
  function onCopyEvent(e) {
    if (S.editing || !selItem()) return
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return
    copySel(e.type === 'cut')
    // 系统剪贴板里放形状的文字，便于粘到别处
    var txt = selItem() ? selItem().node.innerText : S.clip ? '' : ''
    if (S.clip) S.clip.text = txt || '​'
    e.clipboardData.setData('text/plain', S.clip ? S.clip.text : '')
    e.preventDefault()
  }

  /* ---------------- 弹出菜单 ---------------- */

  var pop = null
  function closePop() {
    if (pop) {
      pop.remove()
      pop = null
    }
  }
  function openPop(anchor, content, at) {
    closePop()
    pop = h('div', { class: 'pop' }, content)
    document.body.appendChild(pop)
    var r = at || anchor.getBoundingClientRect()
    var x = at ? at.x : r.left
    var y = at ? at.y : r.bottom + 4
    var pw = pop.offsetWidth, ph = pop.offsetHeight
    x = Math.max(4, Math.min(x, innerWidth - pw - 4))
    if (y + ph > innerHeight - 4) y = Math.max(4, (at ? at.y : r.top - 4) - ph)
    pop.style.left = x + 'px'
    pop.style.top = y + 'px'
    return pop
  }
  function menu(anchor, items, at) {
    var list = h('div', { class: 'menu' })
    items.forEach(function (m) {
      if (!m) return
      if (m === '-') return list.appendChild(h('div', { class: 'msep' }))
      list.appendChild(
        h('button', {
          class: 'mi',
          disabled: m.disabled ? true : null,
          onClick: function () {
            closePop()
            m.run()
          }
        }, h('span', { text: m.label }), m.key ? h('kbd', { text: m.key }) : null)
      )
    })
    return openPop(anchor, list, at)
  }

  function layoutMenu(anchor, index) {
    var layouts = S.doc.pres.layouts()
    var grid = h('div', { class: 'layouts' })
    var W = S.doc.pres.cx / EMU
    var scale = 120 / W
    layouts.forEach(function (l) {
      var cell = h('button', { class: 'lay', title: l.name, onClick: function () { closePop(); newSlide(l.path, index) } })
      var frame = h('div', { class: 'tframe', style: { width: '120px', height: (S.doc.pres.cy / EMU) * scale + 'px' } })
      try {
        var r = Render.renderSlide(S.doc.pres, l.path, {})
        r.el.style.transform = 'scale(' + scale + ')'
        frame.appendChild(r.el)
      } catch (e) {}
      cell.appendChild(frame)
      cell.appendChild(h('span', { text: l.name || l.type }))
      grid.appendChild(cell)
    })
    openPop(anchor, h('div', null, h('div', { class: 'pop-title', text: t('选择版式', 'Choose a layout') }), grid))
  }

  function shapeMenu(anchor) {
    var grid = h('div', { class: 'shapes' })
    SHAPES.forEach(function (s) {
      var g = Geom.preset(s[0], 22, 18, {})
      var svg = '<svg viewBox="-2 -2 26 22" width="26" height="22">' + g.paths.map(function (p) { return '<path d="' + p.d + '" fill="' + (p.fill && !g.line ? 'currentColor' : 'none') + '" fill-opacity="0.18" stroke="currentColor" stroke-width="1.4"' + (s[0] === 'straightConnector1' ? ' marker-end="url(#arr)"' : '') + '/>' }).join('') + (s[0] === 'straightConnector1' ? '<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10z" fill="currentColor"/></marker></defs>' : '') + '</svg>'
      grid.appendChild(h('button', { class: 'shp', title: t(s[1], s[2]), html: svg, onClick: function () { closePop(); insertShape(s[0], t(s[1], s[2])) } }))
    })
    openPop(anchor, grid)
  }

  function tableMenu(anchor) {
    var N = 8
    var label = h('div', { class: 'pop-title', text: t('插入表格', 'Insert table') })
    var grid = h('div', { class: 'tgrid' })
    var cells = []
    for (var r = 0; r < N; r++)
      for (var c = 0; c < N; c++) {
        ;(function (r, c) {
          var cell = h('div', {
            class: 'tc',
            onMouseenter: function () {
              cells.forEach(function (x) {
                x.el.classList.toggle('on', x.r <= r && x.c <= c)
              })
              label.textContent = t('插入表格', 'Insert table') + '  ' + (r + 1) + ' × ' + (c + 1)
            },
            onClick: function () {
              closePop()
              insertTable(r + 1, c + 1)
            }
          })
          cells.push({ el: cell, r: r, c: c })
          grid.appendChild(cell)
        })(r, c)
      }
    openPop(anchor, h('div', null, label, grid))
  }

  function themeColors() {
    var chain = slidePath() ? S.doc.pres.chain(slidePath()) : null
    var c = chain ? chain.theme.colors : {}
    var keys = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
    return keys.map(function (k) {
      return '#' + (c[k] || '888888')
    })
  }
  var STANDARD = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0']

  function colorMenu(anchor, onPick, allowNone) {
    var wrap = h('div', { class: 'colors' })
    var row = function (title, list) {
      wrap.appendChild(h('div', { class: 'pop-title', text: title }))
      var g = h('div', { class: 'swatches' })
      list.forEach(function (c) {
        g.appendChild(h('button', { class: 'sw', title: c, style: { background: c }, onClick: function () { closePop(); onPick(c) } }))
      })
      wrap.appendChild(g)
    }
    var tc = themeColors()
    row(t('主题颜色', 'Theme colors'), tc)
    var tints = []
    tc.forEach(function (c) {
      var rgb = OX.hexToRgb(c)
      tints.push(OX.rgbToHex(rgb.map(function (v) { return v + (255 - v) * 0.6 })))
    })
    var shades = tc.map(function (c) {
      return OX.rgbToHex(OX.hexToRgb(c).map(function (v) { return v * 0.6 }))
    })
    var g2 = h('div', { class: 'swatches' })
    tints.concat(shades).forEach(function (c) {
      g2.appendChild(h('button', { class: 'sw', title: c, style: { background: c }, onClick: function () { closePop(); onPick(c) } }))
    })
    wrap.appendChild(g2)
    row(t('标准色', 'Standard colors'), STANDARD)
    var foot = h('div', { class: 'cfoot' })
    if (allowNone) foot.appendChild(h('button', { class: 'mi', onClick: function () { closePop(); onPick(null) } }, t('无', 'None')))
    var input = h('input', { type: 'color', value: '#3366cc' })
    input.addEventListener('change', function () {
      closePop()
      onPick(input.value)
    })
    foot.appendChild(h('label', { class: 'mi custom' }, t('其他颜色…', 'More colors…'), input))
    wrap.appendChild(foot)
    openPop(anchor, wrap)
  }

  function layerMenu(anchor) {
    var it = selItem()
    var run = function (how) {
      return function () {
        if (it && S.doc.order(slidePath(), it.xml, how)) commit()
      }
    }
    menu(anchor, [
      { label: t('置于顶层', 'Bring to Front'), run: run('front'), disabled: !it },
      { label: t('上移一层', 'Bring Forward'), run: run('forward'), disabled: !it },
      { label: t('下移一层', 'Send Backward'), run: run('backward'), disabled: !it },
      { label: t('置于底层', 'Send to Back'), run: run('back'), disabled: !it }
    ])
  }

  function onContext(e) {
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return
    if (S.editing && S.editing.tb.contains(e.target)) return
    e.preventDefault()
    if (!S.doc) return
    var at = { x: e.clientX, y: e.clientY }
    var th = e.target.closest && e.target.closest('.thumb')
    if (th) {
      var i = Number(th.dataset.i)
      go(i)
      var hidden = S.doc.isHidden(i)
      menu(null, [
        { label: t('新建幻灯片', 'New Slide'), key: 'Ctrl+M', run: function () { newSlide(null, i + 1) } },
        { label: t('复制幻灯片', 'Duplicate Slide'), run: function () { duplicateSlide(i) } },
        { label: t('删除幻灯片', 'Delete Slide'), run: function () { deleteSlide(i) }, disabled: S.doc.slides().length <= 1 },
        '-',
        { label: hidden ? t('取消隐藏幻灯片', 'Unhide Slide') : t('隐藏幻灯片', 'Hide Slide'), run: function () { S.doc.setHidden(i, !hidden); commit({ structure: true }) } },
        { label: t('上移', 'Move Up'), run: function () { moveSlide(i, i - 1) }, disabled: i === 0 },
        { label: t('下移', 'Move Down'), run: function () { moveSlide(i, i + 1) }, disabled: i >= S.doc.slides().length - 1 },
        '-',
        { label: t('从此页开始放映', 'Present from Here'), key: 'Shift+F5', run: function () { present(i) } }
      ], at)
      return
    }
    if (!e.target.closest('#stage')) return
    if (S.editing) endEdit(true)
    var node = e.target.closest('.layer > [data-k]')
    var it = node ? S.items[Number(node.dataset.k)] : null
    if (it) select(it.xml)
    else select(null)
    var items = []
    if (it) {
      items.push(
        { label: t('剪切', 'Cut'), key: 'Ctrl+X', run: function () { copySel(true) } },
        { label: t('复制', 'Copy'), key: 'Ctrl+C', run: function () { copySel(false) } }
      )
    }
    items.push({ label: t('粘贴', 'Paste'), key: 'Ctrl+V', run: pasteClip, disabled: !S.clip })
    if (it) {
      items.push({ label: t('删除', 'Delete'), key: 'Del', run: deleteSel })
      items.push('-')
      if (it.target.localName === 'sp' || it.target.localName === 'graphicFrame') items.push({ label: t('编辑文字', 'Edit Text'), key: 'Enter', run: function () { startEdit(itemOf(it.xml), e) } })
      var td = e.target.closest('td')
      if (td && it.target.localName === 'graphicFrame') {
        var rc = td.dataset.cell.split(',').map(Number)
        var op = function (name) {
          return function () {
            if (S.doc.tableOp(slidePath(), it.target, name, rc[0], rc[1])) commit()
          }
        }
        items.push(
          '-',
          { label: t('在上方插入行', 'Insert Row Above'), run: op('rowAbove') },
          { label: t('在下方插入行', 'Insert Row Below'), run: op('rowBelow') },
          { label: t('在左侧插入列', 'Insert Column Left'), run: op('colLeft') },
          { label: t('在右侧插入列', 'Insert Column Right'), run: op('colRight') },
          { label: t('删除行', 'Delete Row'), run: op('delRow') },
          { label: t('删除列', 'Delete Column'), run: op('delCol') }
        )
      }
      items.push(
        '-',
        { label: t('置于顶层', 'Bring to Front'), run: function () { if (S.doc.order(slidePath(), it.xml, 'front')) commit() } },
        { label: t('置于底层', 'Send to Back'), run: function () { if (S.doc.order(slidePath(), it.xml, 'back')) commit() } }
      )
    } else {
      items.push('-', { label: t('新建幻灯片', 'New Slide'), key: 'Ctrl+M', run: function () { newSlide() } })
    }
    menu(null, items, at)
  }

  /* ---------------- 工具栏 ---------------- */

  var B = {}
  function btn(id, icon, title, run, opts) {
    opts = opts || {}
    var b = h('button', { class: 'tb-btn' + (opts.drop ? ' drop' : ''), title: title, html: icon + (opts.label ? '<span>' + opts.label + '</span>' : '') + (opts.drop ? I.caret : '') })
    b.addEventListener('mousedown', function (e) {
      // 编辑文字时不要让按钮抢走焦点（选区会丢）
      e.preventDefault()
    })
    b.addEventListener('click', function (e) {
      run(e.currentTarget)
    })
    B[id] = b
    return b
  }
  function sep() {
    return h('div', { class: 'sep' })
  }

  function buildBar() {
    var bar = $('bar')
    bar.textContent = ''
    var size = h('select', { class: 'size', title: t('字号', 'Font size') })
    size.appendChild(h('option', { value: '', text: '' }))
    SIZES.forEach(function (s) {
      size.appendChild(h('option', { value: s, text: String(s) }))
    })
    size.addEventListener('mousedown', function () {
      // 记住编辑时的选区
      if (S.editing) {
        var sel = window.getSelection()
        S.savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null
      }
    })
    size.addEventListener('change', function () {
      var v = Number(size.value)
      if (!v) return
      if (S.editing && S.savedRange) {
        S.editing.tb.focus({ preventScroll: true })
        var sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(S.savedRange)
      }
      fmt({ sz: v })
    })
    B.size = size
    bar.append(
      btn('newSlide', I.add, t('新建幻灯片 (Ctrl+M)', 'New slide (Ctrl+M)'), function (b) { layoutMenu(b, S.cur + 1) }, { drop: true, label: t('新建', 'New') }),
      btn('dupSlide', I.dup, t('复制幻灯片', 'Duplicate slide'), function () { duplicateSlide(S.cur) }),
      btn('delSlide', I.del, t('删除幻灯片', 'Delete slide'), function () { deleteSlide(S.cur) }),
      sep(),
      btn('undo', I.undo, t('撤销 (Ctrl+Z)', 'Undo (Ctrl+Z)'), undo),
      btn('redo', I.redo, t('重做 (Ctrl+Y)', 'Redo (Ctrl+Y)'), redo),
      sep(),
      btn('textbox', I.text, t('文本框', 'Text box'), insertTextBox),
      btn('shape', I.shape, t('形状', 'Shapes'), shapeMenu, { drop: true }),
      btn('image', I.image, t('图片', 'Picture'), pickImage),
      btn('table', I.table, t('表格', 'Table'), tableMenu, { drop: true }),
      sep(),
      size,
      btn('fontUp', I.fontUp, t('增大字号', 'Increase font size'), function () { fmt({ sizeStep: 1 }) }),
      btn('fontDown', I.fontDown, t('减小字号', 'Decrease font size'), function () { fmt({ sizeStep: -1 }) }),
      btn('bold', I.bold, t('加粗 (Ctrl+B)', 'Bold (Ctrl+B)'), function () { toggle('b') }),
      btn('italic', I.italic, t('倾斜 (Ctrl+I)', 'Italic (Ctrl+I)'), function () { toggle('i') }),
      btn('underline', I.underline, t('下划线 (Ctrl+U)', 'Underline (Ctrl+U)'), function () { toggle('u') }),
      btn('color', I.color, t('文字颜色', 'Font color'), function (b) { keepRange(); colorMenu(b, function (c) { restoreRange(); if (c) fmt({ color: c }) }) }, { drop: true }),
      sep(),
      btn('left', I.left, t('左对齐', 'Align left'), function () { align('l') }),
      btn('center', I.center, t('居中', 'Center'), function () { align('ctr') }),
      btn('right', I.right, t('右对齐', 'Align right'), function () { align('r') }),
      sep(),
      btn('fill', I.fill, t('形状填充', 'Shape fill'), function (b) { colorMenu(b, function (c) { var it = selItem(); if (it && S.doc.setFill(slidePath(), it.target, c)) commit() }, true) }, { drop: true }),
      btn('line', I.line, t('形状轮廓', 'Shape outline'), function (b) { colorMenu(b, function (c) { var it = selItem(); if (it && S.doc.setLine(slidePath(), it.target, c)) commit() }, true) }, { drop: true }),
      btn('layer', I.layer, t('排列', 'Arrange'), layerMenu, { drop: true }),
      h('div', { class: 'grow' }),
      btn('notes', I.notes, t('备注', 'Notes'), toggleNotes),
      btn('zoomOut', I.zoomOut, t('缩小 (Ctrl -)', 'Zoom out (Ctrl -)'), function () { zoomBy(1 / 1.2) }),
      h('button', { class: 'tb-btn zoom', title: t('适应窗口 (Ctrl 0)', 'Fit (Ctrl 0)'), onClick: function () { S.zoom = 0; layoutStage() }, text: '100%' }),
      btn('zoomIn', I.zoomIn, t('放大 (Ctrl +)', 'Zoom in (Ctrl +)'), function () { zoomBy(1.2) }),
      sep(),
      btn('play', I.play, t('从头放映 (F5)', 'Present (F5)'), function () { present(0) }, { label: t('放映', 'Present') }),
      btn('help', I.help, t('快捷键', 'Shortcuts'), showHelp)
    )
  }

  function keepRange() {
    if (S.editing) {
      var sel = window.getSelection()
      S.savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null
    }
  }
  function restoreRange() {
    if (S.editing && S.savedRange) {
      S.editing.tb.focus({ preventScroll: true })
      var sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(S.savedRange)
    }
  }

  function toggle(k) {
    if (S.editing) {
      var f = {}
      f[k] = true
      fmt(f)
      return
    }
    var it = selItem()
    if (!it) return
    var span = it.node.querySelector('span.r')
    var f2 = {}
    f2[k] = span ? span.dataset[k] !== '1' : true
    fmt(f2)
  }

  function updateBar() {
    if (!B.undo) return
    var has = !!S.doc
    var n = has ? S.doc.slides().length : 0
    var it = selItem()
    var text = !!S.editing || (it && S.doc.textBodies(it.target).length > 0)
    var shape = it && (it.target.localName === 'sp' || it.target.localName === 'cxnSp')
    B.undo.disabled = S.hi <= 0
    B.redo.disabled = S.hi >= S.history.length - 1
    B.dupSlide.disabled = !n
    B.delSlide.disabled = n <= 1
    ;['textbox', 'shape', 'image', 'table'].forEach(function (k) {
      B[k].disabled = !n
    })
    ;['fontUp', 'fontDown', 'bold', 'italic', 'underline', 'color', 'left', 'center', 'right'].forEach(function (k) {
      B[k].disabled = !text
    })
    B.size.disabled = !text
    B.fill.disabled = !(shape && it.target.localName === 'sp')
    B.line.disabled = !(shape || (it && it.target.localName === 'pic'))
    B.layer.disabled = !it
    B.play.disabled = !n
    // 当前字号 / 加粗状态
    var span = null
    if (S.editing) {
      var sel = window.getSelection()
      var nd = sel.anchorNode
      span = nd ? (nd.nodeType === 3 ? nd.parentElement : nd) : null
      if (span && !S.editing.tb.contains(span)) span = null
    } else if (it) span = it.node.querySelector('span.r')
    if (span && text) {
      var cs = getComputedStyle(span)
      var pt = (parseFloat(cs.fontSize) * 0.75) / ((S.editing && S.editing.info.fontScale) || 1)
      if (!S.editing && span.dataset.z) pt = Number(span.dataset.z)
      var v = Math.round(pt * 2) / 2
      if (!SIZES.some(function (s) { return s === v })) {
        var o = B.size.querySelector('option.custom') || B.size.appendChild(h('option', { class: 'custom' }))
        o.value = v
        o.textContent = String(v)
      }
      B.size.value = String(v)
      B.bold.classList.toggle('on', parseInt(cs.fontWeight, 10) >= 600)
      B.italic.classList.toggle('on', cs.fontStyle === 'italic')
      var p = span.closest('.p')
      var ta = p ? p.style.textAlign || 'left' : ''
      B.left.classList.toggle('on', ta === 'left')
      B.center.classList.toggle('on', ta === 'center')
      B.right.classList.toggle('on', ta === 'right')
    } else {
      B.size.value = ''
      ;['bold', 'italic', 'left', 'center', 'right'].forEach(function (k) {
        B[k].classList.remove('on')
      })
    }
    $('status').textContent = n ? t('幻灯片 ', 'Slide ') + (S.cur + 1) + ' / ' + n : ''
  }

  /* ---------------- 备注 ---------------- */

  var notesTimer = 0
  function renderNotes() {
    var ta = $('notesText')
    if (!S.doc || !slidePath()) return
    var n = Render.notesText(S.pkg, slidePath())
    ta.disabled = false
    ta.placeholder = t('单击此处添加备注', 'Click to add notes')
    if (document.activeElement !== ta) ta.value = n ? n.text : ''
  }
  function onNotesInput() {
    clearTimeout(notesTimer)
    var path = slidePath()
    var ta = $('notesText')
    notesTimer = setTimeout(function () {
      flushNotes(path, ta.value)
    }, 500)
  }
  function flushNotes(path, text) {
    clearTimeout(notesTimer)
    if (!path) return
    var cur = Render.notesText(S.pkg, path)
    if ((cur ? cur.text : '') === text) return
    var created = !cur
    if (S.doc.setNotes(path, text)) {
      S.history = S.history.slice(0, S.hi + 1)
      S.history.push(S.pkg.snapshot())
      S.hi = S.history.length - 1
      studio.setDirty(true)
      updateBar()
      void created
    }
  }
  function toggleNotes() {
    var n = $('notes')
    n.hidden = !n.hidden
    B.notes.classList.toggle('on', !n.hidden)
    try {
      localStorage.setItem('pptx.notes', n.hidden ? '0' : '1')
    } catch (e) {}
    layoutStage()
  }

  /* ---------------- 放映 ---------------- */

  var show = { i: 0, list: [] }
  function present(from) {
    endEdit(true)
    if (!S.doc || !S.doc.slides().length) return
    var all = S.doc.slides()
    show.list = []
    all.forEach(function (s, i) {
      if (!S.doc.isHidden(i) || i === from) show.list.push(i)
    })
    show.i = Math.max(0, show.list.indexOf(from))
    var el = $('show')
    el.hidden = false
    el.focus()
    try {
      if (el.requestFullscreen) el.requestFullscreen().catch(function () {})
    } catch (e) {}
    drawShow()
  }
  function drawShow() {
    var el = $('show')
    var stage = el.querySelector('.show-stage')
    stage.textContent = ''
    var idx = show.list[show.i]
    var r = Render.renderSlide(S.doc.pres, slidePath(idx), { slideNum: idx + 1 })
    var W = S.doc.pres.cx / EMU, H = S.doc.pres.cy / EMU
    var z = Math.min(el.clientWidth / W, el.clientHeight / H)
    r.el.style.transform = 'scale(' + z + ')'
    r.el.style.left = (el.clientWidth - W * z) / 2 + 'px'
    r.el.style.top = (el.clientHeight - H * z) / 2 + 'px'
    stage.appendChild(r.el)
    el.querySelector('.show-num').textContent = show.i + 1 + ' / ' + show.list.length
  }
  function endShow() {
    $('show').hidden = true
    try {
      if (document.fullscreenElement) document.exitFullscreen()
    } catch (e) {}
    go(show.list[show.i] || 0)
    $('stage').focus({ preventScroll: true })
  }
  function showStep(d) {
    var n = show.i + d
    if (n < 0) return
    if (n >= show.list.length) return endShow()
    show.i = n
    drawShow()
  }
  function showKey(e) {
    var k = e.key
    if (k === 'Escape') return stop(e, endShow)
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Enter' || k === 'n') return stop(e, function () { showStep(1) })
    if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace' || k === 'p') return stop(e, function () { showStep(-1) })
    if (k === 'Home') return stop(e, function () { show.i = 0; drawShow() })
    if (k === 'End') return stop(e, function () { show.i = show.list.length - 1; drawShow() })
    if (k === 'F5') e.preventDefault()
  }

  /* ---------------- 帮助 ---------------- */

  function showHelp(anchor) {
    var rows = [
      ['Ctrl+M', t('新建幻灯片', 'New slide')],
      [t('双击 / Enter', 'Double-click / Enter'), t('编辑文字', 'Edit text')],
      ['Esc', t('结束编辑 / 取消选中', 'Stop editing / deselect')],
      [t('拖动控点', 'Drag handles'), t('缩放（Shift 保持比例）、旋转（Shift 按 15°）', 'Resize (Shift keeps ratio), rotate (Shift snaps 15°)')],
      [t('方向键', 'Arrow keys'), t('微移形状（Shift ×10）/ 切换幻灯片', 'Nudge (Shift ×10) / change slide')],
      [t('Alt + 拖动', 'Alt + drag'), t('不吸附参考线', 'Move without snapping')],
      ['Ctrl+C / X / V / D', t('复制 / 剪切 / 粘贴 / 再制形状', 'Copy / cut / paste / duplicate shape')],
      ['Ctrl+B / I / U', t('加粗 / 倾斜 / 下划线', 'Bold / italic / underline')],
      ['Ctrl+E / L / R', t('居中 / 左对齐 / 右对齐（编辑文字时）', 'Center / left / right (while editing)')],
      ['Tab / Shift+Tab', t('文字降级 / 升级（编辑时）；切换选中形状', 'Demote / promote (editing); cycle shapes')],
      ['Ctrl+Z / Y', t('撤销 / 重做', 'Undo / redo')],
      ['Ctrl + / - / 0', t('放大 / 缩小 / 适应窗口', 'Zoom in / out / fit')],
      ['F5 / Shift+F5', t('从头放映 / 从当前页放映', 'Present from start / current')],
      ['Ctrl+S', t('保存', 'Save')]
    ]
    var tbl = h('table', { class: 'help' })
    rows.forEach(function (r) {
      tbl.appendChild(h('tr', null, h('td', null, h('kbd', { text: r[0] })), h('td', { text: r[1] })))
    })
    openPop(anchor, h('div', null, h('div', { class: 'pop-title', text: t('快捷键', 'Shortcuts') }), tbl, h('div', { class: 'help-note', text: t('支持粘贴或拖入图片。保存后的文件可以直接用 PowerPoint、WPS、Keynote 打开。', 'Paste or drop images onto the slide. Saved files open in PowerPoint, WPS and Keynote.') })))
  }

  /* ---------------- 缩略图拖动排序 ---------------- */

  var dragFrom = -1
  function onThumbDragStart(e) {
    var th = e.target.closest('.thumb')
    if (!th) return
    dragFrom = Number(th.dataset.i)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(dragFrom))
  }
  function dropIndex(e) {
    var thumbs = Array.prototype.slice.call($('side').querySelectorAll('.thumb'))
    for (var i = 0; i < thumbs.length; i++) {
      var r = thumbs[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) return i
    }
    return thumbs.length
  }
  function onThumbDragOver(e) {
    if (dragFrom < 0) return
    e.preventDefault()
    var i = dropIndex(e)
    var thumbs = $('side').querySelectorAll('.thumb')
    thumbs.forEach(function (th, j) {
      th.classList.toggle('drop-before', j === i)
      th.classList.toggle('drop-after', i === thumbs.length && j === thumbs.length - 1)
    })
  }
  function onThumbDrop(e) {
    if (dragFrom < 0) return
    e.preventDefault()
    var i = dropIndex(e)
    var from = dragFrom
    dragFrom = -1
    clearDrop()
    var to = i > from ? i - 1 : i
    if (to !== from) moveSlide(from, to)
  }
  function clearDrop() {
    $('side')
      .querySelectorAll('.thumb')
      .forEach(function (th) {
        th.classList.remove('drop-before', 'drop-after')
      })
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    keep.sel = document.getElementById('sel')
    keep.guides = document.getElementById('guides')
    document.title = t('演示文稿', 'Presentation')
    buildBar()
    var stage = $('stage')
    stage.addEventListener('pointerdown', onDown)
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerup', onUp)
    stage.addEventListener('pointercancel', onUp)
    stage.addEventListener('dblclick', onDbl)
    stage.addEventListener(
      'wheel',
      function (e) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY)
        }
      },
      { passive: false }
    )
    stage.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types, function (x) { return x === 'Files' })) e.preventDefault()
    })
    stage.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      if (f && /^image\//.test(f.type)) {
        e.preventDefault()
        insertImageFile(f, toSlide(e))
      }
    })
    var side = $('side')
    side.addEventListener('click', function (e) {
      var th = e.target.closest('.thumb')
      if (th) go(Number(th.dataset.i))
    })
    side.addEventListener('dblclick', function (e) {
      if (!e.target.closest('.thumb')) newSlide(null, S.doc ? S.doc.slides().length : 0)
    })
    side.addEventListener('dragstart', onThumbDragStart)
    side.addEventListener('dragover', onThumbDragOver)
    side.addEventListener('drop', onThumbDrop)
    side.addEventListener('dragend', function () {
      dragFrom = -1
      clearDrop()
    })
    document.addEventListener('keydown', onKey)
    document.addEventListener('paste', onPaste)
    document.addEventListener('copy', onCopyEvent)
    document.addEventListener('cut', onCopyEvent)
    document.addEventListener('contextmenu', onContext)
    document.addEventListener('selectionchange', function () {
      if (S.editing) updateBar()
    })
    document.addEventListener('mousedown', function (e) {
      if (pop && !pop.contains(e.target)) closePop()
    })
    // 备注栏显示 / 隐藏、窗口大小变化都会改变画布区域
    if (window.ResizeObserver) new ResizeObserver(function () { requestAnimationFrame(layoutStage) }).observe(stage)
    window.addEventListener('resize', function () {
      closePop()
      layoutStage()
      if (!$('show').hidden) drawShow()
    })
    var ta = $('notesText')
    ta.addEventListener('input', onNotesInput)
    ta.addEventListener('blur', function () {
      flushNotes(slidePath(), ta.value)
    })
    var show = $('show')
    show.addEventListener('click', function (e) {
      if (e.target.closest('.show-num')) return
      showStep(1)
    })
    show.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      showStep(-1)
    })
    document.addEventListener('fullscreenchange', function () {
      if (!$('show').hidden) setTimeout(drawShow, 50)
    })
    try {
      if (localStorage.getItem('pptx.notes') === '1') {
        $('notes').hidden = false
        B.notes.classList.add('on')
      }
    } catch (e) {}
    $('empty').textContent = t('没有幻灯片。双击左侧或按 Ctrl+M 新建。', 'No slides. Double-click the left panel or press Ctrl+M to add one.')
    updateBar()
  }

  studio.onLoad(function (content, info) {
    load(content, info)
  })
  studio.onSave(async function () {
    if (S.editing) endEdit(true)
    var ta = $('notesText')
    if (document.activeElement === ta) flushNotes(slidePath(), ta.value)
    if (!S.doc) throw new Error(t('没有可保存的内容', 'Nothing to save'))
    var bytes = await S.doc.save()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })

  init()
})()
