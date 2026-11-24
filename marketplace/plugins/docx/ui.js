/**
 * 界面：输入事件、快捷键、工具栏、弹出菜单、表格操作、图片（插入 / 缩放）、超链接、查找替换、导航窗格、状态栏、缩放。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var M = window.DocModel
  var R = window.Render
  var Ed = window.Ed
  var S = Ed.S
  var t = Ed.t
  var $ = Ed.$
  var kid = OX.kid
  var kids = OX.kids

  function h(tag, attrs) {
    var e = document.createElement(tag)
    if (attrs)
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null || v === false) continue
        if (k === 'class') e.className = v
        else if (k === 'style') typeof v === 'string' ? e.setAttribute('style', v) : Object.assign(e.style, v)
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
  var docEl = null

  /* ---------------- 输入 ---------------- */

  function staticToRange(sr) {
    var r = document.createRange()
    r.setStart(sr.startContainer, sr.startOffset)
    r.setEnd(sr.endContainer, sr.endOffset)
    return r
  }

  function onBeforeInput(e) {
    var type = e.inputType
    if (!S.doc) return e.preventDefault()
    if (type === 'historyUndo') return e.preventDefault(), Ed.undo()
    if (type === 'historyRedo') return e.preventDefault(), Ed.redo()
    if (/^format/.test(type)) {
      e.preventDefault()
      var map = { formatBold: 'b', formatItalic: 'i', formatUnderline: 'u', formatStrikeThrough: 'strike', formatSuperscript: 'sup', formatSubscript: 'sub' }
      if (map[type]) Ed.toggle(map[type])
      return
    }
    // 输入法组字交给浏览器，组字结束后再同步
    if (type === 'insertCompositionText' || type === 'deleteCompositionText' || type === 'insertFromComposition') return
    var r = Ed.selRange()
    if (!r) return e.preventDefault()
    if (type === 'insertText' || type === 'insertReplacementText') {
      e.preventDefault()
      var text = e.data != null ? e.data : e.dataTransfer ? e.dataTransfer.getData('text/plain') : ''
      if (type === 'insertReplacementText' && e.getTargetRanges && e.getTargetRanges()[0]) {
        var tr = staticToRange(e.getTargetRanges()[0])
        var sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(tr)
        r = tr
      }
      if (!r.collapsed) Ed.flushTyping(), Ed.setPos(Ed.deleteRange(r))
      Ed.insertText(text)
      Ed.typed()
      return
    }
    if (type === 'insertParagraph') {
      e.preventDefault()
      Ed.flushTyping()
      if (!r.collapsed) Ed.setPos(Ed.deleteRange(r))
      Ed.splitPara()
      Ed.commit()
      return
    }
    if (type === 'insertLineBreak') {
      e.preventDefault()
      Ed.flushTyping()
      if (!r.collapsed) Ed.setPos(Ed.deleteRange(r))
      Ed.insertBreak()
      Ed.commit()
      return
    }
    if (/^delete/.test(type)) {
      if (type === 'deleteByCut' || type === 'deleteByDrag') return e.preventDefault()
      if (!r.collapsed) {
        e.preventDefault()
        Ed.flushTyping()
        Ed.setPos(Ed.deleteRange(r))
        Ed.commit()
        return
      }
      var p = Ed.paraOf(r.startContainer)
      if (!p) return e.preventDefault()
      var off = Ed.offsetIn(p, r.startContainer, r.startOffset)
      var back = /Backward/.test(type)
      if (back && off === 0) {
        e.preventDefault()
        Ed.flushTyping()
        if (Ed.backAtStart(p)) Ed.commit()
        return
      }
      if (!back && off >= Ed.count(p)) {
        e.preventDefault()
        Ed.flushTyping()
        if (Ed.deleteAtEnd(p)) Ed.commit()
        return
      }
      // 段落里面的删除交给浏览器（按字、按词），input 事件里同步
      return
    }
    // 其他（粘贴、拖放、浏览器自带的列表命令…）都自己处理或忽略
    e.preventDefault()
  }

  function onInput(e) {
    if (S.composing || e.isComposing) return
    afterNative()
  }
  function afterNative() {
    var r = Ed.selRange()
    if (!r) return
    var p = Ed.paraOf(r.startContainer)
    if (!p) return
    var pos = Ed.savePos()
    Ed.sync(p)
    R.fixEmpty(p)
    // 浏览器可能把编号删掉了
    if (Ed.isListPara(p) && !(p.firstElementChild && p.firstElementChild.classList.contains('num'))) {
      Ed.numberAll()
      Ed.setPos(pos, true)
    }
    Ed.typed()
  }

  function onCompositionStart() {
    S.composing = true
  }
  function onCompositionEnd() {
    S.composing = false
    // 组字前插的零宽占位去掉
    var r = Ed.selRange()
    var p = r && Ed.paraOf(r.startContainer)
    if (p && /​/.test(p.textContent)) {
      var pos = Ed.savePos()
      var tw = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      var n, removed = 0
      var caretOff = pos ? pos.a.off : 0
      var acc = 0
      while ((n = tw.nextNode())) {
        var i
        while ((i = n.data.indexOf('​')) >= 0) {
          if (acc + i < caretOff) removed++
          n.deleteData(i, 1)
        }
        acc += n.data.length
      }
      if (pos) {
        pos.a.off -= removed
        pos.b = pos.a
        Ed.setPos(pos, true)
      }
    }
    afterNative()
  }

  /** 组字开始前：有选中的文字先删掉；有待用格式时先放一个零宽占位让文字进到新格式里 */
  function beforeCompose() {
    var r = Ed.selRange()
    if (!r) return
    if (!r.collapsed) {
      Ed.flushTyping()
      Ed.setPos(Ed.deleteRange(r))
      Ed.commit()
    }
    if (S.pending) {
      Ed.insertText('​')
    }
  }

  function onKey(e) {
    if (!S.doc) return
    var mod = e.ctrlKey || e.metaKey
    var k = e.key
    var inDoc = docEl.contains(document.activeElement) || document.activeElement === docEl
    if (e.isComposing || e.keyCode === 229) {
      if (inDoc && !S.composing) beforeCompose()
      return
    }
    if (k === 'Escape') {
      if (pop) return closePop()
      if (!$('find').hidden) return closeFind()
      hideImgSel()
      return
    }
    if (mod && !e.altKey) {
      var lk = k.toLowerCase()
      if (lk === 'z' && !e.shiftKey) return stop(e, Ed.undo)
      if (lk === 'y' || (lk === 'z' && e.shiftKey)) return stop(e, Ed.redo)
      if (lk === 'f') return stop(e, function () { openFind(false) })
      if (lk === 'h') return stop(e, function () { openFind(true) })
      if (k === '=' || k === '+') return stop(e, function () { zoomBy(1.1) })
      if (k === '-') return stop(e, function () { zoomBy(1 / 1.1) })
      if (k === '0') return stop(e, function () { setZoom(0) })
      if (!inDoc) return
      if (lk === 'b') return stop(e, function () { Ed.toggle('b') })
      if (lk === 'i') return stop(e, function () { Ed.toggle('i') })
      if (lk === 'u') return stop(e, function () { Ed.toggle('u') })
      if (lk === 'e') return stop(e, function () { Ed.setAlign('center') })
      if (lk === 'l') return stop(e, function () { Ed.setAlign('left') })
      if (lk === 'r') return stop(e, function () { Ed.setAlign('right') })
      if (lk === 'j') return stop(e, function () { Ed.setAlign('both') })
      if (k === ']') return stop(e, function () { Ed.stepSize(1) })
      if (k === '[') return stop(e, function () { Ed.stepSize(-1) })
      if (k === 'Enter') return stop(e, insertPageBreak)
      if (lk === 'd' && e.shiftKey) return
    }
    if (mod && e.altKey && /^[0-6]$/.test(k) && inDoc) {
      return stop(e, function () {
        Ed.setStyle(k === '0' ? S.doc.styles().defP : S.doc.ensureStyle('heading ' + k))
      })
    }
    if (!inDoc) return
    if (k === 'Tab' && !mod && !e.altKey) {
      e.preventDefault()
      var r = Ed.selRange()
      if (!r) return
      var p = Ed.paraOf(r.startContainer)
      var td = p && p.closest('td')
      if (td && docEl.contains(td)) return cellNav(td, e.shiftKey ? -1 : 1)
      if (p && Ed.isListPara(p) && (Ed.offsetIn(p, r.startContainer, r.startOffset) === 0 || !r.collapsed)) return Ed.indent(e.shiftKey ? -1 : 1)
      if (e.shiftKey) return
      if (!r.collapsed) Ed.setPos(Ed.deleteRange(r))
      Ed.insertText('\t')
      Ed.typed()
      return
    }
  }
  function stop(e, fn) {
    e.preventDefault()
    e.stopPropagation()
    fn()
  }

  /* ---------------- 剪贴板 ---------------- */

  function norm(s) {
    return String(s || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  }

  function onCopy(e, cut) {
    var r = Ed.selRange()
    if (!r || r.collapsed) return
    e.preventDefault()
    var ps = Ed.parasIn(r)
    if (!ps.length) return
    var A = ps[0], B = ps[ps.length - 1]
    var aOff = Ed.offsetIn(A, r.startContainer, r.startOffset)
    var bOff = Ed.offsetIn(B, r.endContainer, r.endOffset)
    var texts = []
    var htmls = []
    var blocks = []
    ps.forEach(function (p) {
      var s = p === A ? aOff : 0
      var en = p === B ? bOff : Ed.count(p)
      var frag = Ed.rangeIn(p, s, en).cloneContents()
      texts.push(Ed.textOf(frag).replace(/￼/g, ''))
      var tmp = document.createElement('p')
      tmp.className = 'p'
      tmp._pm = p._pm
      var x = p._x.cloneNode(false)
      var pPr = kid(p._x, 'pPr')
      if (pPr) {
        var c = pPr.cloneNode(true)
        OX.removeKid(c, 'sectPr')
        x.appendChild(c)
      }
      tmp._x = x
      tmp.appendChild(frag.cloneNode(true))
      R.syncPara(tmp)
      blocks.push(x)
      var hp = h('p', { style: p.getAttribute('style') || '' })
      hp.appendChild(frag)
      Array.prototype.forEach.call(hp.querySelectorAll('[contenteditable]'), function (n) {
        n.removeAttribute('contenteditable')
      })
      htmls.push(hp.outerHTML)
    })
    var text = texts.join('\r\n')
    S.clip = { text: norm(text), blocks: blocks }
    e.clipboardData.setData('text/plain', text)
    e.clipboardData.setData('text/html', '<meta charset="utf-8"><div>' + htmls.join('') + '</div>')
    if (cut) {
      Ed.flushTyping()
      Ed.setPos(Ed.deleteRange(r))
      Ed.commit()
    }
  }

  function onPaste(e) {
    if (!S.doc) return
    var r = Ed.selRange()
    if (!r) return
    e.preventDefault()
    var dt = e.clipboardData
    var file = Array.prototype.filter.call(dt.files || [], function (f) { return /^image\//.test(f.type) })[0]
    if (file) return insertImageFile(file)
    var text = dt.getData('text/plain')
    var html = dt.getData('text/html')
    var blocks = null
    if (S.clip && text && norm(text) === S.clip.text) {
      blocks = S.clip.blocks.map(function (b) { return b.cloneNode(true) })
    } else if (html) {
      try {
        blocks = htmlToBlocks(html)
      } catch (err) {
        console.error(err)
      }
    }
    if (!blocks || !blocks.length) {
      if (!text) return
      blocks = norm(text).split('\n').map(function (line) {
        return S.doc.newPara(line, { markdown: false })
      })
    }
    Ed.flushTyping()
    if (!r.collapsed) Ed.setPos(Ed.deleteRange(r))
    pasteBlocks(blocks)
    Ed.commit()
  }

  /** 粘贴：只有一个段落时插进当前段落（保留格式），否则作为新段落插入 */
  function pasteBlocks(blocks) {
    var r = Ed.selRange()
    if (!r) return
    var p = Ed.paraOf(r.startContainer)
    if (!p) return
    if (blocks.length === 1 && blocks[0].localName === 'p') {
      var tmp = R.renderPara(blocks[0], Ed.ctxOf(p))
      var frag = document.createDocumentFragment()
      var n = 0
      Array.prototype.slice.call(tmp.childNodes).forEach(function (c) {
        if (c.nodeType === 1 && (c.classList.contains('num') || c.classList.contains('fill'))) return
        n += Ed.count(c)
        frag.appendChild(c)
      })
      if (!n) return
      // 段落里直接的文字用的是粘贴来的段落标记格式：包成 span
      Array.prototype.slice.call(frag.childNodes).forEach(function (c) {
        if (c.nodeType === 3) {
          var s = Ed.newSpan(tmp._pm, p, c.data)
          frag.replaceChild(s, c)
        }
      })
      var off = Ed.offsetIn(p, r.startContainer, r.startOffset)
      var loc = Ed.locate(p, off)
      var ip = Ed.splitUpTo(loc.node, loc.offset, Ed.stopOf(loc.node, p))
      ip.parent.insertBefore(frag, ip.ref)
      Ed.sync(p)
      var np = Ed.rerender(p)
      Ed.setPos({ pi: Ed.paras().indexOf(np), off: off + n })
      return
    }
    Ed.insertBlocks(blocks)
  }

  /** 网页 / 其他程序复制的 HTML → 段落和表格 */
  function htmlToBlocks(html) {
    var d = new DOMParser().parseFromString(html, 'text/html')
    var doc = S.doc
    var out = []
    var cur = null
    var listIds = {}
    var BLOCK = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|TABLE|UL|OL|TR|SECTION|ARTICLE|HEADER|FOOTER|MAIN|NAV|ASIDE|FIGURE|DL|DT|DD|HR)$/
    var startPara = function (opts) {
      cur = { opts: opts || {}, runs: [] }
      out.push(cur)
    }
    var addRun = function (text, f) {
      if (!cur) startPara()
      cur.runs.push({ text: text, f: f })
    }
    var fmtOf = function (el, f) {
      f = Object.assign({}, f)
      var tag = el.nodeName
      var st = el.style || {}
      if (tag === 'B' || tag === 'STRONG' || Number(st.fontWeight) >= 600 || st.fontWeight === 'bold') f.b = 1
      if (st.fontWeight === 'normal' || st.fontWeight === '400') delete f.b
      if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') f.i = 1
      if (tag === 'U' || /underline/.test(st.textDecoration || '')) f.u = 1
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(st.textDecoration || '')) f.s = 1
      if (tag === 'SUP') f.sup = 1
      if (tag === 'SUB') f.sub = 1
      if (tag === 'CODE') f.code = 1
      if (tag === 'A' && el.getAttribute('href') && /^(https?:|mailto:)/i.test(el.getAttribute('href'))) f.link = el.getAttribute('href')
      var col = st.color
      var m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(col || '')
      if (m) {
        var hex = [m[1], m[2], m[3]].map(function (v) { return ('0' + Number(v).toString(16)).slice(-2) }).join('')
        if (hex !== '000000') f.color = hex
      } else if (/^#[0-9a-f]{6}$/i.test(col || '') && col.toLowerCase() !== '#000000') f.color = col.slice(1)
      return f
    }
    var walk = function (el, f, pre) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var s = pre ? c.data : c.data.replace(/\s+/g, ' ')
          if (!pre && (!cur || !cur.runs.length)) s = s.replace(/^\s+/, '')
          if (s) addRun(s, f)
          continue
        }
        if (c.nodeType !== 1) continue
        var tag = c.nodeName
        if (/^(SCRIPT|STYLE|META|LINK|TITLE|HEAD|NOSCRIPT|TEMPLATE)$/.test(tag)) continue
        if (tag === 'BR') {
          addRun('\n', f)
          continue
        }
        if (tag === 'IMG') continue
        if (tag === 'TABLE') {
          var rows = []
          Array.prototype.forEach.call(c.rows || [], function (tr) {
            rows.push(Array.prototype.map.call(tr.cells, function (td) { return td.innerText != null ? td.textContent.trim().replace(/\s+/g, ' ') : '' }))
          })
          if (rows.length) out.push({ table: rows, header: !!c.querySelector('th') })
          cur = null
          continue
        }
        if (BLOCK.test(tag)) {
          var opts = {}
          var hm = /^H([1-6])$/.exec(tag)
          if (hm) opts.style = doc.ensureStyle('heading ' + hm[1])
          if (tag === 'BLOCKQUOTE') opts.style = doc.ensureStyle('quote')
          if (tag === 'HR') {
            out.push({ opts: { border: true }, runs: [] })
            cur = null
            continue
          }
          if (tag === 'LI') {
            var ol = c.parentNode && c.parentNode.nodeName === 'OL'
            var kind = ol ? 'number' : 'bullet'
            var depth = 0
            for (var a = c.parentNode; a && a !== d.body; a = a.parentNode) if (a.nodeName === 'UL' || a.nodeName === 'OL') depth++
            var key = kind + (ol ? ':' + Array.prototype.indexOf.call(d.querySelectorAll('ol'), c.parentNode) : '')
            if (!listIds[key]) listIds[key] = doc.addList(kind === 'bullet' ? 'bullet' : 'decimal')
            opts.numId = listIds[key]
            opts.ilvl = Math.max(0, depth - 1)
            opts.style = doc.ensureStyle('list paragraph')
          }
          var containsBlock = Array.prototype.some.call(c.children, function (x) { return BLOCK.test(x.nodeName) && x.nodeName !== 'LI' })
          if (tag === 'UL' || tag === 'OL' || tag === 'TR' || (containsBlock && tag !== 'LI')) {
            cur = null
            walk(c, fmtOf(c, f), pre)
            cur = null
            continue
          }
          startPara(opts)
          walk(c, fmtOf(c, f), pre || tag === 'PRE')
          cur = null
          continue
        }
        walk(c, fmtOf(c, f), pre)
      }
    }
    walk(d.body, {}, false)
    var blocks = []
    out.forEach(function (b) {
      if (b.table) {
        blocks.push(doc.newTable(b.table, { header: b.header }))
        return
      }
      var runs = b.runs.filter(function (x) { return x.text })
      // 去掉段尾的空白和换行
      while (runs.length && /^\s*$/.test(runs[runs.length - 1].text)) runs.pop()
      if (!runs.length && !b.opts.border) return
      var p = doc.newPara('', b.opts)
      runs.forEach(function (x) {
        var rp = M.wel(doc.xml, 'rPr')
        var f = x.f || {}
        if (f.b) M.ensureW(rp, 'b', M.RPR_ORDER)
        if (f.i) M.ensureW(rp, 'i', M.RPR_ORDER)
        if (f.s) M.ensureW(rp, 'strike', M.RPR_ORDER)
        if (f.color) M.setW(M.ensureW(rp, 'color', M.RPR_ORDER), 'val', f.color.toUpperCase())
        if (f.u) M.setW(M.ensureW(rp, 'u', M.RPR_ORDER), 'val', 'single')
        if (f.sup || f.sub) M.setW(M.ensureW(rp, 'vertAlign', M.RPR_ORDER), 'val', f.sup ? 'superscript' : 'subscript')
        var text = x.text
        if (f.code) text = '`' + text.replace(/`/g, '') + '`'
        if (f.link) text = '[' + text.replace(/[\[\]]/g, '') + '](' + f.link + ')'
        doc.appendRuns(p, text, rp, !!(f.code || f.link))
      })
      blocks.push(p)
    })
    return blocks
  }

  /* ---------------- 表格 ---------------- */

  function cellAt() {
    var r = Ed.selRange()
    if (!r) return null
    var p = Ed.paraOf(r.startContainer)
    var td = p ? p.closest('td') : null
    if (!td || !docEl.contains(td)) return null
    var table = td.closest('table.tbl')
    return { td: td, tr: td.parentNode, table: table, tc: td._x, trX: td.parentNode._x, tbl: table._x }
  }
  function cellsOfRow(trX) {
    var col = 0
    return kids(trX, 'tc').map(function (tc) {
      var span = M.wnum(OX.path(tc, 'tcPr', 'gridSpan'), 'val', 1)
      var c = { tc: tc, col: col, span: span }
      col += span
      return c
    })
  }
  function gridCol(tc) {
    var c = cellsOfRow(tc.parentNode).filter(function (x) { return x.tc === tc })[0]
    return c ? c : { col: 0, span: 1 }
  }
  function emptyCellLike(tc) {
    var doc = S.doc.xml
    var n = tc.cloneNode(false)
    var tcPr = kid(tc, 'tcPr')
    if (tcPr) {
      var c = tcPr.cloneNode(true)
      OX.removeKid(c, 'vMerge')
      OX.removeKid(c, 'gridSpan')
      n.appendChild(c)
    }
    var p0 = kid(tc, 'p')
    var p = M.wel(doc, 'p')
    if (p0 && kid(p0, 'pPr')) p.appendChild(kid(p0, 'pPr').cloneNode(true))
    n.appendChild(p)
    return n
  }
  function fixWidths(tbl) {
    var grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map(function (g) { return M.wnum(g, 'w', 0) })
    kids(tbl, 'tr').forEach(function (tr) {
      cellsOfRow(tr).forEach(function (c) {
        var w = 0
        for (var i = c.col; i < c.col + c.span; i++) w += grid[i] || 0
        var tcPr = M.ensureW(c.tc, 'tcPr', ['tcPr'])
        if (c.tc.firstChild !== tcPr) c.tc.insertBefore(tcPr, c.tc.firstChild)
        var tcW = M.ensureW(tcPr, 'tcW', M.TCPR_ORDER)
        M.setW(tcW, 'w', Math.round(w))
        M.setW(tcW, 'type', 'dxa')
      })
    })
  }
  function rerenderTable(table, focusTc, cellIndexHint) {
    S.doc.touch()
    var n = R.renderBlock(table._x, Ed.ctxOf(table))
    table.replaceWith(n)
    Ed.numberAll()
    if (focusTc) {
      var td = Array.prototype.filter.call(n.querySelectorAll('td'), function (x) { return x._x === focusTc })[0]
      var p = td && td.querySelector('p.p')
      if (p) Ed.setPos({ pi: Ed.paras().indexOf(p), off: 0 })
    }
    Ed.commit()
    return n
  }
  function insertRow(below) {
    var c = cellAt()
    if (!c) return
    Ed.flushTyping()
    var nr = c.trX.cloneNode(false)
    var trPr = kid(c.trX, 'trPr')
    if (trPr) {
      var tp = trPr.cloneNode(true)
      OX.removeKid(tp, 'tblHeader')
      nr.appendChild(tp)
    }
    kids(c.trX, 'tc').forEach(function (tc) {
      var nc = emptyCellLike(tc)
      var span = OX.path(tc, 'tcPr', 'gridSpan')
      if (span) M.ensureW(kid(nc, 'tcPr'), 'gridSpan', M.TCPR_ORDER).replaceWith(span.cloneNode(true))
      nr.appendChild(nc)
    })
    // 行内容里的其他元素（书签等）不复制
    c.tbl.insertBefore(nr, below ? c.trX.nextSibling : c.trX)
    rerenderTable(c.table, kids(nr, 'tc')[0])
  }
  function deleteRow() {
    var c = cellAt()
    if (!c) return
    Ed.flushTyping()
    var rows = kids(c.tbl, 'tr')
    if (rows.length <= 1) return deleteTable()
    var i = rows.indexOf(c.trX)
    // 纵向合并从这一行开始的：让下一行接着开始
    var next = rows[i + 1]
    if (next) {
      cellsOfRow(c.trX).forEach(function (cell) {
        var vm = OX.path(cell.tc, 'tcPr', 'vMerge')
        if (!vm || (M.wattr(vm, 'val') || 'continue') !== 'restart') return
        var below = cellsOfRow(next).filter(function (x) { return x.col === cell.col })[0]
        var bvm = below && OX.path(below.tc, 'tcPr', 'vMerge')
        if (bvm && (M.wattr(bvm, 'val') || 'continue') === 'continue') M.setW(bvm, 'val', 'restart')
      })
    }
    c.tbl.removeChild(c.trX)
    var target = rows[i + 1] || rows[i - 1]
    rerenderTable(c.table, kids(target, 'tc')[0])
  }
  function insertCol(right) {
    var c = cellAt()
    if (!c) return
    Ed.flushTyping()
    var gc = gridCol(c.tc)
    var g = right ? gc.col + gc.span : gc.col
    var gridEl = kid(c.tbl, 'tblGrid')
    var cols = kids(gridEl, 'gridCol')
    var total = cols.reduce(function (a, x) { return a + M.wnum(x, 'w', 0) }, 0) || S.doc.textWidthEmu() / 635
    var n = cols.length
    var neww = total / (n + 1)
    cols.forEach(function (x) {
      M.setW(x, 'w', Math.round((M.wnum(x, 'w', 0) * n) / (n + 1)))
    })
    var ng = M.wel(S.doc.xml, 'gridCol', { w: Math.round(neww) })
    gridEl.insertBefore(ng, cols[g] || null)
    var focus = null
    kids(c.tbl, 'tr').forEach(function (tr) {
      var cells = cellsOfRow(tr)
      var at = cells.filter(function (x) { return x.col === g })[0]
      var inside = cells.filter(function (x) { return x.col < g && x.col + x.span > g })[0]
      if (inside) {
        M.setW(M.ensureW(M.ensureW(inside.tc, 'tcPr', ['tcPr']), 'gridSpan', M.TCPR_ORDER), 'val', inside.span + 1)
        return
      }
      var like = at ? at.tc : cells.length ? cells[cells.length - 1].tc : null
      var nc = like ? emptyCellLike(like) : S.doc.newCell('', 0)
      // 纵向合并的列：新列不合并
      tr.insertBefore(nc, at ? at.tc : cells.length ? cells[cells.length - 1].tc.nextSibling : null)
      if (tr === c.trX) focus = nc
    })
    fixWidths(c.tbl)
    rerenderTable(c.table, focus)
  }
  function deleteCol() {
    var c = cellAt()
    if (!c) return
    Ed.flushTyping()
    var gc = gridCol(c.tc)
    var g = gc.col
    var gridEl = kid(c.tbl, 'tblGrid')
    var cols = kids(gridEl, 'gridCol')
    if (cols.length <= 1) return deleteTable()
    var total = cols.reduce(function (a, x) { return a + M.wnum(x, 'w', 0) }, 0)
    var removedW = cols[g] ? M.wnum(cols[g], 'w', 0) : 0
    if (cols[g]) gridEl.removeChild(cols[g])
    var rest = kids(gridEl, 'gridCol')
    var restTotal = total - removedW
    if (restTotal > 0)
      rest.forEach(function (x) {
        M.setW(x, 'w', Math.round((M.wnum(x, 'w', 0) * total) / restTotal))
      })
    var focus = null
    kids(c.tbl, 'tr').forEach(function (tr) {
      var cells = cellsOfRow(tr)
      var hit = cells.filter(function (x) { return x.col <= g && x.col + x.span > g })[0]
      if (!hit) return
      if (hit.span > 1) M.setW(OX.path(hit.tc, 'tcPr', 'gridSpan'), 'val', hit.span - 1)
      else {
        var idx = cells.indexOf(hit)
        tr.removeChild(hit.tc)
        if (tr === c.trX) {
          var nb = cells[idx + 1] || cells[idx - 1]
          focus = nb ? nb.tc : null
        }
      }
      if (!kids(tr, 'tc').length) c.tbl.removeChild(tr)
    })
    if (!kids(c.tbl, 'tr').length) return deleteTable()
    fixWidths(c.tbl)
    rerenderTable(c.table, focus)
  }
  function deleteTable() {
    var c = cellAt()
    if (!c) return
    Ed.flushTyping()
    var table = c.table
    var parentX = c.tbl.parentNode
    var list = Ed.paras()
    var before = table.previousElementSibling
    var after = table.nextElementSibling
    Ed.removeBlock(table)
    // 容器里至少要有一个段落
    var parentH = after ? after.parentNode : before ? before.parentNode : null
    if (!kids(parentX, 'p').length && !kids(parentX, 'tbl').length) {
      var p = M.wel(S.doc.xml, 'p')
      parentX.insertBefore(p, kid(parentX, 'sectPr'))
      var hp = R.renderPara(p, Ed.ctxFor())
      if (parentH) parentH.appendChild(hp)
      else docEl.appendChild(hp)
    }
    S.doc.touch()
    Ed.numberAll()
    var target = after && after.matches('p.p') ? after : before && before.matches('p.p') ? before : Ed.paras()[0]
    if (target) Ed.setPos({ pi: Ed.paras().indexOf(target), off: 0 })
    Ed.commit()
  }
  function insertTable(rows, cols) {
    Ed.flushTyping()
    var data = []
    for (var i = 0; i < rows; i++) {
      var row = []
      for (var j = 0; j < cols; j++) row.push('')
      data.push(row)
    }
    var tbl = S.doc.newTable(data)
    // 表格后面要有一个段落（光标能移出表格）
    var after = S.doc.newPara('')
    var last = Ed.insertBlocks([tbl, after])
    var tableEl = last && last.previousElementSibling
    var p = tableEl && tableEl.querySelector('p.p')
    if (p) Ed.setPos({ pi: Ed.paras().indexOf(p), off: 0 })
    Ed.commit()
  }
  function cellNav(td, dir) {
    var table = td.closest('table.tbl')
    var tds = Array.prototype.filter.call(table.querySelectorAll('td'), function (x) { return x.closest('table.tbl') === table })
    var i = tds.indexOf(td) + dir
    if (i >= tds.length) {
      insertRow(true)
      return
    }
    if (i < 0) return
    var p = tds[i].querySelector('p.p')
    if (!p) return
    var pi = Ed.paras().indexOf(p)
    var last = tds[i].querySelectorAll('p.p')
    var lp = last[last.length - 1]
    Ed.setPos({ a: { pi: pi, off: 0 }, b: { pi: Ed.paras().indexOf(lp), off: Ed.count(lp) } })
  }

  /* ---------------- 图片 ---------------- */

  function pickImage() {
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml' })
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) insertImageFile(input.files[0])
    })
    input.click()
  }
  function extFor(type, name) {
    var m = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'png', 'image/webp': 'png' }
    if (m[type]) return m[type]
    var e = OX.extOf(name || '')
    return e === 'jpg' ? 'jpeg' : e || 'png'
  }
  async function toPng(blob) {
    var url = URL.createObjectURL(blob)
    try {
      var img = await new Promise(function (res, rej) {
        var i = new Image()
        i.onload = function () { res(i) }
        i.onerror = rej
        i.src = url
      })
      var c = document.createElement('canvas')
      c.width = img.naturalWidth || 400
      c.height = img.naturalHeight || 300
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      var out = await new Promise(function (res) { c.toBlob(res, 'image/png') })
      return new Uint8Array(await out.arrayBuffer())
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  async function imageSize(bytes, mime) {
    var url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    try {
      return await new Promise(function (res) {
        var img = new Image()
        img.onload = function () { res({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 }) }
        img.onerror = function () { res({ w: 400, h: 300 }) }
        img.src = url
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  /** 准备图片：返回 { rId, cx, cy }（宽度不超过正文宽度；widthPt 指定宽度） */
  async function prepareImage(bytes, type, name, widthPt) {
    var ext = extFor(type, name)
    // WebP / SVG 旧版 Word 打不开，转成 PNG
    if (type === 'image/webp' || type === 'image/svg+xml' || /\.(webp|svg)$/i.test(name || '')) {
      bytes = await toPng(new Blob([bytes], { type: type || (/svg$/i.test(name) ? 'image/svg+xml' : 'image/webp') }))
      ext = 'png'
    }
    var size = await imageSize(bytes, OX.MIME[ext] || 'image/png')
    var EMU = 9525
    var cx = size.w * EMU
    var cy = size.h * EMU
    var max = S.doc.textWidthEmu()
    if (widthPt) {
      var k = (widthPt * 12700) / cx
      cx *= k
      cy *= k
    } else if (cx > max) {
      cy *= max / cx
      cx = max
    }
    var rId = S.doc.addImage(bytes, ext)
    return { rId: rId, cx: cx, cy: cy }
  }
  async function insertImageFile(file) {
    if (!S.doc) return
    var pos = Ed.savePos()
    var bytes = new Uint8Array(await file.arrayBuffer())
    var img = await prepareImage(bytes, file.type, file.name)
    var run = S.doc.pictureRun(img.rId, img.cx, img.cy, file.name)
    if (pos) Ed.setPos(pos, true)
    Ed.flushTyping()
    var r = Ed.selRange()
    if (!r) {
      var list = Ed.paras()
      var lp = list[list.length - 1]
      Ed.setPos({ pi: list.length - 1, off: Ed.count(lp) }, true)
    } else if (!r.collapsed) Ed.setPos(Ed.deleteRange(r))
    var a = h('span', { class: 'x obj pic', contenteditable: 'false' })
    a.dataset.x = R.reg.put([run])
    Ed.insertNode(a)
    Ed.commit()
  }

  // 选中图片后的缩放控点
  var imgSel = null
  function showImgSel(atom) {
    var img = atom.querySelector('img')
    if (!img) return hideImgSel()
    imgSel = { atom: atom, img: img }
    placeImgSel()
    $('imgsel').hidden = false
  }
  function placeImgSel() {
    if (!imgSel || !imgSel.img.isConnected) return hideImgSel()
    var wrap = $('wrap')
    var wr = wrap.getBoundingClientRect()
    var r = imgSel.img.getBoundingClientRect()
    var box = $('imgsel')
    box.style.left = r.left - wr.left + wrap.scrollLeft + 'px'
    box.style.top = r.top - wr.top + wrap.scrollTop + 'px'
    box.style.width = r.width + 'px'
    box.style.height = r.height + 'px'
  }
  function hideImgSel() {
    imgSel = null
    var b = $('imgsel')
    if (b) b.hidden = true
  }
  function startImgResize(e) {
    if (!imgSel) return
    e.preventDefault()
    e.stopPropagation()
    var img = imgSel.img
    var atom = imgSel.atom
    var r0 = img.getBoundingClientRect()
    var w0 = parseFloat(img.style.width) || img.offsetWidth * 0.75
    var h0 = parseFloat(img.style.height) || img.offsetHeight * 0.75
    var x0 = e.clientX
    var k = 1
    var move = function (ev) {
      k = Math.max(0.05, (r0.width + (ev.clientX - x0)) / r0.width)
      img.style.width = w0 * k + 'pt'
      img.style.height = h0 * k + 'pt'
      placeImgSel()
    }
    var up = function () {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (Math.abs(k - 1) < 0.005) return
      var nodes = R.reg.get(atom.dataset.x)
      if (!nodes) return
      var run = nodes[0].cloneNode(true)
      var max = S.doc.textWidthEmu() * 1.5
      OX.desc(run, 'extent').concat(OX.desc(run, 'ext')).forEach(function (ex) {
        var cx = Number(ex.getAttribute('cx'))
        var cy = Number(ex.getAttribute('cy'))
        if (!cx) return
        var nk = Math.min(k, max / cx)
        ex.setAttribute('cx', Math.round(cx * nk))
        ex.setAttribute('cy', Math.round(cy * nk))
      })
      atom.dataset.x = R.reg.put([run].concat(nodes.slice(1)))
      var p = Ed.paraOf(atom)
      if (p) {
        Ed.sync(p)
        var pi = Ed.paras().indexOf(p)
        var np = Ed.rerender(p)
        hideImgSel()
        Ed.commit()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /* ---------------- 超链接、分页符 ---------------- */

  function linkAt() {
    var r = Ed.selRange()
    if (!r) return null
    var el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode
    var a = el.closest('a.c.hyperlink')
    return a && docEl.contains(a) ? a : null
  }
  function linkPop(anchor) {
    var cur = linkAt()
    var input = h('input', { class: 'pop-input', type: 'text', placeholder: 'https://', value: cur ? cur.dataset.href || '' : '' })
    var saved = Ed.savePos()
    var ok = function () {
      var url = input.value.trim()
      closePop()
      Ed.setPos(saved, true)
      if (!url) return
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^#/.test(url)) url = (/@/.test(url) && !/\//.test(url) ? 'mailto:' : 'https://') + url
      applyLink(url)
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        ok()
      }
      e.stopPropagation()
    })
    openPop(anchor, h('div', { class: 'linkpop' }, h('div', { class: 'pop-title', text: t('超链接地址', 'Link address') }), input, h('div', { class: 'pop-row' }, cur ? h('button', { class: 'mi', onClick: function () { closePop(); removeLink(cur) } }, t('删除链接', 'Remove link')) : null, h('button', { class: 'btn-primary', onClick: ok }, t('确定', 'OK')))))
    setTimeout(function () { input.focus(); input.select() }, 0)
  }
  function applyLink(url) {
    var doc = S.doc
    var cur = linkAt()
    if (cur) {
      // 已经在链接里：只改地址
      var el = R.reg.get(cur.dataset.c).cloneNode(false)
      el.removeAttributeNS(OX.NS.r, 'id')
      M.setW(el, 'anchor', null)
      if (/^#/.test(url)) M.setW(el, 'anchor', url.slice(1))
      else el.setAttributeNS(OX.NS.r, 'r:id', doc.addLink(url))
      cur.dataset.c = R.reg.put(el)
      var p0 = Ed.paraOf(cur)
      Ed.sync(p0)
      Ed.rerender(p0)
      Ed.commit()
      return
    }
    var r = Ed.selRange()
    if (!r) return
    if (r.collapsed) {
      Ed.flushTyping()
      var p1 = Ed.paraOf(r.startContainer)
      var off = Ed.offsetIn(p1, r.startContainer, r.startOffset)
      Ed.insertText(url.replace(/^mailto:/, ''))
      var pi = Ed.paras().indexOf(p1)
      Ed.setPos({ a: { pi: pi, off: off }, b: { pi: pi, off: off + url.replace(/^mailto:/, '').length } }, true)
      r = Ed.selRange()
    }
    var ps = Ed.parasIn(r)
    if (ps.length !== 1) return studio.toast(t('超链接只能加在同一个段落里的文字上', 'Links can only be added within one paragraph'))
    var p = ps[0]
    var pos = Ed.savePos()
    var e = Ed.splitUpTo(r.endContainer, r.endOffset, p)
    var s = Ed.splitUpTo(r.startContainer, r.startOffset, p)
    var hl = M.wel(doc.xml, 'hyperlink')
    if (/^#/.test(url)) M.setW(hl, 'anchor', url.slice(1))
    else hl.setAttributeNS(OX.NS.r, 'r:id', doc.addLink(url))
    var a = h('a', { class: 'c hyperlink' })
    a.dataset.c = R.reg.put(hl)
    var nodes = []
    for (var n = s.ref; n && n !== e.ref; n = n.nextSibling) nodes.push(n)
    if (!nodes.length) return
    p.insertBefore(a, nodes[0])
    nodes.forEach(function (n) { a.appendChild(n) })
    // 链接文字用“超链接”字符样式
    var hs = doc.ensureStyle('hyperlink')
    Array.prototype.forEach.call(a.querySelectorAll('span.r'), function (sp) {
      var base = R.reg.get(sp.dataset.r)
      var rp = base ? base.cloneNode(true) : M.wel(doc.xml, 'rPr')
      OX.removeKid(rp, 'rStyle')
      OX.removeKid(rp, 'color')
      OX.removeKid(rp, 'u')
      if (hs) M.setW(M.ensureW(rp, 'rStyle', M.RPR_ORDER), 'val', hs)
      sp.dataset.r = R.reg.putR(rp)
    })
    Array.prototype.slice.call(a.childNodes).forEach(function (c) {
      if (c.nodeType === 3) {
        var rp = M.wel(doc.xml, 'rPr')
        if (hs) M.setW(M.ensureW(rp, 'rStyle', M.RPR_ORDER), 'val', hs)
        var sp = Ed.newSpan(R.reg.putR(rp), p, c.data)
        a.replaceChild(sp, c)
      }
    })
    Ed.sync(p)
    Ed.rerender(p)
    Ed.setPos(pos, true)
    Ed.commit()
  }
  function removeLink(a) {
    var p = Ed.paraOf(a)
    if (!p) return
    var hs = S.doc.ensureStyle('hyperlink')
    Array.prototype.forEach.call(a.querySelectorAll('span.r'), function (sp) {
      var base = R.reg.get(sp.dataset.r)
      if (!base) return
      var rp = base.cloneNode(true)
      if (M.wattr(kid(rp, 'rStyle'), 'val') === hs) OX.removeKid(rp, 'rStyle')
      sp.dataset.r = R.reg.putR(rp)
    })
    while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a)
    a.remove()
    Ed.sync(p)
    Ed.rerender(p)
    Ed.commit()
  }
  function openLink(a) {
    var href = a.dataset.href || ''
    if (/^#/.test(href)) {
      var name = href.slice(1)
      var bm = null
      OX.desc(S.doc.body(), 'bookmarkStart').forEach(function (b) {
        if (!bm && M.wattr(b, 'name') === name) bm = b
      })
      var p = bm && bm.closest ? bm.closest('p') : null
      if (p) {
        var hp = Ed.paras().filter(function (x) { return x._x === p })[0]
        if (hp) Ed.setPos({ pi: Ed.paras().indexOf(hp), off: 0 })
      }
      return
    }
    if (/^(https?:|mailto:)/i.test(href)) studio.ui.openExternal(href).catch(function (e) { studio.toast(e.message) })
  }
  function insertPageBreak() {
    Ed.flushTyping()
    var r = Ed.selRange()
    if (!r) return
    if (!r.collapsed) Ed.setPos(Ed.deleteRange(r))
    var run = M.wel(S.doc.xml, 'r')
    run.appendChild(M.wel(S.doc.xml, 'br', { type: 'page' }))
    var a = h('span', { class: 'x pgbr', contenteditable: 'false' })
    a.dataset.x = R.reg.put([run])
    Ed.insertNode(a)
    // 分页符后面另起一段
    Ed.splitPara()
    Ed.commit()
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
          class: 'mi' + (m.on ? ' on' : ''),
          disabled: m.disabled ? true : null,
          onMousedown: function (e) { e.preventDefault() },
          onClick: function () {
            closePop()
            m.run()
          }
        }, h('span', { text: m.label, style: m.style || null }), m.key ? h('kbd', { text: m.key }) : null)
      )
    })
    return openPop(anchor, list, at)
  }

  var STANDARD = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0']
  var HL = ['#FFFF00', '#00FF00', '#00FFFF', '#FF00FF', '#0000FF', '#FF0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#C0C0C0', '#000000']
  function themeColors() {
    var keys = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
    var c = S.doc ? S.doc.theme().colors : {}
    var defs = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
    return keys.map(function (k, i) { return '#' + (c[k] || defs[i]) })
  }
  function mix(hex, k, toWhite) {
    var n = parseInt(hex.slice(1), 16)
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      return Math.round(toWhite ? v + (255 - v) * k : v * (1 - k))
    })
    return '#' + rgb.map(function (v) { return ('0' + v.toString(16)).slice(-2) }).join('')
  }
  function colorMenu(anchor, onPick, opts) {
    opts = opts || {}
    var saved = Ed.savePos()
    var pick = function (c) {
      closePop()
      Ed.setPos(saved, true)
      onPick(c)
    }
    var wrap = h('div', { class: 'colors' })
    var row = function (title, list) {
      if (title) wrap.appendChild(h('div', { class: 'pop-title', text: title }))
      var g = h('div', { class: 'swatches' })
      list.forEach(function (c) {
        g.appendChild(h('button', { class: 'sw', title: c, style: { background: c }, onMousedown: function (e) { e.preventDefault() }, onClick: function () { pick(c) } }))
      })
      wrap.appendChild(g)
    }
    if (opts.highlight) {
      row(t('突出显示', 'Highlight'), HL)
    } else {
      var tc = themeColors()
      row(t('主题颜色', 'Theme colors'), tc)
      row(null, tc.map(function (c) { return mix(c, 0.6, true) }))
      row(null, tc.map(function (c) { return mix(c, 0.4, false) }))
      row(t('标准色', 'Standard colors'), STANDARD)
    }
    var foot = h('div', { class: 'cfoot' })
    foot.appendChild(h('button', { class: 'mi', onMousedown: function (e) { e.preventDefault() }, onClick: function () { pick(null) } }, opts.highlight ? t('无颜色', 'No color') : t('自动', 'Automatic')))
    if (!opts.highlight) {
      var input = h('input', { type: 'color', value: '#3366cc' })
      input.addEventListener('change', function () { pick(input.value) })
      foot.appendChild(h('label', { class: 'mi custom' }, t('其他颜色…', 'More colors…'), input))
    }
    wrap.appendChild(foot)
    openPop(anchor, wrap)
  }

  function tableMenu(anchor) {
    var N = 8
    var saved = Ed.savePos()
    var label = h('div', { class: 'pop-title', text: t('插入表格', 'Insert table') })
    var grid = h('div', { class: 'tgrid' })
    var cells = []
    for (var r = 0; r < N; r++)
      for (var c = 0; c < N; c++) {
        ;(function (r, c) {
          var cell = h('div', {
            class: 'tc',
            onMouseenter: function () {
              cells.forEach(function (x) { x.el.classList.toggle('on', x.r <= r && x.c <= c) })
              label.textContent = t('插入表格', 'Insert table') + '  ' + (r + 1) + ' × ' + (c + 1)
            },
            onMousedown: function (e) { e.preventDefault() },
            onClick: function () {
              closePop()
              Ed.setPos(saved, true)
              insertTable(r + 1, c + 1)
            }
          })
          cells.push({ el: cell, r: r, c: c })
          grid.appendChild(cell)
        })(r, c)
      }
    var box = h('div', null, label, grid)
    if (cellAt()) {
      // 光标在表格里：下面再列出行列操作
      var list = h('div', { class: 'menu', style: { marginTop: '6px' } })
      list.appendChild(h('div', { class: 'msep' }))
      tableOps().forEach(function (m) {
        if (m === '-') list.appendChild(h('div', { class: 'msep' }))
        else list.appendChild(h('button', { class: 'mi', onMousedown: function (e) { e.preventDefault() }, onClick: function () { closePop(); Ed.setPos(saved, true); m.run() } }, m.label))
      })
      box.appendChild(list)
    }
    openPop(anchor, box)
  }
  function tableOps() {
    return [
      { label: t('在上方插入行', 'Insert row above'), run: function () { insertRow(false) } },
      { label: t('在下方插入行', 'Insert row below'), run: function () { insertRow(true) } },
      { label: t('在左侧插入列', 'Insert column left'), run: function () { insertCol(false) } },
      { label: t('在右侧插入列', 'Insert column right'), run: function () { insertCol(true) } },
      '-',
      { label: t('删除行', 'Delete row'), run: deleteRow },
      { label: t('删除列', 'Delete column'), run: deleteCol },
      { label: t('删除表格', 'Delete table'), run: deleteTable }
    ]
  }

  function spacingMenu(anchor) {
    var st = Ed.propsAtSel()
    var sp = st && st.pprops.spacing ? st.pprops.spacing : {}
    var curLine = sp.line && (sp.lineRule || 'auto') === 'auto' ? Number(sp.line) / 240 : null
    var items = [1, 1.15, 1.5, 2, 2.5, 3].map(function (m) {
      return { label: String(m), on: curLine != null && Math.abs(curLine - m) < 0.01, run: function () { Ed.setLineSpacing(m) } }
    })
    items.push('-')
    var before = Number(sp.before || 0) / 20
    var after = Number(sp.after || 0) / 20
    items.push({ label: before ? t('删除段前间距', 'Remove space before') : t('段前增加 12 磅', 'Add 12pt before'), run: function () { Ed.setParaSpacing('before', before ? 0 : 12) } })
    items.push({ label: after ? t('删除段后间距', 'Remove space after') : t('段后增加 8 磅', 'Add 8pt after'), run: function () { Ed.setParaSpacing('after', after ? 0 : 8) } })
    var saved = Ed.savePos()
    items.forEach(function (m) {
      if (m === '-') return
      var run = m.run
      m.run = function () { Ed.setPos(saved, true); run() }
    })
    menu(anchor, items)
  }

  function onContext(e) {
    if (!docEl.contains(e.target)) return
    e.preventDefault()
    var r = Ed.selRange()
    var has = r && !r.collapsed
    var a = e.target.closest('a.c.hyperlink')
    var items = [
      { label: t('剪切', 'Cut'), key: 'Ctrl+X', disabled: !has, run: function () { document.execCommand('cut') } },
      { label: t('复制', 'Copy'), key: 'Ctrl+C', disabled: !has, run: function () { document.execCommand('copy') } },
      { label: t('粘贴', 'Paste'), key: 'Ctrl+V', run: function () { studio.toast(t('请按 Ctrl+V 粘贴', 'Press Ctrl+V to paste')) } }
    ]
    if (a) {
      items.push('-')
      items.push({ label: t('打开链接', 'Open link'), run: function () { openLink(a) } })
      items.push({ label: t('编辑链接…', 'Edit link…'), run: function () { linkPop(B.link) } })
      items.push({ label: t('删除链接', 'Remove link'), run: function () { removeLink(a) } })
    } else {
      items.push('-')
      items.push({ label: t('超链接…', 'Link…'), run: function () { linkPop(B.link) } })
    }
    if (cellAt()) {
      items.push('-')
      tableOps().forEach(function (m) { items.push(m) })
    }
    if (studio.has && studio.has('agent.send') && has) {
      items.push('-')
      items.push({ label: t('发给 AI 助手', 'Send to AI assistant'), run: sendSelectionToAI })
    }
    menu(null, items, { x: e.clientX, y: e.clientY })
  }
  function sendSelectionToAI() {
    var r = Ed.selRange()
    var text = r ? r.toString() : ''
    studio.agent.send((text ? '> ' + text.replace(/\n/g, '\n> ') + '\n' : ''), { file: true }).catch(function (e) { studio.toast(e.message) })
  }

  /* ---------------- 工具栏 ---------------- */

  function ico(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'
  }
  var I = {
    undo: ico('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    redo: ico('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
    bold: ico('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
    italic: ico('<path d="M14 5h-4M14 19h-4M15 5l-6 14"/>'),
    underline: ico('<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>'),
    strike: ico('<path d="M4 12h16M16 6.5C15.3 5 13.8 4 12 4c-2.5 0-4 1.3-4 3.2 0 1.2.6 2 1.7 2.6M8 17.5c.7 1.5 2.2 2.5 4 2.5 2.5 0 4-1.3 4-3.2 0-.7-.2-1.3-.6-1.8"/>'),
    sup: ico('<path d="m4 7 8 10M12 7l-8 10M16 9c0-1.2 1-2 2-2s2 .7 2 1.7c0 1.8-4 2.3-4 4.3h4"/>'),
    sub: ico('<path d="m4 5 8 10M12 5 4 15M16 15c0-1.2 1-2 2-2s2 .7 2 1.7c0 1.8-4 2.3-4 4.3h4"/>'),
    color: ico('<path d="m6 16 6-12 6 12M8 12h8"/><path d="M4 20h16" stroke-width="3" class="swatch"/>'),
    highlight: ico('<path d="m9 11-5 5v3h3l5-5"/><path d="m14 6 4 4-6 6-4-4z"/><path d="M14 20h7" stroke-width="3" class="swatch"/>'),
    clear: ico('<path d="M6 5h12M12 5l-3 14M15 13l5 5M20 13l-5 5"/>'),
    left: ico('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    center: ico('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    right: ico('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
    justify: ico('<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>'),
    bullets: ico('<circle cx="5" cy="6" r="1.2" fill="currentColor"/><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="5" cy="18" r="1.2" fill="currentColor"/><path d="M10 6h10M10 12h10M10 18h10"/>'),
    numbers: ico('<path d="M10 6h10M10 12h10M10 18h10M4 4.5l1.5-1V9M3.5 15.2c0-.7.6-1.2 1.3-1.2s1.2.4 1.2 1c0 1.1-2.5 1.4-2.5 3h2.6"/>'),
    outdent: ico('<path d="M11 6h9M11 12h9M11 18h9M7 9l-3 3 3 3"/>'),
    indent: ico('<path d="M11 6h9M11 12h9M11 18h9M4 9l3 3-3 3"/>'),
    spacing: ico('<path d="M11 6h9M11 12h9M11 18h9M5 4v16M3 6l2-2 2 2M3 18l2 2 2-2"/>'),
    table: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>'),
    image: ico('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
    link: ico('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    pagebreak: ico('<path d="M6 3v5h12V3M6 21v-5h12v5M3 12h2M8 12h2M14 12h2M19 12h2"/>'),
    find: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
    outline: ico('<path d="M4 5h16M8 10h12M8 15h12M12 20h8"/>'),
    zoomIn: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>'),
    zoomOut: ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>'),
    help: ico('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>'),
    caret: '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 10 5 5 5-5"/></svg>'
  }
  var B = {}
  function btn(id, icon, title, run, opts) {
    opts = opts || {}
    var b = h('button', { class: 'tb-btn' + (opts.drop ? ' drop' : ''), title: title, html: icon + (opts.label ? '<span>' + opts.label + '</span>' : '') + (opts.drop ? I.caret : '') })
    b.addEventListener('mousedown', function (e) {
      // 不要让按钮抢走焦点（选区会丢）
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

  // 字号：中文字号 + 磅值
  var CN_SIZES = [['初号', 42], ['小初', 36], ['一号', 26], ['小一', 24], ['二号', 22], ['小二', 18], ['三号', 16], ['小三', 15], ['四号', 14], ['小四', 12], ['五号', 10.5], ['小五', 9], ['六号', 7.5]]
  var PT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]
  var FONTS_CN = ['宋体', '黑体', '微软雅黑', '等线', '楷体', '仿宋', '新宋体', '华文中宋']
  var FONTS_EN = ['Calibri', 'Cambria', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Segoe UI', 'Consolas', 'Courier New']

  function select(cls, title, onChange) {
    var s = h('select', { class: cls, title: title })
    s.addEventListener('mousedown', function () {
      S.savedPos = Ed.savePos()
    })
    s.addEventListener('change', function () {
      var v = s.value
      if (S.savedPos) Ed.setPos(S.savedPos, true)
      docEl.focus({ preventScroll: true })
      if (v !== '') onChange(v)
      updateBar()
    })
    return s
  }

  function buildBar() {
    var bar = $('bar')
    bar.textContent = ''
    B.style = select('style', t('样式', 'Style'), function (v) {
      if (/^builtin:/.test(v)) v = S.doc.ensureStyle(v.slice(8))
      Ed.setStyle(v)
    })
    B.font = select('font', t('字体', 'Font'), function (v) {
      if (v === '__more') {
        var name = ''
        return fontPop(B.font)
      }
      Ed.setFont(v)
    })
    B.size = select('size', t('字号', 'Font size'), function (v) {
      Ed.setSize(Number(v))
    })
    var zh = t('中', 'en') === '中'
    B.size.appendChild(h('option', { value: '', text: '' }))
    if (zh) CN_SIZES.forEach(function (s) { B.size.appendChild(h('option', { value: s[1], text: s[0] })) })
    PT_SIZES.forEach(function (s) { B.size.appendChild(h('option', { value: s, text: String(s) })) })
    bar.append(
      btn('undo', I.undo, t('撤销 (Ctrl+Z)', 'Undo (Ctrl+Z)'), Ed.undo),
      btn('redo', I.redo, t('重做 (Ctrl+Y)', 'Redo (Ctrl+Y)'), Ed.redo),
      sep(),
      B.style,
      B.font,
      B.size,
      sep(),
      btn('bold', I.bold, t('加粗 (Ctrl+B)', 'Bold (Ctrl+B)'), function () { Ed.toggle('b') }),
      btn('italic', I.italic, t('倾斜 (Ctrl+I)', 'Italic (Ctrl+I)'), function () { Ed.toggle('i') }),
      btn('underline', I.underline, t('下划线 (Ctrl+U)', 'Underline (Ctrl+U)'), function () { Ed.toggle('u') }),
      btn('strike', I.strike, t('删除线', 'Strikethrough'), function () { Ed.toggle('strike') }),
      btn('sup', I.sup, t('上标', 'Superscript'), function () { Ed.toggle('sup') }),
      btn('sub', I.sub, t('下标', 'Subscript'), function () { Ed.toggle('sub') }),
      btn('color', I.color, t('字体颜色', 'Font color'), function (b) { colorMenu(b, Ed.setColor) }, { drop: true }),
      btn('highlight', I.highlight, t('突出显示', 'Highlight'), function (b) { colorMenu(b, Ed.setHighlight, { highlight: true }) }, { drop: true }),
      btn('clear', I.clear, t('清除格式', 'Clear formatting'), Ed.clearFormat),
      sep(),
      btn('left', I.left, t('左对齐 (Ctrl+L)', 'Align left (Ctrl+L)'), function () { Ed.setAlign('left') }),
      btn('center', I.center, t('居中 (Ctrl+E)', 'Center (Ctrl+E)'), function () { Ed.setAlign('center') }),
      btn('right', I.right, t('右对齐 (Ctrl+R)', 'Align right (Ctrl+R)'), function () { Ed.setAlign('right') }),
      btn('justify', I.justify, t('两端对齐 (Ctrl+J)', 'Justify (Ctrl+J)'), function () { Ed.setAlign('both') }),
      sep(),
      btn('bullets', I.bullets, t('项目符号', 'Bullets'), function () { Ed.toggleList('bullet') }),
      btn('numbers', I.numbers, t('编号', 'Numbering'), function () { Ed.toggleList('number') }),
      btn('outdent', I.outdent, t('减少缩进', 'Decrease indent'), function () { Ed.indent(-1) }),
      btn('indent', I.indent, t('增加缩进', 'Increase indent'), function () { Ed.indent(1) }),
      btn('spacing', I.spacing, t('行距和段落间距', 'Line and paragraph spacing'), spacingMenu, { drop: true }),
      sep(),
      btn('table', I.table, t('表格', 'Table'), tableMenu, { drop: true }),
      btn('image', I.image, t('图片', 'Picture'), pickImage),
      btn('link', I.link, t('超链接', 'Link'), linkPop),
      btn('pagebreak', I.pagebreak, t('分页符 (Ctrl+Enter)', 'Page break (Ctrl+Enter)'), insertPageBreak),
      h('div', { class: 'grow' }),
      btn('find', I.find, t('查找和替换 (Ctrl+F)', 'Find and replace (Ctrl+F)'), function () { openFind(false) }),
      btn('outline', I.outline, t('导航窗格', 'Navigation pane'), toggleOutline),
      btn('zoomOut', I.zoomOut, t('缩小 (Ctrl -)', 'Zoom out (Ctrl -)'), function () { zoomBy(1 / 1.1) }),
      (B.zoom = h('button', { class: 'tb-btn zoom', title: t('适应宽度 (Ctrl 0)', 'Fit width (Ctrl 0)'), onMousedown: function (e) { e.preventDefault() }, onClick: function () { setZoom(0) }, text: '100%' })),
      btn('zoomIn', I.zoomIn, t('放大 (Ctrl +)', 'Zoom in (Ctrl +)'), function () { zoomBy(1.1) }),
      btn('help', I.help, t('快捷键', 'Shortcuts'), showHelp)
    )
  }

  function fontPop(anchor) {
    var input = h('input', { class: 'pop-input', type: 'text', placeholder: t('字体名称', 'Font name') })
    var saved = S.savedPos
    var ok = function () {
      var v = input.value.trim()
      closePop()
      if (saved) Ed.setPos(saved, true)
      if (v) Ed.setFont(v)
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') e.preventDefault(), ok()
      e.stopPropagation()
    })
    openPop(anchor, h('div', { class: 'linkpop' }, h('div', { class: 'pop-title', text: t('其他字体', 'Other font') }), input, h('div', { class: 'pop-row' }, h('button', { class: 'btn-primary', onClick: ok }, t('确定', 'OK')))))
    setTimeout(function () { input.focus() }, 0)
  }

  var STYLE_NAMES = {
    normal: '正文', title: '标题', subtitle: '副标题', quote: '引用', 'intense quote': '明显引用', 'list paragraph': '列表段落', 'no spacing': '无间隔',
    'toc heading': 'TOC 标题', caption: '题注', code: '代码', 'footnote text': '脚注文本', header: '页眉', footer: '页脚', 'table paragraph': '表格段落'
  }
  function styleLabel(st) {
    var n = st.name
    var low = n.toLowerCase()
    var m = /^heading (\d)$/.exec(low)
    if (m) return t('标题 ' + m[1], 'Heading ' + m[1])
    if (/^toc \d$/.test(low)) return t('目录 ' + low.slice(4), 'TOC ' + low.slice(4))
    if (STYLE_NAMES[low]) return t(STYLE_NAMES[low], n.replace(/\b\w/g, function (c) { return c.toUpperCase() }))
    return n
  }
  function fillStyles() {
    var s = B.style
    s.textContent = ''
    if (!S.doc) return
    var list = S.doc.paragraphStyles()
    var have = {}
    list.forEach(function (st) {
      have[st.name.toLowerCase()] = 1
    })
    var opts = list.map(function (st) {
      return { value: st.id, label: styleLabel(st), st: st }
    })
    ;['title', 'heading 1', 'heading 2', 'heading 3'].forEach(function (n) {
      if (!have[n]) opts.push({ value: 'builtin:' + n, label: styleLabel({ name: n }) })
    })
    // 排序：正文、标题、标题 1..、其他
    var rank = function (o) {
      var n = (o.st ? o.st.name : o.value.slice(8)).toLowerCase()
      if (o.st && o.st.isDefault) return 0
      if (n === 'title') return 1
      if (n === 'subtitle') return 2
      var m = /^heading (\d)$/.exec(n)
      if (m) return 2 + Number(m[1])
      return 20
    }
    opts.sort(function (a, b) { return rank(a) - rank(b) || a.label.localeCompare(b.label) })
    opts.forEach(function (o) {
      s.appendChild(h('option', { value: o.value, text: o.label }))
    })
    S.styleOpts = opts
  }
  function fillFonts() {
    var s = B.font
    s.textContent = ''
    var seen = {}
    var add = function (f, group) {
      if (!f || seen[f.toLowerCase()]) return
      seen[f.toLowerCase()] = 1
      group.appendChild(h('option', { value: f, text: f, style: { fontFamily: '"' + f + '"' } }))
    }
    s.appendChild(h('option', { value: '', text: '' }))
    var used = h('optgroup', { label: t('文档中的字体', 'Document fonts') })
    var ft = S.doc && S.doc.pkg.root('word/fontTable.xml')
    if (ft)
      kids(ft, 'font').forEach(function (f) {
        var n = M.wattr(f, 'name')
        if (n && !/^(Symbol|Wingdings|Webdings|Marlett)/i.test(n)) add(n, used)
      })
    var cn = h('optgroup', { label: t('中文字体', 'Chinese fonts') })
    FONTS_CN.forEach(function (f) { add(f, cn) })
    var en = h('optgroup', { label: t('西文字体', 'Western fonts') })
    FONTS_EN.forEach(function (f) { add(f, en) })
    ;[used, cn, en].forEach(function (g) {
      if (g.children.length) s.appendChild(g)
    })
    s.appendChild(h('option', { value: '__more', text: t('其他字体…', 'Other font…') }))
  }

  var barRaf = 0
  function updateBar() {
    if (barRaf) return
    barRaf = requestAnimationFrame(function () {
      barRaf = 0
      updateBarNow()
    })
  }
  function updateBarNow() {
    if (!B.undo) return
    B.undo.disabled = S.hi <= 0 && !S.typing
    B.redo.disabled = S.hi >= S.history.length - 1
    var st = S.doc ? Ed.propsAtSel() : null
    var dis = !st
    ;['bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'color', 'highlight', 'clear', 'left', 'center', 'right', 'justify', 'bullets', 'numbers', 'outdent', 'indent', 'spacing'].forEach(function (k) {
      B[k].disabled = dis
    })
    B.style.disabled = B.font.disabled = B.size.disabled = dis
    if (!st) return
    var p = st.props
    B.bold.classList.toggle('on', !!M.on(p.b))
    B.italic.classList.toggle('on', !!M.on(p.i))
    B.underline.classList.toggle('on', !!(p.u && M.wattr(p.u, 'val') !== 'none'))
    B.strike.classList.toggle('on', !!(M.on(p.strike) || M.on(p.dstrike)))
    var va = p.vertAlign ? M.wattr(p.vertAlign, 'val') : null
    B.sup.classList.toggle('on', va === 'superscript')
    B.sub.classList.toggle('on', va === 'subscript')
    var c = S.doc.colorOf(p.color)
    B.color.querySelector('.swatch').style.stroke = c || '#e5534b'
    // 字号
    var sz = p.sz ? M.wnum(p.sz, 'val', 21) / 2 : 10.5
    var opt = Array.prototype.filter.call(B.size.options, function (o) { return o.value !== '' && Number(o.value) === sz })[0]
    if (!opt) {
      var extra = B.size.querySelector('option[data-extra]')
      if (!extra) {
        extra = h('option', { 'data-extra': '1' })
        B.size.insertBefore(extra, B.size.options[1] || null)
      }
      extra.value = sz
      extra.textContent = String(sz)
      B.size.value = String(sz)
    } else B.size.value = opt.value
    // 字体
    var fonts = S.doc.fontsOf(p)
    var zhText = st.p.textContent && /[㐀-鿿]/.test(st.p.textContent)
    var f = (zhText && fonts.length > 1 ? fonts[fonts.length - 1] : fonts[0]) || ''
    if (f && !Array.prototype.some.call(B.font.options, function (o) { return o.value === f })) {
      var x = h('option', { value: f, text: f })
      B.font.insertBefore(x, B.font.options[1] || null)
    }
    B.font.value = f
    // 段落
    var pp = st.pprops
    var sid = pp.styleId
    if (!Array.prototype.some.call(B.style.options, function (o) { return o.value === sid })) {
      var stl = S.doc.style(sid)
      if (stl) B.style.appendChild(h('option', { value: sid, text: styleLabel(stl) }))
    }
    B.style.value = sid || ''
    var jc = pp.jc ? M.wattr(pp.jc, 'val') : 'left'
    B.left.classList.toggle('on', jc === 'left' || jc === 'start')
    B.center.classList.toggle('on', jc === 'center')
    B.right.classList.toggle('on', jc === 'right' || jc === 'end')
    B.justify.classList.toggle('on', jc === 'both' || jc === 'distribute')
    var np = Ed.isListPara(st.p)
    var kind = np ? S.doc.listKind(np.numId) : null
    B.bullets.classList.toggle('on', kind === 'bullet')
    B.numbers.classList.toggle('on', kind === 'number')
  }

  /* ---------------- 查找替换 ---------------- */

  var F = { matches: [], cur: -1 }
  function openFind(replace) {
    var bar = $('find')
    bar.hidden = false
    $('findRepRow').hidden = !replace && $('findRepRow').hidden
    if (replace) $('findRepRow').hidden = false
    var r = Ed.selRange()
    var sel = r && !r.collapsed ? r.toString() : ''
    var input = $('findText')
    if (sel && sel.length < 200 && !/\n/.test(sel)) input.value = sel
    input.focus()
    input.select()
    runFind(true)
  }
  function closeFind() {
    $('find').hidden = true
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete('find')
      CSS.highlights.delete('find-cur')
    }
    F.matches = []
    docEl.focus({ preventScroll: true })
  }
  function findRe() {
    var q = $('findText').value
    if (!q) return null
    var flags = 'g' + ($('findCase').checked ? '' : 'i')
    if ($('findRegex').checked) {
      try {
        return new RegExp(q, flags)
      } catch (e) {
        return null
      }
    }
    return new RegExp(M.escRe(q), flags)
  }
  function runFind(keepCur) {
    F.matches = []
    var re = findRe()
    if (re) {
      Ed.paras().forEach(function (p) {
        var txt = Ed.textOf(p)
        re.lastIndex = 0
        var m
        while ((m = re.exec(txt))) {
          if (!m[0]) {
            re.lastIndex++
            continue
          }
          F.matches.push({ p: p, s: m.index, e: m.index + m[0].length })
          if (F.matches.length > 5000) break
        }
      })
    }
    // 从光标处开始
    if (!keepCur || F.cur >= F.matches.length) F.cur = -1
    if (F.cur < 0 && F.matches.length) {
      var pos = Ed.savePos()
      var list = Ed.paras()
      F.cur = 0
      if (pos)
        for (var i = 0; i < F.matches.length; i++) {
          var pi = list.indexOf(F.matches[i].p)
          if (pi > pos.a.pi || (pi === pos.a.pi && F.matches[i].s >= pos.a.off)) {
            F.cur = i
            break
          }
        }
    }
    paintFind()
  }
  function paintFind() {
    var count = $('findCount')
    if (!window.CSS || !CSS.highlights) return
    var ranges = F.matches.map(function (m) {
      return Ed.rangeIn(m.p, m.s, m.e)
    })
    CSS.highlights.set('find', new Highlight(...ranges))
    if (F.cur >= 0 && ranges[F.cur]) CSS.highlights.set('find-cur', new Highlight(ranges[F.cur]))
    else CSS.highlights.delete('find-cur')
    count.textContent = F.matches.length ? F.cur + 1 + ' / ' + F.matches.length : $('findText').value ? t('无结果', 'No results') : ''
  }
  function findStep(dir, select) {
    if (!F.matches.length) return runFind()
    F.cur = (F.cur + dir + F.matches.length) % F.matches.length
    var m = F.matches[F.cur]
    var r = Ed.rangeIn(m.p, m.s, m.e)
    Ed.scrollToRange(r)
    paintFind()
  }
  function replaceOne() {
    var m = F.matches[F.cur]
    if (!m || !m.p.isConnected) return runFind()
    Ed.flushTyping()
    var rep = $('findRep').value
    var re = findRe()
    var txt = Ed.textOf(m.p).slice(m.s, m.e)
    if ($('findRegex').checked && re) rep = txt.replace(new RegExp(re.source, re.flags.replace('g', '')), rep)
    var r = Ed.rangeIn(m.p, m.s, m.e)
    // 在第一个字符的位置插入新文字（继承它的格式），再删掉原来的
    var sc = r.startContainer, so = r.startOffset
    if (sc.nodeType === 3) {
      sc.insertData(so, rep)
      var r2 = Ed.rangeIn(m.p, m.s + rep.length, m.e + rep.length)
      r2.deleteContents()
    } else {
      r.deleteContents()
      var pi = Ed.paras().indexOf(m.p)
      Ed.setPos({ pi: pi, off: m.s }, true)
      Ed.insertText(rep)
    }
    var p = m.p
    Ed.sync(p)
    Ed.rerender(p)
    Ed.commit()
    runFind(true)
  }
  function replaceAll() {
    var re = findRe()
    if (!re) return
    Ed.flushTyping()
    var rep = $('findRep').value
    var n = 0
    var all = OX.desc(S.doc.body(), 'p')
    all.forEach(function (p) {
      n += M.replaceInPara(p, new RegExp(re.source, re.flags), $('findRegex').checked ? rep : function () { return rep })
    })
    if (n) {
      S.doc.touch()
      var scroll = $('wrap').scrollTop
      Ed.renderAll()
      $('wrap').scrollTop = scroll
      Ed.commit()
    }
    studio.toast(t('已替换 {0} 处', 'Replaced {0} occurrence(s)').replace('{0}', n))
    runFind()
  }

  /* ---------------- 导航窗格 ---------------- */

  function toggleOutline() {
    var o = $('outline')
    o.hidden = !o.hidden
    B.outline.classList.toggle('on', !o.hidden)
    try {
      localStorage.setItem('docx.outline', o.hidden ? '0' : '1')
    } catch (e) {}
    if (!o.hidden) buildOutline()
    setTimeout(applyZoom, 0)
  }
  function buildOutline() {
    var o = $('outline')
    if (o.hidden) return
    o.textContent = ''
    var items = Ed.paras().filter(function (p) {
      return p.dataset.ol && Number(p.dataset.ol) <= 6 && Ed.textOf(p).trim()
    })
    if (!items.length) {
      o.appendChild(h('div', { class: 'ol-empty', text: t('没有标题。用“标题 1”“标题 2”等样式的段落会显示在这里。', 'No headings. Paragraphs with Heading styles appear here.') }))
      return
    }
    items.forEach(function (p) {
      var lvl = Number(p.dataset.ol)
      var num = p.querySelector(':scope > .num')
      o.appendChild(
        h('div', {
          class: 'ol-item',
          style: { paddingLeft: 8 + (lvl - 1) * 14 + 'px' },
          title: Ed.textOf(p),
          onClick: function () {
            if (!p.isConnected) return
            Ed.setPos({ pi: Ed.paras().indexOf(p), off: 0 }, true)
            var wrap = $('wrap')
            wrap.scrollTop += p.getBoundingClientRect().top - wrap.getBoundingClientRect().top - 24
          }
        }, (num ? num.textContent + ' ' : '') + Ed.textOf(p).replace(/￼/g, '').trim())
      )
    })
  }

  /* ---------------- 状态栏、缩放 ---------------- */

  function updateStatus() {
    if (!S.doc) return
    var text = Ed.paras().map(function (p) { return Ed.textOf(p).replace(/￼/g, '') }).join('\n')
    var cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length
    var words = (text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9À-ɏЀ-ӿ'’-]+/g) || []).length
    var chars = text.replace(/\s/g, '').length
    var g = S.doc.page()
    var paper = Math.abs(g.w - 11906) < 30 && Math.abs(g.h - 16838) < 30 ? 'A4' : Math.abs(g.w - 12240) < 30 && Math.abs(g.h - 15840) < 30 ? 'Letter' : Math.round(g.w / 56.7) / 10 + ' × ' + Math.round(g.h / 56.7) / 10 + ' cm'
    $('status').textContent = t('字数 {0}', '{0} words').replace('{0}', cjk + words) + '  ·  ' + t('字符 {0}', '{0} characters').replace('{0}', chars) + '  ·  ' + paper
  }
  var statusTimer = 0
  function later() {
    clearTimeout(statusTimer)
    statusTimer = setTimeout(function () {
      updateStatus()
      buildOutline()
    }, 400)
  }

  function fitZoom() {
    var wrap = $('wrap')
    var sheet = $('sheet')
    if (!S.doc) return 1
    var w = (S.doc.page().w / 20) * (96 / 72)
    var avail = wrap.clientWidth - 48
    return Math.max(0.3, Math.min(1, avail / w))
  }
  function applyZoom() {
    var z = S.zoom || fitZoom()
    $('sheet').style.zoom = z
    if (B.zoom) B.zoom.textContent = Math.round(z * 100) + '%'
    placeImgSel()
  }
  function setZoom(z) {
    S.zoom = z
    applyZoom()
  }
  function zoomBy(f) {
    var cur = S.zoom || fitZoom()
    setZoom(Math.max(0.3, Math.min(4, Math.round(cur * f * 100) / 100)))
  }

  function showHelp(anchor) {
    var rows = [
      ['Ctrl+B / I / U', t('加粗 / 倾斜 / 下划线', 'Bold / italic / underline')],
      ['Ctrl+[ / ]', t('减小 / 增大字号', 'Decrease / increase font size')],
      ['Ctrl+L / E / R / J', t('左对齐 / 居中 / 右对齐 / 两端对齐', 'Align left / center / right / justify')],
      ['Ctrl+Alt+1…6 / 0', t('标题 1…6 / 正文', 'Heading 1…6 / Normal')],
      ['Shift+Enter', t('换行（不分段）', 'Line break')],
      ['Ctrl+Enter', t('分页符', 'Page break')],
      ['Tab / Shift+Tab', t('列表降级 / 升级；表格里切换单元格', 'Demote / promote list item; next / previous cell')],
      ['Ctrl+F / H', t('查找 / 替换', 'Find / replace')],
      ['Ctrl+Z / Y', t('撤销 / 重做', 'Undo / redo')],
      ['Ctrl + / - / 0', t('放大 / 缩小 / 适应宽度', 'Zoom in / out / fit width')],
      [t('Ctrl + 单击链接', 'Ctrl + click link'), t('打开链接', 'Open link')],
      ['Ctrl+S', t('保存', 'Save')]
    ]
    var tbl = h('table', { class: 'help' })
    rows.forEach(function (r) {
      tbl.appendChild(h('tr', null, h('td', null, h('kbd', { text: r[0] })), h('td', { text: r[1] })))
    })
    openPop(anchor, h('div', null, h('div', { class: 'pop-title', text: t('快捷键', 'Shortcuts') }), tbl, h('div', { class: 'help-note', text: t('可以粘贴或拖入图片。保存时只改动修改过的部分，页眉页脚、批注、修订、域等原样保留，保存的文件可以直接用 Word、WPS 打开。', 'Paste or drop images. Saving only rewrites what you changed; headers, footers, comments, tracked changes and fields are kept as they were. Saved files open in Word and WPS.') })))
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    docEl = $('doc')
    Ed.init(docEl)
    document.title = t('Word 文档', 'Word document')
    buildBar()
    try {
      document.execCommand('enableObjectResizing', false, 'false')
      document.execCommand('enableInlineTableEditing', false, 'false')
    } catch (e) {}
    docEl.addEventListener('beforeinput', onBeforeInput)
    docEl.addEventListener('input', onInput)
    docEl.addEventListener('compositionstart', onCompositionStart)
    docEl.addEventListener('compositionend', onCompositionEnd)
    docEl.addEventListener('dragstart', function (e) {
      e.preventDefault()
    })
    docEl.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault()
    })
    docEl.addEventListener('drop', function (e) {
      e.preventDefault()
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      if (!f || !/^image\//.test(f.type)) return
      var pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(e.clientX, e.clientY) : null
      if (pos && docEl.contains(pos.offsetNode)) {
        var r = document.createRange()
        r.setStart(pos.offsetNode, pos.offset)
        var sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(r)
      }
      insertImageFile(f)
    })
    docEl.addEventListener('click', function (e) {
      var a = e.target.closest('a.c.hyperlink')
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        return openLink(a)
      }
      var atom = e.target.closest('.x.pic')
      if (atom && docEl.contains(atom)) {
        var r = document.createRange()
        r.selectNode(atom)
        var sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(r)
        showImgSel(atom)
      } else hideImgSel()
    })
    document.addEventListener('keydown', onKey)
    document.addEventListener('copy', function (e) { if (docEl.contains(document.activeElement) || document.activeElement === docEl) onCopy(e, false) })
    document.addEventListener('cut', function (e) { if (docEl.contains(document.activeElement) || document.activeElement === docEl) onCopy(e, true) })
    document.addEventListener('paste', function (e) { if (docEl.contains(document.activeElement) || document.activeElement === docEl) onPaste(e) })
    document.addEventListener('contextmenu', onContext)
    document.addEventListener('mousedown', function (e) {
      if (pop && !pop.contains(e.target)) closePop()
    })
    document.addEventListener('selectionchange', function () {
      if (S.pending && S.pendingAt !== JSON.stringify(Ed.savePos())) S.pending = null
      if (imgSel) {
        var r = Ed.selRange()
        if (!r || r.collapsed || !r.intersectsNode(imgSel.atom)) hideImgSel()
      }
      updateBar()
    })
    $('imgsel').querySelector('.hd').addEventListener('pointerdown', startImgResize)
    $('wrap').addEventListener('scroll', function () {
      if (imgSel) placeImgSel()
    })
    $('wrap').addEventListener(
      'wheel',
      function (e) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
        }
      },
      { passive: false }
    )
    window.addEventListener('resize', function () {
      closePop()
      applyZoom()
    })
    // 点击页面空白处：光标放到最后
    $('wrap').addEventListener('mousedown', function (e) {
      if (e.target !== $('wrap') && e.target !== $('sheet')) return
      var list = Ed.paras()
      var lp = list[list.length - 1]
      if (!lp) return
      var r = $('sheet').getBoundingClientRect()
      if (e.clientY < r.top + 40) return
      e.preventDefault()
      Ed.setPos({ pi: list.length - 1, off: Ed.count(lp) })
    })
    // 查找栏
    $('findText').addEventListener('input', function () { runFind() })
    $('findText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        findStep(e.shiftKey ? -1 : 1)
      }
    })
    $('findRep').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        replaceOne()
      }
    })
    $('findCase').addEventListener('change', function () { runFind() })
    $('findRegex').addEventListener('change', function () { runFind() })
    $('findPrev').addEventListener('click', function () { findStep(-1) })
    $('findNext').addEventListener('click', function () { findStep(1) })
    $('findClose').addEventListener('click', closeFind)
    $('findToggle').addEventListener('click', function () { $('findRepRow').hidden = !$('findRepRow').hidden })
    $('findOne').addEventListener('click', replaceOne)
    $('findAll').addEventListener('click', replaceAll)
    $('findText').placeholder = t('查找', 'Find')
    $('findRep').placeholder = t('替换为', 'Replace with')
    $('findOne').textContent = t('替换', 'Replace')
    $('findAll').textContent = t('全部替换', 'Replace all')
    $('findCaseL').title = t('区分大小写', 'Match case')
    $('findRegexL').title = t('正则表达式', 'Regular expression')
    try {
      if (localStorage.getItem('docx.outline') === '1') {
        $('outline').hidden = false
        B.outline.classList.add('on')
      }
    } catch (e) {}
    Ed.on('render', function () {
      fillStyles()
      fillFonts()
      hideImgSel()
      applyZoom()
      later()
      updateBar()
      if (!$('find').hidden) runFind(true)
    })
    Ed.on('change', function () {
      later()
      updateBar()
      if (!$('find').hidden && F.matches.length) runFind(true)
    })
    updateBar()
  }

  window.UI = {
    init: init,
    prepareImage: prepareImage,
    insertTableRows: insertRow,
    updateBar: updateBar,
    applyZoom: applyZoom,
    fixWidths: fixWidths,
    cellsOfRow: cellsOfRow,
    emptyCellLike: emptyCellLike
  }
})()
