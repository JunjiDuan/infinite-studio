/**
 * 把一张幻灯片渲染成 DOM（1 px = 9525 EMU，即 96 dpi）。
 * 形状几何用 SVG，文本用 HTML（方便直接 contenteditable 编辑）。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var Geom = window.Geom
  var EMU = 9525
  var SVG = 'http://www.w3.org/2000/svg'
  var uid = 0

  /** .tb 文本元素 → { txBody, ... }，编辑器用它找到对应的 XML */
  var textMap = new WeakMap()

  function el(tag, cls, style) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (style) Object.assign(e.style, style)
    return e
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG, tag)
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k])
    return e
  }

  /* ---------------- 几何 / 坐标 ---------------- */

  function xfrmBox(x) {
    if (!x) return null
    var off = OX.kid(x, 'off')
    var ext = OX.kid(x, 'ext')
    return {
      x: OX.num(off, 'x', 0),
      y: OX.num(off, 'y', 0),
      w: OX.num(ext, 'cx', 0),
      h: OX.num(ext, 'cy', 0),
      rot: OX.num(x, 'rot', 0) / 60000,
      flipH: OX.bool(x, 'flipH', false),
      flipV: OX.bool(x, 'flipV', false)
    }
  }
  function map0(b) {
    return { x: b.x / EMU, y: b.y / EMU, w: b.w / EMU, h: b.h / EMU, rot: b.rot, flipH: b.flipH, flipV: b.flipV }
  }
  function place(node, b) {
    node.style.left = b.x + 'px'
    node.style.top = b.y + 'px'
    node.style.width = Math.max(b.w, 0) + 'px'
    node.style.height = Math.max(b.h, 0) + 'px'
    if (b.rot) node.style.transform = 'rotate(' + b.rot + 'deg)'
  }

  /* ---------------- 字体 ---------------- */

  var SCRIPT = { zh: 'Hans', 'zh-tw': 'Hant', 'zh-hk': 'Hant', 'zh-mo': 'Hant', ja: 'Jpan', ko: 'Hang' }
  function scriptFont(set, lang) {
    if (set.ea || !lang) return set.ea
    var l = lang.toLowerCase()
    var sc = SCRIPT[l] || SCRIPT[l.split('-')[0]]
    return (sc && set.scripts && set.scripts[sc]) || ''
  }
  function fontName(tf, ctx, lang) {
    if (!tf) return ''
    var f = ctx.theme.fonts
    switch (tf) {
      case '+mj-lt':
        return f.major.latin
      case '+mn-lt':
        return f.minor.latin
      case '+mj-ea':
        return scriptFont(f.major, lang)
      case '+mn-ea':
        return scriptFont(f.minor, lang)
      case '+mj-cs':
        return f.major.cs
      case '+mn-cs':
        return f.minor.cs
    }
    return tf
  }
  function family(latin, ea) {
    var out = []
    ;[latin, ea].forEach(function (n) {
      if (n && out.indexOf(n) < 0) out.push(n)
    })
    return (
      out
        .map(function (n) {
          return '"' + n.replace(/"/g, '') + '"'
        })
        .concat(['"Segoe UI"', '"Microsoft YaHei"', '"PingFang SC"', 'sans-serif'])
        .join(', ')
    )
  }

  /* ---------------- 文本 ---------------- */

  function lvlOf(lst, n) {
    return OX.kid(lst, 'lvl' + n + 'pPr')
  }
  function firstAttr(list, name) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].hasAttribute(name)) return list[i].getAttribute(name)
    return null
  }
  function firstKid(list, names) {
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue
      for (var c = list[i].firstElementChild; c; c = c.nextElementSibling) if (names.indexOf(c.localName) >= 0) return c
    }
    return null
  }
  function spc(el, fontPt) {
    if (!el) return null
    var p = OX.kid(el, 'spcPts')
    if (p) return (OX.num(p, 'val', 0) / 100) * (4 / 3)
    var q = OX.kid(el, 'spcPct')
    if (q) return (OX.num(q, 'val', 0) / 100000) * fontPt * (4 / 3) * 1.2
    return null
  }

  var ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  function roman(n) {
    var s = ''
    ROMAN.forEach(function (r) {
      while (n >= r[0]) (s += r[1]), (n -= r[0])
    })
    return s
  }
  var CHS = '零一二三四五六七八九十'
  function autoNum(scheme, n) {
    var alpha = String.fromCharCode(97 + ((n - 1) % 26))
    var m = /^(arabic|alphaLc|alphaUc|romanLc|romanUc|circleNum|ea1Chs|ea1ChtPeriod)(.*)$/.exec(scheme || 'arabicPeriod')
    var kind = m ? m[1] : 'arabic'
    var suf = m ? m[2] : 'Period'
    var core = kind === 'alphaLc' ? alpha : kind === 'alphaUc' ? alpha.toUpperCase() : kind === 'romanLc' ? roman(n) : kind === 'romanUc' ? roman(n).toUpperCase() : kind === 'circleNum' ? String.fromCharCode(0x2460 + n - 1) : kind === 'ea1Chs' ? (n <= 10 ? CHS[n] : String(n)) : String(n)
    if (kind === 'circleNum') return core
    if (kind === 'ea1Chs') return core + (suf.indexOf('Period') >= 0 ? '、' : '.')
    if (/ParenBoth/.test(suf)) return '(' + core + ')'
    if (/ParenR/.test(suf)) return core + ')'
    if (/Plain/.test(suf)) return core
    if (/Minus/.test(suf)) return '-' + core + '-'
    return core + '.'
  }

  /**
   * 解析一个 run 的样式。rList：[run 的 rPr, 段落层级 defRPr...]，special：fontRef / 表格样式层（插在 ownCount 之后）
   */
  function runProps(rList, ownCount, special, ctx, fontScale) {
    var list = rList
    function a(name) {
      return firstAttr(list, name)
    }
    var sz = a('sz')
    var out = {
      sz: (sz != null ? Number(sz) / 100 : 18) * (fontScale || 1),
      b: a('b') === '1' || a('b') === 'true',
      i: a('i') === '1' || a('i') === 'true',
      u: a('u') && a('u') !== 'none',
      strike: a('strike') && a('strike') !== 'noStrike',
      baseline: Number(a('baseline') || 0),
      cap: a('cap') || 'none',
      spc: Number(a('spc') || 0)
    }
    if (special && special.bold && firstAttr(list.slice(0, ownCount), 'b') == null) out.b = true
    // 颜色：自己的层级优先，然后 fontRef / 表格样式，然后继承的
    var own = list.slice(0, ownCount)
    var rest = list.slice(ownCount)
    var c = null
    var fe = firstKid(own, OX.FILL_NAMES)
    if (fe) c = fe
    var col = null
    if (c) col = fillColor(OX.fill(c, ctx))
    if (!col && special && special.color) col = special.color
    if (!col) {
      var fe2 = firstKid(rest, OX.FILL_NAMES)
      if (fe2) col = fillColor(OX.fill(fe2, ctx))
    }
    if (!col) col = { hex: '#' + (OX.schemeHex('tx1', ctx) || '000000'), alpha: 1 }
    out.color = col
    var latin = firstKid(own, ['latin'])
    var ea = firstKid(own, ['ea'])
    var lf = latin ? OX.attr(latin, 'typeface') : special && special.font ? special.font + '-lt' : null
    var ef = ea ? OX.attr(ea, 'typeface') : special && special.font ? special.font + '-ea' : null
    if (!lf) lf = OX.attr(firstKid(rest, ['latin']), 'typeface', '+mn-lt')
    if (!ef) ef = OX.attr(firstKid(rest, ['ea']), 'typeface', '+mn-ea')
    var lang = a('lang') || a('altLang')
    out.latin = fontName(lf, ctx)
    out.ea = fontName(ef, ctx, lang)
    var hl = firstKid(own, ['highlight'])
    if (hl) out.highlight = OX.color(hl, ctx)
    return out
  }
  function fillColor(f) {
    if (!f) return null
    if (f.type === 'solid') return f.color
    if (f.type === 'grad') return f.stops[0].color
    if (f.type === 'none') return { hex: '#000000', alpha: 0 }
    return null
  }
  function runCss(span, p) {
    var s = span.style
    s.fontSize = ((p.sz * 4) / 3).toFixed(2) + 'px'
    if (p.b) s.fontWeight = '700'
    if (p.i) s.fontStyle = 'italic'
    var deco = []
    if (p.u) deco.push('underline')
    if (p.strike) deco.push('line-through')
    if (deco.length) s.textDecoration = deco.join(' ')
    s.color = OX.css(p.color)
    s.fontFamily = family(p.latin, p.ea)
    if (p.baseline) {
      s.verticalAlign = p.baseline > 0 ? 'super' : 'sub'
      s.fontSize = ((p.sz * 4 * 0.65) / 3).toFixed(2) + 'px'
    }
    if (p.cap === 'all') s.textTransform = 'uppercase'
    else if (p.cap === 'small') s.fontVariant = 'small-caps'
    if (p.spc) s.letterSpacing = ((p.spc / 100) * (4 / 3)).toFixed(2) + 'px'
    if (p.highlight) s.backgroundColor = OX.css(p.highlight)
  }

  var BASE_STYLE = { title: 'titleStyle', ctrTitle: 'titleStyle', body: 'bodyStyle', subTitle: 'bodyStyle', obj: 'bodyStyle', tbl: 'bodyStyle', chart: 'bodyStyle', dgm: 'bodyStyle', media: 'bodyStyle', clipArt: 'bodyStyle', pic: 'bodyStyle' }

  /**
   * 渲染文本框。info: { sp, chainEls, ph, fontRef, table, inline, geomText }
   * 返回 .tx 容器
   */
  function renderText(txBody, info, ctx) {
    var pkg = ctx.pkg
    var chainEls = info.chainEls || []
    var bodyPrs = [OX.kid(txBody, 'bodyPr')].concat(
      chainEls.map(function (s) {
        return OX.path(s, 'txBody', 'bodyPr')
      })
    )
    function bp(name, def) {
      var v = firstAttr(bodyPrs, name)
      return v == null ? def : v
    }
    var ownBody = bodyPrs[0]
    var lstOwn = OX.kid(txBody, 'lstStyle')
    var lists = [lstOwn].concat(
      chainEls.map(function (s) {
        return OX.path(s, 'txBody', 'lstStyle')
      })
    )
    var ownCount = 1
    // 母版 txStyles / 演示文稿默认样式
    var mroot = ctx.chain.master ? pkg.root(ctx.chain.master) : null
    if (info.ph) {
      var bs = BASE_STYLE[info.ph.type] || 'otherStyle'
      lists.push(OX.path(mroot, 'txStyles', bs))
    }
    lists.push(OX.path(ctx.pres.root(), 'defaultTextStyle'))

    var special = null
    if (info.table) special = info.table
    else if (info.fontRef) {
      var fc = OX.color(info.fontRef, ctx)
      special = { color: fc, font: OX.attr(info.fontRef, 'idx', '') === 'major' ? '+mj' : OX.attr(info.fontRef, 'idx', '') === 'minor' ? '+mn' : null }
      if (!fc && !special.font) special = null
    }

    var norm = OX.kid(ownBody, 'normAutofit')
    var fontScale = norm ? OX.num(norm, 'fontScale', 100000) / 100000 : 1
    var lnRed = norm ? OX.num(norm, 'lnSpcReduction', 0) / 100000 : 0

    var tx = el('div', 'tx')
    var ins = info.inline
      ? info.inline
      : {
          l: Number(bp('lIns', 91440)) / EMU,
          t: Number(bp('tIns', 45720)) / EMU,
          r: Number(bp('rIns', 91440)) / EMU,
          b: Number(bp('bIns', 45720)) / EMU
        }
    var g = info.geomText || { l: 0, t: 0, r: 0, b: 0 }
    tx.style.padding = ins.t + g.t + 'px ' + (ins.r + g.r) + 'px ' + (ins.b + g.b) + 'px ' + (ins.l + g.l) + 'px'
    var anchor = info.anchor || bp('anchor', 't')
    tx.style.justifyContent = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'
    if (info.inline) tx.classList.add('inline')
    var vert = bp('vert', 'horz')
    var tb = el('div', 'tb')
    if (bp('wrap', 'square') === 'none') tb.style.whiteSpace = 'pre'
    if (vert === 'vert' || vert === 'eaVert' || vert === 'wordArtVertRtl' || vert === 'mongolianVert') tb.style.writingMode = 'vertical-rl'
    else if (vert === 'vert270') {
      tb.style.writingMode = 'vertical-rl'
      tb.style.transform = 'rotate(180deg)'
    }
    tx.appendChild(tb)

    var counters = {}
    OX.kids(txBody, 'p').forEach(function (p, pi) {
      var pPr = OX.kid(p, 'pPr')
      var lvl = OX.num(pPr, 'lvl', 0) + 1
      var lv = lists.map(function (l) {
        return lvlOf(l, lvl)
      })
      var pList = [pPr].concat(lv)
      var defR = [OX.kid(pPr, 'defRPr')].concat(
        lv.map(function (x) {
          return OX.kid(x, 'defRPr')
        })
      )
      var div = el('div', 'p')
      div.dataset.p = pi
      var algn = firstAttr(pList, 'algn') || 'l'
      div.style.textAlign = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify', justLow: 'justify', thaiDist: 'justify' }[algn] || 'left'
      var marL = Number(firstAttr(pList, 'marL') || 0) / EMU
      var indent = Number(firstAttr(pList, 'indent') || 0) / EMU
      if (marL) div.style.paddingLeft = marL + 'px'
      if (indent) div.style.textIndent = indent + 'px'

      var runs = OX.kids(p).filter(function (c) {
        return c.localName === 'r' || c.localName === 'br' || c.localName === 'fld'
      })
      var end = OX.kid(p, 'endParaRPr')
      // ownCount = 3：run rPr、段落 defRPr、自己 lstStyle 的层级；之后才轮到 fontRef / 表格样式
      var props = runs.map(function (r) {
        return runProps([OX.kid(r, 'rPr'), defR[0], defR[1]].concat(defR.slice(2)), 3, special, ctx, fontScale)
      })
      var endProps = runProps([end, defR[0], defR[1]].concat(defR.slice(2)), 3, special, ctx, fontScale)
      var base = runProps([null, defR[0], defR[1]].concat(defR.slice(2)), 3, special, ctx, fontScale)
      div.dataset.base = JSON.stringify({ sz: base.sz / fontScale, b: base.b, i: base.i, u: !!base.u, c: base.color.hex })
      var hasText = runs.some(function (r) {
        return r.localName !== 'br' && (OX.kid(r, 't') || {}).textContent
      })
      var firstSz = props.length ? props[0].sz : endProps.sz
      div.style.fontSize = ((firstSz * 4) / 3).toFixed(2) + 'px'
      div.style.fontFamily = family(endProps.latin, endProps.ea)

      // 行距
      var ls = firstKid(pList, ['lnSpc'])
      var maxSz = Math.max.apply(
        null,
        [firstSz].concat(
          props.map(function (q) {
            return q.sz
          })
        )
      )
      if (ls && OX.kid(ls, 'spcPts')) div.style.lineHeight = (OX.num(OX.kid(ls, 'spcPts'), 'val', 1200) / 100) * (4 / 3) * (1 - lnRed) + 'px'
      else {
        var pct = ls && OX.kid(ls, 'spcPct') ? OX.num(OX.kid(ls, 'spcPct'), 'val', 100000) / 100000 : 1
        div.style.lineHeight = String(Math.max(0.5, pct * 1.2 * (1 - lnRed)))
      }
      var sb = spc(firstKid(pList, ['spcBef']), maxSz)
      var sa = spc(firstKid(pList, ['spcAft']), maxSz)
      if (sb && pi > 0) div.style.marginTop = sb + 'px'
      if (sa) div.style.marginBottom = sa + 'px'

      // 项目符号
      for (var k in counters) if (Number(k) > lvl) delete counters[k]
      var bu = firstKid(pList, ['buNone', 'buAutoNum', 'buChar', 'buBlip'])
      if (bu && bu.localName === 'buAutoNum') {
        counters[lvl] = counters[lvl] && counters[lvl].scheme === OX.attr(bu, 'type') ? { scheme: counters[lvl].scheme, n: counters[lvl].n + 1 } : { scheme: OX.attr(bu, 'type'), n: OX.num(bu, 'startAt', 1) }
      } else delete counters[lvl]
      if (bu && hasText && bu.localName !== 'buNone') {
        var b = el('span', 'bu')
        b.contentEditable = 'false'
        var first = props[0] || endProps
        var bsz = first.sz
        var pctEl = firstKid(pList, ['buSzPct', 'buSzPts', 'buSzTx'])
        if (pctEl && pctEl.localName === 'buSzPct') bsz = (bsz * OX.num(pctEl, 'val', 100000)) / 100000
        else if (pctEl && pctEl.localName === 'buSzPts') bsz = OX.num(pctEl, 'val', 1800) / 100
        var bc = firstKid(pList, ['buClr', 'buClrTx'])
        var bcol = bc && bc.localName === 'buClr' ? OX.color(bc, ctx) : first.color
        var bf = firstKid(pList, ['buFont', 'buFontTx'])
        var bfont = bf && bf.localName === 'buFont' ? fontName(OX.attr(bf, 'typeface'), ctx) : first.latin
        var txt
        if (bu.localName === 'buChar') txt = OX.attr(bu, 'char', '•')
        else if (bu.localName === 'buAutoNum') txt = autoNum(OX.attr(bu, 'type'), counters[lvl].n)
        else txt = '•'
        // Wingdings 等符号字体在网页里不可用，换成常见字符
        if (/wingdings|symbol/i.test(bfont || '')) {
          txt = { '§': '■', 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'Ü': '➤', 'o': '□', 'ð': '➔', 'à': '→', 'è': '➔', '': '•' }[txt] || '•'
          bfont = ''
        }
        b.textContent = txt
        b.style.fontSize = ((bsz * 4) / 3).toFixed(2) + 'px'
        b.style.color = OX.css(bcol)
        if (bfont) b.style.fontFamily = family(bfont, '')
        if (indent < 0) b.style.minWidth = -indent + 'px'
        else b.style.paddingRight = '0.4em'
        div.appendChild(b)
      }

      runs.forEach(function (r, ri) {
        if (r.localName === 'br') {
          var br = document.createElement('br')
          br.dataset.r = ri
          div.appendChild(br)
          return
        }
        var s = el('span', 'r')
        s.dataset.r = ri
        var q = props[ri]
        runCss(s, q)
        s.dataset.b = q.b ? 1 : 0
        s.dataset.i = q.i ? 1 : 0
        s.dataset.u = q.u ? 1 : 0
        s.dataset.z = q.sz / fontScale
        s.dataset.c = q.color.hex
        var t = (OX.kid(r, 't') || {}).textContent || ''
        if (r.localName === 'fld') {
          var ft = OX.attr(r, 'type', '')
          if (ft === 'slidenum') t = String(ctx.slideNum || t)
          else if (/^datetime/.test(ft) && !t) t = new Date().toLocaleDateString()
          s.dataset.fld = '1'
        }
        s.textContent = t
        div.appendChild(s)
      })
      if (!hasText) {
        // 空段落也要占一行高度
        div.appendChild(document.createElement('br'))
        div.style.fontSize = ((endProps.sz * 4) / 3).toFixed(2) + 'px'
      }
      tb.appendChild(div)
    })
    textMap.set(tb, { txBody: txBody, part: ctx.part, fontScale: fontScale })
    return tx
  }

  /* ---------------- 填充 / 线条 → SVG ---------------- */

  function shade(c, k) {
    var rgb = OX.hexToRgb(c.hex).map(function (v) {
      return k > 0 ? v + (255 - v) * k : v * (1 + k)
    })
    return { hex: OX.rgbToHex(rgb), alpha: c.alpha }
  }

  function paint(svg, defs, f, mod) {
    if (!f || f.type === 'none') return 'none'
    if (f.type === 'solid') {
      var c = mod === 'darken' ? shade(f.color, -0.2) : mod === 'lighten' ? shade(f.color, 0.2) : f.color
      return OX.css(c)
    }
    var id = 'g' + ++uid
    if (f.type === 'grad') {
      var g
      if (f.path) g = svgEl('radialGradient', { id: id, cx: '50%', cy: '50%', r: '70%' })
      else g = svgEl('linearGradient', { id: id, x1: '0', y1: '0', x2: '1', y2: '0', gradientTransform: 'rotate(' + f.angle + ' 0.5 0.5)' })
      f.stops.forEach(function (s) {
        var c2 = mod === 'darken' ? shade(s.color, -0.2) : mod === 'lighten' ? shade(s.color, 0.2) : s.color
        g.appendChild(svgEl('stop', { offset: s.pos / 100, 'stop-color': c2.hex, 'stop-opacity': c2.alpha }))
      })
      defs.appendChild(g)
      return 'url(#' + id + ')'
    }
    if (f.type === 'img' && f.url) {
      var pat = svgEl('pattern', { id: id, width: 1, height: 1, patternContentUnits: 'objectBoundingBox' })
      pat.appendChild(svgEl('image', { href: f.url, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none' }))
      defs.appendChild(pat)
      return 'url(#' + id + ')'
    }
    return 'none'
  }

  var DASH = { dash: [4, 3], dot: [1, 1], sysDot: [1, 1], sysDash: [3, 1], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1] }

  function marker(defs, type, color, start) {
    if (!type || type === 'none') return null
    var id = 'm' + ++uid
    var m = svgEl('marker', { id: id, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 4, markerHeight: 4, orient: start ? 'auto-start-reverse' : 'auto', markerUnits: 'strokeWidth' })
    var shape
    if (type === 'oval') shape = svgEl('circle', { cx: 5, cy: 5, r: 4, fill: color })
    else if (type === 'diamond') shape = svgEl('path', { d: 'M5,0 L10,5 L5,10 L0,5 Z', fill: color })
    else if (type === 'arrow') shape = svgEl('path', { d: 'M0,0 L10,5 L0,10', fill: 'none', stroke: color, 'stroke-width': 1.5 })
    else if (type === 'stealth') shape = svgEl('path', { d: 'M0,0 L10,5 L0,10 L3,5 Z', fill: color })
    else shape = svgEl('path', { d: 'M0,0 L10,5 L0,10 Z', fill: color })
    m.setAttribute('refX', type === 'oval' || type === 'diamond' ? 5 : 8)
    m.appendChild(shape)
    defs.appendChild(m)
    return 'url(#' + id + ')'
  }

  function drawGeom(node, g, b, f, ln) {
    var svg = svgEl('svg', { class: 'geo', width: Math.max(b.w, 0.01), height: Math.max(b.h, 0.01), viewBox: '0 0 ' + Math.max(b.w, 0.01) + ' ' + Math.max(b.h, 0.01) })
    if (b.flipH || b.flipV) svg.style.transform = 'scale(' + (b.flipH ? -1 : 1) + ',' + (b.flipV ? -1 : 1) + ')'
    var defs = svgEl('defs')
    svg.appendChild(defs)
    var sw = ln ? Math.max(ln.w / EMU, 0.75) : 0
    var stroke = ln ? OX.css(ln.color) : 'none'
    g.paths.forEach(function (p, i) {
      var attrs = { d: p.d }
      attrs.fill = p.fill ? paint(svg, defs, f, typeof p.fill === 'string' ? p.fill : null) : 'none'
      if (p.evenodd) attrs['fill-rule'] = 'evenodd'
      if (ln && p.stroke) {
        attrs.stroke = stroke
        attrs['stroke-width'] = sw
        attrs['stroke-linejoin'] = 'round'
        if (ln.cap === 'rnd') attrs['stroke-linecap'] = 'round'
        if (ln.dash && DASH[ln.dash])
          attrs['stroke-dasharray'] = DASH[ln.dash]
            .map(function (v) {
              return v * sw
            })
            .join(' ')
        if (i === 0 || g.line) {
          var ms = marker(defs, ln.head, stroke, true)
          var me = marker(defs, ln.tail, stroke, false)
          if (ms) attrs['marker-start'] = ms
          if (me) attrs['marker-end'] = me
        }
      } else attrs.stroke = 'none'
      if (attrs.fill === 'none' && attrs.stroke === 'none') return
      svg.appendChild(svgEl('path', attrs))
    })
    node.appendChild(svg)
    return svg
  }

  function shadow(spPr, ctx) {
    var sh = OX.path(spPr, 'effectLst', 'outerShdw')
    if (!sh) return ''
    var c = OX.color(sh, ctx)
    if (!c) return ''
    var dist = OX.num(sh, 'dist', 0) / EMU
    var dir = (OX.num(sh, 'dir', 0) / 60000) * (Math.PI / 180)
    var blur = OX.num(sh, 'blurRad', 0) / EMU
    return 'drop-shadow(' + (dist * Math.cos(dir)).toFixed(1) + 'px ' + (dist * Math.sin(dir)).toFixed(1) + 'px ' + (blur / 2).toFixed(1) + 'px ' + OX.css(c) + ')'
  }

  /* ---------------- 形状 ---------------- */

  function chainOf(sp, ctx) {
    return OX.phOf(sp) ? OX.phChain(ctx.chain, sp, ctx.pkg) : []
  }
  function inheritedXfrm(sp, chainEls) {
    var spPr = OX.kid(sp, 'spPr') || OX.kid(sp, 'grpSpPr')
    var x = OX.kid(spPr, 'xfrm') || OX.kid(sp, 'xfrm')
    if (x && OX.kid(x, 'off')) return x
    for (var i = 0; i < chainEls.length; i++) {
      var y = OX.path(chainEls[i], 'spPr', 'xfrm')
      if (y && OX.kid(y, 'off')) return y
    }
    return null
  }
  function partOfEl(e, ctx) {
    var doc = e.ownerDocument
    var c = ctx.chain
    var cands = [c.slide, c.layout, c.master]
    for (var i = 0; i < cands.length; i++) if (cands[i] && ctx.pkg.doc(cands[i]) === doc) return cands[i]
    return ctx.part
  }

  function hasText(txBody) {
    if (!txBody) return false
    return OX.desc(txBody, 't').some(function (t) {
      return t.textContent.length > 0
    })
  }

  var PROMPTS = {
    title: ['单击此处添加标题', 'Click to add title'],
    ctrTitle: ['单击此处添加标题', 'Click to add title'],
    subTitle: ['单击此处添加副标题', 'Click to add subtitle'],
    pic: ['单击此处添加图片', 'Click to add picture'],
    tbl: ['单击此处添加表格', 'Click to add table'],
    chart: ['单击此处添加图表', 'Click to add chart']
  }
  /** 复制提示用的文本体：只留第一段，文字换成通用提示 */
  function promptBody(src, type) {
    var pr = PROMPTS[type] || ['单击此处添加文本', 'Click to add text']
    var text = window.studio ? window.studio.t(pr[0], pr[1]) : pr[0]
    var c = src.cloneNode(true)
    var ps = OX.kids(c, 'p')
    for (var i = 1; i < ps.length; i++) c.removeChild(ps[i])
    var p = ps[0]
    var first = null
    OX.kids(p).forEach(function (r) {
      if (r.localName !== 'r' && r.localName !== 'fld' && r.localName !== 'br') return
      if (!first && r.localName === 'r') first = r
      else p.removeChild(r)
    })
    if (first) OX.kid(first, 't').textContent = text
    return c
  }

  function renderShape(sp, ctx, map) {
    var chainEls = chainOf(sp, ctx)
    var x = inheritedXfrm(sp, chainEls)
    if (!x) return null
    var b = map(xfrmBox(x))
    var node = el('div', 'sh')
    place(node, b)
    var spPr = OX.kid(sp, 'spPr')
    var style = OX.kid(sp, 'style')
    var geoSrc = spPr && (OX.kid(spPr, 'prstGeom') || OX.kid(spPr, 'custGeom')) ? spPr : null
    for (var i = 0; !geoSrc && i < chainEls.length; i++) {
      var s2 = OX.kid(chainEls[i], 'spPr')
      if (s2 && (OX.kid(s2, 'prstGeom') || OX.kid(s2, 'custGeom'))) geoSrc = s2
    }
    var g = Geom.geometry(geoSrc, b.w, b.h)
    var f = OX.fillOf(spPr, ctx, ctx.part)
    for (var j = 0; !f && j < chainEls.length; j++) f = OX.fillOf(OX.kid(chainEls[j], 'spPr'), ctx, partOfEl(chainEls[j], ctx))
    if (!f && style) f = OX.styleFill(OX.kid(style, 'fillRef'), ctx)
    var lnEl = OX.kid(spPr, 'ln')
    for (var k = 0; !lnEl && k < chainEls.length; k++) lnEl = OX.path(chainEls[k], 'spPr', 'ln')
    var ln = OX.line(lnEl, style ? OX.kid(style, 'lnRef') : null, ctx)
    if (sp.localName === 'cxnSp' && !ln && !lnEl && !style) ln = null
    if ((f && f.type !== 'none') || ln) {
      var svg = drawGeom(node, g, b, f, ln)
      var shd = shadow(spPr, ctx)
      if (shd) svg.style.filter = shd
    }
    var txBody = OX.kid(sp, 'txBody')
    var ph = OX.phOf(sp)
    // 空占位符：编辑视图里显示版式里的提示文字（“单击此处添加标题”）
    if (ph && ctx.prompts && sp !== ctx.noPrompt && !hasText(txBody)) {
      node.classList.add('ph-empty')
      var src = null
      for (var q = 0; q < chainEls.length && !src; q++) if (hasText(OX.kid(chainEls[q], 'txBody'))) src = OX.kid(chainEls[q], 'txBody')
      if (src && ph.type !== 'dt' && ph.type !== 'ftr' && ph.type !== 'sldNum') {
        // 版式没有自定义提示（custPrompt）时，用 PowerPoint 的通用提示文字
        var cust = OX.bool(OX.path(chainEls[0], 'nvSpPr', 'nvPr'), 'custPrompt', false)
        if (!cust) src = promptBody(src, ph.type)
        var pr = renderText(src, { sp: sp, chainEls: chainEls, ph: ph, geomText: g.text }, ctx)
        pr.classList.add('prompt')
        node.appendChild(pr)
      }
      return { node: node, box: b }
    }
    if (txBody) {
      var gt = g.text
      var txX = OX.kid(sp, 'txXfrm')
      if (txX) {
        var tb = map(xfrmBox(txX))
        gt = { l: tb.x - b.x, t: tb.y - b.y, r: b.x + b.w - (tb.x + tb.w), b: b.y + b.h - (tb.y + tb.h) }
      }
      node.appendChild(renderText(txBody, { sp: sp, chainEls: chainEls, ph: OX.phOf(sp), fontRef: style ? OX.kid(style, 'fontRef') : null, geomText: gt }, ctx))
    }
    return { node: node, box: b }
  }

  function renderPic(pic, ctx, map) {
    var chainEls = chainOf(pic, ctx)
    var x = inheritedXfrm(pic, chainEls)
    if (!x) return null
    var b = map(xfrmBox(x))
    var node = el('div', 'sh pic')
    place(node, b)
    var bf = OX.kid(pic, 'blipFill')
    var blip = OX.kid(bf, 'blip')
    var id = OX.rid(blip, 'embed')
    var r = id ? ctx.pkg.rel(ctx.part, id) : null
    var url = r ? ctx.pkg.mediaUrl(r.target) : ''
    var spPr = OX.kid(pic, 'spPr')
    var pg = OX.kid(spPr, 'prstGeom')
    var inner = el('div', 'clip')
    if (pg && OX.attr(pg, 'prst') !== 'rect') {
      var g = Geom.geometry(spPr, b.w, b.h)
      inner.style.clipPath = 'path("' + g.paths[0].d + '")'
    }
    if (b.flipH || b.flipV) inner.style.transform = 'scale(' + (b.flipH ? -1 : 1) + ',' + (b.flipV ? -1 : 1) + ')'
    if (url) {
      var img = el('img')
      img.draggable = false
      img.src = url
      var sr = OX.kid(bf, 'srcRect')
      var l = OX.num(sr, 'l', 0) / 100000, t = OX.num(sr, 't', 0) / 100000, rr = OX.num(sr, 'r', 0) / 100000, bb = OX.num(sr, 'b', 0) / 100000
      var iw = b.w / Math.max(0.01, 1 - l - rr)
      var ih = b.h / Math.max(0.01, 1 - t - bb)
      Object.assign(img.style, { left: -l * iw + 'px', top: -t * ih + 'px', width: iw + 'px', height: ih + 'px' })
      var alpha = OX.kid(blip, 'alphaModFix')
      if (alpha) img.style.opacity = OX.num(alpha, 'amt', 100000) / 100000
      inner.appendChild(img)
    } else if (r || !OX.phOf(pic)) {
      inner.classList.add('missing')
      inner.textContent = r ? OX.extOf(r.target).toUpperCase() : ''
    }
    node.appendChild(inner)
    var shd = shadow(spPr, ctx)
    if (shd) node.style.filter = shd
    var ln = OX.line(OX.kid(spPr, 'ln'), OX.path(pic, 'style', 'lnRef'), ctx)
    if (ln) drawGeom(node, Geom.geometry(spPr, b.w, b.h), b, null, ln)
    return { node: node, box: b }
  }

  function renderGroup(grp, ctx, map, opts) {
    var gp = OX.kid(grp, 'grpSpPr')
    var x = OX.kid(gp, 'xfrm')
    if (!x) return null
    var b = map(xfrmBox(x))
    var node = el('div', 'sh grp')
    place(node, b)
    var chOff = OX.kid(x, 'chOff')
    var chExt = OX.kid(x, 'chExt')
    var cx = OX.num(chOff, 'x', 0), cy = OX.num(chOff, 'y', 0)
    var cw = OX.num(chExt, 'cx', 0) || OX.num(OX.kid(x, 'ext'), 'cx', 1)
    var ch = OX.num(chExt, 'cy', 0) || OX.num(OX.kid(x, 'ext'), 'cy', 1)
    var sx = b.w / (cw || 1), sy = b.h / (ch || 1)
    var sub = function (c) {
      return { x: (c.x - cx) * sx, y: (c.y - cy) * sy, w: c.w * sx, h: c.h * sy, rot: c.rot, flipH: c.flipH, flipV: c.flipV }
    }
    var gf = OX.fillOf(gp, ctx)
    var c2 = gf ? Object.assign({}, ctx, { grpFill: gf }) : ctx
    if (b.flipH || b.flipV) node.style.transform = (node.style.transform || '') + ' scale(' + (b.flipH ? -1 : 1) + ',' + (b.flipV ? -1 : 1) + ')'
    renderTree(grp, c2, node, sub, { skipPh: false })
    return { node: node, box: b }
  }

  /* ---------------- 表格 ---------------- */

  var MEDIUM2 = {
    '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}': 'accent1', '{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}': 'accent2', '{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}': 'accent3',
    '{00A15C55-8517-42AA-B614-E9B94910E393}': 'accent4', '{7DF18680-E054-41AD-8BC1-D1AEF772440D}': 'accent5', '{93296810-A885-4BE3-A3E7-6D5BEEA58F35}': 'accent6', '{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}': 'dk1'
  }

  function builtinStyle(id, ctx) {
    var thin = function (hex, w) {
      return (w || 1) + 'px solid ' + hex
    }
    if (id === '{2D5ABB26-0587-4C30-8999-92F81FD0307C}') return { wholeTbl: {} }
    if (id === '{5940675A-B579-460E-94D1-54222C63F5DA}') {
      var dk = '#' + (OX.schemeHex('tx1', ctx) || '000000')
      return { wholeTbl: { borders: { left: thin(dk), right: thin(dk), top: thin(dk), bottom: thin(dk), insideH: thin(dk), insideV: thin(dk) } } }
    }
    var acc = MEDIUM2[id] || 'accent1'
    var base = '#' + (OX.schemeHex(acc, ctx) || '4472C4')
    var c = OX.hexToRgb(base)
    var tint = function (k) {
      return OX.rgbToHex(
        c.map(function (v) {
          return OX.toS(OX.toLin(v) * k + (1 - k))
        })
      )
    }
    var lt = '#' + (OX.schemeHex('bg1', ctx) || 'FFFFFF')
    var b1 = { left: thin(lt), right: thin(lt), top: thin(lt), bottom: thin(lt), insideH: thin(lt), insideV: thin(lt) }
    var white = { hex: lt, alpha: 1 }
    return {
      wholeTbl: { fill: tint(0.2), borders: b1 },
      band1H: { fill: tint(0.4) },
      band1V: { fill: tint(0.4) },
      firstRow: { fill: base, color: white, bold: true, borders: { bottom: thin(lt, 3) } },
      lastRow: { fill: base, color: white, bold: true, borders: { top: thin(lt, 3) } },
      firstCol: { fill: base, color: white, bold: true },
      lastCol: { fill: base, color: white, bold: true }
    }
  }

  function lnCss(ln, ctx) {
    if (!ln) return null
    if (OX.kid(ln, 'noFill')) return 'none'
    var f = OX.fillOf(ln, ctx)
    if (!f || f.type !== 'solid') return null
    return Math.max(OX.num(ln, 'w', 12700) / EMU, 0.75).toFixed(2) + 'px solid ' + OX.css(f.color)
  }

  function tableStyle(ctx, id) {
    var ts = ctx.pkg.root('ppt/tableStyles.xml')
    if (!id) id = OX.attr(ts, 'def', '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}')
    var st = null
    OX.kids(ts, 'tblStyle').forEach(function (s) {
      if (OX.attr(s, 'styleId') === id) st = s
    })
    if (!st) return builtinStyle(id, ctx)
    var out = {}
    OX.kids(st).forEach(function (part) {
      var o = {}
      var tx = OX.kid(part, 'tcTxStyle')
      if (tx) {
        if (OX.attr(tx, 'b') === 'on') o.bold = true
        var c = OX.color(tx, ctx)
        if (!c) {
          var fr = OX.kid(tx, 'fontRef')
          if (fr) c = OX.color(fr, ctx)
        }
        if (c) o.color = c
      }
      var tc = OX.kid(part, 'tcStyle')
      if (tc) {
        var fl = OX.kid(tc, 'fill')
        var f = fl ? OX.fillOf(fl, ctx) : null
        if (!f) {
          var fr2 = OX.kid(tc, 'fillRef')
          if (fr2) f = OX.styleFill(fr2, ctx)
        }
        if (f) o.fill = OX.fillCss(f)
        var bdr = OX.kid(tc, 'tcBdr')
        if (bdr) {
          o.borders = {}
          OX.kids(bdr).forEach(function (side) {
            var ln = OX.kid(side, 'ln')
            var v = ln ? lnCss(ln, ctx) : null
            if (!v) {
              var lr = OX.kid(side, 'lnRef')
              if (lr) {
                var L = OX.line(null, lr, ctx)
                if (L) v = Math.max(L.w / EMU, 0.75).toFixed(2) + 'px solid ' + OX.css(L.color)
              }
            }
            if (v) o.borders[side.localName] = v
          })
        }
      }
      out[part.localName] = o
    })
    return out
  }

  function renderTable(tbl, ctx, b) {
    var tblPr = OX.kid(tbl, 'tblPr')
    var idEl = OX.kid(tblPr, 'tableStyleId')
    var st = tableStyle(ctx, idEl ? idEl.textContent.trim() : null)
    var flags = { firstRow: OX.bool(tblPr, 'firstRow', false), lastRow: OX.bool(tblPr, 'lastRow', false), firstCol: OX.bool(tblPr, 'firstCol', false), lastCol: OX.bool(tblPr, 'lastCol', false), bandRow: OX.bool(tblPr, 'bandRow', false), bandCol: OX.bool(tblPr, 'bandCol', false) }
    var cols = OX.kids(OX.kid(tbl, 'tblGrid'), 'gridCol').map(function (g) {
      return OX.num(g, 'w', 0) / EMU
    })
    var rows = OX.kids(tbl, 'tr')
    var table = el('table', 'tbl')
    var cg = el('colgroup')
    var total = 0
    cols.forEach(function (w) {
      var c = el('col')
      c.style.width = w + 'px'
      cg.appendChild(c)
      total += w
    })
    table.style.width = total + 'px'
    table.appendChild(cg)
    var nR = rows.length, nC = cols.length
    rows.forEach(function (tr, ri) {
      var row = el('tr')
      row.style.height = OX.num(tr, 'h', 0) / EMU + 'px'
      OX.kids(tr, 'tc').forEach(function (tc, ci) {
        if (OX.bool(tc, 'hMerge', false) || OX.bool(tc, 'vMerge', false)) return
        var td = el('td')
        var gs = OX.num(tc, 'gridSpan', 1), rs = OX.num(tc, 'rowSpan', 1)
        if (gs > 1) td.colSpan = gs
        if (rs > 1) td.rowSpan = rs
        // 适用的样式部分（后面的覆盖前面的）
        var parts = [st.wholeTbl]
        var dataRow = ri - (flags.firstRow ? 1 : 0)
        if (flags.bandRow && !(flags.firstRow && ri === 0) && !(flags.lastRow && ri === nR - 1)) parts.push(dataRow % 2 === 0 ? st.band1H : st.band2H)
        if (flags.bandCol) parts.push((ci - (flags.firstCol ? 1 : 0)) % 2 === 0 ? st.band1V : st.band2V)
        if (flags.firstCol && ci === 0) parts.push(st.firstCol)
        if (flags.lastCol && ci + gs === nC) parts.push(st.lastCol)
        if (flags.firstRow && ri === 0) parts.push(st.firstRow)
        if (flags.lastRow && ri + rs === nR) parts.push(st.lastRow)
        var fill = null, color = null, bold = false
        var bd = {}
        parts.forEach(function (p) {
          if (!p) return
          if (p.fill) fill = p.fill
          if (p.color) color = p.color
          if (p.bold) bold = true
          if (p.borders) {
            var B = p.borders
            var top = ri === 0 ? B.top : B.insideH
            var bottom = ri + rs === nR ? B.bottom : B.insideH
            var left = ci === 0 ? B.left : B.insideV
            var right = ci + gs === nC ? B.right : B.insideV
            if (top) bd.top = top
            if (bottom) bd.bottom = bottom
            if (left) bd.left = left
            if (right) bd.right = right
            // firstRow 的 bottom 适用于第一行的下边
            if (p === st.firstRow && B.bottom) bd.bottom = B.bottom
            if (p === st.lastRow && B.top) bd.top = B.top
          }
        })
        var tcPr = OX.kid(tc, 'tcPr')
        var own = OX.fillOf(tcPr, ctx)
        if (own) fill = OX.fillCss(own)
        ;[['lnL', 'left'], ['lnR', 'right'], ['lnT', 'top'], ['lnB', 'bottom']].forEach(function (pr) {
          var v = lnCss(OX.kid(tcPr, pr[0]), ctx)
          if (v) bd[pr[1]] = v
        })
        if (fill) td.style.background = fill
        ;['top', 'bottom', 'left', 'right'].forEach(function (s) {
          if (bd[s] && bd[s] !== 'none') td.style['border' + s.charAt(0).toUpperCase() + s.slice(1)] = bd[s]
        })
        var anchor = OX.attr(tcPr, 'anchor', 't')
        td.style.verticalAlign = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top'
        td.dataset.cell = ri + ',' + ci
        var txBody = OX.kid(tc, 'txBody')
        if (txBody) {
          var ins = { l: OX.num(tcPr, 'marL', 91440) / EMU, r: OX.num(tcPr, 'marR', 91440) / EMU, t: OX.num(tcPr, 'marT', 45720) / EMU, b: OX.num(tcPr, 'marB', 45720) / EMU }
          td.appendChild(renderText(txBody, { inline: ins, table: { color: color, bold: bold } }, ctx))
        }
        row.appendChild(td)
      })
      table.appendChild(row)
    })
    return table
  }

  /* ---------------- 图表 ---------------- */

  function cache(ref) {
    if (!ref) return []
    var c = OX.desc(ref, 'strCache')[0] || OX.desc(ref, 'numCache')[0] || OX.kid(ref, 'strLit') || OX.kid(ref, 'numLit')
    if (!c) return []
    var n = OX.num(OX.kid(c, 'ptCount'), 'val', 0)
    var out = []
    for (var i = 0; i < n; i++) out.push(null)
    OX.kids(c, 'pt').forEach(function (pt) {
      out[OX.num(pt, 'idx', 0)] = (OX.kid(pt, 'v') || {}).textContent
    })
    return out
  }
  function richText(t) {
    return OX.desc(t, 't')
      .map(function (x) {
        return x.textContent
      })
      .join('')
  }
  function niceStep(range) {
    var raw = range / 7
    if (raw <= 0) return 1
    var e = Math.pow(10, Math.floor(Math.log10(raw)))
    var m = raw / e
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e
  }
  function fmt(v) {
    if (Math.abs(v) >= 1e6) return +(v / 1e6).toFixed(1) + 'M'
    if (Math.abs(v) >= 1e4) return +(v / 1e3).toFixed(1) + 'K'
    return String(+v.toFixed(2))
  }

  function renderChart(part, ctx, b) {
    var root = ctx.pkg.root(part)
    var box = el('div', 'chart')
    if (!root) return box
    var c2 = Object.assign({}, ctx, { part: part })
    var chart = OX.kid(root, 'chart')
    var plot = OX.kid(chart, 'plotArea')
    var types = OX.kids(plot).filter(function (k) {
      return /Chart$/.test(k.localName)
    })
    var W = b.w, H = b.h
    var svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H })
    var txtColor = '#' + (OX.schemeHex('tx1', ctx) || '404040')
    var defSz = OX.desc(OX.kid(root, 'txPr'), 'defRPr')[0]
    var fs = defSz && defSz.hasAttribute('sz') ? (OX.num(defSz, 'sz', 1000) / 100) * (4 / 3) : Math.max(10, Math.min(18, H / 24))
    var top = 8
    var titleEl = OX.kid(chart, 'title')
    var titleText = titleEl ? richText(titleEl) : ''
    var autoDel = OX.bool(OX.kid(chart, 'autoTitleDeleted'), 'val', false)
    var series = []
    var pal = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
    types.forEach(function (t) {
      OX.kids(t, 'ser').forEach(function (s) {
        var name = cache(OX.path(s, 'tx', 'strRef'))[0] || (OX.path(s, 'tx', 'v') || {}).textContent || ''
        var spPr = OX.kid(s, 'spPr')
        var f = OX.fillOf(spPr, c2)
        var lnF = OX.fillOf(OX.kid(spPr, 'ln'), c2)
        var col = (f && f.type === 'solid' && f.color.hex) || (t.localName.indexOf('line') === 0 || t.localName === 'scatterChart' ? lnF && lnF.type === 'solid' && lnF.color.hex : null) || '#' + (OX.schemeHex(pal[series.length % 6], ctx) || '4472C4')
        var dpt = {}
        OX.kids(s, 'dPt').forEach(function (d) {
          var df = OX.fillOf(OX.kid(d, 'spPr'), c2)
          if (df && df.type === 'solid') dpt[OX.num(OX.kid(d, 'idx'), 'val', 0)] = df.color.hex
        })
        series.push({
          type: t,
          name: name,
          cats: cache(OX.kid(s, 'cat') || OX.kid(s, 'xVal')),
          vals: cache(OX.kid(s, 'val') || OX.kid(s, 'yVal')).map(function (v) {
            return v == null || v === '' ? null : Number(v)
          }),
          color: col,
          dpt: dpt
        })
      })
    })
    if (!titleText && !autoDel && titleEl === null && series.length === 1 && /pie|doughnut/.test(series[0].type.localName)) titleText = series[0].name
    if (titleEl && !titleText && series.length === 1) titleText = series[0].name
    function text(x, y, s, anchor, size, color, weight) {
      var t = svgEl('text', { x: x, y: y, 'text-anchor': anchor || 'middle', 'font-size': size || fs, fill: color || txtColor, 'font-family': 'Segoe UI, Microsoft YaHei, sans-serif' })
      if (weight) t.setAttribute('font-weight', weight)
      t.textContent = s
      svg.appendChild(t)
      return t
    }
    if (titleText) {
      text(W / 2, top + fs * 1.3, titleText, 'middle', fs * 1.35)
      top += fs * 2.2
    }
    var legend = OX.kid(chart, 'legend')
    var legPos = legend ? OX.attr(OX.kid(legend, 'legendPos'), 'val', 'r') : null
    var first = series[0]
    var isPie = first && /pie|doughnut/i.test(first.type.localName)
    var legItems = isPie
      ? first.cats.map(function (c, i) {
          return { name: c || String(i + 1), color: first.dpt[i] || '#' + (OX.schemeHex(pal[i % 6], ctx) || '4472C4') }
        })
      : series.map(function (s) {
          return { name: s.name, color: s.color }
        })
    var right = W - 10, bottom = H - 8
    if (legend && legItems.length) {
      if (legPos === 'r' || legPos === 'tr') {
        var lw = Math.min(W * 0.3, 20 + fs * 0.6 * Math.max.apply(null, legItems.map(function (l) { return String(l.name).length + 2 })))
        right = W - lw - 10
        legItems.forEach(function (l, i) {
          var y = H / 2 - (legItems.length * fs * 1.5) / 2 + i * fs * 1.5
          svg.appendChild(svgEl('rect', { x: right + 14, y: y, width: fs * 0.8, height: fs * 0.8, fill: l.color }))
          text(right + 14 + fs * 1.2, y + fs * 0.75, l.name, 'start')
        })
      } else {
        var ly = legPos === 't' ? top + fs : H - fs * 0.6
        if (legPos === 't') top += fs * 1.8
        else bottom -= fs * 1.8
        var widths = legItems.map(function (l) {
          return fs * 1.6 + String(l.name).length * fs * 0.62 + 12
        })
        var tw = widths.reduce(function (a, v) { return a + v }, 0)
        var lx = Math.max(4, (W - tw) / 2)
        legItems.forEach(function (l, i) {
          svg.appendChild(svgEl('rect', { x: lx, y: ly - fs * 0.75, width: fs * 0.8, height: fs * 0.8, fill: l.color }))
          text(lx + fs * 1.1, ly, l.name, 'start')
          lx += widths[i]
        })
      }
    }
    if (!first) {
      box.appendChild(svg)
      return box
    }
    if (isPie) {
      var vals = first.vals.map(function (v) { return Math.max(0, v || 0) })
      var sum = vals.reduce(function (a, v) { return a + v }, 0) || 1
      var cx = (10 + right) / 2, cy = (top + bottom) / 2
      var r = Math.max(4, Math.min(right - 10, bottom - top) / 2 - 4)
      var hole = first.type.localName === 'doughnutChart' ? (OX.num(OX.kid(first.type, 'holeSize'), 'val', 50) / 100) * r : 0
      var ang = ((OX.num(OX.kid(first.type, 'firstSliceAng'), 'val', 0) - 90) * Math.PI) / 180
      vals.forEach(function (v, i) {
        var a2 = ang + (v / sum) * Math.PI * 2
        var large = a2 - ang > Math.PI ? 1 : 0
        var p1 = [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]
        var p2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)]
        var d
        if (v / sum > 0.9999) d = Geom.ellipse(cx, cy, r, r) + (hole ? ' ' + Geom.ellipse(cx, cy, hole, hole) : '')
        else if (hole) {
          var q1 = [cx + hole * Math.cos(a2), cy + hole * Math.sin(a2)]
          var q2 = [cx + hole * Math.cos(ang), cy + hole * Math.sin(ang)]
          d = 'M' + p1 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + p2 + ' L' + q1 + ' A' + hole + ',' + hole + ' 0 ' + large + ' 0 ' + q2 + ' Z'
        } else d = 'M' + cx + ',' + cy + ' L' + p1 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + p2 + ' Z'
        svg.appendChild(svgEl('path', { d: d, fill: legItems[i] ? legItems[i].color : first.color, stroke: '#fff', 'stroke-width': 1, 'fill-rule': 'evenodd' }))
        ang = a2
      })
      box.appendChild(svg)
      return box
    }
    // 坐标轴类图表
    var cats = first.cats.length ? first.cats : first.vals.map(function (_, i) { return String(i + 1) })
    var horizontal = OX.attr(OX.kid(first.type, 'barDir'), 'val', 'col') === 'bar'
    var grouping = OX.attr(OX.kid(first.type, 'grouping'), 'val', 'clustered')
    var stacked = grouping === 'stacked' || grouping === 'percentStacked'
    var maxV = 0, minV = 0
    cats.forEach(function (_, i) {
      var pos = 0, neg = 0
      series.forEach(function (s) {
        var v = s.vals[i] || 0
        if (stacked) v >= 0 ? (pos += v) : (neg += v)
        else (maxV = Math.max(maxV, v)), (minV = Math.min(minV, v))
      })
      if (stacked) (maxV = Math.max(maxV, pos)), (minV = Math.min(minV, neg))
    })
    var step
    if (grouping === 'percentStacked') (maxV = 100), (minV = 0), (step = 20)
    else {
      var span = (maxV - minV) * 1.05 || 1
      step = niceStep(span)
      maxV = Math.max(step, Math.ceil((maxV + (maxV - minV) * 0.05) / step) * step)
      minV = minV < 0 ? Math.floor((minV - (maxV - minV) * 0.05) / step) * step : 0
    }
    var left = 10 + fs * 0.62 * Math.max(fmt(maxV).length, fmt(minV).length) + 6
    var plotB = bottom - fs * 1.6
    if (horizontal) left = 10 + fs * 0.6 * Math.min(14, Math.max.apply(null, cats.map(function (c) { return String(c || '').length }))) + 6
    var PW = right - left, PH = plotB - top
    if (PW < 10 || PH < 10) {
      box.appendChild(svg)
      return box
    }
    var axis = '#' + (OX.schemeHex('tx1', ctx) || '000000')
    var grid = 'rgba(128,128,128,0.25)'
    var ticks = Math.max(1, Math.round((maxV - minV) / step))
    for (var t = 0; t <= ticks; t++) {
      var val = minV + ((maxV - minV) * t) / ticks
      if (horizontal) {
        var gx = left + (PW * t) / ticks
        svg.appendChild(svgEl('line', { x1: gx, y1: top, x2: gx, y2: plotB, stroke: grid }))
        text(gx, plotB + fs * 1.2, fmt(val) + (grouping === 'percentStacked' ? '%' : ''))
      } else {
        var gy = plotB - (PH * t) / ticks
        svg.appendChild(svgEl('line', { x1: left, y1: gy, x2: right, y2: gy, stroke: grid }))
        text(left - 5, gy + fs * 0.35, fmt(val) + (grouping === 'percentStacked' ? '%' : ''), 'end')
      }
    }
    var scale = function (v) {
      return ((v - minV) / (maxV - minV)) * (horizontal ? PW : PH)
    }
    var zero = scale(0)
    var n = cats.length || 1
    var band = (horizontal ? PH : PW) / n
    cats.forEach(function (c, i) {
      var label = String(c == null ? '' : c)
      var maxChars = Math.max(2, Math.floor(band / (fs * 0.62)))
      if (!horizontal && label.length > maxChars) label = label.slice(0, maxChars - 1) + '…'
      if (horizontal) text(left - 5, top + band * (i + 0.5) + fs * 0.35, label, 'end')
      else text(left + band * (i + 0.5), plotB + fs * 1.2, label)
    })
    var bars = series.filter(function (s) { return /bar/i.test(s.type.localName) })
    var lines = series.filter(function (s) { return /line|scatter/i.test(s.type.localName) })
    var areas = series.filter(function (s) { return /area/i.test(s.type.localName) })
    var gapW = OX.num(OX.kid(first.type, 'gapWidth'), 'val', 150) / 100
    var groupW = band / (1 + gapW)
    var bw = stacked ? groupW : groupW / Math.max(1, bars.length)
    var stackP = cats.map(function () { return 0 })
    var stackN = cats.map(function () { return 0 })
    var totals = cats.map(function (_, i) {
      return bars.reduce(function (a, s) { return a + Math.abs(s.vals[i] || 0) }, 0) || 1
    })
    areas.forEach(function (s) {
      var pts = cats.map(function (_, i) {
        return [left + band * (i + 0.5), plotB - scale(s.vals[i] || 0)]
      })
      var d = 'M' + left + band * 0.5 + ',' + (plotB - zero) + ' L' + pts.map(function (p) { return p.join(',') }).join(' L') + ' L' + (left + band * (n - 0.5)) + ',' + (plotB - zero) + ' Z'
      svg.appendChild(svgEl('path', { d: d, fill: s.color, 'fill-opacity': 0.85 }))
    })
    bars.forEach(function (s, si) {
      cats.forEach(function (_, i) {
        var v = s.vals[i]
        if (v == null) return
        if (grouping === 'percentStacked') v = (v / totals[i]) * 100
        var start = stacked ? (v >= 0 ? stackP[i] : stackN[i]) : 0
        if (stacked) v >= 0 ? (stackP[i] += v) : (stackN[i] += v)
        var a0 = scale(start), a1 = scale(start + v)
        var pos = band * i + (band - groupW) / 2 + (stacked ? 0 : bw * si)
        var color = s.dpt[i] || s.color
        if (horizontal) svg.appendChild(svgEl('rect', { x: left + Math.min(a0, a1), y: top + pos, width: Math.abs(a1 - a0), height: bw, fill: color }))
        else svg.appendChild(svgEl('rect', { x: left + pos, y: plotB - Math.max(a0, a1), width: bw, height: Math.abs(a1 - a0), fill: color }))
      })
    })
    lines.forEach(function (s) {
      var pts = []
      cats.forEach(function (_, i) {
        if (s.vals[i] == null) return
        pts.push([left + band * (i + 0.5), plotB - scale(s.vals[i])])
      })
      if (!pts.length) return
      if (!/scatter/.test(s.type.localName) || true) svg.appendChild(svgEl('path', { d: 'M' + pts.map(function (p) { return p.join(',') }).join(' L'), fill: 'none', stroke: s.color, 'stroke-width': 2.25, 'stroke-linejoin': 'round' }))
      var noMarker = OX.attr(OX.path(s.type, 'marker'), 'val', '1') === '0'
      if (!noMarker)
        pts.forEach(function (p) {
          svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 3, fill: s.color }))
        })
    })
    svg.appendChild(svgEl('line', horizontal ? { x1: left + zero, y1: top, x2: left + zero, y2: plotB, stroke: axis, 'stroke-opacity': 0.5 } : { x1: left, y1: plotB - zero, x2: right, y2: plotB - zero, stroke: axis, 'stroke-opacity': 0.5 }))
    box.appendChild(svg)
    return box
  }

  /* ---------------- graphicFrame ---------------- */

  function renderFrame(gf, ctx, map) {
    var x = OX.kid(gf, 'xfrm')
    var chainEls = chainOf(gf, ctx)
    if (!x || !OX.kid(x, 'off')) x = inheritedXfrm(gf, chainEls)
    if (!x) return null
    var b = map(xfrmBox(x))
    var node = el('div', 'sh frame')
    place(node, b)
    var gd = OX.path(gf, 'graphic', 'graphicData')
    var uri = OX.attr(gd, 'uri', '')
    try {
      if (/table$/.test(uri)) {
        var tbl = OX.kid(gd, 'tbl')
        if (tbl) node.appendChild(renderTable(tbl, ctx, b))
        node.classList.add('table')
      } else if (/chart$/.test(uri)) {
        var cref = OX.kid(gd, 'chart')
        var r = cref ? ctx.pkg.rel(ctx.part, OX.rid(cref, 'id')) : null
        if (r) node.appendChild(renderChart(r.target, ctx, b))
      } else if (/diagram$/.test(uri)) {
        var ids = OX.kid(gd, 'relIds')
        var dm = ids ? ctx.pkg.rel(ctx.part, OX.rid(ids, 'dm')) : null
        var ext = dm ? OX.desc(ctx.pkg.root(dm.target), 'dataModelExt')[0] : null
        var dr = ext ? ctx.pkg.rel(ctx.part, OX.attr(ext, 'relId')) : null
        var tree = dr ? OX.desc(ctx.pkg.root(dr.target), 'spTree')[0] : null
        if (tree) {
          var sx = b.w / ((b.w * EMU) || 1)
          renderTree(tree, Object.assign({}, ctx, { part: dr.target }), node, function (c) {
            return { x: c.x / EMU, y: c.y / EMU, w: c.w / EMU, h: c.h / EMU, rot: c.rot, flipH: c.flipH, flipV: c.flipV }
          }, {})
        } else placeholder(node, 'SmartArt')
      } else {
        // OLE 对象等：用里面的预览图
        var pic = OX.desc(gd, 'pic')[0]
        var blip = pic ? OX.desc(pic, 'blip')[0] : null
        var rr = blip ? ctx.pkg.rel(ctx.part, OX.rid(blip, 'embed')) : null
        var url = rr ? ctx.pkg.mediaUrl(rr.target) : ''
        if (url) {
          var img = el('img', 'full')
          img.src = url
          img.draggable = false
          node.appendChild(img)
        } else placeholder(node, rr ? OX.extOf(rr.target).toUpperCase() : '')
      }
    } catch (e) {
      placeholder(node, '?')
    }
    return { node: node, box: b }
  }
  function placeholder(node, label) {
    var d = el('div', 'clip missing')
    d.textContent = label
    node.appendChild(d)
  }

  /* ---------------- 树 ---------------- */

  function renderTree(tree, ctx, container, map, opts) {
    OX.kids(tree).forEach(function (c) {
      var item = c
      var target = c
      if (c.localName === 'AlternateContent') {
        target = OX.kids(OX.kid(c, 'Fallback'))[0] || OX.kids(OX.kid(c, 'Choice'))[0]
        if (!target) return
      }
      if (opts.skipPh && OX.phOf(target)) return
      var r = null
      try {
        switch (target.localName) {
          case 'sp':
          case 'cxnSp':
            r = renderShape(target, ctx, map)
            break
          case 'pic':
            r = renderPic(target, ctx, map)
            break
          case 'grpSp':
            r = renderGroup(target, ctx, map, opts)
            break
          case 'graphicFrame':
            r = renderFrame(target, ctx, map)
            break
        }
      } catch (e) {
        console.error(e)
      }
      if (!r) return
      container.appendChild(r.node)
      if (opts.items) {
        r.node.dataset.k = opts.items.length
        opts.items.push({ xml: item, target: target, node: r.node, box: r.box })
      }
    })
  }

  function background(pres, chain, ctx) {
    var parts = [chain.slide, chain.layout, chain.master]
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue
      var bg = OX.path(pres.pkg.root(parts[i]), 'cSld', 'bg')
      if (!bg) continue
      var c2 = Object.assign({}, ctx, { part: parts[i] })
      var bgPr = OX.kid(bg, 'bgPr')
      var f = bgPr ? OX.fillOf(bgPr, c2, parts[i]) : OX.styleFill(OX.kid(bg, 'bgRef'), c2)
      if (f) return OX.fillCss(f)
    }
    return '#ffffff'
  }

  /**
   * 渲染幻灯片（或版式）。返回 { el, items }
   * items：幻灯片自己的顶层元素（可选中编辑）
   */
  function renderSlide(pres, part, opts) {
    opts = opts || {}
    var pkg = pres.pkg
    var chain = pres.chain(part)
    var W = pres.cx / EMU, H = pres.cy / EMU
    var root = el('div', 'slide')
    root.style.width = W + 'px'
    root.style.height = H + 'px'
    var base = { pres: pres, pkg: pkg, theme: chain.theme, clrMap: chain.clrMap, chain: chain, slideNum: opts.slideNum || 1, prompts: !!opts.prompts, noPrompt: opts.noPrompt || null }
    root.style.background = background(pres, chain, base)
    var sroot = pkg.root(part)
    var show = OX.bool(sroot, 'showMasterSp', true)
    var lroot = chain.layout && chain.layout !== part ? pkg.root(chain.layout) : null
    if (chain.master && chain.master !== part && show && (!lroot || OX.bool(lroot, 'showMasterSp', true))) {
      renderTree(OX.path(pkg.root(chain.master), 'cSld', 'spTree'), Object.assign({}, base, { part: chain.master }), root, map0, { skipPh: true })
    }
    if (lroot && show) renderTree(OX.path(lroot, 'cSld', 'spTree'), Object.assign({}, base, { part: chain.layout }), root, map0, { skipPh: true })
    var items = []
    var layer = el('div', 'layer')
    root.appendChild(layer)
    renderTree(OX.path(sroot, 'cSld', 'spTree'), Object.assign({}, base, { part: part }), layer, map0, { skipPh: false, items: items })
    return { el: root, items: items, layer: layer }
  }

  /** 备注文本 */
  function notesText(pkg, slidePath) {
    var r = pkg.relOfType(slidePath, OX.REL.notes)
    if (!r) return null
    var root = pkg.root(r.target)
    var body = null
    OX.desc(root, 'sp').forEach(function (sp) {
      var ph = OX.phOf(sp)
      if (ph && ph.type === 'body' && !body) body = sp
    })
    if (!body) return { part: r.target, sp: null, text: '' }
    var txt = OX.kids(OX.kid(body, 'txBody'), 'p')
      .map(function (p) {
        return OX.kids(p)
          .map(function (c) {
            return c.localName === 'br' ? '\n' : c.localName === 'r' || c.localName === 'fld' ? (OX.kid(c, 't') || {}).textContent || '' : ''
          })
          .join('')
      })
      .join('\n')
    return { part: r.target, sp: body, text: txt }
  }

  window.Render = { renderSlide: renderSlide, hasText: hasText, textMap: textMap, xfrmBox: xfrmBox, inheritedXfrm: inheritedXfrm, chainOf: chainOf, notesText: notesText, EMU: EMU, family: family, fontName: fontName }
})()
