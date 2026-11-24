/**
 * AI 工具（IDE 里的 AI 助手调用）和文件读写入口。
 * 块（block）：正文里的段落和表格，按顺序从 1 开始编号（内容控件里的块展开计算）。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var M = window.DocModel
  var Ed = window.Ed
  var UI = window.UI
  var S = Ed.S
  var t = Ed.t
  var kid = OX.kid
  var kids = OX.kids

  function needDoc() {
    if (!S.doc) throw new Error('The document could not be opened')
    Ed.flushTyping()
  }
  function blocks() {
    return M.blocksOf(S.doc.body())
  }
  function blockArg(n, list) {
    list = list || blocks()
    var i = Math.floor(Number(n)) - 1
    if (!(i >= 0 && i < list.length)) throw new Error('Block ' + n + ' does not exist (the document has ' + list.length + ' blocks)')
    return i
  }
  /** "3-5,8" → [2,3,4,7]（0 开始） */
  function rangeArg(v, list) {
    list = list || blocks()
    if (v == null || v === '') throw new Error('Which blocks? e.g. "3" or "3-5,8"')
    var out = []
    String(v)
      .split(',')
      .forEach(function (part) {
        var m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
        if (!m) throw new Error('Bad block range "' + part + '"')
        var a = blockArg(m[1], list)
        var b = m[2] ? blockArg(m[2], list) : a
        for (var i = Math.min(a, b); i <= Math.max(a, b); i++) if (out.indexOf(i) < 0) out.push(i)
      })
    return out.sort(function (a, b) { return a - b })
  }
  function toolPath(p) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('`path` is required')
    return '/' + p.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  }
  function hex(v) {
    if (v === null || v === 'none' || v === 'auto') return null
    var s = String(v).trim().replace(/^#/, '')
    if (/^[0-9a-f]{3}$/i.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error('Invalid color "' + v + '" (use #rrggbb)')
    return s.toUpperCase()
  }
  function after() {
    S.doc.touch()
    var wrap = Ed.$('wrap')
    var scroll = wrap.scrollTop
    Ed.renderAll()
    wrap.scrollTop = scroll
    Ed.commit()
  }
  function styleName(id) {
    var st = S.doc.style(id)
    return st ? st.name : id || 'Normal'
  }
  function r1(v) {
    return Math.round(v * 10) / 10
  }

  /* ---------------- 读取 ---------------- */

  function labels() {
    var map = new Map()
    var counter = S.doc.counter()
    OX.desc(S.doc.body(), 'p').forEach(function (p) {
      var props = S.doc.pProps(p)
      var np = S.doc.numPrOf(props)
      if (np) {
        var res = counter.next(np.numId, np.ilvl)
        if (res) map.set(p, { label: res.text, kind: S.doc.listKind(np.numId), level: np.ilvl + 1 })
      }
    })
    return map
  }
  function cellText(tc) {
    return kids(tc, 'p')
      .map(function (p) { return M.paraText(p, true).replace(/￼/g, '[image]') })
      .join('\n')
  }
  function describe(el, i, lab) {
    if (el.localName === 'tbl') {
      var rows = kids(el, 'tr').map(function (tr) {
        return kids(tr, 'tc').map(cellText)
      })
      return { block: i + 1, type: 'table', rows: rows.length, columns: kids(kid(el, 'tblGrid'), 'gridCol').length, cells: rows }
    }
    var props = S.doc.pProps(el)
    var o = { block: i + 1, style: styleName(props.styleId) }
    var l = lab.get(el)
    if (l) o.list = l.kind + ' level ' + l.level + ' "' + l.label + '"'
    var jc = props.jc ? M.wattr(props.jc, 'val') : null
    if (jc && jc !== 'left' && jc !== 'start') o.align = jc === 'both' ? 'justify' : jc
    var text = M.paraText(el, true)
    var imgs = (text.match(/￼/g) || []).length
    o.text = text.replace(/￼/g, '[image]')
    if (imgs) o.images = imgs
    if (OX.desc(el, 'br').some(function (b) { return M.wattr(b, 'type') === 'page' })) o.pageBreak = true
    if (OX.path(el, 'pPr', 'sectPr')) o.sectionBreak = true
    return o
  }

  studio.tools.register('getDocument', function (a) {
    needDoc()
    var list = blocks()
    var from = a.from ? blockArg(a.from, list) : 0
    var to = a.to ? blockArg(a.to, list) : list.length - 1
    var max = 400
    var truncated = false
    if (to - from + 1 > max) {
      to = from + max - 1
      truncated = true
    }
    var lab = labels()
    var g = S.doc.page()
    var out = {
      blocks: list.length,
      page: { width: r1(g.w / 20), height: r1(g.h / 20), margins: { top: r1(g.top / 20), right: r1(g.right / 20), bottom: r1(g.bottom / 20), left: r1(g.left / 20) }, unit: 'pt' },
      styles: S.doc.paragraphStyles().map(function (s) { return s.name }),
      content: []
    }
    for (var i = from; i <= to; i++) out.content.push(describe(list[i], i, lab))
    if (truncated) out.note = 'Showing blocks ' + (from + 1) + '-' + (to + 1) + ' of ' + list.length + '; pass from / to for more.'
    return out
  })

  /* ---------------- 插入 ---------------- */

  /** 把新块插到第 index 块前面（index = 块数时插到末尾） */
  function insertAt(list, index, els) {
    var body = S.doc.body()
    var ref, parent
    if (index < list.length) {
      ref = list[index]
      parent = ref.parentNode
    } else if (list.length) {
      var last = list[list.length - 1]
      parent = last.parentNode
      ref = last.nextSibling
      // 末尾：放在 sectPr 前面
      if (parent === body) ref = kid(body, 'sectPr')
    } else {
      parent = body
      ref = kid(body, 'sectPr')
    }
    els.forEach(function (e) {
      parent.insertBefore(e, ref)
    })
  }
  function isEmptyDoc(list) {
    return list.length === 1 && list[0].localName === 'p' && !M.paraText(list[0], true) && !kid(kid(list[0], 'pPr'), 'sectPr')
  }
  function ensureTrailingPara() {
    var body = S.doc.body()
    var list = blocks()
    var last = list[list.length - 1]
    if (!last || last.localName === 'tbl') body.insertBefore(M.wel(S.doc.xml, 'p'), kid(body, 'sectPr'))
  }
  function where(a, list) {
    if (a.after != null && a.before != null) throw new Error('Use either `after` or `before`, not both')
    if (a.after != null) return Number(a.after) === 0 ? 0 : blockArg(a.after, list) + 1
    if (a.before != null) return blockArg(a.before, list)
    return list.length
  }

  studio.tools.register('insertContent', function (a) {
    needDoc()
    if (typeof a.markdown !== 'string') throw new Error('`markdown` is required')
    var list = blocks()
    var index
    var replaced = 0
    if (a.replace != null) {
      var idx = rangeArg(a.replace, list)
      index = idx[0]
      idx.forEach(function (i) {
        list[i].parentNode.removeChild(list[i])
      })
      replaced = idx.length
      list = blocks()
    } else index = where(a, list)
    var els = S.doc.fromMarkdown(a.markdown, { style: a.style })
    if (!els.length) throw new Error('Nothing to insert')
    var empty = isEmptyDoc(list) && a.replace == null
    insertAt(list, index, els)
    if (empty) list[0].parentNode.removeChild(list[0])
    ensureTrailingPara()
    var now = blocks()
    var first = now.indexOf(els[0]) + 1
    var lastN = now.indexOf(els[els.length - 1]) + 1
    after()
    return { inserted: first === lastN ? 'block ' + first : 'blocks ' + first + '-' + lastN, replaced: replaced || undefined, blocks: now.length }
  })

  studio.tools.register('replaceText', function (a) {
    needDoc()
    if (typeof a.find !== 'string' || !a.find) throw new Error('`find` is required')
    var rep = a.replace == null ? '' : String(a.replace)
    var flags = 'g' + (a.matchCase ? '' : 'i')
    var re
    try {
      re = a.regex ? new RegExp(a.find, flags) : new RegExp((a.wholeWord ? '\\b' : '') + M.escRe(a.find) + (a.wholeWord ? '\\b' : ''), flags)
    } catch (e) {
      throw new Error('Invalid regular expression: ' + e.message)
    }
    var scope = a.blocks ? rangeArg(a.blocks).map(function (i) { return blocks()[i] }) : [S.doc.body()]
    var n = 0
    var limit = a.all === false ? 1 : 0
    scope.forEach(function (root) {
      var ps = root.localName === 'p' ? [root] : OX.desc(root, 'p')
      ps.forEach(function (p) {
        if (limit && n >= limit) return
        n += M.replaceInPara(p, new RegExp(re.source, re.flags), a.regex ? rep : function () { return rep }, limit ? limit - n : 0)
      })
    })
    if (n) after()
    return { replaced: n }
  })

  /* ---------------- 段落 ---------------- */

  function applyRunFormat(rPr, a) {
    var tog = function (names, v) {
      if (v == null) return
      names.forEach(function (n) {
        OX.removeKid(rPr, n)
        var el = M.ensureW(rPr, n, M.RPR_ORDER)
        if (!v) M.setW(el, 'val', '0')
      })
    }
    tog(['b', 'bCs'], a.bold)
    tog(['i', 'iCs'], a.italic)
    tog(['strike'], a.strike)
    if (a.underline != null) M.setW(M.ensureW(rPr, 'u', M.RPR_ORDER), 'val', a.underline ? 'single' : 'none')
    if (a.color !== undefined) {
      OX.removeKid(rPr, 'color')
      var c = hex(a.color)
      if (c) M.setW(M.ensureW(rPr, 'color', M.RPR_ORDER), 'val', c)
    }
    if (a.highlight !== undefined) {
      OX.removeKid(rPr, 'highlight')
      OX.removeKid(rPr, 'shd')
      var hc = hex(a.highlight)
      if (hc) {
        var shd = M.ensureW(rPr, 'shd', M.RPR_ORDER)
        M.setW(shd, 'val', 'clear')
        M.setW(shd, 'color', 'auto')
        M.setW(shd, 'fill', hc)
      }
    }
    if (a.size != null) {
      var v = Math.round(Number(a.size) * 2)
      if (!(v > 0)) throw new Error('Invalid size')
      M.setW(M.ensureW(rPr, 'sz', M.RPR_ORDER), 'val', v)
      M.setW(M.ensureW(rPr, 'szCs', M.RPR_ORDER), 'val', v)
    }
    if (a.font) {
      var rf = M.ensureW(rPr, 'rFonts', M.RPR_ORDER)
      ;['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme'].forEach(function (k) { M.setW(rf, k, null) })
      M.setW(rf, 'ascii', a.font)
      M.setW(rf, 'hAnsi', a.font)
      if (/[㐀-鿿]/.test(a.font) || /^(SimSun|SimHei|KaiTi|FangSong|Microsoft YaHei|DengXian)/i.test(a.font)) M.setW(rf, 'eastAsia', a.font)
    }
  }
  function hasRunFormat(a) {
    return ['bold', 'italic', 'underline', 'strike', 'color', 'highlight', 'size', 'font'].some(function (k) { return a[k] !== undefined })
  }
  function runsOf(p) {
    return OX.desc(p, 'r').filter(function (r) {
      // 文本框等图形里的段落不算
      for (var x = r.parentNode; x && x !== p; x = x.parentNode) if (x.localName === 'txbxContent' || x.localName === 'drawing') return false
      return true
    })
  }
  function setParaText(p, text) {
    var first = runsOf(p).filter(function (r) { return kid(r, 't') })[0]
    var base = first && kid(first, 'rPr') ? kid(first, 'rPr').cloneNode(true) : null
    var pPr = kid(p, 'pPr')
    Array.prototype.slice.call(p.childNodes).forEach(function (c) {
      if (c !== pPr) p.removeChild(c)
    })
    S.doc.appendRuns(p, text, base)
  }

  studio.tools.register('editParagraphs', function (a) {
    needDoc()
    var list = blocks()
    var idx = rangeArg(a.blocks != null ? a.blocks : a.paragraphs, list)
    var doc = S.doc
    var styleId = a.style != null && a.style !== '' ? doc.styleArg(a.style) : undefined
    var listNum = null
    if (a.list && a.list !== 'none') {
      var first = list[idx[0]]
      var prev = first.previousElementSibling
      var pnp = prev && prev.localName === 'p' ? doc.numPrOf(doc.pProps(prev)) : null
      var kind = a.list === 'number' || a.list === 'numbered' ? 'number' : 'bullet'
      listNum = pnp && doc.listKind(pnp.numId) === kind && a.continueList !== false ? pnp.numId : doc.addList(kind === 'bullet' ? 'bullet' : 'decimal')
    }
    var changed = 0
    var skipped = []
    idx.forEach(function (i) {
      var p = list[i]
      if (p.localName !== 'p') {
        // 表格：只能改里面文字的格式
        if (hasRunFormat(a)) {
          OX.desc(p, 'p').forEach(function (cp) {
            runsOf(cp).forEach(function (r) { applyRunFormat(M.rPrOf(r, true), a) })
          })
          changed++
        } else skipped.push(i + 1)
        return
      }
      if (typeof a.text === 'string') setParaText(p, a.text)
      var pPr = M.pPrOf(p, true)
      if (styleId !== undefined) {
        OX.removeKid(pPr, 'pStyle')
        if (styleId && styleId !== doc.styles().defP) M.setW(M.ensureW(pPr, 'pStyle', M.PPR_ORDER), 'val', styleId)
      }
      if (a.align) {
        var map = { left: 'left', center: 'center', right: 'right', justify: 'both', distribute: 'distribute' }
        if (!map[a.align]) throw new Error('align must be left, center, right or justify')
        M.setW(M.ensureW(pPr, 'jc', M.PPR_ORDER), 'val', map[a.align])
      }
      if (a.list === 'none') doc.setNumbering(p, null)
      else if (listNum) doc.setNumbering(p, listNum, Math.max(0, Math.min(8, (a.level || 1) - 1)))
      else if (a.level != null) {
        var np = doc.numPrOf(doc.pProps(p))
        if (np) doc.setNumbering(p, np.numId, Math.max(0, Math.min(8, a.level - 1)))
      }
      if (a.indentLeft != null || a.firstLineIndent != null) {
        var ind = M.ensureW(pPr, 'ind', M.PPR_ORDER)
        if (a.indentLeft != null) {
          M.setW(ind, 'left', Math.round(a.indentLeft * 20))
          M.setW(ind, 'start', null)
          M.setW(ind, 'leftChars', null)
        }
        if (a.firstLineIndent != null) {
          ;['firstLine', 'hanging', 'firstLineChars', 'hangingChars'].forEach(function (k) { M.setW(ind, k, null) })
          if (a.firstLineIndent >= 0) M.setW(ind, 'firstLine', Math.round(a.firstLineIndent * 20))
          else M.setW(ind, 'hanging', Math.round(-a.firstLineIndent * 20))
        }
      }
      if (a.spacingBefore != null || a.spacingAfter != null || a.lineSpacing != null) {
        var sp = M.ensureW(pPr, 'spacing', M.PPR_ORDER)
        if (a.spacingBefore != null) {
          M.setW(sp, 'before', Math.round(a.spacingBefore * 20))
          M.setW(sp, 'beforeLines', null)
          M.setW(sp, 'beforeAutospacing', null)
        }
        if (a.spacingAfter != null) {
          M.setW(sp, 'after', Math.round(a.spacingAfter * 20))
          M.setW(sp, 'afterLines', null)
          M.setW(sp, 'afterAutospacing', null)
        }
        if (a.lineSpacing != null) {
          M.setW(sp, 'line', Math.round(a.lineSpacing * 240))
          M.setW(sp, 'lineRule', 'auto')
        }
      }
      if (a.pageBreakBefore != null) {
        OX.removeKid(pPr, 'pageBreakBefore')
        if (a.pageBreakBefore) M.ensureW(pPr, 'pageBreakBefore', M.PPR_ORDER)
      }
      if (hasRunFormat(a)) {
        runsOf(p).forEach(function (r) { applyRunFormat(M.rPrOf(r, true), a) })
        applyRunFormat(M.ensureW(pPr, 'rPr', M.PPR_ORDER), a)
      }
      if (!pPr.firstElementChild) p.removeChild(pPr)
      changed++
    })
    after()
    var res = { changed: changed }
    if (skipped.length) res.note = 'Blocks ' + skipped.join(', ') + ' are tables: only text formatting (bold, color, size…) applies to them; use docx_editTable for their content.'
    return res
  })

  studio.tools.register('deleteBlocks', function (a) {
    needDoc()
    var list = blocks()
    var idx = rangeArg(a.blocks, list)
    idx.forEach(function (i) {
      var el = list[i]
      // 带分节符的段落：把分节符留给前一个段落
      var sp = OX.path(el, 'pPr', 'sectPr')
      if (sp) {
        var prev = list[i - 1]
        if (prev && prev.localName === 'p' && idx.indexOf(i - 1) < 0 && !OX.path(prev, 'pPr', 'sectPr')) M.ensureW(M.pPrOf(prev, true), 'sectPr', M.PPR_ORDER).replaceWith(sp.cloneNode(true))
      }
      el.parentNode.removeChild(el)
    })
    // 内容控件被删空时一起删掉
    OX.desc(S.doc.body(), 'sdtContent').forEach(function (c) {
      if (!c.firstElementChild && c.parentNode && c.parentNode.parentNode) c.parentNode.parentNode.removeChild(c.parentNode)
    })
    ensureTrailingPara()
    after()
    return { deleted: idx.length, blocks: blocks().length }
  })

  /* ---------------- 表格 ---------------- */

  function tableArg(n) {
    var list = blocks()
    var i = blockArg(n, list)
    if (list[i].localName !== 'tbl') throw new Error('Block ' + n + ' is not a table')
    return list[i]
  }
  function grid(tbl) {
    return kids(kid(tbl, 'tblGrid'), 'gridCol')
  }
  function insertRowAt(tbl, index, texts) {
    var rows = kids(tbl, 'tr')
    var like = rows[Math.min(index, rows.length - 1)] || rows[rows.length - 1]
    var nr = M.wel(S.doc.xml, 'tr')
    if (like) {
      var trPr = kid(like, 'trPr')
      if (trPr) {
        var tp = trPr.cloneNode(true)
        OX.removeKid(tp, 'tblHeader')
        nr.appendChild(tp)
      }
      kids(like, 'tc').forEach(function (tc, ci) {
        var nc = UI.emptyCellLike(tc)
        var span = OX.path(tc, 'tcPr', 'gridSpan')
        if (span) M.ensureW(kid(nc, 'tcPr'), 'gridSpan', M.TCPR_ORDER).replaceWith(span.cloneNode(true))
        nr.appendChild(nc)
      })
    } else {
      grid(tbl).forEach(function () { nr.appendChild(S.doc.newCell('', 0)) })
    }
    // 只插在顶层行之间
    var ref = rows[index] || null
    if (!ref) {
      var last = rows[rows.length - 1]
      ref = last ? last.nextSibling : null
    }
    tbl.insertBefore(nr, ref)
    if (texts) kids(nr, 'tc').forEach(function (tc, ci) { if (texts[ci] != null) setCell(tc, texts[ci]) })
    return nr
  }
  function insertColAt(tbl, g) {
    var gridEl = kid(tbl, 'tblGrid')
    var cols = grid(tbl)
    var total = cols.reduce(function (s, x) { return s + M.wnum(x, 'w', 0) }, 0) || S.doc.textWidthEmu() / 635
    var n = cols.length
    cols.forEach(function (x) { M.setW(x, 'w', Math.round((M.wnum(x, 'w', 0) * n) / (n + 1))) })
    gridEl.insertBefore(M.wel(S.doc.xml, 'gridCol', { w: Math.round(total / (n + 1)) }), cols[g] || null)
    kids(tbl, 'tr').forEach(function (tr) {
      var cells = UI.cellsOfRow(tr)
      var at = cells.filter(function (x) { return x.col === g })[0]
      var inside = cells.filter(function (x) { return x.col < g && x.col + x.span > g })[0]
      if (inside) {
        M.setW(M.ensureW(M.ensureW(inside.tc, 'tcPr', ['tcPr']), 'gridSpan', M.TCPR_ORDER), 'val', inside.span + 1)
        return
      }
      var like = at ? at.tc : cells.length ? cells[cells.length - 1].tc : null
      var nc = like ? UI.emptyCellLike(like) : S.doc.newCell('', 0)
      tr.insertBefore(nc, at ? at.tc : cells.length ? cells[cells.length - 1].tc.nextSibling : null)
    })
  }
  function deleteColAt(tbl, g) {
    var gridEl = kid(tbl, 'tblGrid')
    var cols = grid(tbl)
    var total = cols.reduce(function (s, x) { return s + M.wnum(x, 'w', 0) }, 0)
    var removed = cols[g] ? M.wnum(cols[g], 'w', 0) : 0
    if (cols[g]) gridEl.removeChild(cols[g])
    var rest = grid(tbl)
    if (total - removed > 0) rest.forEach(function (x) { M.setW(x, 'w', Math.round((M.wnum(x, 'w', 0) * total) / (total - removed))) })
    kids(tbl, 'tr').forEach(function (tr) {
      var hit = UI.cellsOfRow(tr).filter(function (x) { return x.col <= g && x.col + x.span > g })[0]
      if (!hit) return
      if (hit.span > 1) M.setW(OX.path(hit.tc, 'tcPr', 'gridSpan'), 'val', hit.span - 1)
      else tr.removeChild(hit.tc)
      if (!kids(tr, 'tc').length) tbl.removeChild(tr)
    })
  }
  /** 单元格文字（\n 分段；行内 Markdown） */
  function setCell(tc, text) {
    var ps = kids(tc, 'p')
    var p0 = ps[0]
    var pPr = p0 ? kid(p0, 'pPr') : null
    var r0 = p0 ? runsOf(p0).filter(function (r) { return kid(r, 't') })[0] : null
    var base = r0 && kid(r0, 'rPr') ? kid(r0, 'rPr').cloneNode(true) : null
    // 只换段落，保留单元格里的其他内容（tcPr）
    kids(tc).forEach(function (c) {
      if (c.localName === 'p' || c.localName === 'tbl') tc.removeChild(c)
    })
    String(text == null ? '' : text)
      .split('\n')
      .forEach(function (line) {
        var p = M.wel(S.doc.xml, 'p')
        if (pPr) p.appendChild(pPr.cloneNode(true))
        S.doc.appendRuns(p, line, base)
        tc.appendChild(p)
      })
  }
  function cellAtGrid(tr, col) {
    var hit = UI.cellsOfRow(tr).filter(function (x) { return x.col <= col && x.col + x.span > col })[0]
    return hit ? hit.tc : null
  }

  studio.tools.register('editTable', function (a) {
    needDoc()
    var tbl = tableArg(a.table)
    var action = a.action
    var count = Math.max(1, Math.floor(Number(a.count) || 1))
    var rows = kids(tbl, 'tr')
    var nCols = grid(tbl).length
    if (action === 'setCells') {
      if (!Array.isArray(a.cells)) throw new Error('`cells` (rows of cell texts) is required')
      var r0 = Math.max(1, Math.floor(Number(a.row) || 1)) - 1
      var c0 = Math.max(1, Math.floor(Number(a.column) || 1)) - 1
      var needCols = c0 + a.cells.reduce(function (m, r) { return Math.max(m, (r || []).length) }, 0)
      while (grid(tbl).length < needCols) insertColAt(tbl, grid(tbl).length)
      while (kids(tbl, 'tr').length < r0 + a.cells.length) insertRowAt(tbl, kids(tbl, 'tr').length)
      var trs = kids(tbl, 'tr')
      a.cells.forEach(function (row, ri) {
        ;(row || []).forEach(function (text, ci) {
          if (text == null) return
          var tc = cellAtGrid(trs[r0 + ri], c0 + ci)
          if (tc) setCell(tc, String(text))
        })
      })
      if (a.header != null) {
        var trPr = M.ensureW(trs[0], 'trPr', ['trPr'])
        if (trs[0].firstChild !== trPr) trs[0].insertBefore(trPr, trs[0].firstChild)
        OX.removeKid(trPr, 'tblHeader')
        if (a.header) {
          trPr.appendChild(M.wel(S.doc.xml, 'tblHeader'))
          kids(trs[0], 'tc').forEach(function (tc) {
            kids(tc, 'p').forEach(function (p) { runsOf(p).forEach(function (r) { applyRunFormat(M.rPrOf(r, true), { bold: true }) }) })
          })
        }
        if (!trPr.firstElementChild) trs[0].removeChild(trPr)
      }
    } else if (action === 'insertRows') {
      var at = a.row != null ? Math.max(1, Math.min(rows.length + 1, Math.floor(Number(a.row)))) - 1 : rows.length
      for (var i = 0; i < count; i++) insertRowAt(tbl, at + i, a.cells && a.cells[i])
    } else if (action === 'deleteRows') {
      if (a.row == null) throw new Error('`row` is required')
      var from = Math.floor(Number(a.row)) - 1
      if (from < 0 || from >= rows.length) throw new Error('Row ' + a.row + ' does not exist (the table has ' + rows.length + ' rows)')
      rows.slice(from, from + count).forEach(function (tr) { tbl.removeChild(tr) })
    } else if (action === 'insertColumns') {
      var g = a.column != null ? Math.max(1, Math.min(nCols + 1, Math.floor(Number(a.column)))) - 1 : nCols
      for (var j = 0; j < count; j++) insertColAt(tbl, g + j)
    } else if (action === 'deleteColumns') {
      if (a.column == null) throw new Error('`column` is required')
      var c = Math.floor(Number(a.column)) - 1
      if (c < 0 || c >= nCols) throw new Error('Column ' + a.column + ' does not exist (the table has ' + nCols + ' columns)')
      for (var k = 0; k < count && grid(tbl).length > c; k++) deleteColAt(tbl, c)
    } else if (action === 'delete') {
      tbl.parentNode.removeChild(tbl)
      ensureTrailingPara()
      after()
      return { deleted: true }
    } else throw new Error('Unknown action "' + action + '" (setCells, insertRows, deleteRows, insertColumns, deleteColumns, delete)')
    if (!kids(tbl, 'tr').length || !grid(tbl).length) {
      tbl.parentNode.removeChild(tbl)
      ensureTrailingPara()
      after()
      return { deleted: true, note: 'The table became empty and was removed' }
    }
    UI.fixWidths(tbl)
    after()
    return { rows: kids(tbl, 'tr').length, columns: grid(tbl).length }
  })

  /* ---------------- 图片 ---------------- */

  studio.tools.register('insertImage', async function (a) {
    needDoc()
    var path = toolPath(a.path)
    var buf = await studio.fs.read(path)
    var bytes = new Uint8Array(buf)
    var ext = OX.extOf(path)
    var mime = OX.MIME[ext] || ''
    if (!/^image\//.test(mime) || /emf|wmf|tif/.test(ext)) throw new Error('Unsupported image type: .' + ext + ' (use png, jpg, gif, bmp, webp or svg)')
    var img = await UI.prepareImage(bytes, mime, path.split('/').pop(), a.width ? Number(a.width) : 0)
    var run = S.doc.pictureRun(img.rId, img.cx, img.cy, path.split('/').pop())
    var list = blocks()
    var index = where(a, list)
    var p = S.doc.newPara('', { align: { left: 'left', center: 'center', right: 'right' }[a.align || 'center'] || 'center' })
    p.appendChild(run)
    var els = [p]
    if (a.caption) els.push(S.doc.newPara(a.caption, { align: 'center', style: S.doc.styleByName('caption') ? S.doc.styleByName('caption').id : null }))
    insertAt(list, index, els)
    var n = blocks().indexOf(p) + 1
    after()
    return { inserted: 'block ' + n, width: r1(img.cx / 12700), height: r1(img.cy / 12700), unit: 'pt' }
  })

  /* ---------------- 截图 ---------------- */

  studio.tools.register('screenshot', function (a) {
    needDoc()
    var list = blocks()
    if (a.block != null) {
      var i = blockArg(a.block, list)
      var x = list[i]
      var el = Array.prototype.filter.call(Ed.docEl.querySelectorAll('p.p, table.tbl'), function (e) { return e._x === x })[0]
      if (el) {
        var wrap = Ed.$('wrap')
        wrap.scrollTop += el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - 16
      }
      return 'Showing block ' + (i + 1) + ' of ' + list.length
    }
    return 'Document with ' + list.length + ' blocks'
  })

  /* ---------------- 入口 ---------------- */

  var askDone = false
  function registerAsk() {
    if (askDone || !studio.has('agent.send')) return
    askDone = true
    studio.commands
      .register('ask-ai', t('把选中的文字发给 AI 助手', 'Send the selected text to the AI assistant'), function () {
        var r = Ed.selRange()
        var text = r && !r.collapsed ? r.toString() : ''
        if (!text) {
          var p = r ? Ed.paraOf(r.startContainer) : null
          text = p ? Ed.textOf(p).replace(/￼/g, '') : ''
        }
        studio.agent.send(text ? '> ' + text.replace(/\n/g, '\n> ') + '\n' : '', { file: true }).catch(function (e) {
          studio.toast(e.message)
        })
      })
      .catch(function () {})
  }

  UI.init()
  studio.onLoad(function (content, info) {
    registerAsk()
    return Ed.load(content, info)
  })
  studio.onSave(async function () {
    Ed.flushTyping()
    if (!S.doc) throw new Error(t('没有可保存的内容', 'Nothing to save'))
    var bytes = await S.doc.save()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  })
})()
