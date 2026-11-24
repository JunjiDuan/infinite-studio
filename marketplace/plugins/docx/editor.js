/**
 * 编辑核心：载入 / 渲染、选区与位置、输入（打字、回车、删除、粘贴）、格式、撤销重做。
 * 原则：HTML 只是视图，XML 是真正的数据。每次改动后把受影响的段落同步回 XML（Render.syncPara），
 * 结构性的改动（拆分 / 合并段落、表格）同时改 HTML 和 XML。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var M = window.DocModel
  var R = window.Render
  var kid = OX.kid
  var t = function (zh, en) {
    return studio.t(zh, en)
  }

  var S = {
    pkg: null,
    doc: null,
    fileName: '',
    history: [],
    hi: -1,
    typing: null,
    pending: null, // 光标处待用的格式（rPr id）：没有选中文字时点了加粗等
    clip: null,
    zoom: 0,
    composing: false
  }
  var $ = function (id) {
    return document.getElementById(id)
  }
  var docEl = null
  var listeners = { change: [], render: [] }
  function emit(name) {
    listeners[name].forEach(function (f) {
      try {
        f()
      } catch (e) {
        console.error(e)
      }
    })
  }

  /* ---------------- 载入与渲染 ---------------- */

  async function load(content, info) {
    S.fileName = (info && info.fileName) || ''
    var buf = content
    var fresh = false
    if (!buf || !buf.byteLength) {
      var files = Blank.files(t('中', 'en') === '中')
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
      var doc = new M.Doc(pkg)
      S.pkg = pkg
      S.doc = doc
    } catch (e) {
      console.error(e)
      var msg = String((e && e.message) || '')
      showError(/encrypted/.test(msg) ? t('这个文件有密码保护，无法打开。', 'This file is password protected.') : /not a zip/.test(msg) ? t('无法打开这个文件：它不是有效的 Word（.docx）文件。如果是旧版 .doc 格式，请先用 Word 另存为 .docx。', 'Cannot open this file: it is not a valid Word (.docx) file. Save legacy .doc files as .docx first.') : t('无法打开这个文件：', 'Cannot open this file: ') + msg)
      return
    }
    $('error').hidden = true
    S.history = [snapshot()]
    S.hi = 0
    S.pending = null
    renderAll()
    if (fresh) {
      studio.setDirty(true)
      studio.save()
    } else studio.setDirty(false)
    var first = paras()[0]
    if (first) setPos({ pi: 0, off: 0 }, true)
  }

  function showError(msg) {
    var e = $('error')
    e.textContent = msg
    e.hidden = false
  }

  function ctxFor(part) {
    return { doc: S.doc, part: part || S.doc.main, tblStyle: null, foot: null }
  }
  /** 段落所在的表格样式（段落样式继承用） */
  function ctxOf(hp) {
    var c = ctxFor()
    var tb = hp.closest('table.tbl')
    if (tb && tb._x) c.tblStyle = M.wattr(OX.path(tb._x, 'tblPr', 'tblStyle'), 'val') || S.doc.styles().defT
    return c
  }

  function renderAll() {
    R.reg.reset()
    var doc = S.doc
    var page = doc.page()
    var sheet = $('sheet')
    sheet.style.width = page.w / 20 + 'pt'
    sheet.style.minHeight = page.h / 20 + 'pt'
    sheet.style.padding = page.top / 20 + 'pt ' + page.right / 20 + 'pt ' + page.bottom / 20 + 'pt ' + page.left / 20 + 'pt'
    // 默认字体（没有任何格式的文字）
    var base = doc.rProps(null, doc.styles().defP)
    docEl.setAttribute('style', R.runCss(doc, base))
    docEl.textContent = ''
    var ctx = ctxFor()
    var frag = document.createDocumentFragment()
    R.renderBlocks(doc.body(), ctx).forEach(function (e) {
      frag.appendChild(e)
    })
    docEl.appendChild(frag)
    if (!paras().length) {
      // 没有段落时补一个（Word 要求正文至少有一个段落）
      var p = M.wel(doc.xml, 'p')
      doc.body().insertBefore(p, kid(doc.body(), 'sectPr'))
      docEl.appendChild(R.renderPara(p, ctx))
    }
    // 页眉页脚（只显示）
    ;[['hdr', 'header', page.header], ['ftr', 'footer', page.footer]].forEach(function (x) {
      var el = $(x[0])
      el.textContent = ''
      var part = doc.headerPart(x[1])
      var root = part ? S.pkg.root(part) : null
      if (root) {
        R.renderBlocks(root, ctxFor(part)).forEach(function (e) {
          el.appendChild(e)
        })
      }
      el.hidden = !root || !el.textContent.trim()
      el.style.left = page.left / 20 + 'pt'
      el.style.right = page.right / 20 + 'pt'
      if (x[0] === 'hdr') el.style.top = Math.max(12, x[2] / 20) + 'pt'
      else el.style.bottom = Math.max(12, x[2] / 20) + 'pt'
    })
    numberAll()
    emit('render')
  }

  /** 列表编号：按文档顺序重新计算每个段落前面的编号 */
  function numberAll() {
    var counter = S.doc.counter()
    paras().forEach(function (hp) {
      var info = R.paraInfo(S.doc, hp._x, ctxOf(hp).tblStyle)
      var label = hp.firstElementChild && hp.firstElementChild.classList.contains('num') ? hp.firstElementChild : null
      var res = info.np ? counter.next(info.np.numId, info.np.ilvl) : null
      if (!res) {
        if (label) label.remove()
        return
      }
      if (!label) {
        label = document.createElement('span')
        label.className = 'num'
        label.contentEditable = 'false'
        hp.insertBefore(label, hp.firstChild)
      }
      label.textContent = res.text
      var lv = res.lv
      var mark = R.markRPr(hp._x)
      var props = S.doc.rProps(mark, info.props.styleId)
      if (lv.rPr) {
        var lp = S.doc.rProps(lv.rPr, info.props.styleId)
        Object.keys(lp).forEach(function (k) {
          if (kid(lv.rPr, k) || (k === 'rFonts' && kid(lv.rPr, 'rFonts'))) props[k] = lp[k]
        })
      }
      var css = R.runCss(S.doc, props).replace(/text-decoration:[^;]*;/g, '')
      var ind = info.ind || {}
      var hang = ind.hanging != null ? Number(ind.hanging) / 20 : 0
      if (lv.suff === 'tab') css += 'min-width:' + Math.max(hang, 0) + 'pt;'
      else if (lv.suff === 'space') css += 'padding-right:0.3em;'
      label.setAttribute('style', css)
      label.dataset.suff = lv.suff
    })
  }

  /* ---------------- 段落与位置 ---------------- */

  function paras() {
    return docEl ? Array.prototype.slice.call(docEl.querySelectorAll('p.p')) : []
  }
  function paraOf(node) {
    if (!node) return null
    var el = node.nodeType === 1 ? node : node.parentNode
    var p = el && el.closest ? el.closest('p.p') : null
    return p && docEl.contains(p) ? p : null
  }
  function inAtom(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentNode)
    return el && el.closest ? el.closest('.x') : null
  }
  /** 段落里的“字符”数：文字按长度，图片等对象和换行各算 1，编号和占位不算 */
  function count(n) {
    if (n.nodeType === 3) return n.data.length
    if (n.nodeType !== 1 && n.nodeType !== 11) return 0
    if (n.nodeType === 1) {
      var cl = n.classList
      if (cl.contains('num') || cl.contains('fill')) return 0
      if (cl.contains('x')) return 1
      if (n.nodeName === 'BR') return cl.contains('b') ? 1 : 0
    }
    var s = 0
    for (var c = n.firstChild; c; c = c.nextSibling) s += count(c)
    return s
  }
  /** 段落的文字（和 count 对应：对象是 ￼，换行是 \n） */
  function textOf(n) {
    if (n.nodeType === 3) return n.data
    if (n.nodeType !== 1 && n.nodeType !== 11) return ''
    if (n.nodeType === 1) {
      var cl = n.classList
      if (cl.contains('num') || cl.contains('fill')) return ''
      if (cl.contains('x')) return '￼'
      if (n.nodeName === 'BR') return cl.contains('b') ? '\n' : ''
    }
    var s = ''
    for (var c = n.firstChild; c; c = c.nextSibling) s += textOf(c)
    return s
  }
  function offsetIn(p, node, off) {
    if (!p.contains(node)) {
      // 在段落前面 → 0，后面 → 末尾
      return p.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : count(p)
    }
    var a = inAtom(node)
    if (a && a !== node) {
      node = a.parentNode
      off = Array.prototype.indexOf.call(node.childNodes, a) + 1
    }
    var r = document.createRange()
    r.setStart(p, 0)
    try {
      r.setEnd(node, off)
    } catch (e) {
      return 0
    }
    return count(r.cloneContents())
  }
  function idx(n) {
    return Array.prototype.indexOf.call(n.parentNode.childNodes, n)
  }
  /** 段落里第 off 个字符处的 DOM 位置（优先落在前一段文字的末尾） */
  function locate(p, off) {
    var rem = off
    var res = null
    var walk = function (el) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          if (rem <= c.data.length) {
            res = { node: c, offset: rem }
            return true
          }
          rem -= c.data.length
          continue
        }
        if (c.nodeType !== 1) continue
        var cl = c.classList
        if (cl.contains('num') || cl.contains('fill')) continue
        var unit = cl.contains('x') || (c.nodeName === 'BR' && cl.contains('b'))
        if (unit || c.nodeName === 'BR') {
          if (!unit) continue
          if (rem === 0) {
            res = { node: c.parentNode, offset: idx(c) }
            return true
          }
          rem -= 1
          if (rem === 0 && !c.nextSibling) {
            res = { node: c.parentNode, offset: idx(c) + 1 }
            return true
          }
          continue
        }
        if (walk(c)) return true
      }
      return false
    }
    if (walk(p)) return res
    var fill = p.querySelector(':scope > br.fill')
    return { node: p, offset: fill ? idx(fill) : p.childNodes.length }
  }
  function rangeIn(p, s, e) {
    var a = locate(p, s)
    var b = locate(p, e)
    var r = document.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    return r
  }

  function selRange() {
    var sel = window.getSelection()
    if (!sel.rangeCount) return null
    var r = sel.getRangeAt(0)
    if (!docEl.contains(r.commonAncestorContainer) && r.commonAncestorContainer !== docEl) return null
    return r
  }
  /** 当前选区 → { a: {pi, off}, b: {pi, off} } */
  function savePos() {
    var r = selRange()
    if (!r) return null
    var list = paras()
    var pt = function (node, off, end) {
      var p = paraOf(node)
      if (!p) {
        // 落在段落之间（表格边上等）：找最近的段落
        var ps = list.filter(function (x) {
          return end ? r.intersectsNode(x) : r.intersectsNode(x)
        })
        p = end ? ps[ps.length - 1] : ps[0]
        if (!p) return null
        return { pi: list.indexOf(p), off: end ? count(p) : 0 }
      }
      return { pi: list.indexOf(p), off: offsetIn(p, node, off) }
    }
    var a = pt(r.startContainer, r.startOffset, false)
    var b = r.collapsed ? a : pt(r.endContainer, r.endOffset, true)
    if (!a || !b) return null
    return { a: a, b: b }
  }
  function setPos(pos, noScroll) {
    if (!pos) return
    var list = paras()
    var a = pos.a || pos
    var b = pos.b || a
    var pa = list[Math.min(a.pi, list.length - 1)]
    var pb = list[Math.min(b.pi, list.length - 1)]
    if (!pa || !pb) return
    var la = locate(pa, Math.min(a.off, count(pa)))
    var lb = locate(pb, Math.min(b.off, count(pb)))
    var sel = window.getSelection()
    var r = document.createRange()
    r.setStart(la.node, la.offset)
    r.setEnd(lb.node, lb.offset)
    sel.removeAllRanges()
    sel.addRange(r)
    if (document.activeElement !== docEl) docEl.focus({ preventScroll: true })
    if (!noScroll) scrollToRange(r)
  }
  function scrollToRange(r) {
    var rect = r.getClientRects()[0] || r.getBoundingClientRect()
    var p = paraOf(r.startContainer)
    if ((!rect || (!rect.width && !rect.height)) && p) rect = p.getBoundingClientRect()
    if (!rect) return
    var wrap = $('wrap')
    var wr = wrap.getBoundingClientRect()
    if (rect.top < wr.top + 20) wrap.scrollTop -= wr.top + 20 - rect.top + 40
    else if (rect.bottom > wr.bottom - 20) wrap.scrollTop += rect.bottom - wr.bottom + 60
  }
  function parasIn(r) {
    var list = paras()
    if (r.collapsed) {
      var p = paraOf(r.startContainer)
      return p ? [p] : []
    }
    return list.filter(function (p) {
      if (!r.intersectsNode(p)) return false
      // 选区刚好从段落末尾开始 / 在段落开头结束时，不算这个段落（选中整段时除外）
      return true
    })
  }

  /* ---------------- 同步与提交 ---------------- */

  function sync(hp) {
    R.syncPara(hp)
    S.doc.touch()
  }
  function rerender(hp) {
    var n = R.renderPara(hp._x, ctxOf(hp))
    hp.replaceWith(n)
    return n
  }

  function snapshot(changed) {
    // touch：document.xml 改过了，保存 / 快照时要重新序列化（没改过的部件原样复制）
    if (changed) S.doc.touch()
    return { pkg: S.pkg.snapshot(), sel: docEl ? savePos() : null }
  }
  /** 记一步撤销。opts.renumber：重新编号 */
  function commit(opts) {
    opts = opts || {}
    if (S.typing) {
      clearTimeout(S.typing)
      S.typing = null
    }
    S.history = S.history.slice(0, S.hi + 1)
    S.history.push(snapshot(true))
    if (S.history.length > 200) S.history.shift()
    S.hi = S.history.length - 1
    studio.setDirty(true)
    if (opts.renumber !== false) numberAll()
    emit('change')
  }
  /** 打字：停顿 700ms 后才记一步撤销 */
  function typed() {
    studio.setDirty(true)
    if (S.typing) clearTimeout(S.typing)
    S.typing = setTimeout(function () {
      S.typing = null
      commit({ renumber: false })
    }, 700)
  }
  function flushTyping() {
    if (S.typing) commit({ renumber: false })
  }
  function undo() {
    flushTyping()
    if (S.hi <= 0) return
    S.hi--
    restore(S.history[S.hi], S.history[S.hi + 1].sel)
  }
  function redo() {
    flushTyping()
    if (S.hi >= S.history.length - 1) return
    S.hi++
    restore(S.history[S.hi], S.history[S.hi].sel)
  }
  function restore(snap, sel) {
    S.pkg.restore(snap.pkg)
    S.doc.reload()
    var scroll = $('wrap').scrollTop
    renderAll()
    $('wrap').scrollTop = scroll
    studio.setDirty(true)
    if (sel) setPos(sel)
    emit('change')
  }

  /* ---------------- 插入文字 ---------------- */

  function h(tag, cls) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    return e
  }
  function cssFor(rid, hp) {
    var c = ctxOf(hp)
    var info = S.doc.pProps(hp._x, c.tblStyle)
    return R.runCss(S.doc, S.doc.rProps(R.reg.get(rid) || null, info.styleId, c.tblStyle))
  }
  function newSpan(rid, hp, text) {
    var s = h('span', 'r')
    s.dataset.r = rid
    s.setAttribute('style', cssFor(rid, hp))
    if (text != null) s.textContent = text
    return s
  }
  /** 拆开祖先元素直到 stop（不含），返回插入点 { parent, ref } */
  function splitUpTo(node, offset, stop) {
    var parent, ref
    if (node.nodeType === 3) {
      if (offset <= 0) ref = node
      else if (offset >= node.data.length) ref = node.nextSibling
      else ref = node.splitText(offset)
      parent = node.parentNode
    } else {
      parent = node
      ref = node.childNodes[offset] || null
    }
    while (parent !== stop && parent && stop.contains(parent)) {
      if (ref === parent.firstChild) {
        ref = parent
        parent = parent.parentNode
        continue
      }
      if (ref === null) {
        ref = parent.nextSibling
        parent = parent.parentNode
        continue
      }
      var clone = parent.cloneNode(false)
      delete clone.dataset.m
      while (ref) {
        var n = ref.nextSibling
        clone.appendChild(ref)
        ref = n
      }
      parent.parentNode.insertBefore(clone, parent.nextSibling)
      ref = clone
      parent = parent.parentNode
    }
    return { parent: parent, ref: ref }
  }
  /** 插入点所在的“容器”：超链接等（在里面插入），否则是段落 */
  function stopOf(node, p) {
    var el = node.nodeType === 1 ? node : node.parentNode
    var c = el.closest('.c')
    return c && p.contains(c) ? c : p
  }
  /** 光标处最近的文字格式 */
  function ridNear(p, off) {
    var loc = locate(p, off)
    var el = loc.node.nodeType === 3 ? loc.node.parentNode : loc.node.childNodes[loc.offset - 1] || loc.node.childNodes[loc.offset] || loc.node
    var span = el && el.closest ? el.closest('span.r') : null
    if (span && p.contains(span)) return span.dataset.r
    return p._pm
  }

  /** 在光标处插入文字（选区已折叠） */
  function insertText(text) {
    var r = selRange()
    if (!r || !text) return
    var p = paraOf(r.startContainer)
    if (!p) return
    var off = offsetIn(p, r.startContainer, r.startOffset)
    var loc = locate(p, off)
    if (S.pending) {
      var span = newSpan(S.pending, p, text)
      var ip = splitUpTo(loc.node, loc.offset, stopOf(loc.node, p))
      ip.parent.insertBefore(span, ip.ref)
      S.pending = null
    } else if (loc.node.nodeType === 3 && !inAtom(loc.node)) {
      loc.node.insertData(loc.offset, text)
    } else {
      // 光标不在文字里（空段落、对象旁边）：用旁边文字的格式
      var rid = ridNear(p, off)
      var prev = loc.node.childNodes[loc.offset - 1]
      var next = loc.node.childNodes[loc.offset]
      var s2 = rid === p._pm && loc.node === p ? document.createTextNode(text) : newSpan(rid, p, text)
      if (prev && prev.nodeType === 1 && prev.matches('span.r') && prev.dataset.r === rid) prev.appendChild(document.createTextNode(text))
      else if (next && next.nodeType === 1 && next.matches('span.r') && next.dataset.r === rid) next.insertBefore(document.createTextNode(text), next.firstChild)
      else loc.node.insertBefore(s2, next || null)
    }
    p.normalize()
    sync(p)
    R.fixEmpty(p)
    setPos({ pi: paras().indexOf(p), off: off + text.length })
    S.pendingAt = null
  }

  /** 在光标处插入节点（对象、换行） */
  function insertNode(node) {
    var r = selRange()
    if (!r) return
    var p = paraOf(r.startContainer)
    if (!p) return
    var off = offsetIn(p, r.startContainer, r.startOffset)
    var loc = locate(p, off)
    var ip = splitUpTo(loc.node, loc.offset, stopOf(loc.node, p))
    ip.parent.insertBefore(node, ip.ref)
    sync(p)
    var np = rerender(p)
    setPos({ pi: paras().indexOf(np), off: off + count(node) })
    return np
  }
  function insertBreak() {
    var r = selRange()
    if (!r) return
    var p = paraOf(r.startContainer)
    if (!p) return
    var off = offsetIn(p, r.startContainer, r.startOffset)
    var br = h('br', 'b')
    br.dataset.r = ridNear(p, off)
    insertNode(br)
  }

  /* ---------------- 删除 ---------------- */

  function deleteIn(p, s, e) {
    if (e <= s) return
    rangeIn(p, s, e).deleteContents()
  }
  function removeBlock(el) {
    if (el._x && el._x.parentNode) el._x.parentNode.removeChild(el._x)
    el.remove()
  }
  /** 把段落 b 接到段落 a 后面（b 删除） */
  function join(a, b) {
    Array.prototype.slice.call(a.querySelectorAll(':scope > br.fill')).forEach(function (x) {
      x.remove()
    })
    Array.prototype.slice.call(b.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && (n.classList.contains('num') || n.classList.contains('fill'))) return
      a.appendChild(n)
    })
    a._tail = (a._tail || []).concat(b._tail || [])
    // 分节符跟着后一个段落：合并后留在合并的段落上
    var bs = OX.path(b._x, 'pPr', 'sectPr')
    if (bs && !OX.path(a._x, 'pPr', 'sectPr')) M.ensureW(M.pPrOf(a._x, true), 'sectPr', M.PPR_ORDER).replaceWith(bs.cloneNode(true))
    removeBlock(b)
    a.normalize()
    sync(a)
  }
  /** 删除选区（可以跨段落），返回删除后光标的位置 */
  function deleteRange(r) {
    var list = paras()
    var ps = parasIn(r)
    if (!ps.length) return null
    var A = ps[0]
    var B = ps[ps.length - 1]
    var aOff = offsetIn(A, r.startContainer, r.startOffset)
    var bOff = offsetIn(B, r.endContainer, r.endOffset)
    var touched = []
    ps.forEach(function (p) {
      var s = p === A ? aOff : 0
      var e = p === B ? bOff : count(p)
      if (e > s) {
        deleteIn(p, s, e)
        touched.push(p)
      }
    })
    if (A !== B && A.parentNode === B.parentNode) {
      var n = A.nextElementSibling
      while (n && n !== B) {
        var nx = n.nextElementSibling
        removeBlock(n)
        n = nx
      }
      join(A, B)
      touched = touched.filter(function (p) {
        return p !== B
      })
      if (touched.indexOf(A) < 0) touched.push(A)
    }
    var pi = list.indexOf(A)
    touched.forEach(function (p) {
      if (!p.isConnected) return
      sync(p)
      rerender(p)
    })
    return { pi: pi, off: aOff }
  }
  function deleteSelection() {
    var r = selRange()
    if (!r || r.collapsed) return false
    var pos = deleteRange(r)
    if (pos) setPos(pos)
    return true
  }

  function isListPara(p) {
    var info = R.paraInfo(S.doc, p._x, ctxOf(p).tblStyle)
    return info.np
  }
  /** 段落开头按退格 */
  function backAtStart(p) {
    var np = isListPara(p)
    if (np) {
      // 先去掉编号（Word 的做法）
      S.doc.setNumbering(p._x, null)
      S.doc.touch()
      var n = rerender(p)
      setPos({ pi: paras().indexOf(n), off: 0 })
      return true
    }
    var prev = p.previousElementSibling
    if (!prev || !prev.matches('p.p')) {
      // 前面是表格：空段落直接删掉（后面还有内容时）
      if (prev && !count(p) && p.nextElementSibling) {
        var list = paras()
        var i = list.indexOf(p)
        removeBlock(p)
        S.doc.touch()
        setPos({ pi: Math.max(0, i - 1), off: 1e9 })
        return true
      }
      return false
    }
    var off = count(prev)
    var pi = paras().indexOf(prev)
    // 前一段是空段落：删掉前一段，保留这一段的格式（标题前的空行等）
    if (!off && !prev._tail && !OX.path(prev._x, 'pPr', 'sectPr')) {
      removeBlock(prev)
      S.doc.touch()
      setPos({ pi: pi, off: 0 })
      return true
    }
    join(prev, p)
    rerender(prev)
    setPos({ pi: pi, off: off })
    return true
  }
  /** 段落末尾按 Delete */
  function deleteAtEnd(p) {
    var next = p.nextElementSibling
    if (!next || !next.matches('p.p')) return false
    var off = count(p)
    var pi = paras().indexOf(p)
    if (!off && !p._tail) {
      removeBlock(p)
      S.doc.touch()
      setPos({ pi: pi, off: 0 })
      return true
    }
    join(p, next)
    rerender(p)
    setPos({ pi: pi, off: off })
    return true
  }

  /* ---------------- 回车：拆分段落 ---------------- */

  function splitPara() {
    var r = selRange()
    if (!r) return null
    var p = paraOf(r.startContainer)
    if (!p) return null
    var x = p._x
    var doc = S.doc
    var off = offsetIn(p, r.startContainer, r.startOffset)
    var total = count(p)
    // 空的列表项回车：结束列表
    if (!total && isListPara(p)) {
      doc.setNumbering(x, null)
      doc.touch()
      var n0 = rerender(p)
      setPos({ pi: paras().indexOf(n0), off: 0 })
      return n0
    }
    var loc = locate(p, off)
    var rg = document.createRange()
    rg.setStart(loc.node, loc.offset)
    rg.setEnd(p, p.childNodes.length)
    var frag = rg.extractContents()
    Array.prototype.slice.call(frag.querySelectorAll('.num, br.fill')).forEach(function (e) {
      e.remove()
    })
    // 被拆开的第一个元素是复制出来的：上面挂的标记留在原段落
    var firstEl = frag.firstChild && frag.firstChild.nodeType === 1 ? frag.firstChild : null
    if (firstEl && firstEl.dataset && firstEl.dataset.m && off > 0) delete firstEl.dataset.m
    var nx = x.cloneNode(false)
    var pPr = kid(x, 'pPr')
    if (pPr) {
      var np = pPr.cloneNode(true)
      nx.appendChild(np)
      // 分节符留在后一段；分页（段前分页）留在前一段
      var sp = kid(pPr, 'sectPr')
      if (sp) pPr.removeChild(sp)
      OX.removeKid(np, 'pageBreakBefore')
      // 在段落末尾回车：新段落用样式的“后续段落样式”（标题 → 正文）
      if (off >= total) {
        var sid = M.wattr(kid(np, 'pStyle'), 'val')
        var st = doc.style(sid)
        if (st && st.next && st.next !== st.id) {
          if (st.next === doc.styles().defP) OX.removeKid(np, 'pStyle')
          else M.setW(kid(np, 'pStyle'), 'val', st.next)
        }
      }
    }
    x.parentNode.insertBefore(nx, x.nextSibling)
    var hp2 = h('p', 'p')
    hp2._x = nx
    hp2._pm = p._pm
    hp2._tail = p._tail
    p._tail = null
    hp2.appendChild(frag)
    p.parentNode.insertBefore(hp2, p.nextSibling)
    sync(p)
    sync(hp2)
    var a = rerender(p)
    var b = rerender(hp2)
    doc.touch()
    setPos({ pi: paras().indexOf(b), off: 0 })
    return b
  }

  /* ---------------- 格式 ---------------- */

  /** 选区里的文字 span（先在选区两端拆开） */
  function spansIn(r) {
    var ps = parasIn(r)
    if (!ps.length) return { spans: [], paras: [] }
    var pos = savePos()
    var A = ps[0]
    var B = ps[ps.length - 1]
    // 先拆结尾再拆开头（拆开头不会影响结尾的位置）
    var e = splitUpTo(r.endContainer, r.endOffset, stopOf(r.endContainer, B))
    var s = splitUpTo(r.startContainer, r.startOffset, stopOf(r.startContainer, A))
    var rg = document.createRange()
    try {
      if (s.ref) rg.setStartBefore(s.ref)
      else rg.setStart(s.parent, s.parent.childNodes.length)
      if (e.ref) rg.setEndBefore(e.ref)
      else rg.setEnd(e.parent, e.parent.childNodes.length)
    } catch (err) {
      rg = r
    }
    var spans = []
    ps.forEach(function (p) {
      var tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      var n
      var texts = []
      while ((n = tw.nextNode())) texts.push(n)
      texts.forEach(function (tn) {
        // 两端已经拆开，文字要么整个在选区里，要么整个在外面
        if (!tn.data || inAtom(tn) || tn.parentNode.closest('.num')) return
        if (!rg.intersectsNode(tn)) return
        var span = tn.parentNode.closest('span.r')
        if (!span || !p.contains(span)) {
          // 段落里直接的文字（用段落标记的格式）：包一个 span
          span = newSpan(p._pm, p)
          tn.parentNode.insertBefore(span, tn)
          span.appendChild(tn)
        }
        if (spans.indexOf(span) < 0) spans.push(span)
      })
    })
    return { spans: spans, paras: ps, pos: pos }
  }

  /** 改选区文字的格式：fn(rPr 副本) 修改 rPr */
  function formatRun(fn) {
    var r = selRange()
    if (!r) return
    if (r.collapsed) {
      // 没有选中文字：记住格式，接下来输入的文字用它
      var p = paraOf(r.startContainer)
      if (!p) return
      var off = offsetIn(p, r.startContainer, r.startOffset)
      var base = R.reg.get(S.pending || ridNear(p, off))
      var rp = base ? base.cloneNode(true) : M.wel(S.doc.xml, 'rPr')
      fn(rp, p)
      S.pending = R.reg.putR(rp)
      S.pendingAt = JSON.stringify(savePos())
      emit('change')
      return
    }
    var res = spansIn(r)
    res.spans.forEach(function (span) {
      var p = paraOf(span)
      var base = R.reg.get(span.dataset.r)
      var rp = base ? base.cloneNode(true) : M.wel(S.doc.xml, 'rPr')
      fn(rp, p)
      span.dataset.r = R.reg.putR(rp)
      span.setAttribute('style', cssFor(span.dataset.r, p))
    })
    res.paras.forEach(function (p) {
      p.normalize()
      sync(p)
    })
    var fresh = res.paras.map(function (p) {
      return rerender(p)
    })
    setPos(res.pos, true)
    commit({ renumber: false })
  }

  /** 光标 / 选区开头的有效文字格式 */
  function propsAtSel() {
    var r = selRange()
    if (!r) return null
    var p = paraOf(r.startContainer)
    if (!p) return null
    var rid
    if (S.pending) rid = S.pending
    else if (r.collapsed) rid = ridNear(p, offsetIn(p, r.startContainer, r.startOffset))
    else {
      // 选区里第一段文字
      var off = offsetIn(p, r.startContainer, r.startOffset)
      rid = ridNear(p, Math.min(off + 1, count(p)))
    }
    var c = ctxOf(p)
    var info = S.doc.pProps(p._x, c.tblStyle)
    return { props: S.doc.rProps(R.reg.get(rid) || null, info.styleId, c.tblStyle), rPr: R.reg.get(rid) || null, p: p, pprops: info }
  }

  /* 开关格式：value 为 true / false；样式本来就是加粗时，取消要写 w:val="0" */
  function setToggle(rp, p, names, value) {
    names.forEach(function (n) {
      OX.removeKid(rp, n)
    })
    var c = ctxOf(p)
    var info = S.doc.pProps(p._x, c.tblStyle)
    var inherited = S.doc.rProps(rp, info.styleId, c.tblStyle)
    var cur = M.on(inherited[names[0]]) || false
    if (cur === value) return
    names.forEach(function (n) {
      var el = M.ensureW(rp, n, M.RPR_ORDER)
      if (!value) M.setW(el, 'val', '0')
    })
  }

  function toggle(kind) {
    var st = propsAtSel()
    if (!st) return
    var pr = st.props
    if (kind === 'b' || kind === 'i' || kind === 'strike') {
      var names = kind === 'strike' ? ['strike'] : [kind, kind + 'Cs']
      var value = !M.on(pr[kind])
      formatRun(function (rp, p) {
        setToggle(rp, p, names, value)
        if (kind === 'strike') OX.removeKid(rp, 'dstrike')
      })
    } else if (kind === 'u') {
      var uOn = pr.u && M.wattr(pr.u, 'val') !== 'none'
      formatRun(function (rp) {
        OX.removeKid(rp, 'u')
        M.setW(M.ensureW(rp, 'u', M.RPR_ORDER), 'val', uOn ? 'none' : 'single')
      })
    } else if (kind === 'sup' || kind === 'sub') {
      var want = kind === 'sup' ? 'superscript' : 'subscript'
      var cur = pr.vertAlign ? M.wattr(pr.vertAlign, 'val') : null
      formatRun(function (rp) {
        OX.removeKid(rp, 'vertAlign')
        if (cur !== want) M.setW(M.ensureW(rp, 'vertAlign', M.RPR_ORDER), 'val', want)
      })
    }
  }
  function setSize(ptSize) {
    var v = Math.round(ptSize * 2)
    formatRun(function (rp) {
      M.setW(M.ensureW(rp, 'sz', M.RPR_ORDER), 'val', v)
      M.setW(M.ensureW(rp, 'szCs', M.RPR_ORDER), 'val', v)
    })
  }
  function stepSize(dir) {
    var st = propsAtSel()
    if (!st) return
    var cur = st.props.sz ? M.wnum(st.props.sz, 'val', 21) / 2 : 10.5
    var SIZES = [5, 5.5, 6.5, 7.5, 8, 9, 10, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 42, 48, 72]
    var next = cur
    if (dir > 0) next = SIZES.filter(function (s) { return s > cur })[0] || cur + 10
    else next = SIZES.filter(function (s) { return s < cur }).pop() || Math.max(1, cur - 1)
    setSize(next)
  }
  var CJK_FONTS = /[㐀-鿿]|^(SimSun|SimHei|NSimSun|KaiTi|FangSong|Microsoft YaHei|DengXian|MS Mincho|MS Gothic|Meiryo|Yu Gothic|Malgun Gothic|PMingLiU|MingLiU|Microsoft JhengHei|STSong|STKaiti|STHeiti|STFangsong|Source Han|Noto Sans CJK|Noto Serif CJK)/i
  function setFont(name) {
    var cjk = CJK_FONTS.test(name)
    formatRun(function (rp) {
      var rf = M.ensureW(rp, 'rFonts', M.RPR_ORDER)
      ;['asciiTheme', 'hAnsiTheme', 'cstheme', 'eastAsiaTheme'].forEach(function (k) {
        M.setW(rf, k, null)
      })
      M.setW(rf, 'ascii', name)
      M.setW(rf, 'hAnsi', name)
      if (cjk) M.setW(rf, 'eastAsia', name)
      else M.setW(rf, 'cs', name)
      M.setW(rf, 'hint', cjk ? 'eastAsia' : null)
    })
  }
  function setColor(hex) {
    formatRun(function (rp) {
      OX.removeKid(rp, 'color')
      if (hex) M.setW(M.ensureW(rp, 'color', M.RPR_ORDER), 'val', hex.replace('#', '').toUpperCase())
    })
  }
  var HL_NAMES = { '#ffff00': 'yellow', '#00ff00': 'green', '#00ffff': 'cyan', '#ff00ff': 'magenta', '#0000ff': 'blue', '#ff0000': 'red', '#000080': 'darkBlue', '#008080': 'darkCyan', '#008000': 'darkGreen', '#800080': 'darkMagenta', '#800000': 'darkRed', '#808000': 'darkYellow', '#808080': 'darkGray', '#c0c0c0': 'lightGray', '#000000': 'black' }
  function setHighlight(hex) {
    formatRun(function (rp) {
      OX.removeKid(rp, 'highlight')
      OX.removeKid(rp, 'shd')
      if (!hex) return
      var name = HL_NAMES[hex.toLowerCase()]
      if (name) M.setW(M.ensureW(rp, 'highlight', M.RPR_ORDER), 'val', name)
      else {
        var shd = M.ensureW(rp, 'shd', M.RPR_ORDER)
        M.setW(shd, 'val', 'clear')
        M.setW(shd, 'color', 'auto')
        M.setW(shd, 'fill', hex.replace('#', '').toUpperCase())
      }
    })
  }
  function clearFormat() {
    formatRun(function (rp) {
      while (rp.firstChild) rp.removeChild(rp.firstChild)
    })
  }

  /* ---------------- 段落格式 ---------------- */

  /** 改选区里每个段落的 pPr：fn(pPr, xmlP, htmlP) */
  function formatPara(fn, opts) {
    flushTyping()
    var r = selRange()
    if (!r) return
    var pos = savePos()
    var ps = parasIn(r)
    if (!ps.length) return
    ps.forEach(function (p, i) {
      fn(M.pPrOf(p._x, true), p._x, p, i, ps)
      var pPr = kid(p._x, 'pPr')
      if (pPr && !pPr.firstElementChild) p._x.removeChild(pPr)
    })
    S.doc.touch()
    ps.forEach(function (p) {
      rerender(p)
    })
    setPos(pos, true)
    commit()
  }
  function setStyle(id) {
    formatPara(function (pPr, x) {
      OX.removeKid(pPr, 'pStyle')
      if (id && id !== S.doc.styles().defP) M.setW(M.ensureW(pPr, 'pStyle', M.PPR_ORDER), 'val', id)
    })
  }
  function setAlign(a) {
    formatPara(function (pPr) {
      OX.removeKid(pPr, 'jc')
      M.setW(M.ensureW(pPr, 'jc', M.PPR_ORDER), 'val', a)
    })
  }
  function setLineSpacing(mult) {
    formatPara(function (pPr) {
      var sp = M.ensureW(pPr, 'spacing', M.PPR_ORDER)
      M.setW(sp, 'line', Math.round(mult * 240))
      M.setW(sp, 'lineRule', 'auto')
    })
  }
  function setParaSpacing(which, ptVal) {
    formatPara(function (pPr) {
      var sp = M.ensureW(pPr, 'spacing', M.PPR_ORDER)
      M.setW(sp, which, Math.round(ptVal * 20))
      M.setW(sp, which + 'Lines', null)
      M.setW(sp, which + 'Autospacing', null)
    })
  }
  /** 列表：kind 为 bullet / number；选区已经全是这种列表时取消 */
  function toggleList(kind) {
    var r = selRange()
    if (!r) return
    var ps = parasIn(r)
    var doc = S.doc
    var all = ps.length && ps.every(function (p) {
      var np = isListPara(p)
      return np && doc.listKind(np.numId) === kind
    })
    var numId = null
    if (!all) {
      // 前一段是同类列表时接着编号
      var prev = ps[0].previousElementSibling
      var pnp = prev && prev.matches('p.p') ? isListPara(prev) : null
      numId = pnp && doc.listKind(pnp.numId) === kind ? pnp.numId : doc.addList(kind === 'bullet' ? 'bullet' : 'decimal')
    }
    formatPara(function (pPr, x, hp) {
      if (all) doc.setNumbering(x, null)
      else {
        var cur = isListPara(hp)
        doc.setNumbering(x, numId, cur ? cur.ilvl : 0)
      }
    })
  }
  /** 缩进：列表里改级别，否则改左缩进 */
  function indent(dir) {
    var doc = S.doc
    formatPara(function (pPr, x, hp) {
      var np = isListPara(hp)
      if (np) {
        var lvl = Math.max(0, Math.min(8, np.ilvl + dir))
        doc.setNumbering(x, np.numId, lvl)
        return
      }
      var props = doc.pProps(x)
      var ind = props.ind || {}
      var left = Number(ind.left || 0)
      var step = 420
      left = Math.max(0, Math.round((left + dir * step) / step) * step)
      var el = M.ensureW(pPr, 'ind', M.PPR_ORDER)
      M.setW(el, 'left', left)
      M.setW(el, 'start', null)
      M.setW(el, 'leftChars', null)
    })
  }

  /* ---------------- 插入块 ---------------- */

  /** 在当前段落后面插入 XML 块（光标在段落中间时先拆开） */
  function insertBlocks(blocks, opts) {
    opts = opts || {}
    var r = selRange()
    var list = paras()
    var p = r ? paraOf(r.startContainer) : list[list.length - 1]
    if (!p) return
    var off = r ? offsetIn(p, r.startContainer, r.startOffset) : count(p)
    var total = count(p)
    var after = p
    var replaceEmpty = !total && !isListPara(p)
    if (off > 0 && off < total) {
      var b = splitPara()
      after = b.previousElementSibling
    } else if (off === 0 && total > 0) {
      after = p.previousElementSibling && p.previousElementSibling._x ? p.previousElementSibling : null
    }
    var parentX = p._x.parentNode
    var parentH = p.parentNode
    var ref = after ? after.nextElementSibling : parentH.firstElementChild
    var refX = after ? after._x.nextSibling : parentX.firstChild
    if (!after && off === 0) {
      ref = p
      refX = p._x
    }
    var ctx = ctxOf(p)
    var last = null
    blocks.forEach(function (bx) {
      parentX.insertBefore(bx, refX)
      var e = R.renderBlock(bx, ctx)
      if (e) {
        parentH.insertBefore(e, ref)
        last = e
      }
    })
    if (replaceEmpty && p.isConnected && blocks.length && p !== last) {
      // 表格后面必须有段落：最后插入的是表格时保留这个空段落
      if (!(blocks[blocks.length - 1].localName === 'tbl' && p === ref)) removeBlock(p)
    }
    S.doc.touch()
    numberAll()
    // 光标放到插入内容的末尾
    if (last) {
      var lp = last.matches('p.p') ? last : last.querySelectorAll('p.p')[last.querySelectorAll('p.p').length - 1]
      if (lp) setPos({ pi: paras().indexOf(lp), off: count(lp) })
    }
    return last
  }

  window.Ed = {
    S: S,
    t: t,
    h: h,
    $: $,
    get docEl() {
      return docEl
    },
    init: function (el) {
      docEl = el
    },
    on: function (name, fn) {
      listeners[name].push(fn)
    },
    emit: emit,
    load: load,
    renderAll: renderAll,
    numberAll: numberAll,
    ctxOf: ctxOf,
    ctxFor: ctxFor,
    paras: paras,
    paraOf: paraOf,
    inAtom: inAtom,
    count: count,
    textOf: textOf,
    offsetIn: offsetIn,
    locate: locate,
    rangeIn: rangeIn,
    selRange: selRange,
    savePos: savePos,
    setPos: setPos,
    scrollToRange: scrollToRange,
    parasIn: parasIn,
    sync: sync,
    rerender: rerender,
    commit: commit,
    typed: typed,
    flushTyping: flushTyping,
    undo: undo,
    redo: redo,
    insertText: insertText,
    insertNode: insertNode,
    insertBreak: insertBreak,
    deleteRange: deleteRange,
    deleteSelection: deleteSelection,
    deleteIn: deleteIn,
    removeBlock: removeBlock,
    backAtStart: backAtStart,
    deleteAtEnd: deleteAtEnd,
    splitPara: splitPara,
    splitUpTo: splitUpTo,
    stopOf: stopOf,
    newSpan: newSpan,
    cssFor: cssFor,
    ridNear: ridNear,
    formatRun: formatRun,
    propsAtSel: propsAtSel,
    toggle: toggle,
    setSize: setSize,
    stepSize: stepSize,
    setFont: setFont,
    setColor: setColor,
    setHighlight: setHighlight,
    clearFormat: clearFormat,
    formatPara: formatPara,
    setStyle: setStyle,
    setAlign: setAlign,
    setLineSpacing: setLineSpacing,
    setParaSpacing: setParaSpacing,
    toggleList: toggleList,
    indent: indent,
    isListPara: isListPara,
    insertBlocks: insertBlocks,
    showError: showError
  }
})()
