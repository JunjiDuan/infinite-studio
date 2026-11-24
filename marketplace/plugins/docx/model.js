/**
 * Word 文档模型：主文档、样式（继承链）、主题字体与颜色、编号（列表）、图片、超链接，
 * 以及只操作 XML 的辅助函数（段落文字、查找替换、Markdown → OOXML）。
 * 界面渲染在 render.js，编辑在 app.js。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var NS = OX.NS
  var W = NS.w
  var kid = OX.kid
  var kids = OX.kids

  /* ---------------- 小工具 ---------------- */

  function wattr(el, name) {
    if (!el) return null
    var v = el.getAttributeNS(W, name)
    if (v == null || v === '') v = el.getAttribute('w:' + name)
    return v == null || v === '' ? null : v
  }
  function wnum(el, name, def) {
    var v = wattr(el, name)
    if (v == null) return def
    var n = parseFloat(v)
    return isNaN(n) ? def : n
  }
  /** 开关属性：<w:b/> 为 true，w:val="0|false|off" 为 false */
  function on(el) {
    if (!el) return undefined
    var v = wattr(el, 'val')
    return !(v === '0' || v === 'false' || v === 'off' || v === 'none')
  }
  function wel(doc, name, attrs) {
    var el = doc.createElementNS(W, 'w:' + name)
    if (attrs) for (var k in attrs) if (attrs[k] != null) el.setAttributeNS(W, 'w:' + k, String(attrs[k]))
    return el
  }
  function setW(el, name, v) {
    if (v == null) {
      el.removeAttributeNS(W, name)
      el.removeAttribute('w:' + name)
    } else el.setAttributeNS(W, 'w:' + name, String(v))
  }
  function attrsOf(el) {
    var o = {}
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i]
      if (a.namespaceURI === W || a.prefix === 'w') o[a.localName] = a.value
    }
    return o
  }

  // 段落 / 行属性里子元素的 schema 顺序（插入新元素时用）
  var PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange']
  var RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath']
  var TCPR_ORDER = ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark']

  function ensureW(parent, name, order) {
    var c = kid(parent, name)
    if (c) return c
    c = wel(parent.ownerDocument, name)
    var idx = order.indexOf(name)
    for (var x = parent.firstElementChild; x; x = x.nextElementSibling) {
      var j = order.indexOf(x.localName)
      if (j > idx) {
        parent.insertBefore(c, x)
        return c
      }
    }
    parent.appendChild(c)
    return c
  }
  function pPrOf(p, create) {
    var pp = kid(p, 'pPr')
    if (!pp && create) {
      pp = wel(p.ownerDocument, 'pPr')
      p.insertBefore(pp, p.firstChild)
    }
    return pp
  }
  function rPrOf(r, create) {
    var rp = kid(r, 'rPr')
    if (!rp && create) {
      rp = wel(r.ownerDocument, 'rPr')
      r.insertBefore(rp, r.firstChild)
    }
    return rp
  }

  var MERGE = { ind: 1, spacing: 1, rFonts: 1, lang: 1 }
  /** 把一个 pPr / rPr 的子元素合并进 props（ind / spacing / rFonts 按属性合并） */
  function mergeProps(props, el) {
    if (!el) return props
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      var n = c.localName
      if (n === 'rPr' || n === 'sectPr' || n === 'pPrChange' || n === 'rPrChange' || n === 'ins' || n === 'del') continue
      if (MERGE[n]) {
        var a = attrsOf(c)
        var cur = props[n] ? Object.assign({}, props[n]) : {}
        // 主题字体优先于具体字体：同一级里有 asciiTheme 时去掉旧的 ascii
        if (n === 'rFonts') ['ascii', 'hAnsi', 'eastAsia', 'cs'].forEach(function (k) {
          if (a[k] != null && a[k + 'Theme'] == null) delete cur[k + 'Theme']
        })
        if (n === 'ind') {
          if (a.start != null && a.left == null) a.left = a.start
          if (a.end != null && a.right == null) a.right = a.end
          if (a.hanging != null) delete cur.firstLine
          if (a.firstLine != null) delete cur.hanging
        }
        props[n] = Object.assign(cur, a)
      } else props[n] = c
    }
    return props
  }

  /* ---------------- 编号格式 ---------------- */

  function roman(n) {
    var map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
    var s = ''
    map.forEach(function (m) {
      while (n >= m[0]) (s += m[1]), (n -= m[0])
    })
    return s
  }
  function letters(n) {
    var c = String.fromCharCode(97 + ((n - 1) % 26))
    return new Array(Math.floor((n - 1) / 26) + 2).join(c)
  }
  var CN = '〇一二三四五六七八九'
  function chinese(n) {
    if (n <= 0) return String(n)
    if (n < 10) return CN[n]
    if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '')
    if (n < 100) return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '')
    if (n < 1000) {
      var r = n % 100
      return CN[Math.floor(n / 100)] + '百' + (r ? (r < 10 ? '零' + CN[r] : r < 20 ? '一' + chinese(r) : chinese(r)) : '')
    }
    return String(n)
  }
  function formatNum(n, fmt) {
    switch (fmt) {
      case 'lowerLetter': return letters(n)
      case 'upperLetter': return letters(n).toUpperCase()
      case 'lowerRoman': return roman(n)
      case 'upperRoman': return roman(n).toUpperCase()
      case 'decimalZero': return (n < 10 ? '0' : '') + n
      case 'chineseCounting':
      case 'chineseCountingThousand':
      case 'chineseLegalSimplified':
        return chinese(n)
      case 'japaneseCounting':
      case 'taiwaneseCountingThousand': return chinese(n)
      case 'ideographTraditional': return '甲乙丙丁戊己庚辛壬癸'[(n - 1) % 10]
      case 'ideographZodiac': return '子丑寅卯辰巳午未申酉戌亥'[(n - 1) % 12]
      case 'decimalEnclosedCircle':
      case 'decimalEnclosedCircleChinese': return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n)
      case 'decimalEnclosedParen': return '(' + n + ')'
      case 'decimalFullWidth':
      case 'decimalFullWidth2': return String(n).replace(/\d/g, function (d) { return String.fromCharCode(0xff10 + Number(d)) })
      case 'ordinal': return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th')
      case 'none': return ''
      default: return String(n)
    }
  }
  // Symbol / Wingdings 私用区字符 → 普通 Unicode
  var BULLET = { '': '•', '': '▪', '': '➢', '': '❖', '': '✓', '': '■', '': '□', '': '●', '': '➔', '': '◆', '': '◆', '': '◇', '': '◦', '': '○', '': '□', '': '❑', '': '⇨', '': '➤' }
  function bulletChar(s, font) {
    if (!s) return ''
    if (BULLET[s]) return BULLET[s]
    if (s === 'o' && /courier/i.test(font || '')) return '◦'
    if (s === '§' && /wingdings/i.test(font || '')) return '▪'
    var c = s.charCodeAt(0)
    if (c >= 0xf000 && c <= 0xf0ff) return '•'
    return s
  }

  /* ---------------- 文档 ---------------- */

  function Doc(pkg) {
    this.pkg = pkg
    var rel = pkg.relOfType('', OX.REL.officeDoc)
    if (!rel) {
      // 有的文件根关系里用的是 strict 命名空间
      var any = pkg.rels('').filter(function (r) { return /officeDocument$/.test(r.type) })[0]
      rel = any || null
    }
    this.main = rel ? rel.target : 'word/document.xml'
    if (!pkg.has(this.main)) throw new Error('no document part')
    this.xml = pkg.doc(this.main)
    if (!this.xml || !this.body()) throw new Error('bad document part')
    this.reload()
  }

  Doc.prototype.reload = function () {
    var pkg = this.pkg
    this.xml = pkg.doc(this.main)
    var self = this
    var partOf = function (type) {
      var r = pkg.rels(self.main).filter(function (x) { return x.type === type || x.type.split('/').pop() === type.split('/').pop() })[0]
      return r && !r.external && pkg.has(r.target) ? r.target : null
    }
    this.stylesPart = partOf(OX.REL.styles)
    this.numberingPart = partOf(OX.REL.numbering)
    this.themePart = partOf(OX.REL.theme)
    this._styles = null
    this._theme = null
    this._num = null
    this._pcache = new Map()
    this._rcache = new Map()
  }
  Doc.prototype.body = function () {
    return kid(this.xml.documentElement, 'body')
  }
  Doc.prototype.touch = function () {
    this.pkg.touch(this.main)
  }
  Doc.prototype.invalidate = function () {
    this._styles = null
    this._num = null
    this._pcache = new Map()
    this._rcache = new Map()
  }
  Doc.prototype.save = function () {
    return this.pkg.save()
  }

  /* ---------- 主题 ---------- */

  Doc.prototype.theme = function () {
    if (this._theme) return this._theme
    var th = { fonts: { major: {}, minor: {} }, colors: {} }
    var root = this.themePart ? this.pkg.root(this.themePart) : null
    if (root) {
      var fs = OX.desc(root, 'fontScheme')[0]
      ;['major', 'minor'].forEach(function (k) {
        var f = fs && kid(fs, k + 'Font')
        if (!f) return
        var o = th.fonts[k]
        o.latin = OX.attr(kid(f, 'latin'), 'typeface', '')
        o.ea = OX.attr(kid(f, 'ea'), 'typeface', '')
        o.cs = OX.attr(kid(f, 'cs'), 'typeface', '')
        kids(f, 'font').forEach(function (x) {
          if (OX.attr(x, 'script') === 'Hans' && !o.ea) o.ea = OX.attr(x, 'typeface', '')
          if (OX.attr(x, 'script') === 'Jpan') o.jpan = OX.attr(x, 'typeface', '')
        })
        if (!o.ea) o.ea = o.jpan || ''
      })
      var cs = OX.desc(root, 'clrScheme')[0]
      kids(cs).forEach(function (c) {
        var v = kid(c, 'srgbClr')
        var s = kid(c, 'sysClr')
        th.colors[c.localName] = v ? OX.attr(v, 'val') : s ? OX.attr(s, 'lastClr', '000000') : '000000'
      })
    }
    this._theme = th
    return th
  }
  var THEME_COLOR = { dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink' }
  Doc.prototype.themeColor = function (name) {
    var c = this.theme().colors
    return c[THEME_COLOR[name] || name] || null
  }
  Doc.prototype.themeFont = function (name) {
    // majorHAnsi / minorEastAsia / majorBidi ...
    var m = /^(major|minor)(.*)$/.exec(name || '')
    if (!m) return ''
    var f = this.theme().fonts[m[1]]
    if (m[2] === 'EastAsia') return f.ea || ''
    if (m[2] === 'Bidi') return f.cs || ''
    return f.latin || ''
  }

  /* ---------- 样式 ---------- */

  Doc.prototype.styles = function () {
    if (this._styles) return this._styles
    var s = { byId: new Map(), list: [], defP: null, defC: null, defT: null, rDef: null, pDef: null }
    var root = this.stylesPart ? this.pkg.root(this.stylesPart) : null
    if (root) {
      var dd = kid(root, 'docDefaults')
      s.rDef = OX.path(dd, 'rPrDefault', 'rPr')
      s.pDef = OX.path(dd, 'pPrDefault', 'pPr')
      kids(root, 'style').forEach(function (el) {
        var id = wattr(el, 'styleId')
        if (!id) return
        var st = {
          id: id,
          el: el,
          type: wattr(el, 'type') || 'paragraph',
          name: wattr(kid(el, 'name'), 'val') || id,
          basedOn: wattr(kid(el, 'basedOn'), 'val'),
          next: wattr(kid(el, 'next'), 'val'),
          hidden: !!kid(el, 'semiHidden') || !!kid(el, 'hidden'),
          q: !!kid(el, 'qFormat'),
          prio: wnum(kid(el, 'uiPriority'), 'val', 99),
          isDefault: wattr(el, 'default') === '1' || wattr(el, 'default') === 'true' || wattr(el, 'default') === 'on'
        }
        s.byId.set(id, st)
        s.list.push(st)
        if (st.isDefault) {
          if (st.type === 'paragraph') s.defP = id
          else if (st.type === 'character') s.defC = id
          else if (st.type === 'table') s.defT = id
        }
      })
    }
    this._styles = s
    return s
  }
  Doc.prototype.style = function (id) {
    return id ? this.styles().byId.get(id) || null : null
  }
  /** 样式继承链（从最底层的基础样式到它自己） */
  Doc.prototype.chain = function (id) {
    var out = []
    var seen = {}
    var st = this.style(id)
    while (st && !seen[st.id]) {
      seen[st.id] = 1
      out.unshift(st)
      st = this.style(st.basedOn)
    }
    return out
  }
  Doc.prototype.styleByName = function (name) {
    var n = String(name || '').toLowerCase()
    var found = null
    this.styles().list.forEach(function (st) {
      if (!found && (st.name.toLowerCase() === n || st.id.toLowerCase() === n.replace(/\s+/g, ''))) found = st
    })
    return found
  }

  /** 段落的有效属性（docDefaults → 表格样式 → 段落样式链 → 直接格式） */
  Doc.prototype.pProps = function (p, tblStyle) {
    var pPr = kid(p, 'pPr')
    var sid = wattr(kid(pPr, 'pStyle'), 'val') || this.styles().defP
    var key = (tblStyle || '') + '|' + (sid || '')
    var base = this._pcache.get(key)
    if (!base) {
      base = {}
      mergeProps(base, this.styles().pDef)
      var self = this
      if (tblStyle) this.chain(tblStyle).forEach(function (st) { mergeProps(base, kid(st.el, 'pPr')) })
      this.chain(sid).forEach(function (st) { mergeProps(base, kid(st.el, 'pPr')) })
      this._pcache.set(key, base)
    }
    var out = mergeProps(Object.assign({}, base), pPr)
    out.styleId = sid
    // 编号可以来自样式：样式里的 numPr 只给了 numId 时，级别取样式的 outline
    return out
  }

  /** 文字的有效属性 */
  Doc.prototype.rProps = function (rPr, pStyleId, tblStyle) {
    var rs = wattr(kid(rPr, 'rStyle'), 'val')
    var key = (tblStyle || '') + '|' + (pStyleId || '') + '|' + (rs || '')
    var base = this._rcache.get(key)
    if (!base) {
      base = {}
      var self = this
      mergeProps(base, this.styles().rDef)
      if (tblStyle) this.chain(tblStyle).forEach(function (st) { mergeProps(base, kid(st.el, 'rPr')) })
      this.chain(pStyleId || this.styles().defP).forEach(function (st) { mergeProps(base, kid(st.el, 'rPr')) })
      if (rs) this.chain(rs).forEach(function (st) { mergeProps(base, kid(st.el, 'rPr')) })
      this._rcache.set(key, base)
    }
    return mergeProps(Object.assign({}, base), rPr)
  }

  /** 字体名（CSS 用）：西文字体在前，中文字体在后 */
  Doc.prototype.fontsOf = function (props) {
    var f = props.rFonts || {}
    var self = this
    var pick = function (k) {
      if (f[k + 'Theme']) return self.themeFont(f[k + 'Theme']) || f[k] || ''
      return f[k] || ''
    }
    var out = []
    ;[pick('ascii'), pick('hAnsi'), pick('eastAsia')].forEach(function (x) {
      if (x && out.indexOf(x) < 0) out.push(x)
    })
    return out
  }

  Doc.prototype.colorOf = function (el) {
    if (!el) return null
    var v = wattr(el, 'val')
    var tc = wattr(el, 'themeColor')
    if ((!v || v === 'auto') && tc) {
      var h = this.themeColor(tc)
      return h ? '#' + h : null
    }
    if (!v || v === 'auto') return null
    return '#' + v
  }

  /** 编辑界面里列出的段落样式 */
  Doc.prototype.paragraphStyles = function () {
    var out = []
    this.styles().list.forEach(function (st) {
      if (st.type !== 'paragraph') return
      if (st.hidden && !st.q) return
      if (!st.q && st.prio > 50 && !st.isDefault) return
      out.push(st)
    })
    out.sort(function (a, b) {
      return (a.isDefault ? -1 : 0) - (b.isDefault ? -1 : 0) || a.prio - b.prio || a.name.localeCompare(b.name)
    })
    return out
  }

  /* ---------- 内置样式（文档里没有时补上） ---------- */

  var BUILTIN = {
    title: ['Title', 'paragraph', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>'],
    subtitle: ['Subtitle', 'paragraph', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>'],
    quote: ['Quote', 'paragraph', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:spacing w:before="160" w:after="160"/><w:ind w:left="864" w:right="864"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr>'],
    'list paragraph': ['ListParagraph', 'paragraph', '<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr>'],
    'table grid': ['TableGrid', 'table', '<w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>'],
    hyperlink: ['Hyperlink', 'character', '<w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>'],
    code: ['Code', 'paragraph', '<w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>']
  }
  var HSIZE = [0, 32, 28, 26, 24, 22, 21]
  for (var hn = 1; hn <= 6; hn++)
    BUILTIN['heading ' + hn] = ['Heading' + hn, 'paragraph', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="' + (hn <= 2 ? 340 : 260) + '" w:after="' + (hn <= 2 ? 200 : 120) + '"/><w:outlineLvl w:val="' + (hn - 1) + '"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="' + HSIZE[hn] + '"/><w:szCs w:val="' + HSIZE[hn] + '"/></w:rPr>']

  /** 找到（或新建）一个内置样式，返回 styleId */
  Doc.prototype.ensureStyle = function (name) {
    var st = this.styleByName(name)
    if (st) return st.id
    var b = BUILTIN[String(name).toLowerCase()]
    if (!b) return null
    var part = this.ensureStylesPart()
    var root = this.pkg.root(part)
    var id = b[0]
    while (this.style(id)) id += '0'
    // 基础样式不叫 Normal 时（例如中文 Word 的样式 id 是 a），换成文档的默认段落样式
    var defP = this.styles().defP
    var inner = b[2]
    if (!this.style('Normal')) {
      inner = inner.replace(/<w:basedOn w:val="Normal"\/>/, defP ? '<w:basedOn w:val="' + defP + '"/>' : '').replace(/<w:next w:val="Normal"\/>/, defP ? '<w:next w:val="' + defP + '"/>' : '')
    }
    // Word 内置样式的 name：标题是小写的 "heading 1"，其他首字母大写
    var low = String(name).toLowerCase()
    var nm = /^heading \d$/.test(low) ? low : low.replace(/\b\w/g, function (c) { return c.toUpperCase() })
    var xml = '<w:style xmlns:w="' + W + '" w:type="' + b[1] + '" w:styleId="' + id + '"><w:name w:val="' + nm + '"/>' + inner + '</w:style>'
    var el = new DOMParser().parseFromString(xml, 'application/xml').documentElement
    root.appendChild(root.ownerDocument.importNode(el, true))
    this.pkg.touch(part)
    this.invalidate()
    return id
  }
  Doc.prototype.ensureStylesPart = function () {
    if (this.stylesPart) return this.stylesPart
    var part = 'word/styles.xml'
    this.pkg.setXml(part, OX.XML_DECL + '<w:styles xmlns:w="' + W + '"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>')
    this.pkg.addRel(this.main, OX.REL.styles, part)
    this.pkg.addOverride(part, OX.CT.styles)
    this.stylesPart = part
    this.invalidate()
    return part
  }

  /* ---------- 编号 ---------- */

  Doc.prototype.numbering = function () {
    if (this._num) return this._num
    var n = { abs: new Map(), nums: new Map() }
    var root = this.numberingPart ? this.pkg.root(this.numberingPart) : null
    if (root) {
      kids(root, 'abstractNum').forEach(function (a) {
        n.abs.set(wattr(a, 'abstractNumId'), a)
      })
      kids(root, 'num').forEach(function (x) {
        var ov = {}
        kids(x, 'lvlOverride').forEach(function (o) {
          var l = wnum(o, 'ilvl', 0)
          ov[l] = { start: wnum(kid(o, 'startOverride'), 'val', null), lvl: kid(o, 'lvl') }
        })
        n.nums.set(wattr(x, 'numId'), { abs: wattr(kid(x, 'abstractNumId'), 'val'), ov: ov })
      })
    }
    this._num = n
    return n
  }
  /** 列表某一级的定义 */
  Doc.prototype.level = function (numId, ilvl) {
    var n = this.numbering()
    var num = n.nums.get(String(numId))
    if (!num) return null
    var a = n.abs.get(num.abs)
    if (!a) return null
    // numStyleLink：指向一个编号样式，真正的定义在那个样式的 num 里
    var link = wattr(kid(a, 'numStyleLink'), 'val')
    if (link && !kids(a, 'lvl').length) {
      var st = this.style(link)
      var nid = st && wattr(OX.path(st.el, 'pPr', 'numPr', 'numId'), 'val')
      if (nid && nid !== String(numId)) return this.level(nid, ilvl)
    }
    var lvl = null
    if (num.ov[ilvl] && num.ov[ilvl].lvl) lvl = num.ov[ilvl].lvl
    if (!lvl)
      kids(a, 'lvl').forEach(function (l) {
        if (wnum(l, 'ilvl', 0) === ilvl) lvl = l
      })
    if (!lvl) return null
    var rpr = kid(lvl, 'rPr')
    var rf = kid(rpr, 'rFonts')
    return {
      abs: num.abs,
      el: lvl,
      fmt: wattr(kid(lvl, 'numFmt'), 'val') || 'decimal',
      text: wattr(kid(lvl, 'lvlText'), 'val'),
      start: wnum(kid(lvl, 'start'), 'val', 1),
      restart: wnum(kid(lvl, 'lvlRestart'), 'val', null),
      legal: !!kid(lvl, 'isLgl'),
      suff: wattr(kid(lvl, 'suff'), 'val') || 'tab',
      jc: wattr(kid(lvl, 'lvlJc'), 'val') || 'left',
      pPr: kid(lvl, 'pPr'),
      rPr: rpr,
      font: rf ? wattr(rf, 'ascii') || wattr(rf, 'hAnsi') || '' : '',
      startOverride: num.ov[ilvl] ? num.ov[ilvl].start : null
    }
  }
  /** 段落的编号（numId + 级别），来自直接格式或样式；没有时返回 null */
  Doc.prototype.numPrOf = function (props) {
    var np = props.numPr
    if (!np) return null
    var id = wattr(kid(np, 'numId'), 'val')
    if (id == null || id === '0') return null
    var il = kid(np, 'ilvl')
    var lvl = il ? wnum(il, 'val', 0) : props.outlineLvl ? wnum(props.outlineLvl, 'val', 0) : 0
    if (!this.level(id, lvl)) return null
    return { numId: id, ilvl: lvl }
  }

  /** 编号计数器：按文档顺序依次调用 next() */
  Doc.prototype.counter = function () {
    var self = this
    var counts = {}
    var seen = {}
    return {
      next: function (numId, ilvl) {
        var lv = self.level(numId, ilvl)
        if (!lv) return null
        var c = counts[lv.abs] || (counts[lv.abs] = [])
        if (!seen[numId]) {
          seen[numId] = 1
          var num = self.numbering().nums.get(String(numId))
          if (num)
            Object.keys(num.ov).forEach(function (k) {
              if (num.ov[k].start != null) {
                c[k] = num.ov[k].start - 1
                for (var j = Number(k) + 1; j < 9; j++) c[j] = undefined
              }
            })
        }
        c[ilvl] = (c[ilvl] == null ? lv.start - 1 : c[ilvl]) + 1
        for (var j = ilvl + 1; j < 9; j++) c[j] = undefined
        if (lv.fmt === 'bullet') return { text: bulletChar(lv.text, lv.font), lv: lv }
        var s = (lv.text == null ? '%' + (ilvl + 1) + '.' : lv.text).replace(/%(\d)/g, function (m, d) {
          var k = Number(d) - 1
          var l2 = k === ilvl ? lv : self.level(numId, k)
          var v = c[k] == null ? (l2 ? l2.start : 1) : c[k]
          return formatNum(v, lv.legal && k !== ilvl ? 'decimal' : l2 ? l2.fmt : 'decimal')
        })
        return { text: s, lv: lv }
      }
    }
  }

  Doc.prototype.ensureNumberingPart = function () {
    if (this.numberingPart) return this.numberingPart
    var part = this.pkg.has('word/numbering.xml') ? this.pkg.uniqueName('word/numbering', '.xml') : 'word/numbering.xml'
    this.pkg.setXml(part, OX.XML_DECL + '<w:numbering xmlns:w="' + W + '"></w:numbering>')
    this.pkg.addRel(this.main, OX.REL.numbering, part)
    this.pkg.addOverride(part, OX.CT.numbering)
    this.numberingPart = part
    this._num = null
    return part
  }
  /** 新建一个列表（bullet / decimal），返回 numId */
  Doc.prototype.addList = function (kind) {
    var part = this.ensureNumberingPart()
    var root = this.pkg.root(part)
    var maxA = -1, maxN = 0
    kids(root, 'abstractNum').forEach(function (a) { maxA = Math.max(maxA, wnum(a, 'abstractNumId', 0)) })
    kids(root, 'num').forEach(function (a) { maxN = Math.max(maxN, wnum(a, 'numId', 0)) })
    var aid = maxA + 1, nid = maxN + 1
    var lv = ''
    var bullets = ['•', '◦', '▪']
    var fmts = ['decimal', 'lowerLetter', 'lowerRoman']
    for (var i = 0; i < 9; i++) {
      var left = 420 * (i + 1) + (kind === 'bullet' ? 0 : 0)
      if (kind === 'bullet') lv += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="' + bullets[i % 3] + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + left + '" w:hanging="420"/></w:pPr></w:lvl>'
      else lv += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + fmts[i % 3] + '"/><w:lvlText w:val="%' + (i + 1) + (i % 3 === 0 ? '.' : ')') + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + left + '" w:hanging="420"/></w:pPr></w:lvl>'
    }
    var xml = '<w:x xmlns:w="' + W + '"><w:abstractNum w:abstractNumId="' + aid + '"><w:multiLevelType w:val="hybridMultilevel"/>' + lv + '</w:abstractNum><w:num w:numId="' + nid + '"><w:abstractNumId w:val="' + aid + '"/></w:num></w:x>'
    var frag = new DOMParser().parseFromString(xml, 'application/xml').documentElement
    var a = root.ownerDocument.importNode(kid(frag, 'abstractNum'), true)
    var n = root.ownerDocument.importNode(kid(frag, 'num'), true)
    var firstNum = kid(root, 'num')
    root.insertBefore(a, firstNum || kid(root, 'numIdMacAtCleanup'))
    root.insertBefore(n, kid(root, 'numIdMacAtCleanup'))
    this.pkg.touch(part)
    this._num = null
    return String(nid)
  }
  Doc.prototype.listKind = function (numId) {
    var lv = this.level(numId, 0)
    return lv ? (lv.fmt === 'bullet' ? 'bullet' : 'number') : null
  }

  /** 设置段落的编号（numId 为 null 时去掉） */
  Doc.prototype.setNumbering = function (p, numId, ilvl) {
    var pPr = pPrOf(p, true)
    OX.removeKid(pPr, 'numPr')
    if (numId != null) {
      var np = ensureW(pPr, 'numPr', PPR_ORDER)
      np.appendChild(wel(p.ownerDocument, 'ilvl', { val: ilvl || 0 }))
      np.appendChild(wel(p.ownerDocument, 'numId', { val: numId }))
      // 列表段落自己的缩进会盖住列表定义里的缩进
      var ind = kid(pPr, 'ind')
      if (ind) pPr.removeChild(ind)
    } else {
      // 样式里带编号（例如有编号的标题）时，用 numId=0 去掉
      var props = this.pProps(p)
      if (props.numPr) {
        var np2 = ensureW(pPr, 'numPr', PPR_ORDER)
        np2.appendChild(wel(p.ownerDocument, 'numId', { val: 0 }))
      }
    }
  }

  /* ---------- 图片、超链接 ---------- */

  Doc.prototype.mediaUrl = function (part, rId) {
    var rel = this.pkg.rel(part, rId)
    return rel && !rel.external ? this.pkg.mediaUrl(rel.target) : ''
  }
  Doc.prototype.addImage = function (bytes, ext) {
    ext = ext === 'jpg' ? 'jpeg' : ext
    var name = this.pkg.uniqueName('word/media/image', '.' + ext)
    this.pkg.setBytes(name, bytes)
    this.pkg.ensureDefault(ext, OX.MIME[ext] || 'image/' + ext)
    return this.pkg.addRel(this.main, OX.REL.image, name)
  }
  Doc.prototype.addLink = function (url) {
    return this.pkg.addRel(this.main, OX.REL.hyperlink, url, true)
  }
  Doc.prototype.nextDocPrId = function () {
    var max = 0
    OX.desc(this.xml.documentElement, 'docPr').forEach(function (d) {
      max = Math.max(max, Number(d.getAttribute('id')) || 0)
    })
    return max + 1
  }
  /** 一个嵌入式图片的 <w:r>（cx / cy 为 EMU） */
  Doc.prototype.pictureRun = function (rId, cx, cy, name) {
    var id = this.nextDocPrId()
    cx = Math.round(cx)
    cy = Math.round(cy)
    name = String(name || 'Picture ' + id).replace(/[<>&"]/g, '')
    var xml =
      '<w:r xmlns:w="' + W + '" xmlns:wp="' + NS.wp + '" xmlns:a="' + NS.a + '" xmlns:pic="' + NS.pic + '" xmlns:r="' + NS.r + '"><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:docPr id="' + id + '" name="' + name + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      '<pic:nvPicPr><pic:cNvPr id="0" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + rId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    var el = new DOMParser().parseFromString(xml, 'application/xml').documentElement
    return this.xml.importNode(el, true)
  }
  /** 正文可用宽度（EMU） */
  Doc.prototype.textWidthEmu = function () {
    var g = this.page()
    return Math.max(1, g.w - g.left - g.right) * 635
  }
  /** 页面尺寸和页边距（twip），取最后一节 */
  Doc.prototype.page = function () {
    var sp = kid(this.body(), 'sectPr')
    var sz = kid(sp, 'pgSz')
    var mar = kid(sp, 'pgMar')
    return {
      w: wnum(sz, 'w', 11906),
      h: wnum(sz, 'h', 16838),
      top: Math.abs(wnum(mar, 'top', 1440)),
      bottom: Math.abs(wnum(mar, 'bottom', 1440)),
      left: wnum(mar, 'left', 1800),
      right: wnum(mar, 'right', 1800),
      header: wnum(mar, 'header', 720),
      footer: wnum(mar, 'footer', 720),
      sectPr: sp
    }
  }
  /** 某一节默认的页眉 / 页脚部件 */
  Doc.prototype.headerPart = function (kind) {
    var sp = kid(this.body(), 'sectPr')
    var ref = null
    kids(sp, kind + 'Reference').forEach(function (r) {
      var t = wattr(r, 'type') || 'default'
      if (t === 'default' || (!ref && t === 'first')) ref = r
    })
    if (!ref) return null
    var rel = this.pkg.rel(this.main, OX.rid(ref, 'id'))
    return rel && this.pkg.has(rel.target) ? rel.target : null
  }

  /* ---------------- 段落文字（XML） ---------------- */

  var SKIP = { del: 1, instrText: 1, delInstrText: 1, drawing: 1, pict: 1, object: 1, rPr: 1, pPr: 1, sectPr: 1, fldChar: 0, moveFrom: 1, txbxContent: 1 }
  /** 段落里能看到的文字片段：[{ el, text, edit }]（edit 为 true 的是 <w:t>，可以改） */
  function segments(p) {
    var out = []
    var walk = function (el) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        var n = c.localName
        if (SKIP[n]) {
          if (n === 'drawing' || n === 'pict' || n === 'object') out.push({ el: c, text: '￼', edit: false })
          continue
        }
        if (n === 't') out.push({ el: c, text: c.textContent, edit: true })
        else if (n === 'tab' && c.parentNode.localName === 'r') out.push({ el: c, text: '\t', edit: false })
        else if ((n === 'br' || n === 'cr') && c.parentNode.localName === 'r') out.push({ el: c, text: '\n', edit: false })
        else if (n === 'noBreakHyphen') out.push({ el: c, text: '-', edit: false })
        else if (n === 'sym') out.push({ el: c, text: String.fromCharCode(parseInt(wattr(c, 'char') || '25A1', 16) & 0xffff), edit: false })
        else if (n === 'p' || n === 'tbl') continue
        else walk(c)
      }
    }
    walk(p)
    return out
  }
  function paraText(p, keepObj) {
    var s = segments(p)
      .map(function (x) { return x.text })
      .join('')
    return keepObj ? s : s.replace(/￼/g, '')
  }
  function setT(t, text) {
    t.textContent = text
    if (/^\s|\s$|\s\s/.test(text)) t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  }
  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  /**
   * 段落里查找替换，保留每段文字原来的格式。返回替换次数。
   * re：带 g 标志的正则；replace 为字符串（支持 $1）或函数。跨越制表符 / 换行 / 图片的匹配跳过。
   */
  function replaceInPara(p, re, replace, limit) {
    var segs = segments(p)
    if (!segs.length) return 0
    var full = ''
    segs.forEach(function (s) {
      s.start = full.length
      full += s.text
    })
    var matches = []
    re.lastIndex = 0
    var m
    while ((m = re.exec(full))) {
      if (m[0] === '') {
        re.lastIndex++
        continue
      }
      matches.push({ s: m.index, e: m.index + m[0].length, rep: typeof replace === 'function' ? replace.apply(null, m.concat([m.index, full])) : m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replace) })
      if (limit && matches.length >= limit) break
    }
    var count = 0
    for (var k = matches.length - 1; k >= 0; k--) {
      var mt = matches[k]
      var cover = segs.filter(function (s) {
        return s.start < mt.e && s.start + s.text.length > mt.s
      })
      if (!cover.length || cover.some(function (s) { return !s.edit })) continue
      cover.forEach(function (s, i) {
        var a = Math.max(0, mt.s - s.start)
        var b = Math.min(s.text.length, mt.e - s.start)
        var nt = s.text.slice(0, a) + (i === 0 ? mt.rep : '') + s.text.slice(b)
        s.text = nt
        setT(s.el, nt)
      })
      // 重新算位置
      var pos = 0
      segs.forEach(function (s) {
        s.start = pos
        pos += s.text.length
      })
      count++
    }
    // 清理空的 <w:t> 和只剩 rPr 的 <w:r>
    if (count)
      segs.forEach(function (s) {
        if (s.edit && s.el.textContent === '' && s.el.parentNode) {
          var r = s.el.parentNode
          r.removeChild(s.el)
          if (r.localName === 'r' && !kids(r).some(function (c) { return c.localName !== 'rPr' })) r.parentNode.removeChild(r)
        }
      })
    return count
  }

  /* ---------------- 块（AI 工具用的编号） ---------------- */

  /** 正文里的块：段落和表格（内容控件里的块展开） */
  function blocksOf(container) {
    var out = []
    var walk = function (el) {
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === 'p' || c.localName === 'tbl') out.push(c)
        else if (c.localName === 'sdt') walk(kid(c, 'sdtContent') || c)
        else if (c.localName === 'customXml') walk(c)
      }
    }
    walk(container)
    return out
  }

  /* ---------------- Markdown → OOXML ---------------- */

  function parseInline(text) {
    // 返回 [{ text, b, i, s, code, u, link }]
    var out = []
    var re = /(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)|(~~([^~]+)~~)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(<u>(.*?)<\/u>)/g
    var last = 0
    var m
    var push = function (t, f) {
      if (!t) return
      var o = Object.assign({ text: t }, f || {})
      out.push(o)
    }
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index))
      if (m[1]) push(m[2], { b: 1, i: 1 })
      else if (m[3]) push(m[4], { b: 1 })
      else if (m[5]) push(m[6], { b: 1 })
      else if (m[7]) push(m[8], { i: 1 })
      else if (m[9]) push(m[10], { i: 1 })
      else if (m[11]) push(m[12], { s: 1 })
      else if (m[13]) push(m[14], { code: 1 })
      else if (m[15]) push(m[16], { link: m[17] })
      else if (m[18]) push(m[19], { u: 1 })
      last = re.lastIndex
    }
    push(text.slice(last))
    return out.map(function (x) {
      x.text = x.text.replace(/\\([*_~`\[\]\\])/g, '$1')
      return x
    })
  }

  /**
   * 把一段行内文字变成 run 列表加进 parent（<w:p> 或 <w:hyperlink>）。
   * base：基础 rPr（克隆后加格式），markdown 为 false 时不解析 ** 等标记。
   */
  Doc.prototype.appendRuns = function (parent, text, base, markdown) {
    var doc = this.xml
    var self = this
    var parts = markdown === false ? [{ text: text }] : parseInline(text)
    parts.forEach(function (part) {
      var target = parent
      if (part.link) {
        var hl = wel(doc, 'hyperlink')
        if (/^#/.test(part.link)) setW(hl, 'anchor', part.link.slice(1))
        else hl.setAttributeNS(NS.r, 'r:id', self.addLink(part.link))
        parent.appendChild(hl)
        target = hl
      }
      var rPr = base ? base.cloneNode(true) : wel(doc, 'rPr')
      if (part.link) {
        var hs = self.ensureStyle('hyperlink')
        if (hs) {
          OX.removeKid(rPr, 'rStyle')
          ensureW(rPr, 'rStyle', RPR_ORDER)
          setW(kid(rPr, 'rStyle'), 'val', hs)
        }
      }
      if (part.b) ensureW(rPr, 'b', RPR_ORDER), ensureW(rPr, 'bCs', RPR_ORDER)
      if (part.i) ensureW(rPr, 'i', RPR_ORDER), ensureW(rPr, 'iCs', RPR_ORDER)
      if (part.s) ensureW(rPr, 'strike', RPR_ORDER)
      if (part.u) setW(ensureW(rPr, 'u', RPR_ORDER), 'val', 'single')
      if (part.code) {
        var rf = ensureW(rPr, 'rFonts', RPR_ORDER)
        setW(rf, 'ascii', 'Consolas')
        setW(rf, 'hAnsi', 'Consolas')
        var shd = ensureW(rPr, 'shd', RPR_ORDER)
        setW(shd, 'val', 'clear')
        setW(shd, 'color', 'auto')
        setW(shd, 'fill', 'F2F2F2')
      }
      var lines = part.text.split('\n')
      lines.forEach(function (line, li) {
        var r = wel(doc, 'r')
        if (rPr.firstElementChild) r.appendChild(rPr.cloneNode(true))
        if (li > 0) r.appendChild(wel(doc, 'br'))
        line.split('\t').forEach(function (seg, si) {
          if (si > 0) r.appendChild(wel(doc, 'tab'))
          if (seg) {
            var t = wel(doc, 't')
            setT(t, seg)
            r.appendChild(t)
          }
        })
        if (kids(r).some(function (c) { return c.localName !== 'rPr' })) target.appendChild(r)
      })
    })
  }

  Doc.prototype.newPara = function (text, opts) {
    opts = opts || {}
    var p = wel(this.xml, 'p')
    if (opts.style || opts.numId != null || opts.align || opts.border || opts.pageBreak) {
      var pPr = pPrOf(p, true)
      if (opts.style) setW(ensureW(pPr, 'pStyle', PPR_ORDER), 'val', opts.style)
      if (opts.numId != null) {
        var np = ensureW(pPr, 'numPr', PPR_ORDER)
        np.appendChild(wel(this.xml, 'ilvl', { val: opts.ilvl || 0 }))
        np.appendChild(wel(this.xml, 'numId', { val: opts.numId }))
      }
      if (opts.align) setW(ensureW(pPr, 'jc', PPR_ORDER), 'val', opts.align)
      if (opts.border) {
        var bd = ensureW(pPr, 'pBdr', PPR_ORDER)
        bd.appendChild(wel(this.xml, 'bottom', { val: 'single', sz: 6, space: 1, color: 'auto' }))
      }
    }
    if (opts.pageBreak) {
      var r = wel(this.xml, 'r')
      r.appendChild(wel(this.xml, 'br', { type: 'page' }))
      p.appendChild(r)
    }
    if (text) this.appendRuns(p, text, opts.rPr || null, opts.markdown)
    return p
  }

  /** 表格：rows 为二维文字数组 */
  Doc.prototype.newTable = function (rows, opts) {
    opts = opts || {}
    var doc = this.xml
    var nCols = 0
    rows.forEach(function (r) { nCols = Math.max(nCols, r.length) })
    nCols = Math.max(1, nCols)
    var width = Math.floor(this.textWidthEmu() / 635)
    var cw = Math.floor(width / nCols)
    var tbl = wel(doc, 'tbl')
    var tblPr = wel(doc, 'tblPr')
    var gs = this.ensureStyle('table grid')
    if (gs) tblPr.appendChild(wel(doc, 'tblStyle', { val: gs }))
    tblPr.appendChild(wel(doc, 'tblW', { w: 0, type: 'auto' }))
    if (!gs) {
      var b = wel(doc, 'tblBorders')
      ;['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].forEach(function (k) {
        b.appendChild(wel(doc, k, { val: 'single', sz: 4, space: 0, color: 'auto' }))
      })
      tblPr.appendChild(b)
    }
    tblPr.appendChild(wel(doc, 'tblLook', { val: '04A0', firstRow: 1, lastRow: 0, firstColumn: 1, lastColumn: 0, noHBand: 0, noVBand: 1 }))
    tbl.appendChild(tblPr)
    var grid = wel(doc, 'tblGrid')
    for (var c = 0; c < nCols; c++) grid.appendChild(wel(doc, 'gridCol', { w: cw }))
    tbl.appendChild(grid)
    var self = this
    rows.forEach(function (row, ri) {
      var tr = wel(doc, 'tr')
      if (ri === 0 && opts.header) {
        var trPr = wel(doc, 'trPr')
        trPr.appendChild(wel(doc, 'tblHeader'))
        tr.appendChild(trPr)
      }
      for (var c = 0; c < nCols; c++) tr.appendChild(self.newCell(row[c] || '', cw, ri === 0 && opts.header))
      tbl.appendChild(tr)
    })
    return tbl
  }
  Doc.prototype.newCell = function (text, w, bold) {
    var doc = this.xml
    var tc = wel(doc, 'tc')
    var tcPr = wel(doc, 'tcPr')
    tcPr.appendChild(wel(doc, 'tcW', { w: w || 0, type: w ? 'dxa' : 'auto' }))
    tc.appendChild(tcPr)
    var self = this
    String(text == null ? '' : text)
      .split('\n')
      .forEach(function (line) {
        var base = null
        if (bold) {
          base = wel(doc, 'rPr')
          base.appendChild(wel(doc, 'b'))
        }
        tc.appendChild(self.newPara(line, { rPr: base }))
      })
    return tc
  }

  /**
   * Markdown（子集）→ 块元素列表：# 标题、- / * / 1. 列表（两个空格一级）、> 引用、``` 代码、| 表格 |、
   * --- 分隔线、<!-- pagebreak --> 分页；行内 **粗** *斜* ~~删除~~ `代码` [链接](url) <u>下划线</u>。
   * 每个非空行是一个段落。
   */
  Doc.prototype.fromMarkdown = function (md, opts) {
    opts = opts || {}
    var self = this
    var out = []
    var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
    var lists = {} // kind → numId（连续的列表共用）
    var lastKind = null
    var baseStyle = opts.style ? this.styleArg(opts.style) : null
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (/^\s*```/.test(line)) {
        var code = []
        i++
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
        var cs = this.ensureStyle('code')
        code.forEach(function (c) {
          out.push(self.newPara(c, { style: cs, markdown: false }))
        })
        lastKind = null
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        var rows = []
        var header = false
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          var cells = lines[i].trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|') })
          if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c) })) header = rows.length === 1
          else rows.push(cells)
          i++
        }
        i--
        var tbl = this.newTable(rows.map(function (r) { return r.map(function () { return '' }) }), { header: header })
        // 单元格文字带行内格式
        kids(tbl, 'tr').forEach(function (tr, ri) {
          kids(tr, 'tc').forEach(function (tc, ci) {
            var p = kid(tc, 'p')
            var base = null
            if (ri === 0 && header) {
              base = wel(self.xml, 'rPr')
              base.appendChild(wel(self.xml, 'b'))
            }
            self.appendRuns(p, (rows[ri][ci] || '').replace(/<br\s*\/?>/gi, '\n'), base)
          })
        })
        out.push(tbl)
        lastKind = null
        continue
      }
      if (!line.trim()) {
        lastKind = null
        continue
      }
      if (/^\s*<!--\s*page\s*break\s*-->\s*$/i.test(line)) {
        out.push(this.newPara('', { pageBreak: true }))
        continue
      }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push(this.newPara('', { border: true }))
        continue
      }
      var m = /^(#{1,6})\s+(.*)$/.exec(line)
      if (m) {
        var lvl = m[1].length
        var sid = lvl === 1 && opts.titleAsHeading1 === false ? this.ensureStyle('title') : this.ensureStyle('heading ' + lvl)
        out.push(this.newPara(m[2].replace(/\s+#+\s*$/, ''), { style: sid }))
        lastKind = null
        continue
      }
      m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (m) {
        var kind = /\d/.test(m[2]) ? 'number' : 'bullet'
        var ilvl = Math.min(8, Math.floor(m[1].replace(/\t/g, '  ').length / 2))
        if (lastKind !== kind || !lists[kind]) lists[kind] = this.addList(kind === 'bullet' ? 'bullet' : 'decimal')
        lastKind = kind
        var lp = this.ensureStyle('list paragraph')
        var text = m[3]
        var task = /^\[( |x|X)\]\s+/.exec(text)
        if (task) text = (task[1] === ' ' ? '☐ ' : '☑ ') + text.slice(task[0].length)
        out.push(this.newPara(text, { style: lp, numId: lists[kind], ilvl: ilvl }))
        continue
      }
      lastKind = null
      m = /^\s*>\s?(.*)$/.exec(line)
      if (m) {
        out.push(this.newPara(m[1], { style: this.ensureStyle('quote') }))
        continue
      }
      out.push(this.newPara(line.replace(/^\s+/, ''), { style: baseStyle }))
    }
    return out
  }

  /** 样式参数：样式 id、名称，或 "Heading 1" / "标题 1" / "title" / "normal" 之类 */
  Doc.prototype.styleArg = function (name) {
    if (name == null || name === '') return null
    var s = String(name).trim()
    var st = this.style(s) || this.styleByName(s)
    if (st) return st.id
    var m = /^(?:h|heading|标题)\s*(\d)$/i.exec(s)
    if (m) return this.ensureStyle('heading ' + m[1])
    var low = s.toLowerCase()
    var alias = { '标题': 'title', '副标题': 'subtitle', '引用': 'quote', '正文': 'normal', 'body': 'normal', 'text': 'normal', '代码': 'code', 'list': 'list paragraph', '列表段落': 'list paragraph' }
    if (alias[s]) low = alias[s]
    if (low === 'normal') return this.styles().defP || this.styleByName('normal')?.id || null
    var id = this.ensureStyle(low)
    if (id) return id
    throw new Error('Unknown style "' + name + '". Available: ' + this.paragraphStyles().map(function (x) { return x.name }).join(', '))
  }

  window.DocModel = {
    Doc: Doc,
    W: W,
    wattr: wattr,
    wnum: wnum,
    on: on,
    wel: wel,
    setW: setW,
    ensureW: ensureW,
    pPrOf: pPrOf,
    rPrOf: rPrOf,
    PPR_ORDER: PPR_ORDER,
    RPR_ORDER: RPR_ORDER,
    TCPR_ORDER: TCPR_ORDER,
    segments: segments,
    paraText: paraText,
    replaceInPara: replaceInPara,
    escRe: escRe,
    setT: setT,
    blocksOf: blocksOf,
    formatNum: formatNum,
    bulletChar: bulletChar
  }
})()
