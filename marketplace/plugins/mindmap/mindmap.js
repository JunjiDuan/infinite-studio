/* 思维导图编辑器 —— Infinite Studio 插件 */
;(function () {
  'use strict'

  var $ = function (s) {
    return document.querySelector(s)
  }
  var T = function (zh, en) {
    return studio.t(zh, en)
  }

  var COLORS = ['#E8784A', '#5FA8FF', '#7FBF7A', '#C99BFF', '#E5C15C', '#5FC4C0', '#F06A8C', '#A3B86C']
  var GAP_ROOT = 56
  var GAP = 36
  var VGAP = 12
  var CLIP_TYPE = 'web application/x-infinite-mindmap'

  var viewport = $('#viewport')
  var canvas = $('#canvas')
  var nodesEl = $('#nodes')
  var edgesEl = $('#edges')
  var bar = $('#bar')
  var helpEl = $('#help')
  var errorEl = $('#error')

  var doc = null
  var original = ''
  var fileName = 'mindmap.mind'
  var savedJson = ''
  var pendingSaved = null
  var selected = null
  var editing = null
  var undoStack = []
  var redoStack = []
  var view = { x: 0, y: 0, s: 1 }
  /** id -> { node, parent, depth, color, el, x, y, w, h, side } */
  var layout = new Map()
  /** id -> { node, parent } */
  var index = new Map()
  var edgeList = []
  var buttons = {}

  /* ---------------- 数据 ---------------- */

  function uid() {
    return Math.random().toString(36).slice(2, 10)
  }
  function newNode(text) {
    return { id: uid(), text: text, children: [] }
  }
  function defaultDoc() {
    var root = newNode(T('中心主题', 'Central Topic'))
    root.children = [newNode(T('分支主题 1', 'Topic 1')), newNode(T('分支主题 2', 'Topic 2')), newNode(T('分支主题 3', 'Topic 3'))]
    return { format: 'infinite-mindmap', version: 1, root: root }
  }
  function normalize(n, seen) {
    if (!n || typeof n !== 'object') n = {}
    var id = typeof n.id === 'string' && n.id && !seen.has(n.id) ? n.id : uid()
    seen.add(id)
    var out = { id: id, text: String(n.text == null ? '' : n.text), children: [] }
    if (n.collapsed) out.collapsed = true
    if (n.side === 'left' || n.side === 'right') out.side = n.side
    if (Array.isArray(n.children)) out.children = n.children.map(function (c) { return normalize(c, seen) })
    return out
  }
  /** 复制 / 粘贴时换一套新 id */
  function cloneFresh(n) {
    var out = { id: uid(), text: n.text, children: (n.children || []).map(cloneFresh) }
    if (n.collapsed) out.collapsed = true
    return out
  }
  function serialize() {
    return JSON.stringify(doc, null, 2) + '\n'
  }
  function reindex() {
    index.clear()
    ;(function walk(n, p) {
      index.set(n.id, { node: n, parent: p })
      n.children.forEach(function (c) { walk(c, n) })
    })(doc.root, null)
  }
  function isAncestor(a, b) {
    // a 是否是 b 的祖先（或就是 b）
    for (var cur = index.get(b.id); cur; cur = cur.parent ? index.get(cur.parent.id) : null) if (cur.node === a) return true
    return false
  }
  function countAll(n) {
    return n.children.reduce(function (s, c) { return s + 1 + countAll(c) }, 0)
  }

  /* ---------------- 撤销 ---------------- */

  function snapshot() {
    return JSON.stringify(doc.root)
  }
  function commit(mutate) {
    var before = snapshot()
    var sel = selected
    mutate()
    if (snapshot() === before) return render()
    undoStack.push({ root: before, sel: sel })
    if (undoStack.length > 300) undoStack.shift()
    redoStack = []
    changed()
  }
  function changed() {
    reindex()
    if (!index.has(selected)) selected = doc.root.id
    render()
    updateDirty()
    updateBar()
  }
  function updateDirty() {
    if (doc) studio.setDirty(serialize() !== savedJson)
  }
  function restore(entry, other) {
    other.push({ root: snapshot(), sel: selected })
    doc.root = JSON.parse(entry.root)
    selected = entry.sel
    changed()
    ensureVisible(selected)
  }
  function undo() {
    var e = undoStack.pop()
    if (e) restore(e, redoStack)
  }
  function redo() {
    var e = redoStack.pop()
    if (e) restore(e, undoStack)
  }

  /* ---------------- 布局与绘制 ---------------- */

  function kids(n) {
    return n.collapsed ? [] : n.children
  }

  function render() {
    if (!doc) return
    layout.clear()
    nodesEl.replaceChildren()
    // 1. 建元素并测量
    ;(function walk(n, parent, depth, color) {
      var el = document.createElement('div')
      el.className = 'node ' + (depth === 0 ? 'root' : depth === 1 ? 'l1' : 'deep')
      el.dataset.id = n.id
      el.textContent = n.text || ' '
      if (color) el.style.setProperty('--c', color)
      nodesEl.appendChild(el)
      layout.set(n.id, { node: n, parent: parent, depth: depth, color: color, el: el, x: 0, y: 0, w: 0, h: 0, side: 'right' })
      kids(n).forEach(function (c, i) {
        walk(c, n, depth + 1, depth === 0 ? COLORS[i % COLORS.length] : color)
      })
    })(doc.root, null, 0, null)
    layout.forEach(function (L) {
      L.w = L.el.offsetWidth
      L.h = L.el.offsetHeight
    })

    // 2. 子树高度
    var memo = new Map()
    function sth(n) {
      if (memo.has(n.id)) return memo.get(n.id)
      var L = layout.get(n.id)
      var ks = kids(n)
      var total = ks.reduce(function (s, c) { return s + sth(c) }, 0) + VGAP * Math.max(0, ks.length - 1)
      var v = Math.max(L.h, total)
      memo.set(n.id, v)
      return v
    }
    function place(n, x, top, dir, depth) {
      var L = layout.get(n.id)
      var st = sth(n)
      L.side = dir
      L.y = top + st / 2 - L.h / 2
      L.x = dir === 'right' ? x : x - L.w
      var ks = kids(n)
      if (!ks.length) return
      var total = ks.reduce(function (s, c) { return s + sth(c) }, 0) + VGAP * (ks.length - 1)
      var y = top + (st - total) / 2
      var cx = dir === 'right' ? x + L.w + GAP : x - L.w - GAP
      ks.forEach(function (c) {
        place(c, cx, y, dir, depth + 1)
        y += sth(c) + VGAP
      })
    }

    // 3. 根节点两侧分配：没有指定方向的分支放到当前较矮的一侧
    var root = layout.get(doc.root.id)
    root.x = -root.w / 2
    root.y = -root.h / 2
    var right = []
    var left = []
    var rh = 0
    var lh = 0
    kids(doc.root).forEach(function (c) {
      var side = c.side || (rh <= lh ? 'right' : 'left')
      if (side === 'right') {
        right.push(c)
        rh += sth(c) + VGAP
      } else {
        left.push(c)
        lh += sth(c) + VGAP
      }
    })
    function group(list, dir, total) {
      var y = -(total - VGAP) / 2
      list.forEach(function (c) {
        place(c, dir === 'right' ? root.x + root.w + GAP_ROOT : root.x - GAP_ROOT, y, dir, 1)
        y += sth(c) + VGAP
      })
    }
    group(right, 'right', rh)
    group(left, 'left', lh)

    // 4. 定位、折叠按钮
    layout.forEach(function (L) {
      var el = L.el
      el.style.left = L.x + 'px'
      el.style.top = L.y + 'px'
      if (L.depth > 0) el.classList.add(L.side)
      if (L.node.id === selected) el.classList.add('selected')
      if (L.depth > 0 && L.node.children.length) {
        var f = document.createElement('span')
        f.className = 'fold'
        f.textContent = L.node.collapsed ? String(countAll(L.node)) : '−'
        f.title = L.node.collapsed ? T('展开', 'Expand') : T('折叠', 'Collapse')
        if (L.node.collapsed) el.classList.add('collapsed')
        el.appendChild(f)
      }
    })

    // 5. 连线
    edgeList = []
    layout.forEach(function (C) {
      if (!C.parent) return
      var P = layout.get(C.parent.id)
      var r = C.side === 'right'
      var x1 = r ? P.x + P.w : P.x
      var y1 = P.depth >= 2 ? P.y + P.h : P.y + P.h / 2
      var x2 = r ? C.x : C.x + C.w
      var y2 = C.depth >= 2 ? C.y + C.h : C.y + C.h / 2
      var mx = (x1 + x2) / 2
      edgeList.push({ d: 'M' + x1 + ' ' + y1 + 'C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2, color: C.color, width: C.depth === 1 ? 3 : 2 })
    })
    edgesEl.innerHTML = edgeList
      .map(function (e) {
        return '<path d="' + e.d + '" stroke="' + e.color + '" stroke-width="' + e.width + '" stroke-opacity="0.85"/>'
      })
      .join('')
    applyView()
  }

  function applyView() {
    canvas.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')'
    if (buttons.zoom) buttons.zoom.textContent = Math.round(view.s * 100) + '%'
  }

  function bounds() {
    var b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
    layout.forEach(function (L) {
      b.x1 = Math.min(b.x1, L.x)
      b.y1 = Math.min(b.y1, L.y)
      b.x2 = Math.max(b.x2, L.x + L.w)
      b.y2 = Math.max(b.y2, L.y + L.h)
    })
    return b
  }

  function fit() {
    var b = bounds()
    var vw = viewport.clientWidth
    var vh = viewport.clientHeight
    var s = Math.min(1, (vw - 80) / (b.x2 - b.x1), (vh - 80) / (b.y2 - b.y1))
    view.s = Math.max(0.15, s)
    view.x = vw / 2 - ((b.x1 + b.x2) / 2) * view.s
    view.y = vh / 2 - ((b.y1 + b.y2) / 2) * view.s
    applyView()
  }

  function centerRoot() {
    view.s = 1
    view.x = viewport.clientWidth / 2
    view.y = viewport.clientHeight / 2
    applyView()
  }

  function zoomAt(factor, cx, cy) {
    var s = Math.min(3, Math.max(0.15, view.s * factor))
    if (cx == null) {
      cx = viewport.clientWidth / 2
      cy = viewport.clientHeight / 2
    }
    view.x = cx - ((cx - view.x) * s) / view.s
    view.y = cy - ((cy - view.y) * s) / view.s
    view.s = s
    applyView()
  }

  function ensureVisible(id) {
    var L = layout.get(id)
    if (!L) return
    var m = 40
    var sx = view.x + L.x * view.s
    var sy = view.y + L.y * view.s
    var sw = L.w * view.s
    var sh = L.h * view.s
    var vw = viewport.clientWidth
    var vh = viewport.clientHeight
    if (sx < m) view.x += m - sx
    else if (sx + sw > vw - m) view.x -= sx + sw - (vw - m)
    if (sy < m) view.y += m - sy
    else if (sy + sh > vh - m) view.y -= sy + sh - (vh - m)
    applyView()
  }

  /* ---------------- 选择与编辑 ---------------- */

  function select(id) {
    if (!id || !layout.has(id)) return
    if (selected && layout.has(selected)) layout.get(selected).el.classList.remove('selected')
    selected = id
    layout.get(id).el.classList.add('selected')
    ensureVisible(id)
    updateBar()
  }

  function startEdit(id, initial) {
    // 先结束正在进行的编辑（会重绘，元素会被替换），再取节点
    finishEdit(true)
    var L = layout.get(id)
    if (!L) return
    editing = id
    var el = L.el
    var fold = el.querySelector('.fold')
    if (fold) fold.remove()
    el.classList.add('editing')
    el.contentEditable = 'plaintext-only'
    if (initial != null) el.textContent = initial
    else if (!L.node.text) el.textContent = ''
    el.focus()
    var range = document.createRange()
    range.selectNodeContents(el)
    if (initial != null) range.collapse(false)
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    var rightEdge = L.x + L.w
    var centerX = L.x + L.w / 2
    el.oninput = function () {
      // 左侧节点保持右边缘不动，根节点保持居中
      if (L.depth === 0) el.style.left = centerX - el.offsetWidth / 2 + 'px'
      else if (L.side === 'left') el.style.left = rightEdge - el.offsetWidth + 'px'
    }
    el.onkeydown = function (e) {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        finishEdit(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finishEdit(false)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        finishEdit(true)
        addChild()
      }
      e.stopPropagation()
    }
    el.onblur = function () {
      finishEdit(true)
    }
  }

  function finishEdit(keep) {
    if (!editing) return
    var L = layout.get(editing)
    editing = null
    if (!L) return
    var el = L.el
    el.onblur = el.onkeydown = el.oninput = null
    el.contentEditable = 'false'
    var text = el.innerText.replace(/\r/g, '').replace(/\n+$/, '')
    if (keep && text !== L.node.text) commit(function () { L.node.text = text })
    else render()
    viewport.focus({ preventScroll: true })
  }

  /* ---------------- 结构操作 ---------------- */

  function addChild() {
    var cur = index.get(selected)
    if (!cur) return
    var n = newNode('')
    commit(function () {
      cur.node.collapsed = false
      cur.node.children.push(n)
      selected = n.id
    })
    ensureVisible(n.id)
    startEdit(n.id)
  }

  function addSibling(before) {
    var cur = index.get(selected)
    if (!cur) return
    if (!cur.parent) return addChild()
    var n = newNode('')
    if (cur.node.side) n.side = cur.node.side
    else if (!index.get(cur.parent.id).parent) n.side = layout.get(cur.node.id).side
    commit(function () {
      var list = cur.parent.children
      list.splice(list.indexOf(cur.node) + (before ? 0 : 1), 0, n)
      selected = n.id
    })
    ensureVisible(n.id)
    startEdit(n.id)
  }

  function removeSelected() {
    var cur = index.get(selected)
    if (!cur || !cur.parent) return
    var list = cur.parent.children
    var i = list.indexOf(cur.node)
    var next = list[i + 1] || list[i - 1] || cur.parent
    commit(function () {
      list.splice(i, 1)
      selected = next.id
    })
  }

  function toggleCollapse(id) {
    var cur = index.get(id || selected)
    if (!cur || !cur.parent || !cur.node.children.length) return
    commit(function () {
      cur.node.collapsed = !cur.node.collapsed
      if (!cur.node.collapsed) delete cur.node.collapsed
    })
  }

  function toggleAll() {
    var anyCollapsed = false
    index.forEach(function (v) {
      if (v.node.collapsed) anyCollapsed = true
    })
    commit(function () {
      index.forEach(function (v) {
        if (anyCollapsed) delete v.node.collapsed
        else if (v.parent && !index.get(v.parent.id).parent && v.node.children.length) v.node.collapsed = true
      })
      if (!anyCollapsed) {
        var c = index.get(selected)
        while (c && c.parent && index.get(c.parent.id).parent) c = index.get(c.parent.id)
        if (c) selected = c.node.id
      }
    })
    fit()
  }

  function moveAmongSiblings(delta) {
    var cur = index.get(selected)
    if (!cur || !cur.parent) return
    var list = cur.parent.children
    var i = list.indexOf(cur.node)
    var j = i + delta
    if (j < 0 || j >= list.length) return
    commit(function () {
      list.splice(i, 1)
      list.splice(j, 0, cur.node)
    })
  }

  function navigate(key) {
    var cur = layout.get(selected)
    if (!cur) return select(doc.root.id)
    var n = cur.node
    var cy = cur.y + cur.h / 2
    var cx = cur.x + cur.w / 2
    function nearestY(list) {
      var best = null
      var bd = Infinity
      list.forEach(function (c) {
        var L = layout.get(c.id)
        if (!L) return
        var d = Math.abs(L.y + L.h / 2 - cy)
        if (d < bd) {
          bd = d
          best = c
        }
      })
      return best
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      var dir = key === 'ArrowRight' ? 'right' : 'left'
      if (cur.depth === 0) {
        var side = kids(n).filter(function (c) { return layout.get(c.id).side === dir })
        var t = nearestY(side)
        if (t) select(t.id)
      } else if (cur.side === dir) {
        if (n.collapsed && n.children.length) {
          toggleCollapse(n.id)
          cur = layout.get(selected)
        }
        var c = nearestY(kids(n))
        if (c) select(c.id)
      } else select(cur.parent.id)
      return
    }
    var down = key === 'ArrowDown'
    if (cur.parent) {
      var sibs = kids(cur.parent).filter(function (c) { return layout.get(c.id).side === cur.side })
      var k = sibs.indexOf(n) + (down ? 1 : -1)
      if (sibs[k]) return select(sibs[k].id)
    }
    // 没有同级节点：找该方向上最近的节点
    var best = null
    var bs = Infinity
    layout.forEach(function (L) {
      var ly = L.y + L.h / 2
      if (down ? ly <= cy + 1 : ly >= cy - 1) return
      var s = Math.abs(ly - cy) + 2 * Math.abs(L.x + L.w / 2 - cx)
      if (s < bs) {
        bs = s
        best = L
      }
    })
    if (best) select(best.node.id)
  }

  /* ---------------- 大纲文本（复制 / 粘贴 / 导出 Markdown） ---------------- */

  function oneLine(s) {
    return s.replace(/\s*\n\s*/g, ' ')
  }

  function toOutline(n, depth) {
    var out = '  '.repeat(depth) + '- ' + oneLine(n.text) + '\n'
    n.children.forEach(function (c) { out += toOutline(c, depth + 1) })
    return out
  }

  function toMarkdown() {
    var r = doc.root
    var out = '# ' + oneLine(r.text) + '\n'
    r.children.forEach(function (c) {
      out += '\n## ' + oneLine(c.text) + '\n\n'
      c.children.forEach(function (g) { out += toOutline(g, 0) })
    })
    return out
  }

  /** 缩进文本 / Markdown 列表、标题 -> 节点列表 */
  function parseOutline(text) {
    var top = []
    var stack = []
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return
      var key
      var body
      var hm = line.match(/^\s*(#{1,6})\s+(.*)$/)
      if (hm) {
        key = hm[1].length
        body = hm[2]
      } else {
        var ws = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length
        key = 10 + ws
        body = line.trim().replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '')
      }
      var node = newNode(body.trim())
      while (stack.length && stack[stack.length - 1].key >= key) stack.pop()
      if (stack.length) stack[stack.length - 1].node.children.push(node)
      else top.push(node)
      stack.push({ key: key, node: node })
    })
    return top
  }

  function insertNodes(list) {
    var cur = index.get(selected)
    if (!cur || !list.length) return
    commit(function () {
      cur.node.collapsed = false
      delete cur.node.collapsed
      list.forEach(function (n) { cur.node.children.push(n) })
      selected = list[0].id
    })
    ensureVisible(selected)
  }

  document.addEventListener('copy', function (e) {
    if (editing || !doc || isTextField(e.target)) return
    var cur = index.get(selected)
    if (!cur) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', toOutline(cur.node, 0))
    try {
      e.clipboardData.setData(CLIP_TYPE, JSON.stringify(cur.node))
    } catch (err) {
      /* 不支持自定义格式时只复制文本 */
    }
  })
  document.addEventListener('cut', function (e) {
    if (editing || !doc || isTextField(e.target)) return
    var cur = index.get(selected)
    if (!cur || !cur.parent) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', toOutline(cur.node, 0))
    try {
      e.clipboardData.setData(CLIP_TYPE, JSON.stringify(cur.node))
    } catch (err) {
      /* 同上 */
    }
    removeSelected()
  })
  document.addEventListener('paste', function (e) {
    if (editing || !doc || isTextField(e.target)) return
    e.preventDefault()
    var json = ''
    try {
      json = e.clipboardData.getData(CLIP_TYPE)
    } catch (err) {
      json = ''
    }
    if (json) {
      try {
        return insertNodes([cloneFresh(normalize(JSON.parse(json), new Set()))])
      } catch (err) {
        /* 按文本处理 */
      }
    }
    insertNodes(parseOutline(e.clipboardData.getData('text/plain') || ''))
  })

  function isTextField(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))
  }

  /* ---------------- 导出 ---------------- */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function mix(a, b, t) {
    var p = function (h) {
      var n = parseInt(h.slice(1), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    var x = p(a)
    var y = p(b)
    return '#' + [0, 1, 2].map(function (i) { return Math.round(x[i] * t + y[i] * (1 - t)).toString(16).padStart(2, '0') }).join('')
  }

  function buildSvg() {
    var th = studio.theme || {}
    var bg = /^#[0-9a-f]{6}$/i.test(th.bg) ? th.bg : '#16151b'
    var fg = /^#[0-9a-f]{6}$/i.test(th.text) ? th.text : '#ece7f2'
    var accent = /^#[0-9a-f]{6}$/i.test(th.accent) ? th.accent : '#6e9bff'
    var font = getComputedStyle(document.body).fontFamily
    var b = bounds()
    var pad = 40
    var w = Math.ceil(b.x2 - b.x1 + pad * 2)
    var h = Math.ceil(b.y2 - b.y1 + pad * 2)
    var parts = []
    parts.push('<rect width="100%" height="100%" fill="' + bg + '"/>')
    parts.push('<g transform="translate(' + (pad - b.x1) + ',' + (pad - b.y1) + ')">')
    edgeList.forEach(function (e) {
      parts.push('<path d="' + e.d + '" fill="none" stroke="' + e.color + '" stroke-width="' + e.width + '" stroke-opacity="0.85" stroke-linecap="round"/>')
    })
    layout.forEach(function (L) {
      var size = L.depth === 0 ? 17 : L.depth === 1 ? 14 : 13
      var weight = L.depth === 0 ? 600 : L.depth === 1 ? 500 : 400
      var padX = L.depth === 0 ? 18 : L.depth === 1 ? 13 : 10
      var color = fg
      if (L.depth === 0) {
        parts.push('<rect x="' + L.x + '" y="' + L.y + '" width="' + L.w + '" height="' + L.h + '" rx="10" fill="' + accent + '"/>')
        color = '#ffffff'
      } else if (L.depth === 1) {
        parts.push('<rect x="' + (L.x + 0.75) + '" y="' + (L.y + 0.75) + '" width="' + (L.w - 1.5) + '" height="' + (L.h - 1.5) + '" rx="7" fill="' + mix(L.color, bg, 0.16) + '" stroke="' + mix(L.color, bg, 0.7) + '" stroke-width="1.5"/>')
      } else {
        parts.push('<line x1="' + L.x + '" y1="' + (L.y + L.h - 1) + '" x2="' + (L.x + L.w) + '" y2="' + (L.y + L.h - 1) + '" stroke="' + mix(L.color, bg, 0.75) + '" stroke-width="2"/>')
      }
      var lines = (L.node.text || ' ').split('\n')
      var lh = size * 1.4
      var top = L.y + (L.h - lines.length * lh) / 2
      var tspans = lines
        .map(function (line, i) {
          return '<tspan x="' + (L.x + padX + 1.5) + '" y="' + (top + lh * (i + 0.5)) + '">' + esc(line) + '</tspan>'
        })
        .join('')
      parts.push('<text font-family="' + esc(font) + '" font-size="' + size + '" font-weight="' + weight + '" fill="' + color + '" dominant-baseline="central" xml:space="preserve">' + tspans + '</text>')
    })
    parts.push('</g>')
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + parts.join('') + '</svg>', w: w, h: h }
  }

  function baseName() {
    return fileName.replace(/\.[^.]+$/, '') || 'mindmap'
  }

  function exportPng() {
    var r = buildSvg()
    var img = new Image()
    img.onload = function () {
      var scale = Math.min(2, 16000 / r.w, 16000 / r.h)
      var c = document.createElement('canvas')
      c.width = Math.round(r.w * scale)
      c.height = Math.round(r.h * scale)
      var ctx = c.getContext('2d')
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0, r.w, r.h)
      c.toBlob(function (blob) {
        if (blob) studio.exportFile(baseName() + '.png', blob)
      }, 'image/png')
    }
    img.onerror = function () {
      studio.toast(T('导出 PNG 失败', 'Failed to export PNG'))
    }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg)
  }

  /* ---------------- 工具栏、帮助 ---------------- */

  var ICONS = {
    child: '<path d="M4 5h6M7 5v9a2 2 0 0 0 2 2h3"/><rect x="13" y="13" width="7" height="6" rx="1.5"/>',
    sibling: '<rect x="4" y="4" width="11" height="6" rx="1.5"/><rect x="4" y="14" width="11" height="6" rx="1.5"/><path d="M19 15v4M17 17h4"/>',
    del: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
    undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 0 1 0 10h-2"/>',
    redo: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19 11.5h-9a5 5 0 0 0 0 10h2"/>',
    fold: '<path d="M7 9l5-5 5 5M7 15l5 5 5-5"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    png: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20 16l-5-5-8 8"/>',
    md: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6.5 15V9l2.5 3 2.5-3v6M16 9v6M14 13l2 2 2-2"/>',
    svg: '<path d="M4 20c4-1 5-6 8-8s6-2 8-8"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.7M12 16.6v.1"/>'
  }

  function btn(key, icon, label, title, run) {
    var b = document.createElement('button')
    b.title = title || label || ''
    b.innerHTML = (icon ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[icon] + '</svg>' : '') + (label ? '<span></span>' : '')
    if (label) b.querySelector('span').textContent = label
    b.addEventListener('mousedown', function (e) { e.preventDefault() })
    b.addEventListener('click', function () {
      run()
      viewport.focus({ preventScroll: true })
    })
    if (key) buttons[key] = b
    return b
  }

  function sep() {
    var s = document.createElement('span')
    s.className = 'sep'
    return s
  }

  function buildBar() {
    buttons = {}
    var grow = document.createElement('span')
    grow.className = 'grow'
    var zoom = btn('zoom', null, '100%', T('缩放到 100%', 'Reset zoom'), function () { zoomAt(1 / view.s) })
    zoom.classList.add('zoom')
    bar.replaceChildren(
      btn('child', 'child', T('子主题', 'Child'), T('添加子主题 (Tab)', 'Add child (Tab)'), addChild),
      btn('sibling', 'sibling', T('同级主题', 'Sibling'), T('添加同级主题 (Enter)', 'Add sibling (Enter)'), function () { addSibling(false) }),
      btn('del', 'del', null, T('删除 (Delete)', 'Delete (Delete)'), removeSelected),
      sep(),
      btn('undo', 'undo', null, T('撤销 (Ctrl Z)', 'Undo (Ctrl Z)'), undo),
      btn('redo', 'redo', null, T('重做 (Ctrl Y)', 'Redo (Ctrl Y)'), redo),
      sep(),
      btn('fold', 'fold', null, T('全部展开 / 折叠到一级', 'Expand all / collapse to first level'), toggleAll),
      btn(null, 'minus', null, T('缩小 (Ctrl -)', 'Zoom out (Ctrl -)'), function () { zoomAt(1 / 1.2) }),
      zoom,
      btn(null, 'plus', null, T('放大 (Ctrl =)', 'Zoom in (Ctrl =)'), function () { zoomAt(1.2) }),
      btn(null, 'fit', null, T('适应窗口 (Ctrl 0)', 'Fit to window (Ctrl 0)'), fit),
      grow,
      btn(null, 'png', 'PNG', T('导出为 PNG 图片', 'Export as PNG'), exportPng),
      btn(null, 'svg', 'SVG', T('导出为 SVG 矢量图', 'Export as SVG'), function () { studio.exportFile(baseName() + '.svg', buildSvg().svg) }),
      btn(null, 'md', 'Markdown', T('导出为 Markdown 大纲', 'Export as Markdown outline'), function () { studio.exportFile(baseName() + '.md', toMarkdown()) }),
      sep(),
      btn(null, 'help', null, T('快捷键', 'Shortcuts'), function () { helpEl.hidden = !helpEl.hidden })
    )
    updateBar()
  }

  function updateBar() {
    if (!buttons.undo) return
    var cur = index.get(selected)
    buttons.undo.disabled = !undoStack.length
    buttons.redo.disabled = !redoStack.length
    buttons.del.disabled = !cur || !cur.parent
    buttons.sibling.disabled = !cur
    buttons.child.disabled = !cur
  }

  function buildHelp() {
    var rows = [
      ['Tab', T('添加子主题', 'Add child')],
      ['Enter', T('添加同级主题', 'Add sibling')],
      ['Shift Enter', T('在上方添加同级（编辑时换行）', 'Sibling above (newline while editing)')],
      ['F2 / ' + T('双击', 'Double-click'), T('编辑文字；直接打字也会开始编辑', 'Edit text; typing also starts editing')],
      ['Delete', T('删除主题', 'Delete topic')],
      [T('空格', 'Space'), T('折叠 / 展开', 'Collapse / expand')],
      [T('方向键', 'Arrows'), T('在主题之间移动', 'Move between topics')],
      ['Alt ↑ / ↓', T('调整同级顺序', 'Reorder among siblings')],
      [T('拖动主题', 'Drag topic'), T('放到另一主题上成为子主题，放到上 / 下边缘调整顺序', 'Drop on a topic to nest it, on its top / bottom edge to reorder')],
      ['Ctrl C / X / V', T('复制、剪切、粘贴分支；可粘贴缩进文本或 Markdown 列表', 'Copy, cut, paste branches; paste indented text or Markdown lists')],
      ['Ctrl Z / Y', T('撤销 / 重做', 'Undo / redo')],
      [T('拖动空白 / 滚轮', 'Drag / wheel'), T('平移画布；Ctrl + 滚轮缩放', 'Pan; Ctrl + wheel to zoom')],
      ['Ctrl 0', T('适应窗口', 'Fit to window')]
    ]
    var html = '<h3>' + esc(T('快捷键', 'Shortcuts')) + '</h3><table>'
    rows.forEach(function (r) {
      html += '<tr><td><kbd>' + esc(r[0]) + '</kbd></td><td>' + esc(r[1]) + '</td></tr>'
    })
    helpEl.innerHTML = html + '</table>'
  }

  /* ---------------- 鼠标 ---------------- */

  var drag = null
  var pan = null
  var ghost = null

  function clearDrop() {
    nodesEl.querySelectorAll('.drop-child,.drop-before,.drop-after').forEach(function (el) {
      el.classList.remove('drop-child', 'drop-before', 'drop-after')
    })
  }

  viewport.addEventListener('mousedown', function (e) {
    if (!doc || e.button !== 0) return
    helpEl.hidden = true
    var nodeEl = e.target.closest && e.target.closest('.node')
    if (nodeEl && nodeEl.classList.contains('editing')) return
    finishEdit(true)
    if (e.target.classList && e.target.classList.contains('fold')) {
      e.preventDefault()
      toggleCollapse(e.target.parentElement.dataset.id)
      return
    }
    e.preventDefault()
    viewport.focus({ preventScroll: true })
    if (nodeEl) {
      // render 可能替换了元素，按 id 重新取
      var id = nodeEl.dataset.id
      select(id)
      drag = { id: id, x0: e.clientX, y0: e.clientY, started: false, target: null, zone: null }
    } else {
      pan = { x0: e.clientX, y0: e.clientY, vx: view.x, vy: view.y }
      viewport.classList.add('panning')
    }
  })

  window.addEventListener('mousemove', function (e) {
    if (pan) {
      view.x = pan.vx + e.clientX - pan.x0
      view.y = pan.vy + e.clientY - pan.y0
      applyView()
      return
    }
    if (!drag) return
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5 || drag.id === doc.root.id) return
      drag.started = true
      var L = layout.get(drag.id)
      if (!L) return (drag = null)
      L.el.classList.add('dragging')
      ghost = document.createElement('div')
      ghost.className = 'ghost'
      ghost.textContent = L.node.text || ' '
      document.body.appendChild(ghost)
    }
    ghost.style.left = e.clientX + 12 + 'px'
    ghost.style.top = e.clientY + 8 + 'px'
    clearDrop()
    drag.target = null
    var hit = document.elementFromPoint(e.clientX, e.clientY)
    var tEl = hit && hit.closest && hit.closest('.node')
    if (!tEl) return
    var target = index.get(tEl.dataset.id)
    var src = index.get(drag.id)
    if (!target || !src || isAncestor(src.node, target.node)) return
    var r = tEl.getBoundingClientRect()
    var rel = (e.clientY - r.top) / r.height
    var zone = !target.parent ? 'child' : rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'child'
    drag.target = target
    drag.zone = zone
    drag.side = e.clientX < r.left + r.width / 2 ? 'left' : 'right'
    tEl.classList.add('drop-' + zone)
  })

  window.addEventListener('mouseup', function () {
    if (pan) {
      pan = null
      viewport.classList.remove('panning')
    }
    if (!drag) return
    var d = drag
    drag = null
    if (ghost) {
      ghost.remove()
      ghost = null
    }
    clearDrop()
    if (!d.started) return
    if (!d.target) return render()
    var src = index.get(d.id)
    var t = d.target
    commit(function () {
      var from = src.parent.children
      from.splice(from.indexOf(src.node), 1)
      delete src.node.side
      if (d.zone === 'child') {
        delete t.node.collapsed
        t.node.children.push(src.node)
        if (!t.parent) src.node.side = d.side
      } else {
        var list = t.parent.children
        list.splice(list.indexOf(t.node) + (d.zone === 'after' ? 1 : 0), 0, src.node)
        if (!index.get(t.parent.id).parent) src.node.side = layout.get(t.node.id).side
      }
      selected = src.node.id
    })
  })

  viewport.addEventListener('dblclick', function (e) {
    var nodeEl = e.target.closest && e.target.closest('.node')
    if (nodeEl && !nodeEl.classList.contains('editing') && !e.target.classList.contains('fold')) startEdit(nodeEl.dataset.id)
  })

  viewport.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        var r = viewport.getBoundingClientRect()
        zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top)
      } else {
        view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY
        applyView()
      }
    },
    { passive: false }
  )

  window.addEventListener('resize', applyView)

  /* ---------------- 键盘 ---------------- */

  document.addEventListener('keydown', function (e) {
    if (!doc || editing || isTextField(e.target)) return
    var mod = e.ctrlKey || e.metaKey
    var k = e.key
    var handled = true
    if (mod && !e.altKey) {
      if (k === 'z' || k === 'Z') e.shiftKey ? redo() : undo()
      else if (k === 'y' || k === 'Y') redo()
      else if (k === '0') fit()
      else if (k === '=' || k === '+') zoomAt(1.2)
      else if (k === '-') zoomAt(1 / 1.2)
      else handled = false
    } else if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) moveAmongSiblings(k === 'ArrowUp' ? -1 : 1)
    else if (e.altKey) handled = false
    else if (k === 'Tab' || k === 'Insert') addChild()
    else if (k === 'Enter') addSibling(e.shiftKey)
    else if (k === 'Delete' || k === 'Backspace') removeSelected()
    else if (k === 'F2') startEdit(selected)
    else if (k === ' ') toggleCollapse()
    else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') navigate(k)
    else if (k === 'Escape') helpEl.hidden = true
    else if (k === 'Process' || e.keyCode === 229) startEdit(selected)
    else if (k.length === 1) startEdit(selected, k)
    else handled = false
    if (handled) e.preventDefault()
  })

  /* ---------------- 和 IDE 对接 ---------------- */

  function showError(msg) {
    errorEl.textContent = msg
    errorEl.hidden = false
  }

  studio.onLoad(function (content, info) {
    var first = !doc
    fileName = (info && info.fileName) || fileName
    document.title = fileName
    buildBar()
    buildHelp()
    errorEl.hidden = true
    var text = String(content == null ? '' : content).trim()
    var prevSel = selected
    try {
      if (!text) doc = defaultDoc()
      else {
        var data = JSON.parse(text)
        if (!data || typeof data !== 'object' || !data.root) throw new Error(T('缺少 root 字段', 'missing "root" field'))
        doc = { format: 'infinite-mindmap', version: 1, root: normalize(data.root, new Set()) }
      }
    } catch (err) {
      doc = null
      original = String(content)
      nodesEl.replaceChildren()
      edgesEl.innerHTML = ''
      showError(T('无法解析这个思维导图文件：', 'Cannot read this mind map file: ') + String((err && err.message) || err) + '\n\n' + T('可以在文件上右键，用文本方式打开修复。', 'Open it as text to fix it.'))
      return
    }
    savedJson = serialize()
    undoStack = []
    redoStack = []
    reindex()
    selected = prevSel && index.has(prevSel) ? prevSel : doc.root.id
    render()
    updateBar()
    if (first) {
      requestAnimationFrame(function () {
        var b = bounds()
        if (b.x2 - b.x1 > viewport.clientWidth - 80 || b.y2 - b.y1 > viewport.clientHeight - 80) fit()
        else centerRoot()
      })
    }
    viewport.focus({ preventScroll: true })
  })

  studio.onSave(function () {
    finishEdit(true)
    if (!doc) return original
    pendingSaved = serialize()
    return pendingSaved
  })

  studio.onSaved(function () {
    if (pendingSaved != null) savedJson = pendingSaved
    pendingSaved = null
    updateDirty()
  })

  studio.onTheme(function () {
    render()
  })
})()
