/**
 * XML ⇄ HTML。
 * 渲染：正文的每个块变成一个 HTML 元素（段落 p.p、表格 table.tbl、内容控件 div.sdt），元素的 _x 指向对应的 XML。
 * 段落里：文字是 span.r（data-r → rPr）；图片、域、脚注引用、修订删除等是不可编辑的 span.x（data-x → 原始 XML 节点）；
 * 超链接、修订插入、行内内容控件是容器（data-c → 原始元素），里面再放文字；书签等看不见的标记挂在后面那个元素上（data-m）。
 * 同步：把编辑过的 HTML 段落重新生成 XML 段落的内容（段落属性 pPr 不动；原样复制不认识的节点）。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var M = window.DocModel
  var kid = OX.kid
  var kids = OX.kids
  var wattr = M.wattr
  var wnum = M.wnum
  var on = M.on
  var W = M.W

  /* ---------------- 注册表：HTML 属性里的 id → XML ---------------- */

  var reg = new Map()
  var regKeys = new Map() // rPr 序列化 → id（相同格式共用一个 id，同步时相邻的文字能合并成一个 run）
  var seq = 1
  var ser = new XMLSerializer()
  function put(v) {
    var id = String(seq++)
    reg.set(id, v)
    return id
  }
  /** rPr（可以为 null）→ id */
  function putR(rPr) {
    var key = rPr && rPr.firstElementChild ? ser.serializeToString(rPr) : ''
    var id = regKeys.get(key)
    if (id) return id
    id = put(rPr && rPr.firstElementChild ? rPr.cloneNode(true) : null)
    regKeys.set(key, id)
    return id
  }
  function get(id) {
    return id ? reg.get(id) : undefined
  }
  function resetReg() {
    reg = new Map()
    regKeys = new Map()
  }

  /* ---------------- CSS ---------------- */

  var pt = function (twip) {
    return Math.round((twip / 20) * 100) / 100 + 'pt'
  }
  var HIGHLIGHT = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' }
  function fontCss(list) {
    return list
      .map(function (f) {
        return '"' + f.replace(/"/g, '') + '"'
      })
      .concat(['"Microsoft YaHei"', 'sans-serif'])
      .join(', ')
  }
  function borderCss(doc, el) {
    if (!el) return null
    var v = wattr(el, 'val')
    if (!v || v === 'nil' || v === 'none') return 'none'
    var w = Math.max(0.5, wnum(el, 'sz', 4) / 8)
    var style = v === 'double' ? 'double' : /dot/.test(v) ? 'dotted' : /dash/.test(v) ? 'dashed' : 'solid'
    if (style === 'double') w = Math.max(w, 2.25)
    // 边框的 w:val 是线型，颜色在 w:color / w:themeColor
    var col = wattr(el, 'color')
    var tc = wattr(el, 'themeColor')
    var css = col && col !== 'auto' ? '#' + col : tc && doc.themeColor(tc) ? '#' + doc.themeColor(tc) : '#000'
    return w + 'pt ' + style + ' ' + css
  }
  /** 文字格式 → CSS 字符串 */
  function runCss(doc, p) {
    var s = ''
    var fonts = doc.fontsOf(p)
    if (fonts.length) s += 'font-family:' + fontCss(fonts) + ';'
    var sz = p.sz ? wnum(p.sz, 'val', 21) / 2 : 10.5
    var va = p.vertAlign ? wattr(p.vertAlign, 'val') : null
    if (va === 'superscript' || va === 'subscript') {
      s += 'font-size:' + Math.round(sz * 0.65 * 10) / 10 + 'pt;vertical-align:' + (va === 'superscript' ? 'super' : 'sub') + ';'
    } else s += 'font-size:' + sz + 'pt;'
    if (on(p.b)) s += 'font-weight:700;'
    if (on(p.i)) s += 'font-style:italic;'
    var deco = []
    if (p.u && wattr(p.u, 'val') !== 'none') deco.push('underline')
    if (on(p.strike) || on(p.dstrike)) deco.push('line-through')
    if (deco.length) {
      s += 'text-decoration:' + deco.join(' ') + ';'
      if (p.u && /double/.test(wattr(p.u, 'val') || '')) s += 'text-decoration-style:double;'
      else if (p.u && /dot/.test(wattr(p.u, 'val') || '')) s += 'text-decoration-style:dotted;'
      else if (p.u && /wave/.test(wattr(p.u, 'val') || '')) s += 'text-decoration-style:wavy;'
      if (on(p.dstrike)) s += 'text-decoration-style:double;'
    }
    var c = doc.colorOf(p.color)
    if (c) s += 'color:' + c + ';'
    var hl = p.highlight ? HIGHLIGHT[wattr(p.highlight, 'val')] : null
    if (hl) s += 'background-color:' + hl + ';'
    else if (p.shd) {
      var f = wattr(p.shd, 'fill')
      if (f && f !== 'auto') s += 'background-color:#' + f + ';'
    }
    if (on(p.caps)) s += 'text-transform:uppercase;'
    if (on(p.smallCaps)) s += 'font-variant:small-caps;'
    if (p.spacing && p.spacing.val) s += 'letter-spacing:' + pt(Number(p.spacing.val)) + ';'
    if (p.position && !va) {
      var pos = wnum(p.position, 'val', 0)
      if (pos) s += 'position:relative;top:' + -pos / 2 + 'pt;'
    }
    return s
  }

  /** 段落格式 → CSS（不含编号） */
  function paraCss(doc, props, ind) {
    var s = ''
    var jc = props.jc ? wattr(props.jc, 'val') : null
    if (jc === 'center') s += 'text-align:center;'
    else if (jc === 'right' || jc === 'end') s += 'text-align:right;'
    else if (jc === 'both' || jc === 'distribute' || jc === 'thaiDistribute') s += 'text-align:justify;'
    ind = ind || props.ind || {}
    var left = Number(ind.left || 0)
    var right = Number(ind.right || 0)
    var first = ind.hanging != null ? -Number(ind.hanging) : Number(ind.firstLine || 0)
    // 按字符的缩进（中文文档常见）：百分之一个字符
    var em = function (v) {
      return Math.round(Number(v) / 10) / 10 + 'em'
    }
    if (ind.leftChars != null && Number(ind.leftChars)) s += 'padding-left:' + em(ind.leftChars) + ';'
    else if (left) s += 'padding-left:' + pt(left) + ';'
    if (ind.rightChars != null && Number(ind.rightChars)) s += 'padding-right:' + em(ind.rightChars) + ';'
    else if (right) s += 'padding-right:' + pt(right) + ';'
    if (ind.firstLineChars != null && Number(ind.firstLineChars)) s += 'text-indent:' + em(ind.firstLineChars) + ';'
    else if (ind.hangingChars != null && Number(ind.hangingChars)) s += 'text-indent:-' + em(ind.hangingChars) + ';'
    else if (first) s += 'text-indent:' + pt(first) + ';'
    var sp = props.spacing || {}
    var before = sp.beforeAutospacing === '1' || sp.beforeAutospacing === 'true' ? 280 : Number(sp.before || 0)
    var after = sp.afterAutospacing === '1' || sp.afterAutospacing === 'true' ? 280 : Number(sp.after || 0)
    if (sp.beforeLines != null && Number(sp.beforeLines)) before = Number(sp.beforeLines) * 2.4 * 12
    if (sp.afterLines != null && Number(sp.afterLines)) after = Number(sp.afterLines) * 2.4 * 12
    if (before) s += 'padding-top:' + pt(before) + ';'
    if (after) s += 'padding-bottom:' + pt(after) + ';'
    if (sp.line) {
      var rule = sp.lineRule || 'auto'
      var line = Number(sp.line)
      if (rule === 'auto') s += 'line-height:' + Math.round((line / 240) * 1.2 * 100) / 100 + ';'
      else if (rule === 'exact') s += 'line-height:' + pt(line) + ';'
      else s += 'line-height:max(1.2em,' + pt(line) + ');'
    }
    if (props.shd) {
      var f = wattr(props.shd, 'fill')
      if (f && f !== 'auto') s += 'background-color:#' + f + ';'
    }
    if (props.pBdr) {
      ;['top', 'bottom', 'left', 'right'].forEach(function (k) {
        var b = borderCss(doc, kid(props.pBdr, k))
        if (b && b !== 'none') s += 'border-' + k + ':' + b + ';'
      })
    }
    return s
  }

  /* ---------------- 块 ---------------- */

  function h(tag, cls) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    return e
  }

  /**
   * ctx: { doc, part, tblStyle, foot: { n } }
   * 返回 HTML 元素列表
   */
  function renderBlocks(container, ctx) {
    var out = []
    for (var c = container.firstElementChild; c; c = c.nextElementSibling) {
      var e = renderBlock(c, ctx)
      if (e) out.push(e)
    }
    return out
  }
  /** 一个块 → HTML 元素；sectPr、书签等不显示的返回 null（留在 XML 里不动） */
  function renderBlock(c, ctx) {
    var n = c.localName
    if (n === 'p') return renderPara(c, ctx)
    if (n === 'tbl') return renderTable(c, ctx)
    if (n === 'sdt' || n === 'customXml') {
      var content = n === 'sdt' ? kid(c, 'sdtContent') : c
      if (!content) return null
      var d = h('div', 'sdt')
      d._x = c
      d._c = content
      renderBlocks(content, ctx).forEach(function (e) {
        d.appendChild(e)
      })
      return d.firstChild ? d : null
    }
    if (n === 'altChunk') {
      var b = h('div', 'blk')
      b.contentEditable = 'false'
      b._x = c
      b.textContent = '[嵌入的内容]'
      return b
    }
    return null
  }

  /** 段落的有效属性，编号的缩进也算进去 */
  function paraInfo(doc, p, tblStyle) {
    var props = doc.pProps(p, tblStyle)
    var np = doc.numPrOf(props)
    var ind = props.ind
    var lv = null
    if (np) {
      lv = doc.level(np.numId, np.ilvl)
      var direct = kid(kid(p, 'pPr'), 'ind')
      var li = lv && lv.pPr ? kid(lv.pPr, 'ind') : null
      if (li && !direct) {
        var a = {}
        for (var i = 0; i < li.attributes.length; i++) a[li.attributes[i].localName] = li.attributes[i].value
        if (a.start != null && a.left == null) a.left = a.start
        ind = a
      }
    }
    return { props: props, np: np, lv: lv, ind: ind }
  }

  function markRPr(p) {
    var r = OX.path(p, 'pPr', 'rPr')
    if (!r) return null
    r = r.cloneNode(true)
    ;['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange'].forEach(function (n) {
      OX.removeKid(r, n)
    })
    return r
  }

  function renderPara(p, ctx) {
    var doc = ctx.doc
    var info = paraInfo(doc, p, ctx.tblStyle)
    var props = info.props
    var el = h('p', 'p')
    el._x = p
    var mark = markRPr(p)
    el._pm = putR(mark)
    var css = paraCss(doc, props, info.ind) + runCss(doc, doc.rProps(mark, props.styleId, ctx.tblStyle))
    el.setAttribute('style', css)
    if (props.pageBreakBefore && on(props.pageBreakBefore)) el.classList.add('pb-before')
    if (OX.path(p, 'pPr', 'sectPr')) el.classList.add('sect-end')
    if (props.outlineLvl) {
      var ol = wnum(props.outlineLvl, 'val', 9)
      if (ol < 9) el.dataset.ol = String(ol + 1)
    }
    var rc = { doc: doc, ctx: ctx, pStyle: props.styleId, pending: [] }
    renderInline(p, el, rc)
    flushMarks(rc, null, el)
    fixEmpty(el)
    return el
  }

  /** 空段落（或以换行结尾的段落）放一个占位的 <br>，不然没有高度、放不了光标 */
  function fixEmpty(el) {
    // 浏览器插的 <br> 都当成占位
    Array.prototype.forEach.call(el.querySelectorAll('br:not(.b):not(.fill)'), function (b) {
      b.className = 'fill'
    })
    var fills = el.querySelectorAll('br.fill')
    for (var i = 0; i < fills.length; i++) fills[i].remove()
    var last = el.lastChild
    while (last && last.nodeType === 3 && last.data === '') last = last.previousSibling
    var need = !hasContent(el) || (last && last.nodeName === 'BR' && last.classList.contains('b'))
    if (need) el.appendChild(h('br', 'fill'))
  }
  function hasContent(el) {
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (c.data.length) return true
      } else if (c.nodeType === 1) {
        if (c.classList.contains('num') || c.classList.contains('fill')) continue
        if (c.classList.contains('x') || c.classList.contains('b') || c.nodeName === 'BR') return true
        if (hasContent(c)) return true
      }
    }
    return false
  }

  /* ---------------- 行内 ---------------- */

  var MARK = { bookmarkStart: 1, bookmarkEnd: 1, commentRangeStart: 1, commentRangeEnd: 1, permStart: 1, permEnd: 1, moveFromRangeStart: 1, moveFromRangeEnd: 1, moveToRangeStart: 1, moveToRangeEnd: 1, customXmlInsRangeStart: 1, customXmlInsRangeEnd: 1, customXmlDelRangeStart: 1, customXmlDelRangeEnd: 1 }
  var DROP = { proofErr: 1, pPr: 1, rPr: 1 }

  function addMark(rc, nodes) {
    for (var i = 0; i < nodes.length; i++) rc.pending.push(nodes[i])
  }
  /** 把攒着的看不见的标记挂到 el 上（el 为 null 时挂到段落末尾） */
  function flushMarks(rc, el, para) {
    if (!rc.pending.length) return
    if (el) el.dataset.m = put(rc.pending)
    else para._tail = (para._tail || []).concat(rc.pending)
    rc.pending = []
  }

  function fieldEnd(start) {
    // 从 begin 开始找配对的 end（同一父元素里），找不到返回 null
    var depth = 0
    for (var c = start; c; c = c.nextElementSibling) {
      if (c.localName !== 'r') continue
      kids(c, 'fldChar').forEach(function (f) {
        var t = wattr(f, 'fldCharType')
        if (t === 'begin') depth++
        else if (t === 'end') depth--
      })
      if (depth <= 0) return c
    }
    return null
  }
  function hasFldChar(r, type) {
    return kids(r, 'fldChar').some(function (f) {
      return !type || wattr(f, 'fldCharType') === type
    })
  }
  function hasInstr(r) {
    return !!kid(r, 'instrText') || !!kid(r, 'delInstrText')
  }

  function renderInline(parent, out, rc) {
    var c = parent.firstElementChild
    while (c) {
      var n = c.localName
      var next = c.nextElementSibling
      if (DROP[n]) {
        c = next
        continue
      }
      if (MARK[n]) {
        addMark(rc, [c])
      } else if (n === 'r') {
        if (hasFldChar(c, 'begin')) {
          var end = fieldEnd(c)
          if (end) {
            var nodes = []
            for (var x = c; x; x = x.nextElementSibling) {
              nodes.push(x)
              if (x === end) break
            }
            out.appendChild(fieldAtom(nodes, rc))
            c = end.nextElementSibling
            continue
          }
          // 跨段落的域（目录等）：开始部分不显示，结果文字照常编辑
          addMark(rc, [c])
        } else if (hasFldChar(c) || hasInstr(c)) {
          addMark(rc, [c])
        } else renderRun(c, out, rc)
      } else if (n === 'hyperlink' || n === 'ins' || n === 'moveTo' || n === 'smartTag' || n === 'customXml' || n === 'dir' || n === 'bdo') {
        var a = h(n === 'hyperlink' ? 'a' : 'span', 'c ' + n)
        a.dataset.c = put(c)
        if (n === 'hyperlink') {
          var rel = rc.doc.pkg.rel(rc.ctx.part, OX.rid(c, 'id'))
          a.dataset.href = rel ? rel.target : wattr(c, 'anchor') ? '#' + wattr(c, 'anchor') : ''
          a.title = a.dataset.href + '\nCtrl + 单击打开 / Ctrl+click to open'
        }
        flushMarks(rc, a, null)
        renderInline(c, a, rc)
        out.appendChild(a)
      } else if (n === 'sdt') {
        var content = kid(c, 'sdtContent')
        var s = h('span', 'c sdt-i')
        s.dataset.c = put(c)
        flushMarks(rc, s, null)
        if (content) renderInline(content, s, rc)
        out.appendChild(s)
      } else if (n === 'fldSimple') {
        out.appendChild(atom([c], 'fld', M.paraText(c) || '{' + (wattr(c, 'instr') || '').trim() + '}', rc))
      } else if (n === 'del' || n === 'moveFrom') {
        var txt = ''
        OX.desc(c, 'delText').forEach(function (t) {
          txt += t.textContent
        })
        out.appendChild(atom([c], 'del', txt, rc))
      } else if (n === 'oMath' || n === 'oMathPara') {
        var mt = ''
        OX.desc(c, 't').forEach(function (t) {
          mt += t.textContent
        })
        out.appendChild(atom([c], 'math', mt || '[公式]', rc))
      } else {
        // 不认识的行内元素：原样保留，显示里面的文字
        out.appendChild(atom([c], 'unk', M.paraText(c), rc))
      }
      c = next
    }
  }

  function atom(nodes, cls, text, rc) {
    var s = h('span', 'x ' + cls)
    s.contentEditable = 'false'
    s.dataset.x = put(nodes)
    if (text) s.textContent = text
    flushMarks(rc, s, null)
    return s
  }
  function fieldAtom(nodes, rc) {
    // 显示域结果（separate 和 end 之间的文字）
    var instr = ''
    var result = ''
    var phase = 0
    nodes.forEach(function (r) {
      for (var c = r.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === 'fldChar') {
          var t = wattr(c, 'fldCharType')
          if (t === 'separate') phase = 1
        } else if (c.localName === 'instrText' && phase === 0) instr += c.textContent
        else if (c.localName === 't' && phase === 1) result += c.textContent
        else if (c.localName === 'tab' && phase === 1) result += '\t'
      }
    })
    var first = nodes.filter(function (r) {
      return kid(r, 'rPr')
    })[0]
    var css = runCss(rc.doc, rc.doc.rProps(first ? kid(first, 'rPr') : null, rc.pStyle, rc.ctx.tblStyle))
    var a = atom(nodes, 'fld', result || '{' + instr.trim() + '}', rc)
    a.title = instr.trim()
    a.setAttribute('style', css)
    return a
  }

  function renderRun(r, out, rc) {
    var doc = rc.doc
    var rPr = kid(r, 'rPr')
    var rid = putR(rPr)
    var css = null
    var cssOf = function () {
      if (css == null) css = runCss(doc, doc.rProps(rPr, rc.pStyle, rc.ctx.tblStyle))
      return css
    }
    var span = null
    var text = function (s) {
      if (!span) {
        span = h('span', 'r')
        span.dataset.r = rid
        span.setAttribute('style', cssOf())
        if (rPr && on(kid(rPr, 'vanish'))) span.classList.add('vanish')
        flushMarks(rc, span, null)
        out.appendChild(span)
      }
      var last = span.lastChild
      if (last && last.nodeType === 3) last.appendData(s)
      else span.appendChild(document.createTextNode(s))
    }
    var single = function (child) {
      // 只含这个子元素的 run（复制 rPr）
      var nr = r.cloneNode(false)
      if (rPr) nr.appendChild(rPr.cloneNode(true))
      nr.appendChild(child.cloneNode(true))
      return nr
    }
    for (var c = r.firstElementChild; c; c = c.nextElementSibling) {
      var n = c.localName
      if (n === 'rPr' || n === 'lastRenderedPageBreak') continue
      if (n === 't') {
        if (c.textContent) text(c.textContent)
      } else if (n === 'tab') text('\t')
      else if (n === 'noBreakHyphen') text('‑')
      else if (n === 'softHyphen') text('­')
      else if ((n === 'br' && !wattr(c, 'type')) || (n === 'br' && wattr(c, 'type') === 'textWrapping') || n === 'cr') {
        var br = h('br', 'b')
        br.dataset.r = rid
        flushMarks(rc, br, null)
        out.appendChild(br)
        span = null
      } else {
        span = null
        var a
        if (n === 'br') {
          var type = wattr(c, 'type')
          a = atom([single(c)], type === 'page' ? 'pgbr' : 'colbr', '', rc)
          a.dataset.label = type === 'page' ? '分页符' : '分栏符'
        } else if (n === 'drawing' || n === 'pict' || n === 'object') {
          a = atom([single(c)], 'obj', '', rc)
          drawObject(c, a, rc)
        } else if (n === 'footnoteReference' || n === 'endnoteReference') {
          rc.ctx.foot = rc.ctx.foot || { footnoteReference: 0, endnoteReference: 0 }
          rc.ctx.foot[n] = (rc.ctx.foot[n] || 0) + 1
          var num = n === 'endnoteReference' ? M.formatNum(rc.ctx.foot[n], 'lowerRoman') : String(rc.ctx.foot[n])
          a = atom([single(c)], 'fn', num, rc)
          a.setAttribute('style', cssOf())
        } else if (n === 'sym') {
          var ch = String.fromCharCode(parseInt(wattr(c, 'char') || '25A1', 16) & 0xffff)
          a = atom([single(c)], 'sym', M.bulletChar(ch, wattr(c, 'font')), rc)
          a.setAttribute('style', cssOf())
        } else if (n === 'commentReference') {
          a = atom([single(c)], 'cmt', '', rc)
        } else if (n === 'footnoteRef' || n === 'endnoteRef' || n === 'separator' || n === 'continuationSeparator' || n === 'annotationRef') {
          a = atom([single(c)], 'unk', '', rc)
        } else {
          a = atom([single(c)], 'unk', '', rc)
        }
        out.appendChild(a)
      }
    }
    // 只有 rPr 的空 run：不需要保留
  }

  /** 图片 / 图形 */
  function drawObject(c, a, rc) {
    var doc = rc.doc
    var emu = 12700
    var ext = OX.desc(c, 'extent')[0]
    var w = 0, hh = 0
    if (ext) {
      w = Number(ext.getAttribute('cx')) / emu
      hh = Number(ext.getAttribute('cy')) / emu
    }
    var blip = OX.desc(c, 'blip')[0]
    var rid = blip ? OX.rid(blip, 'embed') || OX.rid(blip, 'link') : ''
    if (!rid) {
      var vi = OX.desc(c, 'imagedata')[0]
      if (vi) rid = OX.rid(vi, 'id')
      var shape = OX.desc(c, 'shape')[0]
      if (shape && !w) {
        var st = shape.getAttribute('style') || ''
        var mw = /width:([\d.]+)(pt|in|px)?/.exec(st)
        var mh = /height:([\d.]+)(pt|in|px)?/.exec(st)
        var cv = function (m) {
          if (!m) return 0
          var v = Number(m[1])
          return m[2] === 'in' ? v * 72 : m[2] === 'px' ? v * 0.75 : v
        }
        w = cv(mw)
        hh = cv(mh)
      }
    }
    var url = rid ? doc.mediaUrl(rc.ctx.part, rid) : ''
    if (OX.desc(c, 'anchor').length) a.classList.add('float')
    if (url) {
      var img = h('img')
      img.src = url
      img.draggable = false
      if (w) img.style.width = w + 'pt'
      if (hh) img.style.height = hh + 'pt'
      a.appendChild(img)
      a.classList.add('pic')
    } else {
      // 图形、图表、文本框：画一个占位框，显示里面的文字
      var box = h('span', 'shape')
      if (w) box.style.width = Math.min(w, 2000) + 'pt'
      if (hh) box.style.height = Math.min(hh, 2000) + 'pt'
      var txt = ''
      OX.desc(c, 'txbxContent').forEach(function (tb) {
        kids(tb, 'p').forEach(function (p) {
          txt += M.paraText(p) + '\n'
        })
      })
      var isChart = OX.desc(c, 'chart').length > 0
      box.textContent = txt.trim() || (isChart ? '图表 / Chart' : '图形 / Shape')
      a.appendChild(box)
    }
  }

  /* ---------------- 表格 ---------------- */

  function tblProp(doc, tbl, name) {
    var tblPr = kid(tbl, 'tblPr')
    var v = kid(tblPr, name)
    if (v) return v
    var sid = wattr(kid(tblPr, 'tblStyle'), 'val') || doc.styles().defT
    var chain = doc.chain(sid)
    for (var i = chain.length - 1; i >= 0; i--) {
      var x = OX.path(chain[i].el, 'tblPr', name)
      if (x) return x
    }
    return null
  }

  function renderTable(tbl, ctx) {
    var doc = ctx.doc
    var t = h('table', 'tbl')
    t._x = tbl
    var tblPr = kid(tbl, 'tblPr')
    var sid = wattr(kid(tblPr, 'tblStyle'), 'val') || doc.styles().defT
    var sub = Object.assign({}, ctx, { tblStyle: sid })
    var borders = tblProp(doc, tbl, 'tblBorders')
    var mar = tblProp(doc, tbl, 'tblCellMar')
    var marL = mar ? wnum(kid(mar, 'left') || kid(mar, 'start'), 'w', 108) : 108
    var marR = mar ? wnum(kid(mar, 'right') || kid(mar, 'end'), 'w', 108) : 108
    var marT = mar ? wnum(kid(mar, 'top'), 'w', 0) : 0
    var marB = mar ? wnum(kid(mar, 'bottom'), 'w', 0) : 0
    var jc = wattr(kid(tblPr, 'jc'), 'val')
    if (jc === 'center') t.style.margin = '0 auto'
    else if (jc === 'right' || jc === 'end') t.style.marginLeft = 'auto'
    var ind = kid(tblPr, 'tblInd')
    if (ind && wattr(ind, 'type') !== 'pct' && jc !== 'center') t.style.marginLeft = pt(wnum(ind, 'w', 0) - marL)
    var grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map(function (g) {
      return wnum(g, 'w', 0)
    })
    var total = grid.reduce(function (a, b) { return a + b }, 0)
    var cg = h('colgroup')
    grid.forEach(function (w) {
      var col = h('col')
      col.style.width = pt(w)
      cg.appendChild(col)
    })
    t.appendChild(cg)
    var tw = kid(tblPr, 'tblW')
    if (tw && wattr(tw, 'type') === 'pct') t.style.width = wnum(tw, 'w', 5000) / 50 + '%'
    else if (total) t.style.width = pt(total)
    var tb = h('tbody')
    t.appendChild(tb)
    var rows = kids(tbl, 'tr')
    // 网格：每行每个格子起始列，用来算纵向合并
    var layout = rows.map(function (tr) {
      var col = 0
      return kids(tr, 'tc').map(function (tc) {
        var tcPr = kid(tc, 'tcPr')
        var span = wnum(kid(tcPr, 'gridSpan'), 'val', 1)
        var vm = kid(tcPr, 'vMerge')
        var cell = { tc: tc, col: col, span: span, vm: vm ? wattr(vm, 'val') || 'continue' : null }
        col += span
        return cell
      })
    })
    var nRows = rows.length
    rows.forEach(function (tr, ri) {
      var row = h('tr')
      row._x = tr
      var trh = OX.path(tr, 'trPr', 'trHeight')
      if (trh) row.style.height = pt(wnum(trh, 'val', 0))
      layout[ri].forEach(function (cell) {
        if (cell.vm === 'continue') return
        var td = h('td')
        td._x = cell.tc
        if (cell.span > 1) td.colSpan = cell.span
        if (cell.vm === 'restart') {
          var n = 1
          for (var k = ri + 1; k < nRows; k++) {
            var below = layout[k].filter(function (x) { return x.col === cell.col })[0]
            if (below && below.vm === 'continue') n++
            else break
          }
          if (n > 1) td.rowSpan = n
        }
        var tcPr = kid(cell.tc, 'tcPr')
        var tcb = kid(tcPr, 'tcBorders')
        var lastRow = ri + (td.rowSpan || 1) - 1 >= nRows - 1
        var edge = function (side, outer, inner) {
          var b = borderCss(doc, kid(tcb, side) || (side === 'left' ? kid(tcb, 'start') : side === 'right' ? kid(tcb, 'end') : null))
          if (!b) b = borderCss(doc, kid(borders, outer ? side : inner) || (outer && side === 'left' ? kid(borders, 'start') : outer && side === 'right' ? kid(borders, 'end') : null))
          return b || 'none'
        }
        var st = td.style
        var bt = edge('top', ri === 0, 'insideH')
        var bb = edge('bottom', lastRow, 'insideH')
        var bl = edge('left', cell.col === 0, 'insideV')
        var br = edge('right', cell.col + cell.span >= grid.length, 'insideV')
        st.borderTop = bt
        st.borderBottom = bb
        st.borderLeft = bl
        st.borderRight = br
        if ([bt, bb, bl, br].indexOf('none') >= 0) td.classList.add('nob')
        var cm = kid(tcPr, 'tcMar')
        st.padding = pt(cm ? wnum(kid(cm, 'top'), 'w', marT) : marT) + ' ' + pt(cm ? wnum(kid(cm, 'right') || kid(cm, 'end'), 'w', marR) : marR) + ' ' + pt(cm ? wnum(kid(cm, 'bottom'), 'w', marB) : marB) + ' ' + pt(cm ? wnum(kid(cm, 'left') || kid(cm, 'start'), 'w', marL) : marL)
        var shd = kid(tcPr, 'shd')
        var fill = shd ? wattr(shd, 'fill') : null
        if (fill && fill !== 'auto') st.backgroundColor = '#' + fill
        var va = wattr(kid(tcPr, 'vAlign'), 'val')
        st.verticalAlign = va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : 'top'
        renderBlocks(cell.tc, sub).forEach(function (e) {
          td.appendChild(e)
        })
        row.appendChild(td)
      })
      tb.appendChild(row)
    })
    return t
  }

  /* ---------------- 同步：HTML 段落 → XML ---------------- */

  function syncPara(hp) {
    var p = hp._x
    if (!p) return
    var doc = p.ownerDocument
    var pPr = kid(p, 'pPr')
    while (p.lastChild && p.lastChild !== pPr) p.removeChild(p.lastChild)
    if (pPr) while (pPr.previousSibling) p.removeChild(pPr.previousSibling)
    var st = { doc: doc, run: null, rid: null }
    emit(hp, p, hp._pm, st)
    st.run = null
    if (hp._tail) hp._tail.forEach(function (n) {
      p.appendChild(n.cloneNode(true))
    })
  }

  function marks(el, target, st) {
    var m = el.dataset && el.dataset.m
    if (!m) return
    var list = get(m)
    if (!list) return
    st.run = null
    list.forEach(function (n) {
      target.appendChild(n.cloneNode(true))
    })
  }

  function newRun(target, rid, st) {
    var r = st.doc.createElementNS(W, 'w:r')
    var rPr = get(rid)
    if (rPr) r.appendChild(rPr.cloneNode(true))
    target.appendChild(r)
    st.run = r
    st.rid = rid
    st.target = target
    return r
  }
  function runFor(target, rid, st) {
    if (st.run && st.rid === rid && st.target === target && st.run.parentNode === target) return st.run
    return newRun(target, rid, st)
  }
  function addText(target, s, rid, st) {
    s = s.replace(/​/g, '')
    if (!s) return
    var r = runFor(target, rid, st)
    var buf = ''
    var flush = function () {
      if (!buf) return
      var last = r.lastChild
      if (last && last.localName === 't') M.setT(last, last.textContent + buf)
      else {
        var t = st.doc.createElementNS(W, 'w:t')
        M.setT(t, buf)
        r.appendChild(t)
      }
      buf = ''
    }
    for (var i = 0; i < s.length; i++) {
      var ch = s[i]
      var special = ch === '\t' ? 'tab' : ch === '‑' ? 'noBreakHyphen' : ch === '­' ? 'softHyphen' : ch === '\n' ? 'br' : null
      if (special) {
        flush()
        r.appendChild(st.doc.createElementNS(W, 'w:' + special))
      } else buf += ch
    }
    flush()
  }

  function emit(el, target, rid, st) {
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        addText(target, c.data, rid, st)
        continue
      }
      if (c.nodeType !== 1) continue
      var cl = c.classList
      if (cl.contains('num') || cl.contains('fill') || cl.contains('caret-x')) continue
      marks(c, target, st)
      if (cl.contains('x') && c.dataset.x) {
        var nodes = get(c.dataset.x) || []
        st.run = null
        nodes.forEach(function (n) {
          target.appendChild(n.cloneNode(true))
        })
        st.run = null
      } else if (cl.contains('c') && c.dataset.c) {
        var src = get(c.dataset.c)
        if (!src) {
          emit(c, target, rid, st)
          continue
        }
        st.run = null
        var copy
        var inner
        if (src.localName === 'sdt') {
          copy = src.cloneNode(true)
          inner = kid(copy, 'sdtContent')
          if (!inner) {
            inner = st.doc.createElementNS(W, 'w:sdtContent')
            copy.appendChild(inner)
          }
          while (inner.firstChild) inner.removeChild(inner.firstChild)
        } else {
          copy = src.cloneNode(false)
          inner = copy
        }
        emit(c, inner, rid, st)
        st.run = null
        // 空的超链接 / 修订插入不留
        if (inner.firstElementChild || src.localName === 'sdt') target.appendChild(copy)
      } else if (c.nodeName === 'BR') {
        // 只有 br.b 是 Word 的换行；浏览器自己插的 <br>（空行占位）不算
        if (!cl.contains('b')) continue
        var r = runFor(target, c.dataset.r || rid, st)
        r.appendChild(st.doc.createElementNS(W, 'w:br'))
      } else if (c.nodeName === 'IMG') {
        continue
      } else {
        // span.r 或浏览器插进来的元素（b、font…）：继续往里走
        emit(c, target, c.dataset && c.dataset.r ? c.dataset.r : rid, st)
      }
    }
  }

  window.Render = {
    reg: { put: put, putR: putR, get: get, reset: resetReg },
    renderBlocks: renderBlocks,
    renderBlock: renderBlock,
    renderPara: renderPara,
    renderTable: renderTable,
    paraInfo: paraInfo,
    runCss: runCss,
    syncPara: syncPara,
    fixEmpty: fixEmpty,
    hasContent: hasContent,
    markRPr: markRPr
  }
})()
