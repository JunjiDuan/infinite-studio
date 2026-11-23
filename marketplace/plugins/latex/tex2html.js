/* LaTeX → HTML 即时预览 —— Infinite Studio LaTeX 编辑器
 *
 * 不是 TeX 引擎：按 LaTeX 文档的常见写法直接转成 HTML，公式交给 KaTeX。
 * 覆盖章节编号、列表、表格、浮动体、定理、交叉引用、脚注、参考文献、\newcommand 等日常用法；
 * TikZ 之类的绘图和精确排版请用“PDF”模式（本机 TeX 编译）。
 *
 *   TeX2HTML.render(source, {
 *     katex,                      KaTeX 对象
 *     files: { '/a/b.tex': text } \input / \include / .bib 的内容（null = 找不到，undefined = 还没读）
 *     base: '/a',                 相对路径的起点（主文件所在目录，以 / 开头）
 *   }) → { html, toc, labels, bibKeys, need, warnings, title, lang }
 */
;(function (global) {
  'use strict'

  /* ================= 源文本与行号 ================= */

  function Source(text, fixedLine) {
    this.text = text
    this.fixed = fixedLine == null ? null : fixedLine
    if (this.fixed == null) {
      var s = [0]
      for (var i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) s.push(i + 1)
      this.starts = s
    }
  }
  /** 位置 → 行号（从 0 开始）；宏展开 / \input 进来的内容固定在调用处那一行 */
  Source.prototype.line = function (pos) {
    if (this.fixed != null) return this.fixed
    var s = this.starts
    var lo = 0
    var hi = s.length - 1
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1
      if (s[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /* ================= 小工具 ================= */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function stripTags(h) {
    return String(h)
      .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
      .replace(/<span class="katex-mathml">[\s\S]*?<\/span>(?=<span class="katex-html")/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
  }
  var CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]/
  var LETTER = /[A-Za-z@]/

  function roman(n) {
    if (n <= 0 || n >= 4000) return String(n)
    var v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1]
    var r = ['m', 'cm', 'd', 'cd', 'c', 'xc', 'l', 'xl', 'x', 'ix', 'v', 'iv', 'i']
    var out = ''
    for (var i = 0; i < v.length; i++)
      while (n >= v[i]) {
        out += r[i]
        n -= v[i]
      }
    return out
  }
  function alph(n) {
    if (n <= 0) return String(n)
    var s = ''
    while (n > 0) {
      n--
      s = String.fromCharCode(97 + (n % 26)) + s
      n = Math.floor(n / 26)
    }
    return s
  }
  var CN = '零一二三四五六七八九'
  function chineseNum(n) {
    if (n <= 0 || n >= 100) return String(n)
    if (n < 10) return CN[n]
    var t = Math.floor(n / 10)
    return (t > 1 ? CN[t] : '') + '十' + (n % 10 ? CN[n % 10] : '')
  }
  function fnSymbol(n) {
    var s = ['*', '†', '‡', '§', '¶', '‖', '**', '††', '‡‡']
    return s[(n - 1) % s.length]
  }

  /** LaTeX 长度 → CSS（\textwidth 的倍数变成百分比） */
  function cssLen(s) {
    s = String(s || '').trim()
    if (!s) return ''
    var m = /^(-?[\d.]*)\s*\\(textwidth|linewidth|columnwidth|hsize|paperwidth|textheight)$/.exec(s)
    if (m) {
      var f = m[1] === '' || m[1] === '-' ? 1 : parseFloat(m[1])
      if (m[2] === 'textheight') return Math.round(f * 60) + 'vh'
      return +(f * 100).toFixed(2) + '%'
    }
    m = /^(-?\d*\.?\d+)\s*(pt|bp|cm|mm|in|em|ex|pc|px|dd|sp)?$/.exec(s)
    if (m) {
      var u = m[2] || 'pt'
      var n = parseFloat(m[1])
      if (u === 'bp') u = 'pt'
      if (u === 'dd') (n *= 1.07), (u = 'pt')
      if (u === 'sp') (n /= 65536), (u = 'pt')
      return +n.toFixed(3) + u
    }
    m = /^(-?[\d.]*)\s*\\(baselineskip|parindent|parskip|fill|stretch)/.exec(s)
    if (m) return (m[1] === '' ? 1 : parseFloat(m[1])) * 1.4 + 'em'
    return ''
  }

  /* ---------- 颜色（xcolor 的常用写法：red、red!30、red!30!blue、HTML / rgb / RGB / gray） ---------- */

  var COLORS = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    red: [255, 0, 0],
    green: [0, 255, 0],
    blue: [0, 0, 255],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
    yellow: [255, 255, 0],
    gray: [128, 128, 128],
    darkgray: [64, 64, 64],
    lightgray: [191, 191, 191],
    brown: [191, 128, 64],
    lime: [191, 255, 0],
    olive: [128, 128, 0],
    orange: [255, 128, 0],
    pink: [255, 191, 191],
    purple: [191, 0, 64],
    teal: [0, 128, 128],
    violet: [128, 0, 128]
  }
  function colorFrom(model, spec) {
    model = String(model || '').trim()
    spec = String(spec || '').trim()
    var p = spec.split(/\s*,\s*|\s+/).map(parseFloat)
    if (model === 'HTML' && /^[0-9a-fA-F]{6}$/.test(spec)) return [parseInt(spec.slice(0, 2), 16), parseInt(spec.slice(2, 4), 16), parseInt(spec.slice(4, 6), 16)]
    if (model === 'rgb' && p.length >= 3) return p.slice(0, 3).map(function (x) { return Math.round(x * 255) })
    if (model === 'RGB' && p.length >= 3) return p.slice(0, 3).map(Math.round)
    if (model === 'gray' && p.length) return [Math.round(p[0] * 255), Math.round(p[0] * 255), Math.round(p[0] * 255)]
    if (model === 'cmyk' && p.length >= 4) {
      var k = p[3]
      return [0, 1, 2].map(function (i) { return Math.round(255 * (1 - Math.min(1, p[i] + k))) })
    }
    return null
  }
  function colorRgb(ctx, expr) {
    expr = String(expr || '').trim()
    var parts = expr.split('!')
    var base = namedColor(ctx, parts[0])
    if (!base) return null
    var cur = base
    for (var i = 1; i < parts.length; i += 2) {
      var pct = parseFloat(parts[i])
      if (isNaN(pct)) break
      var other = i + 1 < parts.length ? namedColor(ctx, parts[i + 1]) : COLORS.white
      if (!other) other = COLORS.white
      var f = pct / 100
      cur = [0, 1, 2].map(function (j) { return Math.round(cur[j] * f + other[j] * (1 - f)) })
    }
    return cur
  }
  function namedColor(ctx, n) {
    n = String(n || '').trim()
    if (ctx.colors[n]) return ctx.colors[n]
    if (COLORS[n]) return COLORS[n]
    if (/^#[0-9a-fA-F]{6}$/.test(n)) return colorFrom('HTML', n.slice(1))
    return null
  }
  function colorCss(ctx, model, spec) {
    var c = model ? colorFrom(model, spec) : colorRgb(ctx, spec)
    return c ? 'rgb(' + c.join(',') + ')' : ''
  }

  /* ================= 名称（中文文档用 ctex 的叫法） ================= */

  var NAMES = {
    en: { figure: 'Figure', table: 'Table', abstract: 'Abstract', contents: 'Contents', refs: 'References', bib: 'Bibliography', proof: 'Proof', chapter: 'Chapter', part: 'Part', appendix: 'Appendix', lof: 'List of Figures', lot: 'List of Tables', section: 'Section', equation: 'Equation', listing: 'Listing', item: 'item', footnote: 'footnote', page: 'page' },
    zh: { figure: '图', table: '表', abstract: '摘要', contents: '目录', refs: '参考文献', bib: '参考文献', proof: '证明', chapter: '章', part: '部分', appendix: '附录', lof: '插图', lot: '表格', section: '节', equation: '式', listing: '代码', item: '项', footnote: '脚注', page: '页' }
  }
  var THM_NAMES = {
    theorem: ['Theorem', '定理'],
    thm: ['Theorem', '定理'],
    lemma: ['Lemma', '引理'],
    lem: ['Lemma', '引理'],
    corollary: ['Corollary', '推论'],
    cor: ['Corollary', '推论'],
    proposition: ['Proposition', '命题'],
    prop: ['Proposition', '命题'],
    definition: ['Definition', '定义'],
    defn: ['Definition', '定义'],
    def: ['Definition', '定义'],
    example: ['Example', '例'],
    remark: ['Remark', '注'],
    rem: ['Remark', '注'],
    note: ['Note', '注'],
    conjecture: ['Conjecture', '猜想'],
    claim: ['Claim', '断言'],
    exercise: ['Exercise', '练习'],
    problem: ['Problem', '问题'],
    question: ['Question', '问题'],
    solution: ['Solution', '解'],
    assumption: ['Assumption', '假设'],
    hypothesis: ['Hypothesis', '假设'],
    notation: ['Notation', '记号'],
    observation: ['Observation', '观察'],
    fact: ['Fact', '事实'],
    axiom: ['Axiom', '公理'],
    property: ['Property', '性质'],
    algorithm: ['Algorithm', '算法']
  }

  /* ================= 文档状态 ================= */

  var SEC_LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 }

  function Ctx(opts) {
    this.opts = opts
    this.katex = opts.katex
    this.files = opts.files || {}
    this.base = opts.base || '/'
    this.prevLabels = opts.prevLabels || null
    this.cls = 'article'
    this.book = false
    this.zh = false
    this.cnt = { part: 0, chapter: 0, section: 0, subsection: 0, subsubsection: 0, paragraph: 0, subparagraph: 0, equation: 0, figure: 0, table: 0, footnote: 0, subfigure: 0, listing: 0, algorithm: 0 }
    this.parent = { section: null, subsection: 'section', subsubsection: 'subsection', paragraph: 'subsubsection', subparagraph: 'paragraph', subfigure: 'figure' }
    this.fmtOf = {}
    this.secnumdepth = 3
    this.labels = {}
    this.lastRef = null
    this.macros = {}
    this.kmacros = {}
    this.envs = {}
    this.thms = {}
    this.thmStyle = 'plain'
    this.colors = {}
    this.toc = []
    this.lof = []
    this.lot = []
    this.footnotes = []
    this.title = null
    this.author = null
    this.date = null
    this.dateSet = false
    this.cites = []
    this.citeSeen = {}
    this.nociteAll = false
    this.bibitems = {}
    this.bibitemOrder = []
    this.bibFiles = []
    this.graphicspath = []
    this.appendix = false
    this.list = null
    this.listDepth = 0
    this.float = null
    this.seq = 0
    this.depth = 0
    this.expansions = 0
    this.need = {}
    this.warn = {}
    this.mathRefMiss = false
    this.includeDepth = 0
    this.beamer = false
  }
  Ctx.prototype.id = function (p) {
    return (p || 'x') + '-' + ++this.seq
  }
  Ctx.prototype.setBook = function () {
    this.book = true
    var p = this.parent
    p.section = 'chapter'
    p.equation = p.figure = p.table = p.listing = p.algorithm = 'chapter'
  }
  /** \renewcommand{\figurename}{Fig.} 之类的改名优先 */
  var NAME_MACRO = { figure: 'figurename', table: 'tablename', abstract: 'abstractname', contents: 'contentsname', refs: 'refname', bib: 'bibname', proof: 'proofname', appendix: 'appendixname', lof: 'listfigurename', lot: 'listtablename' }
  Ctx.prototype.name = function (k) {
    var m = this.macros[NAME_MACRO[k]]
    if (m && !m.n) return esc(m.body.replace(/\\[a-zA-Z]+\s*|[{}]/g, '').trim())
    return NAMES[this.zh ? 'zh' : 'en'][k]
  }
  Object.defineProperty(Ctx.prototype, 'kkey', {
    get: function () {
      if (this._kkey == null) this._kkey = JSON.stringify(this.kmacros)
      return this._kkey
    },
    set: function (v) {
      this._kkey = v
    }
  })
  Ctx.prototype.warnCmd = function (n, kind) {
    // 导言区里不认识的设置命令不提示
    if (this.inPreamble) return
    var k = (kind || 'unknown') + '\u0001' + n
    this.warn[k] = (this.warn[k] || 0) + 1
  }
  Ctx.prototype.step = function (c) {
    if (!(c in this.cnt)) this.cnt[c] = 0
    this.cnt[c]++
    var self = this
    // 重置以它为上级的计数器（section → subsection → …）
    var reset = function (p) {
      for (var k in self.parent)
        if (self.parent[k] === p) {
          self.cnt[k] = 0
          reset(k)
        }
    }
    reset(c)
  }
  Ctx.prototype.the = function (c) {
    var n = this.cnt[c] || 0
    var f = this.fmtOf[c]
    var own
    if (f === 'Alph') own = alph(n).toUpperCase()
    else if (f === 'alph') own = alph(n)
    else if (f === 'roman') own = roman(n)
    else if (f === 'Roman') own = roman(n).toUpperCase()
    else own = String(n)
    if (c === 'part') return roman(n).toUpperCase()
    var p = this.parent[c]
    if (p && c === 'subfigure') return own
    return p ? this.the(p) + '.' + own : own
  }

  /* ================= 输出（段落 / 块 / 字体开关） ================= */

  function Out(ctx, inline) {
    this.ctx = ctx
    this.inline = !!inline
    this.html = ''
    this.p = inline ? '' : null
    this.pl = 0
    this.styles = []
    this.ni = false
    this.lead = ''
    this.align = ''
  }
  Out.prototype.child = function (inline) {
    var o = new Out(this.ctx, inline)
    if (!inline) {
      o.styles = this.styles.slice()
      o.align = this.align
    }
    return o
  }
  Out.prototype.text = function (h, line) {
    if (this.p === null) {
      if (!h || /^\s*$/.test(h)) return
      this.p = ''
      this.pl = line != null ? line : this.cl || 0
      for (var i = 0; i < this.styles.length; i++) this.p += this.styles[i].open
      if (this.lead) {
        this.p += this.lead
        this.lead = ''
      }
    }
    this.p += h
  }
  Out.prototype.endPar = function () {
    if (this.inline) {
      if (this.p && !/<br>\s*$/.test(this.p)) this.p += '<br>'
      return
    }
    if (this.p === null) return
    var body = this.p
    for (var i = this.styles.length - 1; i >= 0; i--) body += this.styles[i].close
    body = body.replace(/(\s|<br>)+$/, '').replace(/^\s+/, '')
    var empty = !stripTags(body).replace(/ /g, '').trim() && !/<img|<table|katex|\sid=|<canvas|class="(?:hfill|tikz|ph|minipage|subfig|parbox)/.test(body)
    if (!empty) {
      var st = this.align ? ' style="text-align:' + this.align + '"' : ''
      this.html += '<div class="par' + (this.ni ? ' ni' : '') + '" data-line="' + this.pl + '"' + st + '>' + body + '</div>'
    }
    this.p = null
    this.ni = false
  }
  /** 空行 / \par：新段落要缩进 */
  Out.prototype.par = function () {
    this.endPar()
    this.ni = false
  }
  Out.prototype.block = function (h) {
    if (this.inline) {
      this.p += h
      return
    }
    this.endPar()
    if (this.lead) {
      this.html += '<div class="par ni">' + this.lead + '</div>'
      this.lead = ''
    }
    this.html += h
    this.ni = true
  }
  Out.prototype.push = function (open, close) {
    this.styles.push({ open: open, close: close })
    if (this.p !== null) this.p += open
  }
  Out.prototype.mark = function () {
    return { n: this.styles.length, align: this.align }
  }
  Out.prototype.restore = function (m) {
    while (this.styles.length > m.n) {
      var s = this.styles.pop()
      if (this.p !== null) this.p += s.close
    }
    this.align = m.align
  }
  Out.prototype.result = function () {
    if (this.inline) {
      var h = this.p
      for (var i = this.styles.length - 1; i >= 0; i--) h += this.styles[i].close
      return h
    }
    this.endPar()
    if (this.lead) {
      this.html += '<div class="par ni">' + this.lead + '</div>'
      this.lead = ''
    }
    return this.html
  }

  /* ================= 解析器 ================= */

  function P(ctx, src, s, e, out) {
    this.c = ctx
    this.src = src
    this.t = src.text
    this.i = s
    this.e = e == null ? src.text.length : e
    this.o = out
  }

  P.prototype.line = function (pos) {
    return this.src.line(pos == null ? this.i : pos)
  }
  P.prototype.run = function () {
    var guard = 0
    while (this.i < this.e) {
      var before = this.i
      this.o.cl = this.src.line(this.i)
      this.step()
      if (this.i <= before) this.i = before + 1 // 保险：不会死循环
      if (++guard > 2e6) break
    }
    return this.o
  }
  /** 在同一个输出里解析一段范围 */
  P.prototype.sub = function (r, out, src) {
    return new P(this.c, src || this.src, r.s, r.e, out || this.o).run()
  }
  /** 一段范围 → 行内 HTML */
  P.prototype.inl = function (r, src) {
    if (!r) return ''
    return new P(this.c, src || this.src, r.s, r.e, new Out(this.c, true)).run().result()
  }
  /** 一段范围 → 块级 HTML（新的输出，继承当前字体） */
  P.prototype.blk = function (r, out) {
    var o = out || this.o.child(false)
    new P(this.c, this.src, r.s, r.e, o).run()
    return o.result()
  }
  /** 一段文字（不是源文件里的，例如宏展开结果）在当前输出里解析 */
  P.prototype.virt = function (text, out) {
    if (++this.c.expansions > 20000 || this.c.depth > 60) return
    this.c.depth++
    var src = new Source(text, this.line())
    new P(this.c, src, 0, text.length, out || this.o).run()
    this.c.depth--
  }
  P.prototype.virtInl = function (text) {
    var o = new Out(this.c, true)
    this.virt(text, o)
    return o.result()
  }
  P.prototype.str = function (r) {
    return r ? this.t.slice(r.s, r.e) : ''
  }

  /* ---------- 读取参数 ---------- */

  /** 跳过空格、单个换行和注释（不跨过空行） */
  P.prototype.skipSp = function () {
    var t = this.t
    while (this.i < this.e) {
      var ch = t[this.i]
      if (ch === ' ' || ch === '\t' || ch === '\r') this.i++
      else if (ch === '\n') {
        var j = this.i + 1
        while (j < this.e && (t[j] === ' ' || t[j] === '\t' || t[j] === '\r')) j++
        if (t[j] === '\n') return
        this.i = j
      } else if (ch === '%') this.skipComment()
      else return
    }
  }
  P.prototype.skipComment = function () {
    var j = this.t.indexOf('\n', this.i)
    if (j < 0 || j >= this.e) {
      this.i = this.e
      return
    }
    // 注释吃掉行尾换行和下一行开头的空白
    j++
    while (j < this.e && (this.t[j] === ' ' || this.t[j] === '\t' || this.t[j] === '\r')) j++
    this.i = j
  }
  /** 从 { 开始找到配对的 }，返回 } 的位置 */
  P.prototype.matchBrace = function (from) {
    var t = this.t
    var d = 0
    for (var j = from; j < this.e; j++) {
      var ch = t[j]
      if (ch === '\\') j++
      else if (ch === '%') {
        var n = t.indexOf('\n', j)
        if (n < 0) return -1
        j = n
      } else if (ch === '{') d++
      else if (ch === '}') {
        d--
        if (d === 0) return j
      }
    }
    return -1
  }
  P.prototype.group = function () {
    if (this.t[this.i] !== '{') return null
    var end = this.matchBrace(this.i)
    if (end < 0) {
      var r0 = { s: this.i + 1, e: this.e }
      this.i = this.e
      return r0
    }
    var r = { s: this.i + 1, e: end }
    this.i = end + 1
    return r
  }
  /** 必选参数：{…}、一个命令或一个字符 */
  P.prototype.arg = function () {
    this.skipSp()
    if (this.i >= this.e) return null
    var ch = this.t[this.i]
    if (ch === '{') return this.group()
    if (ch === '}') return null
    if (ch === '\\') {
      var s = this.i
      this.i++
      if (LETTER.test(this.t[this.i] || '')) while (this.i < this.e && LETTER.test(this.t[this.i])) this.i++
      else this.i++
      return { s: s, e: this.i }
    }
    this.i++
    return { s: this.i - 1, e: this.i }
  }
  /** 可选参数 […] */
  P.prototype.opt = function () {
    var save = this.i
    this.skipSp()
    if (this.t[this.i] !== '[') {
      this.i = save
      return null
    }
    var t = this.t
    var d = 0
    for (var j = this.i + 1; j < this.e; j++) {
      var ch = t[j]
      if (ch === '\\') j++
      else if (ch === '{') d++
      else if (ch === '}') d--
      else if (ch === ']' && d === 0) {
        var r = { s: this.i + 1, e: j }
        this.i = j + 1
        return r
      }
    }
    this.i = save
    return null
  }
  P.prototype.star = function () {
    if (this.t[this.i] === '*') {
      this.i++
      return true
    }
    return false
  }
  /** beamer 的 <2-> 覆盖说明：直接跳过 */
  P.prototype.overlay = function () {
    var save = this.i
    this.skipSp()
    if (this.t[this.i] === '<') {
      var j = this.t.indexOf('>', this.i)
      if (j > 0 && j - this.i < 20) {
        this.i = j + 1
        return
      }
    }
    this.i = save
  }
  P.prototype.argStr = function () {
    return this.str(this.arg()).trim()
  }
  P.prototype.optStr = function () {
    var r = this.opt()
    return r ? this.str(r).trim() : null
  }
  /** 按 "o a s" 这样的格式吃掉参数（忽略的命令） */
  P.prototype.eat = function (spec) {
    for (var k = 0; k < spec.length; k++) {
      var c = spec[k]
      if (c === 'a') this.arg()
      else if (c === 'o') this.opt()
      else if (c === 's') this.star()
      else if (c === 'v') this.overlay()
    }
  }
  /** 参数是不是命令名（\newcommand\foo 或 {\foo}） */
  P.prototype.cmdArg = function () {
    var r = this.arg()
    var s = this.str(r).trim()
    var m = /^\\([A-Za-z@]+|.)/.exec(s)
    return m ? m[1] : s
  }

  /* ---------- 主循环 ---------- */

  var TEXT_RE = /[^\\%{}$&~\n`'\-<>"^_#!?]+/y

  P.prototype.step = function () {
    var t = this.t
    var ch = t[this.i]
    var o = this.o
    switch (ch) {
      case '\\':
        return this.command()
      case '%':
        return this.skipComment()
      case '{': {
        var r = this.group()
        var m = o.mark()
        this.sub(r)
        o.restore(m)
        return
      }
      case '}':
        this.i++
        return
      case '$':
        return this.dollar()
      case '&':
        this.i++
        o.text(' ', this.line())
        return
      case '~':
        this.i++
        o.text('&nbsp;', this.line())
        return
      case '\n': {
        var j = this.i + 1
        while (j < this.e && (t[j] === ' ' || t[j] === '\t' || t[j] === '\r')) j++
        if (t[j] === '\n') {
          while (j < this.e && /\s/.test(t[j])) j++
          this.i = j
          o.par()
          return
        }
        // 中文之间的换行不产生空格（和 xeCJK / ctex 一样）
        var prev = t[this.i - 1] || ''
        var next = t[j] || ''
        this.i = j
        if (!(CJK.test(prev) && CJK.test(next))) o.text(' ', this.line())
        return
      }
      case '`':
        if (t[this.i + 1] === '`') {
          this.i += 2
          return o.text('“', this.line())
        }
        this.i++
        return o.text('‘', this.line())
      case "'":
        if (t[this.i + 1] === "'") {
          this.i += 2
          return o.text('”', this.line())
        }
        this.i++
        return o.text('’', this.line())
      case '-':
        if (t.substr(this.i, 3) === '---') {
          this.i += 3
          return o.text('—', this.line())
        }
        if (t.substr(this.i, 2) === '--') {
          this.i += 2
          return o.text('–', this.line())
        }
        this.i++
        return o.text('-', this.line())
      case '!':
      case '?':
        if (t[this.i + 1] === '`') {
          this.i += 2
          return o.text(ch === '!' ? '¡' : '¿', this.line())
        }
        this.i++
        return o.text(ch, this.line())
      case '<':
      case '>':
      case '"':
        this.i++
        return o.text(esc(ch), this.line())
      case '^':
      case '_':
      case '#':
        this.i++
        return o.text(ch, this.line())
    }
    TEXT_RE.lastIndex = this.i
    var mm = TEXT_RE.exec(t)
    if (mm) {
      var s = mm[0]
      if (this.i + s.length > this.e) s = s.slice(0, this.e - this.i)
      var line = this.line()
      this.i += s.length
      o.text(esc(s.replace(/[ \t\r]+/g, ' ')), line)
      return
    }
    this.i++
  }

  /* ---------- 数学 ---------- */

  P.prototype.dollar = function () {
    var t = this.t
    var line = this.line()
    if (t[this.i + 1] === '$') {
      var end = this.findStr('$$', this.i + 2)
      var body = { s: this.i + 2, e: end < 0 ? this.e : end }
      this.i = end < 0 ? this.e : end + 2
      this.o.block(this.displayMath(this.str(body), line, false))
      return
    }
    var j = this.i + 1
    var d = 0
    for (; j < this.e; j++) {
      var ch = t[j]
      if (ch === '\\') j++
      else if (ch === '{') d++
      else if (ch === '}') d--
      else if (ch === '$' && d <= 0) break
      else if (ch === '\n' && t[j + 1] === '\n') break
    }
    var tex = t.slice(this.i + 1, Math.min(j, this.e))
    this.i = Math.min(j + 1, this.e)
    this.o.text(this.math(tex, false), line)
  }
  /** 找到不在转义里的字符串 */
  P.prototype.findStr = function (s, from) {
    var t = this.t
    for (var j = from; j < this.e; j++) {
      if (t[j] === '\\') {
        if (t.substr(j, s.length) === s && s[0] === '\\') return j
        j++
        continue
      }
      if (t.substr(j, s.length) === s) return j
    }
    return -1
  }

  var mathCache = new Map()

  P.prototype.math = function (tex, display) {
    tex = this.mathPrep(tex).tex
    return this.katex(tex, display)
  }
  P.prototype.katex = function (tex, display) {
    var c = this.c
    var key = (display ? 'D' : 'I') + c.kkey + '\u0001' + tex
    var hit = mathCache.get(key)
    if (hit) return hit
    var html
    if (!c.katex) html = '<code class="math-raw">' + esc(tex) + '</code>'
    else
      try {
        var macros = {}
        for (var k in c.kmacros) macros[k] = c.kmacros[k]
        html = c.katex.renderToString(tex, { displayMode: !!display, throwOnError: true, strict: 'ignore', trust: false, macros: macros, maxExpand: 2000, output: 'htmlAndMathml' })
      } catch (err) {
        var msg = String((err && err.message) || err).replace(/^KaTeX parse error: /, '')
        html = '<span class="math-err" title="' + esc(msg) + '">' + esc(tex) + '</span>'
      }
    if (mathCache.size > 4000) mathCache.clear()
    mathCache.set(key, html)
    return html
  }

  /** 公式里的 \label、\ref、\eqref 先处理掉（KaTeX 不认识） */
  P.prototype.mathPrep = function (tex) {
    var c = this.c
    var labels = []
    tex = tex.replace(/\\label\s*\{([^}]*)\}/g, function (_, k) {
      labels.push(k.trim())
      return ''
    })
    tex = tex.replace(/\\(eqref|ref|autoref|cref|Cref|pageref)\s*\{([^}]*)\}/g, function (_, kind, k) {
      var keys = k.split(',')
      return keys
        .map(function (key) {
          key = key.trim()
          var l = c.labels[key] || (c.prevLabels && c.prevLabels[key])
          if (!l) c.mathRefMiss = true
          var n = l ? l.num : '??'
          return '\\text{' + (kind === 'eqref' ? '(' + n + ')' : n).replace(/([#$%&_{}])/g, '\\$1') + '}'
        })
        .join(',')
    })
    tex = tex.replace(/\\(nonumber|notag)\b/g, '\\nonumber')
    return { tex: tex, labels: labels }
  }

  /** 单个编号公式：equation、\[ \]、$$ $$ */
  P.prototype.displayMath = function (tex, line, numbered) {
    var c = this.c
    var prep = this.mathPrep(tex)
    var body = prep.tex
    var id = c.id('eq')
    var hasTag = /\\tag\*?\s*\{/.test(body)
    var noNum = /\\nonumber/.test(body)
    body = body.replace(/\\nonumber/g, '')
    if (numbered && !hasTag && !noNum) {
      c.step('equation')
      var n = c.the('equation')
      body += '\\tag{' + n + '}'
      c.lastRef = { num: n, id: id, type: 'equation' }
    } else if (hasTag) {
      var m = /\\tag\*?\s*\{([^}]*)\}/.exec(body)
      c.lastRef = { num: m ? m[1] : '', id: id, type: 'equation' }
    }
    for (var i = 0; i < prep.labels.length; i++) c.labels[prep.labels[i]] = c.lastRef || { num: '??', id: id }
    return '<div class="eq" id="' + id + '" data-line="' + line + '">' + this.katex(body.trim(), true) + '</div>'
  }

  /** 多行公式：align / gather / alignat / multline / eqnarray / flalign；每行单独编号 */
  P.prototype.multiMath = function (env, tex, line, star, colArg) {
    var c = this.c
    var id = c.id('eq')
    var rows = splitRows(tex)
    var kind = env
    if (env === 'eqnarray') {
      kind = 'align'
      // a & = & b → a &= b
      rows = rows.map(function (r) {
        var k = 0
        return r.replace(/(^|[^\\])&/g, function (all, pre) {
          k++
          return k === 2 ? pre + '{}' : all
        })
      })
    }
    if (env === 'flalign') kind = 'align'
    var multline = env === 'multline'
    if (multline) kind = 'gather'
    var out = []
    for (var i = 0; i < rows.length; i++) {
      var prep = this.mathPrep(rows[i])
      var r = prep.tex
      var tagged = /\\tag\*?\s*\{/.test(r)
      var skip = /\\nonumber/.test(r)
      r = r.replace(/\\nonumber/g, '')
      if (!r.trim() && i === rows.length - 1) continue
      var num = null
      var wantNum = !star && !skip && !tagged && (!multline || i === rows.length - 1)
      if (wantNum) {
        c.step('equation')
        num = c.the('equation')
        r += '\\tag{' + num + '}'
      } else if (tagged) {
        var m = /\\tag\*?\s*\{([^}]*)\}/.exec(r)
        num = m ? m[1] : null
      }
      if (num != null) {
        c.lastRef = { num: num, id: id, type: 'equation' }
      }
      for (var j = 0; j < prep.labels.length; j++) c.labels[prep.labels[j]] = num != null ? { num: num, id: id, type: 'equation' } : c.lastRef || { num: '??', id: id }
      out.push(r)
    }
    var envName = kind === 'alignat' ? 'alignat*}{' + (colArg || '1') : kind + '*'
    var src = '\\begin{' + envName + '}' + out.join('\\\\') + '\\end{' + (kind === 'alignat' ? 'alignat*' : kind + '*') + '}'
    return '<div class="eq" id="' + id + '" data-line="' + line + '">' + this.katex(src, true) + '</div>'
  }

  /** 按最外层的 \\ 拆行（不拆嵌套环境和花括号里的） */
  function splitRows(tex) {
    var rows = []
    var d = 0
    var env = 0
    var last = 0
    for (var j = 0; j < tex.length; j++) {
      var ch = tex[j]
      if (ch === '\\') {
        if (tex[j + 1] === '\\' && d === 0 && env === 0) {
          rows.push(tex.slice(last, j))
          j += 2
          // \\[2pt] 和 \\*
          if (tex[j] === '*') j++
          var k = j
          while (tex[k] === ' ') k++
          if (tex[k] === '[') {
            var close = tex.indexOf(']', k)
            if (close > 0) j = close + 1
          }
          last = j
          j--
          continue
        }
        if (tex.startsWith('begin', j + 1)) env++
        else if (tex.startsWith('end', j + 1)) env--
        j++
      } else if (ch === '{') d++
      else if (ch === '}') d--
    }
    rows.push(tex.slice(last))
    return rows
  }

  /* ---------- 环境的结束位置 ---------- */

  var VERB_ENVS = { verbatim: 1, 'verbatim*': 1, Verbatim: 1, 'Verbatim*': 1, BVerbatim: 1, lstlisting: 1, minted: 1, comment: 1, filecontents: 1, 'filecontents*': 1, alltt: 1, spverbatim: 1, tcblisting: 1, pycode: 1 }

  /** 找 \end{name}：返回 { bodyEnd, after }；verbatim 类环境里的内容不算 */
  P.prototype.findEnd = function (name, from) {
    var t = this.t
    var endTag = '\\end{' + name + '}'
    if (VERB_ENVS[name]) {
      var k = t.indexOf(endTag, from)
      if (k < 0 || k >= this.e) return { bodyEnd: this.e, after: this.e }
      return { bodyEnd: k, after: k + endTag.length }
    }
    var d = 1
    var re = /\\(begin|end)\s*\{([^}]*)\}|%|\\verb\*?(.)|\\./g
    re.lastIndex = from
    var m
    while ((m = re.exec(t))) {
      if (m.index >= this.e) break
      if (m[0] === '%') {
        var n = t.indexOf('\n', m.index)
        if (n < 0) break
        re.lastIndex = n
        continue
      }
      if (m[3] !== undefined) {
        var close = t.indexOf(m[3], re.lastIndex)
        if (close > 0) re.lastIndex = close + 1
        continue
      }
      if (!m[1]) continue
      var nm = m[2].trim()
      if (m[1] === 'begin' && VERB_ENVS[nm]) {
        var ve = t.indexOf('\\end{' + nm + '}', re.lastIndex)
        if (ve > 0) re.lastIndex = ve + nm.length + 6
        continue
      }
      if (nm !== name) continue
      if (m[1] === 'begin') d++
      else if (--d === 0) return { bodyEnd: m.index, after: m.index + m[0].length }
    }
    this.c.warnCmd('\\begin{' + name + '}', 'unclosed')
    return { bodyEnd: this.e, after: this.e }
  }

  /* ---------- 命令 ---------- */

  P.prototype.command = function () {
    var t = this.t
    var start = this.i
    this.i++
    var name
    if (this.i >= this.e) return
    if (LETTER.test(t[this.i])) {
      var s = this.i
      while (this.i < this.e && LETTER.test(t[this.i])) this.i++
      name = t.slice(s, this.i)
      // 控制词后面的空格被吃掉
      while (this.i < this.e && (t[this.i] === ' ' || t[this.i] === '\t' || t[this.i] === '\r')) this.i++
      if (t[this.i] === '\n') {
        var j = this.i + 1
        while (j < this.e && (t[j] === ' ' || t[j] === '\t' || t[j] === '\r')) j++
        if (t[j] !== '\n') this.i = j
      }
    } else {
      name = t[this.i]
      this.i++
    }
    var line = this.line(start)
    var c = this.c
    if (c.macros.hasOwnProperty(name) && !CMDS_PROTECTED[name]) return this.expand(c.macros[name])
    var h = CMDS[name]
    if (h) return h.call(this, name, line, start)
    if (SYM.hasOwnProperty(name)) return this.o.text(typeof SYM[name] === 'function' ? SYM[name](c) : SYM[name], line)
    if (ACCENTS[name]) return this.accent(name, line)
    if (SWITCH[name]) return this.o.push(SWITCH[name][0], SWITCH[name][1])
    if (IGNORE.hasOwnProperty(name)) return this.eat(IGNORE[name])
    if (c.envs[name] && /^end/.test(name)) return
    this.unknown(name, line)
  }

  /** 不认识的命令：花括号参数照常显示，命令本身略过 */
  P.prototype.unknown = function (name, line) {
    this.c.warnCmd('\\' + name)
    var parts = []
    for (;;) {
      var save = this.i
      // 只吃紧跟着的 [..] / {..}，不跨空格（避免把后面的普通文字分组吃掉）
      if (this.t[this.i] === '[') {
        if (!this.opt()) break
        continue
      }
      if (this.t[this.i] === '{') {
        parts.push(this.inl(this.group()))
        continue
      }
      this.i = save
      break
    }
    if (parts.length) this.o.text('<span class="unk" title="\\' + esc(name) + '">' + parts.join(' ') + '</span>', line)
  }

  /** 用户宏：参数代进去再解析 */
  P.prototype.expand = function (m) {
    var args = []
    var k = 0
    if (m.def != null) {
      var o = this.opt()
      args.push(o ? this.str(o) : m.def)
      k = 1
    }
    for (; k < m.n; k++) args.push(this.str(this.arg()))
    var body = m.body.replace(/##|#(\d)/g, function (all, d) {
      if (all === '##') return '#'
      var v = args[+d - 1]
      return v == null ? '' : v
    })
    this.virt(body)
  }

  P.prototype.accent = function (name, line) {
    var r = this.arg()
    var base = this.str(r).trim().replace(/^\\([ij])$/, function (_, x) { return x })
    if (base === '\\i') base = 'i'
    if (base === '\\j') base = 'j'
    var s = (base || ' ') + ACCENTS[name]
    try {
      s = s.normalize('NFC')
    } catch (e) {
      /* 忽略 */
    }
    this.o.text(esc(s), line)
  }

  /* ---------- 交叉引用占位（文档最后统一替换） ---------- */

  var PH_RE = /(\w+):([^]*)/g
  function ph(kind, key) {
    return '' + kind + ':' + String(key).replace(/[]/g, '') + ''
  }

  /* ---------- 浮动体里的图片 ---------- */

  function imgStyle(opts) {
    var st = []
    if (!opts) return ''
    var kv = parseKV(opts)
    if (kv.width) st.push('width:' + (cssLen(kv.width) || 'auto'))
    if (kv.height && !kv.width) st.push('height:' + (cssLen(kv.height) || 'auto'))
    if (kv.scale) st.push('--scale:' + parseFloat(kv.scale))
    if (kv.angle) st.push('transform:rotate(' + -parseFloat(kv.angle) + 'deg)')
    return st.join(';')
  }
  function parseKV(s) {
    var out = {}
    String(s || '')
      .split(/,(?![^{]*\})/)
      .forEach(function (p) {
        var i = p.indexOf('=')
        if (i < 0) {
          if (p.trim()) out[p.trim()] = true
          return
        }
        out[p.slice(0, i).trim()] = p
          .slice(i + 1)
          .trim()
          .replace(/^\{([\s\S]*)\}$/, '$1')
      })
    return out
  }

  /** 相对主文件目录的路径 → 插件路径（以 / 开头） */
  function joinPath(base, rel) {
    rel = String(rel).trim().replace(/\\/g, '/')
    if (rel[0] === '/') return rel
    var parts = (base || '/').split('/').filter(Boolean)
    rel.split('/').forEach(function (seg) {
      if (!seg || seg === '.') return
      if (seg === '..') parts.pop()
      else parts.push(seg)
    })
    return '/' + parts.join('/')
  }

  /* ================= 命令表 ================= */

  var CMDS = {}
  var CMDS_PROTECTED = { begin: 1, end: 1, newcommand: 1, renewcommand: 1, def: 1 }

  function def(names, fn) {
    names.split(' ').forEach(function (n) {
      CMDS[n] = fn
    })
  }

  /* --- 换行、段落、空白 --- */
  def('\\', function (n, line) {
    this.star()
    this.opt()
    this.o.text('<br>', line)
  })
  // \[ … \] 和 \( … \)
  def('[', function (n, line) {
    var end = this.findStr('\\]', this.i)
    var tex = this.t.slice(this.i, end < 0 ? this.e : end)
    this.i = end < 0 ? this.e : end + 2
    this.o.block(this.displayMath(tex, line, false))
  })
  def('(', function (n, line) {
    var end = this.findStr('\\)', this.i)
    var tex = this.t.slice(this.i, end < 0 ? this.e : end)
    this.i = end < 0 ? this.e : end + 2
    this.o.text(this.math(tex, false), line)
  })
  def('] )', function () {})
  def('ensuremath', function (n, line) {
    this.o.text(this.math(this.str(this.arg()), false), line)
  })
  def('newline linebreak', function (n, line) {
    if (n === 'linebreak') this.opt()
    this.o.text('<br>', line)
  })
  def('par', function () {
    this.o.par()
  })
  def('noindent', function () {
    this.o.endPar()
    this.o.ni = true
  })
  def('indent', function () {})
  def('centering', function () {
    this.o.align = 'center'
  })
  def('raggedright', function () {
    this.o.align = 'left'
  })
  def('raggedleft', function () {
    this.o.align = 'right'
  })
  def('newpage clearpage cleardoublepage pagebreak', function (n) {
    if (n === 'pagebreak') this.opt()
    this.o.block('<div class="pagebreak" aria-hidden="true"></div>')
  })
  CMDS.vspace = function () {
    this.star()
    var h = cssLen(this.argStr())
    if (h && !/^-/.test(h)) this.o.block('<div class="vsp" style="height:' + h + '"></div>')
  }
  def('smallskip medskip bigskip', function (n) {
    this.o.block('<div class="vsp ' + n + '"></div>')
  })
  def('vfill vfil', function () {
    this.o.block('<div class="vsp bigskip"></div>')
  })
  def('hspace', function (n, line) {
    this.star()
    var w = cssLen(this.argStr())
    if (w && !/^-/.test(w)) this.o.text('<span class="hsp" style="width:' + w + '"></span>', line)
  })
  def('hfill hfil hss', function (n, line) {
    this.o.text('<span class="hfill"></span>', line)
  })
  def('dotfill', function (n, line) {
    this.o.text('<span class="hfill dotfill"></span>', line)
  })
  def('hrulefill', function (n, line) {
    this.o.text('<span class="hfill rulefill"></span>', line)
  })
  def('rule', function (n, line) {
    this.opt()
    var w = cssLen(this.argStr()) || '100%'
    var h = cssLen(this.argStr()) || '0.4pt'
    this.o.text('<span class="rule" style="width:' + w + ';height:' + h + '"></span>', line)
  })

  /* --- 字体（带参数的形式） --- */
  var FONT_CMD = {
    textbf: ['<b>', '</b>'],
    textit: ['<i>', '</i>'],
    textsl: ['<i class="sl">', '</i>'],
    emph: ['<em>', '</em>'],
    textsc: ['<span class="sc">', '</span>'],
    texttt: ['<code class="tt">', '</code>'],
    textsf: ['<span class="sf">', '</span>'],
    textrm: ['<span class="rm">', '</span>'],
    textup: ['<span class="up">', '</span>'],
    textmd: ['<span class="md">', '</span>'],
    textnormal: ['<span class="nf">', '</span>'],
    underline: ['<u>', '</u>'],
    uline: ['<u>', '</u>'],
    uuline: ['<u class="uu">', '</u>'],
    uwave: ['<u class="wave">', '</u>'],
    sout: ['<s>', '</s>'],
    st: ['<s>', '</s>'],
    xout: ['<s>', '</s>'],
    hl: ['<mark>', '</mark>'],
    textsuperscript: ['<sup>', '</sup>'],
    textsubscript: ['<sub>', '</sub>'],
    mbox: ['<span class="nowrap">', '</span>'],
    hbox: ['<span class="nowrap">', '</span>'],
    text: ['<span>', '</span>'],
    textnormalfont: ['<span class="nf">', '</span>'],
    alert: ['<span class="alert">', '</span>'],
    structure: ['<span class="alert">', '</span>'],
    textls: ['<span>', '</span>'],
    CJKfamily: null,
    heiti: null
  }
  Object.keys(FONT_CMD).forEach(function (k) {
    if (!FONT_CMD[k]) return
    CMDS[k] = function (n, line) {
      if (k === 'alert' || k === 'structure') this.overlay()
      if (k === 'textls') this.opt()
      var h = this.inl(this.arg())
      this.o.text(FONT_CMD[k][0] + h + FONT_CMD[k][1], line)
    }
  })
  // 嵌套 \emph 恢复正体
  CMDS.emph = function (n, line) {
    var r = this.arg()
    this.c.emph = (this.c.emph || 0) + 1
    var h = this.inl(r)
    this.c.emph--
    this.o.text(this.c.emph % 2 ? '<em class="up">' + h + '</em>' : '<em>' + h + '</em>', line)
  }
  def('fbox framebox', function (n, line) {
    if (n === 'framebox') this.eat('oo')
    this.o.text('<span class="fbox">' + this.inl(this.arg()) + '</span>', line)
  })
  def('makebox', function (n, line) {
    this.eat('oo')
    this.o.text('<span class="nowrap">' + this.inl(this.arg()) + '</span>', line)
  })
  def('parbox', function (n, line) {
    this.eat('ooo')
    var w = cssLen(this.argStr())
    this.o.text('<div class="parbox" style="width:' + (w || 'auto') + '">' + this.blk(this.arg(), this.o.child(false)) + '</div>', line)
  })
  def('raisebox', function (n, line) {
    var d = cssLen(this.argStr())
    this.eat('oo')
    this.o.text('<span style="position:relative;top:' + (d ? '-' + d : '0') + '">' + this.inl(this.arg()) + '</span>', line)
  })
  def('centerline', function (n, line) {
    this.o.block('<div class="center" data-line="' + line + '">' + this.inl(this.arg()) + '</div>')
  })
  def('phantom hphantom vphantom', function (n, line) {
    this.o.text('<span class="ph">' + this.inl(this.arg()) + '</span>', line)
  })
  def('textcolor', function (n, line) {
    var model = this.optStr()
    var col = colorCss(this.c, model, this.argStr())
    var h = this.inl(this.arg())
    this.o.text(col ? '<span style="color:' + col + '">' + h + '</span>' : h, line)
  })
  def('color', function () {
    var model = this.optStr()
    var col = colorCss(this.c, model, this.argStr())
    if (col) this.o.push('<span style="color:' + col + '">', '</span>')
  })
  def('colorbox', function (n, line) {
    var model = this.optStr()
    var col = colorCss(this.c, model, this.argStr())
    this.o.text('<span class="cbox" style="background:' + (col || 'transparent') + '">' + this.inl(this.arg()) + '</span>', line)
  })
  def('fcolorbox', function (n, line) {
    var model = this.optStr()
    var fc = colorCss(this.c, model, this.argStr())
    var bc = colorCss(this.c, model, this.argStr())
    this.o.text('<span class="cbox" style="border:1px solid ' + (fc || 'currentColor') + ';background:' + (bc || 'transparent') + '">' + this.inl(this.arg()) + '</span>', line)
  })
  def('definecolor', function () {
    var name = this.argStr()
    var model = this.argStr()
    var spec = this.argStr()
    var c = colorFrom(model, spec)
    if (c) this.c.colors[name] = c
  })
  def('colorlet', function () {
    var name = this.argStr()
    var c = colorRgb(this.c, this.argStr())
    if (c) this.c.colors[name] = c
  })
  def('fontsize', function () {
    this.arg()
    this.arg()
  })

  /* --- 链接 --- */
  def('url nolinkurl', function (n, line) {
    var u = this.argStr()
    this.o.text('<a class="url" href="' + esc(u) + '">' + esc(u) + '</a>', line)
  })
  def('href', function (n, line) {
    var u = this.argStr()
    this.o.text('<a href="' + esc(u) + '">' + this.inl(this.arg()) + '</a>', line)
  })
  def('email', function (n, line) {
    var u = this.argStr()
    this.o.text('<a href="mailto:' + esc(u) + '">' + esc(u) + '</a>', line)
  })

  /* --- 原样文字 --- */
  def('verb lstinline mintinline', function (n, line) {
    var t = this.t
    if (n === 'mintinline') this.arg()
    if (n === 'lstinline') this.opt()
    this.star()
    var dlm = t[this.i]
    if (!dlm) return
    var close = dlm === '{' ? '}' : dlm
    var end = t.indexOf(close, this.i + 1)
    if (end < 0 || end > this.e) end = this.e
    var s = t.slice(this.i + 1, end)
    this.i = Math.min(end + 1, this.e)
    this.o.text('<code class="tt">' + esc(s) + '</code>', line)
  })

  /* --- 章节 --- */
  Object.keys(SEC_LEVEL).forEach(function (sec) {
    CMDS[sec] = function (n, line) {
      this.section(n, line)
    }
  })
  P.prototype.section = function (n, line) {
    var c = this.c
    var star = this.star()
    var short = this.opt()
    var r = this.arg()
    var title = this.inl(r)
    var lvl = SEC_LEVEL[n]
    var depth = lvl - 1
    var snd = 'secnumdepth' in c.cnt ? c.cnt.secnumdepth : c.book ? 2 : 3
    var numbered = !star && (n === 'part' || depth <= snd) && !(n === 'chapter' && !c.book)
    var id = c.id('sec')
    var num = ''
    if (numbered) {
      c.step(n)
      num = c.the(n)
      c.lastRef = { num: num, id: id, type: n, title: stripTags(title) }
    }
    if (!star) c.toc.push({ level: lvl, num: num, title: short ? this.inl(short) : title, id: id, line: line, kind: n })
    else c.toc.push({ level: lvl, num: '', title: title, id: id, line: line, kind: n, star: true })
    if (n === 'paragraph' || n === 'subparagraph') {
      this.o.endPar()
      this.o.text('<strong class="runin" id="' + id + '">' + (num ? '<span class="secnum">' + num + '</span>' : '') + title + '</strong>&ensp;', line)
      return
    }
    var html
    if (n === 'part') {
      html = '<h1 class="part" id="' + id + '" data-line="' + line + '">' + (num ? '<span class="partnum">' + (c.zh ? '第' + chineseNum(c.cnt.part) + '部分' : c.name('part') + ' ' + num) + '</span>' : '') + title + '</h1>'
    } else if (n === 'chapter') {
      var label = num ? (c.appendix ? (c.zh ? '附录 ' + num : c.name('appendix') + ' ' + num) : c.zh ? '第' + chineseNum(c.cnt.chapter) + '章' : c.name('chapter') + ' ' + num) : ''
      html = '<h1 class="chapter" id="' + id + '" data-line="' + line + '">' + (label ? '<span class="chapnum">' + label + '</span>' : '') + title + '</h1>'
    } else {
      var tag = 'h' + Math.min(6, lvl)
      html = '<' + tag + ' class="sec" id="' + id + '" data-line="' + line + '">' + (num ? '<span class="secnum">' + num + '</span>' : '') + title + '</' + tag + '>'
    }
    this.o.block(html)
    // 英文排版：章节后的第一段不缩进；ctex 缩进
    this.o.ni = !c.zh
  }
  def('appendix', function () {
    var c = this.c
    c.appendix = true
    if (c.book) {
      c.cnt.chapter = 0
      c.fmtOf.chapter = 'Alph'
    } else {
      c.cnt.section = 0
      c.fmtOf.section = 'Alph'
    }
  })
  def('frontmatter mainmatter backmatter', function () {})

  /* --- 标题 --- */
  def('title', function () {
    this.c.shortTitle = this.opt()
    this.c.title = { r: this.arg(), src: this.src }
  })
  def('author', function () {
    this.opt()
    this.c.author = { r: this.arg(), src: this.src }
  })
  def('date', function () {
    this.c.date = { r: this.arg(), src: this.src }
    this.c.dateSet = true
  })
  def('subtitle institute', function (n) {
    this.opt()
    this.c[n] = { r: this.arg(), src: this.src }
  })
  def('thanks', function () {
    var h = this.inl(this.arg())
    this.c.thanks = (this.c.thanks || 0) + 1
    var sym = fnSymbol(this.c.thanks)
    this.c.footnotes.push({ n: sym, html: h, id: 'fn-t' + this.c.thanks })
    this.o.text('<sup class="fn"><a href="#fn-t' + this.c.thanks + '">' + sym + '</a></sup>')
  })
  def('maketitle titlepage', function (n, line) {
    this.o.block(this.titleBlock(line))
  })
  P.prototype.titleBlock = function (line) {
    var c = this.c
    var part = function (x) {
      if (!x) return ''
      return new P(c, x.src, x.r.s, x.r.e, new Out(c, true)).run().result()
    }
    var html = '<header class="titleblock" data-line="' + line + '">'
    if (c.title) html += '<h1 class="title">' + part(c.title) + '</h1>'
    if (c.subtitle) html += '<div class="subtitle">' + part(c.subtitle) + '</div>'
    if (c.author) {
      // \and 分开的作者并排显示
      var a = part(c.author)
      html += '<div class="authors">' + a.split(//).map(function (x) { return '<div class="author">' + x.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '') + '</div>' }).join('') + '</div>'
    }
    if (c.institute) html += '<div class="institute">' + part(c.institute) + '</div>'
    var d = c.dateSet ? part(c.date) : SYM.today(c)
    if (d && stripTags(d).trim()) html += '<div class="date">' + d + '</div>'
    return html + '</header>'
  }
  def('and', function (n, line) {
    this.o.text('', line)
  })
  def('today', function (n, line) {
    this.o.text(SYM.today(this.c), line)
  })

  /* --- 目录、图表目录 --- */
  def('tableofcontents', function (n, line) {
    this.o.block('<div data-line="' + line + '">' + ph('TOC', '') + '</div>')
  })
  def('listoffigures', function (n, line) {
    this.o.block('<div data-line="' + line + '">' + ph('LOF', '') + '</div>')
  })
  def('listoftables', function (n, line) {
    this.o.block('<div data-line="' + line + '">' + ph('LOT', '') + '</div>')
  })
  def('addcontentsline', function () {
    this.arg()
    var lvl = this.argStr()
    var r = this.arg()
    if (SEC_LEVEL[lvl] != null) this.c.toc.push({ level: SEC_LEVEL[lvl], num: '', title: this.inl(r), id: this.c.lastRef ? this.c.lastRef.id : '', line: this.line(), kind: lvl })
  })

  /* --- 标签和引用 --- */
  def('label', function (n, line) {
    var key = this.argStr()
    var c = this.c
    var id = 'lbl-' + key.replace(/[^\w-]/g, '_')
    c.labels[key] = c.lastRef ? { num: c.lastRef.num, id: c.lastRef.id, type: c.lastRef.type, title: c.lastRef.title } : { num: '', id: id }
    if (!c.lastRef) this.o.text('<a class="anchor" id="' + id + '"></a>', line)
  })
  def('ref pageref eqref autoref Autoref cref Cref vref nameref cpageref', function (n, line) {
    this.star()
    var keys = this.argStr().split(',')
    this.o.text(
      keys
        .map(function (k) {
          return ph(n === 'pageref' || n === 'cpageref' ? 'PREF' : n === 'eqref' ? 'EQREF' : n === 'nameref' ? 'NREF' : /^(autoref|Autoref|cref|Cref|vref)$/.test(n) ? 'AREF' : 'REF', k.trim())
        })
        .join(', '),
      line
    )
  })

  /* --- 引用文献 --- */
  def('cite citep citet parencite textcite autocite footcite citeauthor citeyear supercite Cite Parencite Textcite cites', function (n, line) {
    this.star()
    var pre = this.opt()
    var post = this.opt()
    if (pre && !post) {
      post = pre
      pre = null
    }
    var keys = this.argStr()
      .split(',')
      .map(function (k) {
        return k.trim()
      })
      .filter(Boolean)
    var c = this.c
    keys.forEach(function (k) {
      if (!c.citeSeen[k]) {
        c.citeSeen[k] = true
        c.cites.push(k)
      }
    })
    var inner = keys
      .map(function (k) {
        return ph('CITE', k)
      })
      .join(', ')
    var postH = post && this.str(post).trim() ? ', ' + this.inl(post) : ''
    var preH = pre && this.str(pre).trim() ? this.inl(pre) + ' ' : ''
    var html
    if (n === 'citet' || n === 'textcite' || n === 'Textcite' || n === 'citeauthor') html = keys.map(function (k) { return ph('CITEA', k) + (n === 'citeauthor' ? '' : ' [' + ph('CITE', k) + ']') }).join(', ')
    else if (n === 'citeyear') html = keys.map(function (k) { return ph('CITEY', k) }).join(', ')
    else if (n === 'supercite') html = '<sup>[' + inner + ']</sup>'
    else html = '[' + preH + inner + postH + ']'
    this.o.text('<span class="cite">' + html + '</span>', line)
  })
  def('nocite', function () {
    var c = this.c
    this.argStr()
      .split(',')
      .forEach(function (k) {
        k = k.trim()
        if (k === '*') c.nociteAll = true
        else if (k && !c.citeSeen[k]) {
          c.citeSeen[k] = true
          c.cites.push(k)
        }
      })
  })
  def('bibliography addbibresource', function (n, line) {
    this.opt()
    var self = this
    var files = this.argStr()
      .split(',')
      .map(function (f) {
        f = f.trim()
        return joinPath(self.c.base, /\.bib$/i.test(f) ? f : f + '.bib')
      })
    files.forEach(function (f) {
      if (self.c.bibFiles.indexOf(f) < 0) self.c.bibFiles.push(f)
    })
    if (n === 'bibliography') this.o.block('<div data-line="' + line + '">' + ph('BIB', '') + '</div>')
  })
  def('printbibliography', function (n, line) {
    this.opt()
    this.o.block('<div data-line="' + line + '">' + ph('BIB', '') + '</div>')
  })
  def('bibliographystyle', function () {
    this.arg()
  })

  /* --- 脚注 --- */
  def('footnote', function (n, line) {
    var c = this.c
    var num = this.optStr()
    var h = this.inl(this.arg())
    if (num == null) {
      c.step('footnote')
      num = String(c.cnt.footnote)
    }
    var id = c.id('fn')
    c.footnotes.push({ n: num, html: h, id: id })
    this.o.text('<sup class="fn"><a href="#' + id + '">' + esc(num) + '</a></sup>', line)
  })
  def('footnotemark', function (n, line) {
    var num = this.optStr()
    if (num == null) {
      this.c.step('footnote')
      num = String(this.c.cnt.footnote)
    }
    this.o.text('<sup class="fn">' + esc(num) + '</sup>', line)
  })
  def('footnotetext', function () {
    var num = this.optStr()
    this.c.footnotes.push({ n: num || String(this.c.cnt.footnote), html: this.inl(this.arg()), id: this.c.id('fn') })
  })

  /* --- 图片 --- */
  def('includegraphics', function (n, line) {
    this.star()
    var o = this.optStr()
    this.opt()
    var file = this.argStr()
    this.o.text(this.image(file, o), line)
  })
  P.prototype.image = function (file, opts) {
    var c = this.c
    var paths = (c.graphicspath.length ? c.graphicspath : ['']).map(function (g) {
      return joinPath(c.base, g + file)
    })
    return '<img class="gfx" alt="' + esc(file) + '" data-src="' + esc(file) + '" data-paths="' + esc(paths.join('|')) + '" style="' + imgStyle(opts) + '">'
  }
  def('graphicspath', function () {
    var r = this.str(this.arg())
    var list = []
    r.replace(/\{([^}]*)\}/g, function (_, p) {
      list.push(p.replace(/\/?$/, '/'))
    })
    if (!list.length && r.trim()) list.push(r.trim().replace(/\/?$/, '/'))
    this.c.graphicspath = list
  })

  /* --- 图表标题 --- */
  def('caption captionof', function (n, line) {
    var c = this.c
    var kind = n === 'captionof' ? this.argStr() : c.float ? c.float.type : null
    this.star()
    var short = this.opt()
    var r = this.arg()
    var title = this.inl(r)
    var id = c.id('cap')
    if (c.float && c.float.sub && n === 'caption') {
      c.step('subfigure')
      var sn = alph(c.cnt.subfigure)
      c.lastRef = { num: c.the(c.float.type) + sn, id: id, type: c.float.type }
      this.o.block('<figcaption class="subcap" id="' + id + '" data-line="' + line + '">(' + sn + ') ' + title + '</figcaption>')
      return
    }
    if (kind !== 'figure' && kind !== 'table' && kind !== 'listing' && kind !== 'algorithm') {
      this.o.block('<figcaption data-line="' + line + '">' + title + '</figcaption>')
      return
    }
    c.step(kind)
    var num = c.the(kind)
    c.lastRef = { num: num, id: id, type: kind, title: stripTags(title) }
    var name = kind === 'algorithm' ? (c.zh ? '算法' : 'Algorithm') : c.name(kind)
    ;(kind === 'table' ? c.lot : c.lof).push({ num: num, title: short ? this.inl(short) : title, id: id, kind: kind })
    if (c.float) c.float.captioned = true
    this.o.block('<figcaption id="' + id + '" data-line="' + line + '"><span class="caplbl">' + name + (c.zh ? '&nbsp;' : ' ') + num + (c.zh ? '&ensp;' : ': ') + '</span>' + title + '</figcaption>')
  })
  def('subfloat subfigure', function (n, line) {
    var c = this.c
    var cap = this.opt()
    this.opt()
    var r = this.arg()
    var id = c.id('sub')
    var capH = ''
    if (c.float) {
      c.step('subfigure')
      var sn = alph(c.cnt.subfigure)
      c.lastRef = { num: c.the(c.float.type) + sn, id: id, type: c.float.type }
      capH = '<figcaption class="subcap">(' + sn + ')' + (cap ? ' ' + this.inl(cap) : '') + '</figcaption>'
    }
    this.o.text('<div class="subfig" id="' + id + '">' + this.blk(r, this.o.child(false)) + capH + '</div>', line)
  })

  /* --- 宏定义 --- */
  def('newcommand renewcommand providecommand DeclareRobustCommand', function (n) {
    this.star()
    var name = this.cmdArg()
    var nargs = this.optStr()
    var dflt = this.opt()
    var body = this.str(this.arg())
    this.defMacro(name, nargs ? parseInt(nargs, 10) || 0 : 0, dflt ? this.str(dflt) : null, body, n === 'providecommand')
  })
  def('NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand', function () {
    var name = this.cmdArg()
    var spec = this.argStr()
    var body = this.str(this.arg())
    var n = (spec.match(/[mo]|O\{[^}]*\}/g) || []).length
    this.defMacro(name, n, null, body)
  })
  def('def gdef edef xdef', function () {
    var t = this.t
    this.skipSp()
    if (t[this.i] !== '\\') return
    this.i++
    var s = this.i
    if (LETTER.test(t[this.i])) while (this.i < this.e && LETTER.test(t[this.i])) this.i++
    else this.i++
    var name = t.slice(s, this.i)
    var params = ''
    while (this.i < this.e && t[this.i] !== '{') params += t[this.i++]
    var body = this.str(this.group())
    var n = (params.match(/#\d/g) || []).length
    this.defMacro(name, n, null, body)
  })
  def('let', function () {
    var a = this.cmdArg()
    this.skipSp()
    if (this.t[this.i] === '=') this.i++
    var b = this.cmdArg()
    if (this.c.macros[b]) this.c.macros[a] = this.c.macros[b]
    else this.defMacro(a, 0, null, '\\' + b)
  })
  def('DeclareMathOperator', function () {
    var star = this.star()
    var name = this.cmdArg()
    var body = this.str(this.arg())
    this.c.kmacros['\\' + name] = '\\operatorname' + (star ? '*' : '') + '{' + body + '}'
    this.c.kkey = null
  })
  def('DeclarePairedDelimiter', function () {
    var name = this.cmdArg()
    var l = this.str(this.arg())
    var r = this.str(this.arg())
    this.c.kmacros['\\' + name] = '\\left' + l + '#1\\right' + r
    this.c.kkey = null
  })
  P.prototype.defMacro = function (name, n, dflt, body, provide) {
    var c = this.c
    if (!name) return
    if (provide && (c.macros[name] || CMDS[name] || SYM[name])) return
    // 只在公式里有意义的宏（\R、\vect 之类）不进文字宏表，文字里遇到时交给 KaTeX
    c.macros[name] = { n: n, def: dflt, body: body }
    var kb = body
    if (dflt != null) {
      // KaTeX 的宏不支持可选参数：公式里按“没给可选参数”处理
      kb = body.replace(/#1/g, dflt).replace(/#(\d)/g, function (_, d) { return '#' + (d - 1) })
    }
    c.kmacros['\\' + name] = kb
    c.kkey = null
  }
  def('newenvironment renewenvironment', function () {
    this.star()
    var name = this.argStr()
    var nargs = this.optStr()
    var dflt = this.opt()
    var b = this.str(this.arg())
    var e = this.str(this.arg())
    this.c.envs[name] = { n: nargs ? parseInt(nargs, 10) || 0 : 0, def: dflt ? this.str(dflt) : null, begin: b, end: e }
  })
  def('newtheorem', function () {
    var star = this.star()
    var name = this.argStr()
    var shared = this.optStr()
    var title = this.str(this.arg())
    var within = this.optStr()
    var c = this.c
    var counter = shared || name
    if (!shared) {
      c.cnt[counter] = 0
      if (within) c.parent[counter] = within
    }
    c.thms[name] = { title: title, counter: star ? null : counter, style: c.thmStyle }
  })
  def('theoremstyle', function () {
    this.c.thmStyle = this.argStr()
  })
  def('newcounter', function () {
    var name = this.argStr()
    var within = this.optStr()
    this.c.cnt[name] = 0
    if (within) this.c.parent[name] = within
  })
  def('setcounter addtocounter', function (n) {
    var name = this.argStr()
    var v = parseInt(this.argStr(), 10) || 0
    if (n === 'setcounter') this.c.cnt[name] = v
    else this.c.cnt[name] = (this.c.cnt[name] || 0) + v
  })
  def('stepcounter refstepcounter', function () {
    this.c.step(this.argStr())
  })
  def('numberwithin', function () {
    this.opt()
    var a = this.argStr()
    var b = this.argStr()
    this.c.parent[a] = b
  })
  def('arabic roman Roman alph Alph', function (n, line) {
    var name = this.argStr()
    var v = this.c.cnt[name] || 0
    var s = n === 'arabic' ? String(v) : n === 'roman' ? roman(v) : n === 'Roman' ? roman(v).toUpperCase() : n === 'alph' ? alph(v) : alph(v).toUpperCase()
    this.o.text(s, line)
  })
  def('value', function (n, line) {
    this.o.text(String(this.c.cnt[this.argStr()] || 0), line)
  })

  /* --- 输入其他文件 --- */
  def('input include subfile InputIfFileExists import subimport includefrom', function (n, line) {
    var c = this.c
    var dir = ''
    if (n === 'import' || n === 'subimport' || n === 'includefrom') dir = this.argStr().replace(/\/?$/, '/')
    var name = this.argStr()
    if (n === 'InputIfFileExists') this.eat('aa')
    if (!name) return
    if (n === 'include') this.o.block('<div class="pagebreak" aria-hidden="true"></div>')
    var path = joinPath(c.base, dir + (/\.\w+$/.test(name) ? name : name + '.tex'))
    var text = c.files[path]
    if (text === undefined) {
      c.need[path] = true
      this.o.block('<div class="inc-note" data-line="' + line + '">' + esc(name) + ' …</div>')
      return
    }
    if (text === null) {
      this.o.block('<div class="inc-note missing" data-line="' + line + '">' + (c.zh ? '找不到文件：' : 'File not found: ') + esc(name) + '</div>')
      return
    }
    if (c.includeDepth > 12) return
    c.includeDepth++
    var src = new Source(text, line)
    var body = text
    // 子文件（subfiles / standalone）只取正文
    var b = body.indexOf('\\begin{document}')
    var s = 0
    var e = body.length
    if (b >= 0) {
      s = b + 16
      var ee = body.indexOf('\\end{document}', s)
      if (ee > 0) e = ee
    }
    new P(c, src, s, e, this.o).run()
    c.includeDepth--
  })

  /* --- 文档类 --- */
  def('documentclass', function () {
    var o = this.optStr()
    var cls = this.argStr()
    var c = this.c
    c.cls = cls
    c.clsOpts = o || ''
    if (/^(book|report|ctexbook|ctexrep|memoir|scrbook|scrreprt|thesis)/.test(cls)) c.setBook()
    if (/^ctex/.test(cls)) c.zh = true
    if (cls === 'beamer' || cls === 'ctexbeamer') c.beamer = true
  })
  def('usepackage RequirePackage', function () {
    var o = this.optStr() || ''
    var pk = this.argStr()
    var c = this.c
    pk.split(',').forEach(function (p) {
      p = p.trim()
      if (/^(ctex|xeCJK|CJK|CJKutf8|ctexcap|zhnumber|xeCJKfntef)$/.test(p)) c.zh = true
      if (p === 'babel' && /english/.test(o)) c.zh = false
    })
    this.opt()
  })

  /* --- \begin / \end --- */
  def('begin', function (n, line) {
    var name = this.argStr()
    var after = this.i
    var end = this.findEnd(name, after)
    this.envEnd = end
    var c = this.c
    var h = ENVS[name] || ENVS[name.replace(/\*$/, '')]
    var bodyEnd = end.bodyEnd
    if (h) {
      var res = h.call(this, name, line, bodyEnd)
      this.i = end.after
      return res
    }
    if (c.thms[name] || (THM_NAMES[name.replace(/\*$/, '')] && !c.envs[name])) {
      this.theorem(name, line, bodyEnd)
      this.i = end.after
      return
    }
    if (c.envs[name]) {
      this.userEnv(name, line, bodyEnd)
      this.i = end.after
      return
    }
    if (SWITCH[name]) {
      var m = this.o.mark()
      this.o.push(SWITCH[name][0], SWITCH[name][1])
      this.sub({ s: this.i, e: bodyEnd })
      this.o.restore(m)
      this.i = end.after
      return
    }
    // 不认识的环境：照常显示内容，旁边标上环境名
    c.warnCmd(name, 'env')
    var body = this.blk({ s: this.i, e: bodyEnd })
    this.o.block('<div class="env-unk" data-env="' + esc(name) + '" data-line="' + line + '">' + body + '</div>')
    this.i = end.after
  })
  def('end', function () {
    this.arg()
  })

  P.prototype.userEnv = function (name, line, bodyEnd) {
    var e = this.c.envs[name]
    var args = []
    var k = 0
    if (e.def != null) {
      var o = this.opt()
      args.push(o ? this.str(o) : e.def)
      k = 1
    }
    for (; k < e.n; k++) args.push(this.str(this.arg()))
    var sub = function (s) {
      return s.replace(/##|#(\d)/g, function (all, d) {
        return all === '##' ? '#' : args[+d - 1] || ''
      })
    }
    var m = this.o.mark()
    this.virt(sub(e.begin))
    this.sub({ s: this.i, e: bodyEnd })
    this.virt(e.end)
    this.o.restore(m)
  }

  P.prototype.theorem = function (name, line, bodyEnd) {
    var c = this.c
    var star = /\*$/.test(name)
    var th = c.thms[name] || c.thms[name.replace(/\*$/, '')]
    var title
    var counter = null
    var style = 'plain'
    if (th) {
      title = this.virtInl(th.title)
      counter = star ? null : th.counter
      style = th.style
    } else {
      var nm = THM_NAMES[name.replace(/\*$/, '')]
      title = nm[c.zh ? 1 : 0]
      counter = star ? null : name.replace(/\*$/, '')
      if (/^(definition|defn|def|example|exercise|problem|question|notation|assumption|axiom)$/.test(name)) style = 'definition'
      if (/^(remark|rem|note|solution|observation|fact)$/.test(name)) style = 'remark'
    }
    var note = this.opt()
    var id = c.id('thm')
    var num = ''
    if (counter) {
      if (!(counter in c.cnt)) {
        c.cnt[counter] = 0
        if (c.book) c.parent[counter] = 'chapter'
      }
      c.step(counter)
      num = c.the(counter)
      c.lastRef = { num: num, id: id, type: 'theorem', title: stripTags(title) }
    }
    var head = '<span class="thm-head">' + title + (num ? ' ' + num : '') + (note ? ' <span class="thm-note">(' + this.inl(note) + ')</span>' : '') + (c.zh ? '&ensp;' : '.&ensp;') + '</span>'
    var o = this.o.child(false)
    o.lead = head
    o.align = ''
    var body = this.blk({ s: this.i, e: bodyEnd }, o)
    this.o.block('<div class="thm thm-' + esc(style) + '" id="' + id + '" data-line="' + line + '">' + body + '</div>')
  }

  /* ================= 环境表 ================= */

  var ENVS = {}
  function env(names, fn) {
    names.split(' ').forEach(function (n) {
      ENVS[n] = fn
    })
  }

  env('document', function (n, line, end) {
    this.sub({ s: this.i, e: end })
  })

  /* --- 公式 --- */
  env('equation equation* displaymath math', function (n, line, end) {
    var tex = this.t.slice(this.i, end)
    if (n === 'math') return this.o.text(this.math(tex, false), line)
    this.o.block(this.displayMath(tex, line, n === 'equation'))
  })
  env('align align* flalign flalign* gather gather* multline multline* eqnarray eqnarray* alignat alignat* xalignat xxalignat', function (n, line, end) {
    var star = /\*$/.test(n) || n === 'xxalignat'
    var base = n.replace(/\*$/, '')
    var col = null
    if (base === 'alignat' || base === 'xalignat' || base === 'xxalignat') {
      col = this.argStr()
      base = 'alignat'
    }
    var tex = this.t.slice(this.i, end)
    this.o.block(this.multiMath(base, tex, line, star, col))
  })
  env('subequations', function (n, line, end) {
    this.sub({ s: this.i, e: end })
  })
  env('dmath dmath* dgroup dgroup*', function (n, line, end) {
    this.o.block(this.displayMath(this.t.slice(this.i, end), line, !/\*$/.test(n)))
  })

  /* --- 列表 --- */
  var BULLETS = ['•', '–', '∗', '·']
  env('itemize enumerate description compactitem compactenum asparaitem asparaenum inparaenum inparaitem compactdesc', function (n, line, end) {
    var c = this.c
    var kind = /enum/.test(n) ? 'enumerate' : /desc/.test(n) ? 'description' : 'itemize'
    var o = this.optStr()
    var prev = c.list
    var depth = kind === 'enumerate' ? (prev ? prev.edepth + 1 : 0) : prev ? prev.edepth : 0
    var idepth = kind === 'itemize' ? (prev ? prev.idepth + 1 : 0) : prev ? prev.idepth : 0
    var fmt = null
    if (o) {
      var kv = parseKV(o)
      var lbl = kv.label
      if (lbl) fmt = lbl
      else if (!/=/.test(o)) fmt = o.replace(/\b([1aAiI])\b/, function (x) { return { 1: '\\arabic*', a: '\\alph*', A: '\\Alph*', i: '\\roman*', I: '\\Roman*' }[x] })
      if (kv.start) c.listStart = parseInt(kv.start, 10)
    }
    var L = { kind: kind, n: c.listStart ? c.listStart - 1 : 0, fmt: fmt, edepth: depth, idepth: idepth, open: false, out: null }
    c.listStart = 0
    c.list = L
    var out = this.o.child(false)
    out.align = ''
    L.out = out
    this.sub({ s: this.i, e: end }, out)
    flushLead(out)
    if (L.open) out.html += '</li>'
    c.list = prev
    var tag = kind === 'enumerate' ? 'ol' : kind === 'description' ? 'dl' : 'ul'
    if (tag === 'dl') tag = 'ul'
    this.o.block('<' + tag + ' class="list ' + kind + '" data-line="' + line + '">' + out.html + '</' + tag + '>')
  })
  def('item', function (n, line) {
    var c = this.c
    var L = c.list
    this.overlay()
    var custom = this.opt()
    if (!L) {
      this.o.par()
      this.o.text((custom ? this.inl(custom) : '•') + '&ensp;', line)
      return
    }
    var o = L.out
    flushLead(o)
    if (L.open) o.html += '</li>'
    var label
    var id = c.id('item')
    if (custom) label = this.inl(custom)
    else if (L.kind === 'enumerate') {
      L.n++
      label = enumLabel(L)
      c.lastRef = { num: label.replace(/^[(\[]|[.)\]]$/g, '').replace(/[.)]$/, ''), id: id, type: 'item' }
    } else if (L.kind === 'itemize') label = BULLETS[L.idepth % 4]
    else label = ''
    // 标签放进列表项的第一段
    if (L.kind === 'description') {
      o.html += '<li class="desc" id="' + id + '" data-line="' + line + '">'
      o.lead = custom ? '<b class="dt">' + label + '</b>&ensp;' : ''
    } else {
      o.html += '<li id="' + id + '" data-line="' + line + '">'
      o.lead = '<span class="lbl">' + label + '</span>'
    }
    L.open = true
    o.ni = true
  })
  /** 结束上一项：没有正文的项也要显示标签 */
  function flushLead(o) {
    o.endPar()
    if (o.lead) {
      o.html += '<div class="par ni">' + o.lead + '</div>'
      o.lead = ''
    }
  }
  function enumLabel(L) {
    var n = L.n
    var f = L.fmt
    if (f) {
      return f
        .replace(/\\arabic\*?(\{[^}]*\})?/g, String(n))
        .replace(/\\alph\*?(\{[^}]*\})?/g, alph(n))
        .replace(/\\Alph\*?(\{[^}]*\})?/g, alph(n).toUpperCase())
        .replace(/\\roman\*?(\{[^}]*\})?/g, roman(n))
        .replace(/\\Roman\*?(\{[^}]*\})?/g, roman(n).toUpperCase())
        .replace(/\\(textbf|textit|emph)\{([^}]*)\}/g, '$2')
        .replace(/[{}]/g, '')
    }
    switch (L.edepth % 4) {
      case 0:
        return n + '.'
      case 1:
        return '(' + alph(n) + ')'
      case 2:
        return roman(n) + '.'
      default:
        return alph(n).toUpperCase() + '.'
    }
  }
  env('thebibliography', function (n, line, end) {
    var c = this.c
    this.arg()
    var prev = c.list
    var L = { kind: 'bib', n: 0, out: this.o.child(false), open: false, edepth: 0, idepth: 0 }
    c.list = L
    c.inBib = true
    this.sub({ s: this.i, e: end }, L.out)
    flushLead(L.out)
    if (L.open) L.out.html += '</li>'
    c.inBib = false
    c.list = prev
    c.hasBibEnv = true
    this.o.block('<section class="bib" data-line="' + line + '"><h2 class="sec nonum">' + (c.book ? c.name('bib') : c.name('refs')) + '</h2><ul class="list biblist">' + L.out.html + '</ul></section>')
  })
  def('bibitem', function (n, line) {
    var c = this.c
    var L = c.list
    var custom = this.optStr()
    var key = this.argStr()
    if (!L) return
    var o = L.out
    flushLead(o)
    if (L.open) o.html += '</li>'
    L.n++
    var label = custom != null ? custom : String(L.n)
    c.bibitems[key] = { label: label, id: 'bib-' + key.replace(/[^\w-]/g, '_') }
    c.bibitemOrder.push(key)
    o.html += '<li id="' + c.bibitems[key].id + '" data-line="' + line + '">'
    o.lead = '<span class="lbl">[' + esc(label) + ']</span>'
    L.open = true
    o.ni = true
  })
  def('newblock', function () {})

  /* --- 版式 --- */
  env('center flushleft flushright', function (n, line, end) {
    var o = this.o.child(false)
    o.align = n === 'center' ? 'center' : n === 'flushleft' ? 'left' : 'right'
    var body = this.blk({ s: this.i, e: end }, o)
    this.o.block('<div class="' + n + '" data-line="' + line + '">' + body + '</div>')
  })
  env('quote quotation verse', function (n, line, end) {
    this.o.block('<blockquote class="' + n + '" data-line="' + line + '">' + this.blk({ s: this.i, e: end }) + '</blockquote>')
  })
  env('abstract', function (n, line, end) {
    this.o.block('<div class="abstract" data-line="' + line + '"><div class="abs-title">' + this.c.name('abstract') + '</div>' + this.blk({ s: this.i, e: end }) + '</div>')
  })
  env('keywords', function (n, line, end) {
    this.o.block('<div class="keywords" data-line="' + line + '"><b>' + (this.c.zh ? '关键词：' : 'Keywords: ') + '</b>' + this.inl({ s: this.i, e: end }) + '</div>')
  })
  env('minipage', function (n, line, end) {
    this.eat('ooo')
    var w = cssLen(this.argStr())
    var o = this.o.child(false)
    o.align = this.o.align
    var body = this.blk({ s: this.i, e: end }, o)
    this.o.text('<div class="minipage" style="width:' + (w || '100%') + '" data-line="' + line + '">' + body + '</div>', line)
  })
  env('multicols multicols*', function (n, line, end) {
    var k = parseInt(this.argStr(), 10) || 2
    this.opt()
    this.o.block('<div class="multicols" style="column-count:' + k + '" data-line="' + line + '">' + this.blk({ s: this.i, e: end }) + '</div>')
  })
  env('titlepage', function (n, line, end) {
    this.o.block('<div class="titlepage" data-line="' + line + '">' + this.blk({ s: this.i, e: end }) + '</div>')
  })
  env('proof', function (n, line, end) {
    var note = this.opt()
    var o = this.o.child(false)
    o.lead = '<span class="proof-head">' + (note ? this.inl(note) : this.c.name('proof')) + (this.c.zh ? '&ensp;' : '.&ensp;') + '</span>'
    var body = this.blk({ s: this.i, e: end }, o)
    this.o.block('<div class="proof" data-line="' + line + '">' + body + '</div>')
  })
  def('qed qedhere', function (n, line) {
    this.o.text('<span class="qed">∎</span>', line)
  })

  /* --- 浮动体 --- */
  env('figure figure* table table* wrapfigure wraptable SCfigure listing algorithm sidewaysfigure sidewaystable marginfigure', function (n, line, end) {
    var c = this.c
    var type = /table/.test(n) ? 'table' : n === 'listing' ? 'listing' : n === 'algorithm' ? 'algorithm' : 'figure'
    this.opt()
    if (n === 'wrapfigure' || n === 'wraptable') {
      this.opt()
      this.arg()
      this.opt()
      this.arg()
    }
    var prev = c.float
    c.float = { type: type, sub: false }
    c.cnt.subfigure = 0
    var o = this.o.child(false)
    o.align = 'center'
    var body = this.blk({ s: this.i, e: end }, o)
    c.float = prev
    this.o.block('<figure class="float ' + type + '" data-line="' + line + '">' + body + '</figure>')
  })
  env('subfigure subtable', function (n, line, end) {
    var c = this.c
    this.opt()
    var w = cssLen(this.argStr())
    var prev = c.float
    c.float = { type: prev ? prev.type : 'figure', sub: true }
    var o = this.o.child(false)
    o.align = 'center'
    var body = this.blk({ s: this.i, e: end }, o)
    c.float = prev
    this.o.text('<div class="subfig" style="width:' + (w || '48%') + '" data-line="' + line + '">' + body + '</div>', line)
  })

  /* --- 原样文本 --- */
  env('verbatim verbatim* Verbatim Verbatim* BVerbatim lstlisting minted spverbatim alltt pycode', function (n, line, end) {
    var o = null
    var lang = ''
    if (n === 'Verbatim' || n === 'BVerbatim' || n === 'lstlisting') o = this.optStr()
    if (n === 'minted') {
      this.opt()
      lang = this.argStr()
    }
    if (o && n === 'lstlisting') {
      var kv = parseKV(o)
      lang = kv.language || ''
      if (kv.caption) {
        /* 标题 */
      }
    }
    var code = this.t.slice(this.i, end).replace(/^[ \t]*\r?\n/, '').replace(/\s+$/, '')
    this.o.block('<pre class="code" data-line="' + line + '"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + esc(code) + '</code></pre>')
  })
  env('comment filecontents filecontents*', function () {})

  /* --- 表格 --- */
  env('tabular tabular* tabularx tabulary longtable longtable* array tblr longtblr xltabular', function (n, line, end) {
    if (n === 'tabular*' || n === 'tabularx' || n === 'tabulary' || n === 'xltabular') this.arg()
    if (n === 'tblr' || n === 'longtblr') this.opt()
    this.opt()
    var specR = this.arg()
    var spec = this.str(specR)
    if (n === 'tblr' || n === 'longtblr') {
      var kv = parseKV(spec)
      spec = kv.colspec || spec
    }
    if (n === 'array') {
      this.o.text(this.math('\\begin{array}{' + spec + '}' + this.t.slice(this.i, end) + '\\end{array}', false), line)
      return
    }
    // 表格和 LaTeX 一样是行内的盒子：可以并排、跟着 \centering 居中
    this.o.text(this.tabular(spec, { s: this.i, e: end }, line), line)
  })

  P.prototype.tabular = function (spec, r, line) {
    var c = this.c
    var cols = parseColSpec(spec)
    var rows = splitTable(this.t, r.s, r.e)
    var prevTable = c.inTable
    c.inTable = true
    var html = '<table class="tabular" data-line="' + line + '"><tbody>'
    var rowspanLeft = []
    var pendingTop = null
    var out = []
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri]
      // 行首的横线命令
      var lead = this.tableRules(row)
      var top = mergeRules(pendingTop, lead.rules)
      pendingTop = null
      var cells = lead.cells
      var isEmpty = cells.length === 1 && !this.t.slice(cells[0].s, cells[0].e).trim()
      if (isEmpty) {
        // 只有横线的行：作为上一行的下边线
        if (out.length && top) out[out.length - 1].bottom = mergeRules(out[out.length - 1].bottom, top)
        else if (top) pendingTop = top
        continue
      }
      var cellsH = []
      var col = 0
      for (var ci = 0; ci < cells.length; ci++) {
        while (rowspanLeft[col] > 0) {
          rowspanLeft[col]--
          col++
        }
        var cr = cells[ci]
        var raw = this.t.slice(cr.s, cr.e)
        var span = 1
        var align = cols[col] ? cols[col].align : 'l'
        var borderL = cols[col] ? cols[col].bl : 0
        var borderR = cols[col] && col === cols.length - 1 ? cols[col].br || 0 : 0
        var rs = 1
        var bg = ''
        var content = cr
        var mm = /^\s*\\multicolumn\s*\{\s*(\d+)\s*\}/.exec(raw)
        if (mm) {
          var p = new P(c, this.src, cr.s + mm[0].length, cr.e, null)
          var sp = parseColSpec(p.str(p.arg()))
          span = parseInt(mm[1], 10)
          align = sp[0] ? sp[0].align : 'c'
          borderL = sp[0] ? sp[0].bl : 0
          borderR = sp[0] ? sp[0].br : 0
          content = p.arg() || { s: cr.e, e: cr.e }
        }
        var rawC = this.t.slice(content.s, content.e)
        var mr = /^\s*\\multirow\s*(\[[^\]]*\])?\s*\{\s*(-?\d+)\s*\}/.exec(rawC)
        if (mr) {
          var p2 = new P(c, this.src, content.s + mr[0].length, content.e, null)
          p2.opt()
          p2.arg()
          p2.opt()
          rs = Math.abs(parseInt(mr[2], 10)) || 1
          content = p2.arg() || { s: content.e, e: content.e }
          for (var k = 0; k < span; k++) rowspanLeft[col + k] = rs - 1
        }
        var mc = /^\s*\\cellcolor\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(this.t.slice(content.s, content.e))
        if (mc) {
          bg = colorCss(c, mc[1] ? mc[1].slice(1, -1) : null, mc[2])
          content = { s: content.s + mc[0].length, e: content.e }
        }
        var colDef = cols[col] || {}
        var inner
        if (colDef.width) inner = this.blk(content, this.o.child(false))
        else inner = this.inl(content).trim()
        var st = []
        st.push('text-align:' + (align === 'c' ? 'center' : align === 'r' ? 'right' : 'left'))
        if (colDef.width) st.push('width:' + colDef.width)
        if (borderL) st.push('border-left:' + (borderL > 1 ? '3px double' : '1px solid') + ' var(--rule)')
        if (borderR) st.push('border-right:' + (borderR > 1 ? '3px double' : '1px solid') + ' var(--rule)')
        if (bg) st.push('background:' + bg)
        cellsH.push({ html: inner, span: span, rs: rs, style: st, col: col })
        col += span
      }
      out.push({ cells: cellsH, top: top, bottom: null, line: this.line(cells[0] ? cells[0].s : r.s) })
    }
    if (pendingTop && out.length) out[out.length - 1].bottom = mergeRules(out[out.length - 1].bottom, pendingTop)
    for (var i = 0; i < out.length; i++) {
      var R = out[i]
      html += '<tr data-line="' + R.line + '">'
      for (var j = 0; j < R.cells.length; j++) {
        var cell = R.cells[j]
        var st2 = cell.style.slice()
        var tr = ruleAt(R.top, cell.col, cell.span)
        var br = ruleAt(R.bottom, cell.col, cell.span)
        if (tr) st2.push('border-top:' + tr)
        if (br) st2.push('border-bottom:' + br)
        html += '<td' + (cell.span > 1 ? ' colspan="' + cell.span + '"' : '') + (cell.rs > 1 ? ' rowspan="' + cell.rs + '"' : '') + ' style="' + st2.join(';') + '">' + cell.html + '</td>'
      }
      html += '</tr>'
    }
    c.inTable = prevTable
    return '<div class="tblwrap">' + html + '</tbody></table></div>'
  }

  /** 行首的 \hline / \toprule / \cline{2-3} 等 → { rules, cells } */
  P.prototype.tableRules = function (row) {
    var t = this.t
    var s = row.s
    var rules = []
    var re = /^\s*(?:%[^\n]*\n\s*)*\\(hline|toprule|midrule|bottomrule|cline|cmidrule|specialrule|addlinespace|hhline|endhead|endfirsthead|endfoot|endlastfoot|noalign|rowcolor|morecmidrules|cmidrule|Xhline|hdashline|cdashline)\b\s*(\([^)]*\))?\s*(\[[^\]]*\])?\s*/
    for (var guard = 0; guard < 50; guard++) {
      var rest = t.slice(s, row.e)
      var m = re.exec(rest)
      if (!m) break
      var name = m[1]
      s += m[0].length
      var arg = null
      if (/^(cline|cmidrule|hhline|noalign|rowcolor|cdashline|Xhline|specialrule)$/.test(name)) {
        var p = new P(this.c, this.src, s, row.e, null)
        if (name === 'rowcolor') p.opt()
        arg = p.str(p.arg())
        if (name === 'specialrule') {
          p.arg()
          p.arg()
        }
        s = p.i
      }
      if (name === 'hline' || name === 'hdashline') rules.push({ w: rules.some(function (x) { return x.full }) ? 'double' : 1, full: true })
      else if (name === 'toprule' || name === 'bottomrule' || name === 'Xhline' || name === 'specialrule') rules.push({ w: 2, full: true })
      else if (name === 'midrule') rules.push({ w: 1, full: true })
      else if (name === 'cline' || name === 'cmidrule' || name === 'cdashline') {
        var mm = /(\d+)\s*-\s*(\d+)/.exec(arg || '')
        if (mm) rules.push({ w: 1, from: +mm[1] - 1, to: +mm[2] - 1 })
      }
    }
    // 重新按 & 拆单元格（行首横线已去掉）
    var cells = splitCells(t, s, row.e)
    return { rules: rules.length ? rules : null, cells: cells }
  }
  function mergeRules(a, b) {
    if (!a) return b
    if (!b) return a
    return a.concat(b)
  }
  function ruleAt(rules, col, span) {
    if (!rules) return ''
    var w = 0
    var dbl = false
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i]
      if (!(r.full || (r.from <= col + span - 1 && r.to >= col))) continue
      if (r.w === 'double') dbl = true
      else w = Math.max(w, r.w)
    }
    if (dbl) return '3px double var(--rule)'
    if (!w) return ''
    return (w > 1 ? '1.5px' : '1px') + ' solid var(--rule)'
  }

  /** 列格式：l c r p{3cm} | @{} >{\centering} *{3}{c} X S … */
  function parseColSpec(spec) {
    var cols = []
    var bar = 0
    var i = 0
    spec = String(spec || '')
    // 展开 *{n}{…}
    for (var g = 0; g < 10 && /\*\s*\{\s*\d+\s*\}/.test(spec); g++) {
      spec = spec.replace(/\*\s*\{\s*(\d+)\s*\}\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/, function (_, n, s) {
        return new Array(Math.min(50, +n) + 1).join(s)
      })
    }
    var skipGroup = function () {
      while (spec[i] === ' ') i++
      if (spec[i] !== '{') return ''
      var d = 0
      var s = i
      for (; i < spec.length; i++) {
        if (spec[i] === '{') d++
        else if (spec[i] === '}' && --d === 0) {
          i++
          return spec.slice(s + 1, i - 1)
        }
      }
      return spec.slice(s + 1)
    }
    while (i < spec.length) {
      var ch = spec[i++]
      if (ch === '|') bar++
      else if (ch === 'l' || ch === 'c' || ch === 'r' || ch === 'L' || ch === 'C' || ch === 'R' || ch === 'S' || ch === 'J' || ch === 'Q') {
        cols.push({ align: ch === 'S' || ch === 'C' ? 'c' : ch === 'R' ? 'r' : ch === 'L' || ch === 'J' ? 'l' : ch === 'Q' ? 'l' : ch, bl: bar })
        bar = 0
        if (ch === 'Q' && spec[i] === '[') i = spec.indexOf(']', i) + 1 || spec.length
      } else if (ch === 'p' || ch === 'm' || ch === 'b') {
        var w = skipGroup()
        cols.push({ align: 'l', bl: bar, width: cssLen(w) })
        bar = 0
      } else if (ch === 'X') {
        if (spec[i] === '[') i = spec.indexOf(']', i) + 1 || spec.length
        cols.push({ align: 'l', bl: bar })
        bar = 0
      } else if (ch === '@' || ch === '!' || ch === '>' || ch === '<') skipGroup()
      else if (ch === 'D') {
        skipGroup()
        skipGroup()
        skipGroup()
        cols.push({ align: 'c', bl: bar })
        bar = 0
      } else if (ch === '{') {
        i--
        skipGroup()
      }
    }
    if (cols.length) cols[cols.length - 1].br = bar
    return cols
  }

  /** 表格正文按 \\ 拆成行（不拆花括号和嵌套环境里的） */
  function splitTable(t, s, e) {
    var rows = []
    var d = 0
    var env = 0
    var last = s
    for (var j = s; j < e; j++) {
      var ch = t[j]
      if (ch === '%') {
        var n = t.indexOf('\n', j)
        j = n < 0 ? e : n
        continue
      }
      if (ch === '\\') {
        if ((t[j + 1] === '\\' || t.startsWith('tabularnewline', j + 1)) && d === 0 && env === 0) {
          rows.push({ s: last, e: j })
          j += t[j + 1] === '\\' ? 2 : 15
          if (t[j] === '*') j++
          var k = j
          while (t[k] === ' ' || t[k] === '\n') k++
          if (t[k] === '[') {
            var close = t.indexOf(']', k)
            if (close > 0 && close < e) j = close + 1
          }
          last = j
          j--
          continue
        }
        if (t.startsWith('begin', j + 1)) env++
        else if (t.startsWith('end', j + 1)) env--
        j++
        continue
      }
      if (ch === '{') d++
      else if (ch === '}') d--
    }
    rows.push({ s: last, e: e })
    return rows
  }
  function splitCells(t, s, e) {
    var cells = []
    var d = 0
    var env = 0
    var last = s
    for (var j = s; j < e; j++) {
      var ch = t[j]
      if (ch === '%') {
        var n = t.indexOf('\n', j)
        j = n < 0 ? e : n
        continue
      }
      if (ch === '\\') {
        if (t.startsWith('begin', j + 1)) env++
        else if (t.startsWith('end', j + 1)) env--
        j++
        continue
      }
      if (ch === '{') d++
      else if (ch === '}') d--
      else if (ch === '&' && d === 0 && env === 0) {
        cells.push({ s: last, e: j })
        last = j + 1
      }
    }
    cells.push({ s: last, e: e })
    return cells
  }

  /* --- beamer --- */
  env('frame', function (n, line, end) {
    var c = this.c
    this.overlay()
    this.opt()
    var title = ''
    var save = this.i
    this.skipSp()
    if (this.t[this.i] === '{') title = this.inl(this.group())
    else this.i = save
    save = this.i
    this.skipSp()
    var subtitle = ''
    if (this.t[this.i] === '{') subtitle = this.inl(this.group())
    else this.i = save
    var o = this.o.child(false)
    c.frame = { title: title }
    var body = this.blk({ s: this.i, e: end }, o)
    var t = c.frame.title
    c.frame = null
    this.o.block('<section class="frame" data-line="' + line + '">' + (t ? '<h3 class="frametitle">' + t + (subtitle ? '<small>' + subtitle + '</small>' : '') + '</h3>' : '') + '<div class="framebody">' + body + '</div></section>')
  })
  def('frametitle', function () {
    this.overlay()
    var h = this.inl(this.arg())
    if (this.c.frame) this.c.frame.title = h
  })
  def('framesubtitle', function () {
    this.arg()
  })
  def('pause', function () {})
  def('only onslide uncover visible invisible', function (n, line) {
    this.overlay()
    var save = this.i
    this.skipSp()
    if (this.t[this.i] === '{') this.o.text(this.inl(this.group()), line)
    else this.i = save
  })
  env('block alertblock exampleblock', function (n, line, end) {
    this.overlay()
    var title = this.inl(this.arg())
    this.o.block('<div class="bblock ' + n + '" data-line="' + line + '"><div class="bblock-title">' + title + '</div><div class="bblock-body">' + this.blk({ s: this.i, e: end }) + '</div></div>')
  })
  env('columns', function (n, line, end) {
    this.opt()
    this.o.block('<div class="columns" data-line="' + line + '">' + this.blk({ s: this.i, e: end }) + '</div>')
  })
  env('column', function (n, line, end) {
    this.opt()
    var w = cssLen(this.argStr())
    this.o.block('<div class="column" style="flex-basis:' + (w || '50%') + '">' + this.blk({ s: this.i, e: end }) + '</div>')
  })
  env('overprint onlyenv', function (n, line, end) {
    this.overlay()
    this.sub({ s: this.i, e: end })
  })

  /* --- 绘图：即时预览画不了，提示用 PDF 模式 --- */
  env('tikzpicture pspicture picture circuitikz forest tikzcd axis', function (n, line) {
    var c = this.c
    this.o.block('<div class="tikz" data-line="' + line + '"><span>' + esc(n) + '</span>' + (c.zh ? '绘图在“PDF”模式下显示' : 'Drawings show in PDF mode') + '</div>')
  })
  def('tikz', function (n, line) {
    this.opt()
    this.arg()
    this.o.text('<span class="tikz inline">TikZ</span>', line)
  })
  env('algorithmic algorithmic* algorithm2e', function (n, line, end) {
    var code = this.t.slice(this.i, end)
    var lines = code
      .split('\n')
      .map(function (l) {
        return l.trim()
      })
      .filter(Boolean)
    var self = this
    var html = lines
      .map(function (l) {
        var m = /^\\(State|Statex|If|ElsIf|Else|EndIf|For|ForAll|EndFor|While|EndWhile|Repeat|Until|Return|Require|Ensure|Function|EndFunction|Procedure|EndProcedure|Comment|STATE|IF|ELSE|ENDIF|FOR|ENDFOR|WHILE|ENDWHILE|RETURN|REQUIRE|ENSURE)\b\s*/.exec(l)
        var kw = m ? m[1] : ''
        var rest = m ? l.slice(m[0].length) : l
        var label = { If: 'if', ElsIf: 'else if', Else: 'else', EndIf: 'end if', For: 'for', ForAll: 'for all', EndFor: 'end for', While: 'while', EndWhile: 'end while', Repeat: 'repeat', Until: 'until', Return: 'return', Require: 'Require:', Ensure: 'Ensure:', Function: 'function', EndFunction: 'end function', Procedure: 'procedure', EndProcedure: 'end procedure', IF: 'if', ELSE: 'else', ENDIF: 'end if', FOR: 'for', ENDFOR: 'end for', WHILE: 'while', ENDWHILE: 'end while', RETURN: 'return', REQUIRE: 'Require:', ENSURE: 'Ensure:' }[kw]
        return '<div class="alg-line">' + (label ? '<b>' + label + '</b> ' : '') + self.virtInl(rest) + '</div>'
      })
      .join('')
    this.o.block('<div class="algorithmic" data-line="' + line + '">' + html + '</div>')
  })

  /* --- 其他 --- */
  def('iffalse', function () {
    var j = this.t.indexOf('\\fi', this.i)
    this.i = j < 0 || j > this.e ? this.e : j + 3
  })
  def('fi else ifx ifdefined ifcsname', function () {})
  def('makeatletter makeatother', function () {})

  /* ================= 符号 ================= */

  var SYM = {
    LaTeX: '<span class="logo">L<span class="a">a</span>T<span class="e">e</span>X</span>',
    LaTeXe: '<span class="logo">L<span class="a">a</span>T<span class="e">e</span>X&thinsp;2<sub>ε</sub></span>',
    TeX: '<span class="logo">T<span class="e">e</span>X</span>',
    XeTeX: '<span class="logo">X<span class="e">ǝ</span>T<span class="e">e</span>X</span>',
    XeLaTeX: '<span class="logo">X<span class="e">ǝ</span>L<span class="a">a</span>T<span class="e">e</span>X</span>',
    LuaTeX: 'LuaT<span class="logo"><span class="e">e</span></span>X',
    LuaLaTeX: 'LuaL<span class="logo"><span class="a">a</span>T<span class="e">e</span></span>X',
    BibTeX: 'B<span class="sc">ib</span><span class="logo">T<span class="e">e</span>X</span>',
    pdfLaTeX: 'pdfL<span class="logo"><span class="a">a</span>T<span class="e">e</span></span>X',
    today: function (c) {
      var d = new Date()
      if (c.zh) return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
      return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear()
    },
    ldots: '…',
    dots: '…',
    textellipsis: '…',
    textbackslash: '\\',
    '&': '&amp;',
    '%': '%',
    $: '$',
    '#': '#',
    _: '_',
    '{': '{',
    '}': '}',
    ' ': ' ',
    ',': ' ',
    ';': ' ',
    ':': ' ',
    '!': '',
    '/': '',
    '-': '&shy;',
    '@': '',
    '\n': ' ',
    '\t': ' ',
    quad: ' ',
    qquad: '  ',
    enspace: ' ',
    enskip: ' ',
    thinspace: ' ',
    negthinspace: '',
    nobreakspace: '&nbsp;',
    textbar: '|',
    textless: '&lt;',
    textgreater: '&gt;',
    S: '§',
    P: '¶',
    textsection: '§',
    textparagraph: '¶',
    dag: '†',
    ddag: '‡',
    textdagger: '†',
    textdaggerdbl: '‡',
    copyright: '©',
    textcopyright: '©',
    textregistered: '®',
    texttrademark: '™',
    textdegree: '°',
    degree: '°',
    celsius: '℃',
    pounds: '£',
    textsterling: '£',
    euro: '€',
    texteuro: '€',
    yen: '¥',
    textyen: '¥',
    textbullet: '•',
    textperiodcentered: '·',
    textendash: '–',
    textemdash: '—',
    textasciitilde: '~',
    textasciicircum: '^',
    textunderscore: '_',
    textvisiblespace: '␣',
    textquoteleft: '‘',
    textquoteright: '’',
    textquotedblleft: '“',
    textquotedblright: '”',
    textquotedbl: '"',
    guillemotleft: '«',
    guillemotright: '»',
    guillemetleft: '«',
    guillemetright: '»',
    guilsinglleft: '‹',
    guilsinglright: '›',
    slash: '/',
    lq: '‘',
    rq: '’',
    i: 'ı',
    j: 'ȷ',
    ss: 'ß',
    SS: 'SS',
    ae: 'æ',
    AE: 'Æ',
    oe: 'œ',
    OE: 'Œ',
    o: 'ø',
    O: 'Ø',
    aa: 'å',
    AA: 'Å',
    l: 'ł',
    L: 'Ł',
    checkmark: '✓',
    cmark: '✓',
    xmark: '✗',
    textmu: 'µ',
    texttimes: '×',
    textdiv: '÷',
    textpm: '±',
    textonehalf: '½',
    textonequarter: '¼',
    textthreequarters: '¾',
    textminus: '−',
    textrightarrow: '→',
    textleftarrow: '←',
    textcent: '¢',
    textnumero: '№',
    textohm: 'Ω',
    textperthousand: '‰',
    textbrokenbar: '¦',
    textordfeminine: 'ª',
    textordmasculine: 'º',
    textexclamdown: '¡',
    textquestiondown: '¿',
    textopenbullet: '◦',
    textasteriskcentered: '∗',
    textcircled: '',
    ding: '',
    space: ' ',
    nobreak: '',
    allowbreak: '',
    break: '',
    protect: '',
    relax: '',
    ignorespaces: '',
    leavevmode: '',
    null: '',
    strut: '',
    unskip: '',
    xspace: '',
    selectfont: '',
    centerdot: '·'
  }

  var ACCENTS = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', d: '̣', b: '̱', r: '̊', k: '̨', t: '͡' }

  /** 字体开关（作用到所在分组 / 环境结束） */
  var SWITCH = {
    bfseries: ['<b>', '</b>'],
    bf: ['<b>', '</b>'],
    mdseries: ['<span class="md">', '</span>'],
    itshape: ['<i>', '</i>'],
    it: ['<i>', '</i>'],
    em: ['<em>', '</em>'],
    slshape: ['<i class="sl">', '</i>'],
    sl: ['<i class="sl">', '</i>'],
    scshape: ['<span class="sc">', '</span>'],
    sc: ['<span class="sc">', '</span>'],
    upshape: ['<span class="up">', '</span>'],
    ttfamily: ['<code class="tt">', '</code>'],
    tt: ['<code class="tt">', '</code>'],
    sffamily: ['<span class="sf">', '</span>'],
    sf: ['<span class="sf">', '</span>'],
    rmfamily: ['<span class="rm">', '</span>'],
    rm: ['<span class="rm">', '</span>'],
    normalfont: ['<span class="nf">', '</span>'],
    tiny: ['<span class="fs-tiny">', '</span>'],
    scriptsize: ['<span class="fs-script">', '</span>'],
    footnotesize: ['<span class="fs-foot">', '</span>'],
    small: ['<span class="fs-small">', '</span>'],
    normalsize: ['<span class="fs-normal">', '</span>'],
    large: ['<span class="fs-large">', '</span>'],
    Large: ['<span class="fs-Large">', '</span>'],
    LARGE: ['<span class="fs-LARGE">', '</span>'],
    huge: ['<span class="fs-huge">', '</span>'],
    Huge: ['<span class="fs-Huge">', '</span>'],
    heiti: ['<span class="sf">', '</span>'],
    kaishu: ['<i class="kai">', '</i>'],
    songti: ['<span class="rm">', '</span>'],
    fangsong: ['<span class="rm">', '</span>']
  }

  /** 忽略的命令和它们的参数格式（a 必选，o 可选，s 星号） */
  var IGNORE = {
    usetikzlibrary: 'a',
    pgfplotsset: 'a',
    tikzset: 'a',
    setlength: 'aa',
    addtolength: 'aa',
    settowidth: 'aa',
    newlength: 'a',
    pagestyle: 'a',
    thispagestyle: 'a',
    pagenumbering: 'a',
    geometry: 'a',
    hypersetup: 'a',
    lstset: 'a',
    setminted: 'oa',
    usemintedstyle: 'a',
    setmainfont: 'oao',
    setsansfont: 'oao',
    setmonofont: 'oao',
    setCJKmainfont: 'oao',
    setCJKsansfont: 'oao',
    setCJKmonofont: 'oao',
    setCJKfamilyfont: 'aoa',
    newfontfamily: 'aoa',
    xeCJKsetup: 'a',
    ctexset: 'a',
    linespread: 'a',
    captionsetup: 'oa',
    sisetup: 'a',
    index: 'a',
    glossary: 'a',
    hyphenation: 'a',
    frenchspacing: '',
    sloppy: '',
    fussy: '',
    raggedbottom: '',
    flushbottom: '',
    onecolumn: '',
    twocolumn: 'o',
    enlargethispage: 'sa',
    addvspace: 'a',
    newtheoremstyle: 'aaaaaaaaa',
    DeclareGraphicsExtensions: 'a',
    AtBeginDocument: 'a',
    AtEndDocument: 'a',
    usetheme: 'oa',
    usecolortheme: 'oa',
    usefonttheme: 'oa',
    useinnertheme: 'oa',
    useoutertheme: 'oa',
    setbeamertemplate: 'aoo',
    setbeamercolor: 'sa a',
    setbeamerfont: 'sa a',
    setbeamersize: 'a',
    logo: 'a',
    titlegraphic: 'a',
    includeonly: 'a',
    listfiles: '',
    nofiles: '',
    newcolumntype: 'aoa',
    nopagebreak: 'o',
    nolinebreak: 'o',
    newif: 'a',
    ExplSyntaxOn: '',
    ExplSyntaxOff: '',
    special: 'a',
    pdfbookmark: 'oaa',
    bookmark: 'oa',
    phantomsection: '',
    markboth: 'aa',
    markright: 'a',
    fancyhf: 'oa',
    fancyhead: 'oa',
    fancyfoot: 'oa',
    lhead: 'oa',
    chead: 'oa',
    rhead: 'oa',
    lfoot: 'oa',
    cfoot: 'oa',
    rfoot: 'oa',
    titleformat: 'saoaaao',
    titlespacing: 'saaaao',
    setlist: 'oa',
    setitemize: 'oa',
    setenumerate: 'oa',
    DeclareFieldFormat: 'oaa',
    DeclareCaptionFormat: 'aa',
    DeclareCaptionLabelFormat: 'aa',
    crefname: 'aaa',
    Crefname: 'aaa',
    renewbibmacro: 'saa',
    floatname: 'aa',
    restylefloat: 'a',
    floatstyle: 'a',
    newfloat: 'aaao',
    setstretch: 'a',
    doublespacing: '',
    onehalfspacing: '',
    singlespacing: '',
    allowdisplaybreaks: 'o',
    noindentafter: 'a',
    pgfmathsetmacro: 'aa',
    linenumbers: '',
    nolinenumbers: '',
    balance: '',
    IEEEoverridecommandlockouts: '',
    IEEEpeerreviewmaketitle: '',
    IEEEauthorblockN: 'a',
    IEEEauthorblockA: 'a',
    keywords: 'a',
    affiliation: 'a',
    address: 'a',
    ccsdesc: 'oa',
    acmConference: 'oaaa',
    setcopyright: 'a',
    copyrightyear: 'a',
    acmYear: 'a',
    acmDOI: 'a',
    acmISBN: 'a',
    clubpenalty: '',
    widowpenalty: '',
    tolerance: '',
    emergencystretch: '',
    hbadness: '',
    vbadness: '',
    hfuzz: '',
    vfuzz: '',
    parindent: '',
    parskip: '',
    baselineskip: '',
    textwidth: '',
    linewidth: '',
    columnwidth: '',
    footnotesep: '',
    arraystretch: '',
    tabcolsep: '',
    stretch: 'a',
    newpagestyle: 'aa',
    ifthenelse: 'aaa'
  }

  /* ================= 参考文献（.bib） ================= */

  function parseBib(text) {
    var out = {}
    var re = /@(\w+)\s*([{(])/g
    var m
    while ((m = re.exec(text))) {
      var type = m[1].toLowerCase()
      if (type === 'comment' || type === 'preamble' || type === 'string') continue
      var s = re.lastIndex
      var d = 1
      var j = s
      for (; j < text.length && d > 0; j++) {
        var ch = text[j]
        if (ch === '{' || ch === '(') d++
        else if (ch === '}' || ch === ')') d--
      }
      var body = text.slice(s, j - 1)
      re.lastIndex = j
      var comma = body.indexOf(',')
      if (comma < 0) continue
      var key = body.slice(0, comma).trim()
      var fields = {}
      var rest = body.slice(comma + 1)
      var fre = /\s*([\w-]+)\s*=\s*/g
      var fm
      while ((fm = fre.exec(rest))) {
        var k = fm[1].toLowerCase()
        var p = fre.lastIndex
        var val = ''
        if (rest[p] === '{') {
          var dd = 0
          var q = p
          for (; q < rest.length; q++) {
            if (rest[q] === '{') dd++
            else if (rest[q] === '}' && --dd === 0) break
          }
          val = rest.slice(p + 1, q)
          p = q + 1
        } else if (rest[p] === '"') {
          var q2 = p + 1
          var d2 = 0
          for (; q2 < rest.length; q2++) {
            if (rest[q2] === '{') d2++
            else if (rest[q2] === '}') d2--
            else if (rest[q2] === '"' && d2 === 0) break
          }
          val = rest.slice(p + 1, q2)
          p = q2 + 1
        } else {
          var mm = /^[^,]*/.exec(rest.slice(p))
          val = mm[0].trim()
          p += mm[0].length
        }
        fields[k] = val.replace(/\s+/g, ' ').trim()
        var nc = rest.indexOf(',', p)
        fre.lastIndex = nc < 0 ? rest.length : nc + 1
      }
      out[key] = { type: type, f: fields }
    }
    return out
  }
  function bibAuthors(s) {
    if (!s) return ''
    var names = s.split(/\s+and\s+/).map(function (n) {
      n = n.trim()
      if (n.indexOf(',') >= 0) {
        var p = n.split(',')
        return (p[1].trim() + ' ' + p[0].trim()).trim()
      }
      return n
    })
    if (names.length > 3) return names[0] + ' et al.'
    if (names.length === 1) return names[0]
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
  }
  function bibLastName(s) {
    if (!s) return ''
    var first = s.split(/\s+and\s+/)[0].trim()
    var last = first.indexOf(',') >= 0 ? first.split(',')[0] : first.split(/\s+/).pop()
    var n = s.split(/\s+and\s+/).length
    return last.replace(/[{}]/g, '') + (n > 2 ? ' et al.' : n === 2 ? ' and ' + bibLastName(s.split(/\s+and\s+/)[1]).replace(/ et al\.$/, '') : '')
  }

  P.prototype.bibEntry = function (e) {
    var f = e.f
    var self = this
    var x = function (s) {
      return s ? self.virtInl(s) : ''
    }
    var parts = []
    if (f.author || f.editor) parts.push(x(bibAuthors(f.author || f.editor)) + (f.author ? '' : ' (ed.)'))
    var title = x(f.title)
    if (title) parts.push(/^(book|phdthesis|mastersthesis|manual)$/.test(e.type) ? '<i>' + title + '</i>' : title)
    var venue = f.journal || f.booktitle || f.publisher || f.school || f.institution || f.howpublished || f.organization
    if (venue) {
      var v = '<i>' + x(venue) + '</i>'
      if (f.volume) v += ', ' + esc(f.volume) + (f.number ? '(' + esc(f.number) + ')' : '')
      if (f.pages) v += ':' + esc(f.pages.replace(/--?/, '–'))
      parts.push((f.booktitle ? (this.c.zh ? '' : 'In ') : '') + v)
    }
    if (f.year || f.date) parts.push(esc(f.year || f.date))
    var html = parts.filter(Boolean).join('. ') + '.'
    if (f.doi) html += ' <a class="url" href="https://doi.org/' + esc(f.doi) + '">doi:' + esc(f.doi) + '</a>'
    else if (f.url) html += ' <a class="url" href="' + esc(f.url) + '">' + esc(f.url) + '</a>'
    return html
  }

  /* ================= 入口 ================= */

  function render(text, opts) {
    var result = renderOnce(text, opts || {}, null)
    // 公式里引用了后面才定义的标签：带着第一遍的编号再渲染一次
    if (result.ctx.mathRefMiss) result = renderOnce(text, opts || {}, result.ctx.labels)
    var c = result.ctx
    var warnings = Object.keys(c.warn).map(function (k) {
      var p = k.split('\u0001')
      return { kind: p[0], cmd: p[1], count: c.warn[k] }
    })
    return {
      html: result.html,
      toc: c.toc.map(function (x) {
        return { level: x.level, num: x.num, title: stripTags(x.title), line: x.line, id: x.id }
      }),
      labels: Object.keys(c.labels),
      bibKeys: result.bibKeys,
      need: Object.keys(c.need),
      warnings: warnings,
      title: c.title ? plainTitle(c) : '',
      lang: c.zh ? 'zh' : 'en',
      cls: c.cls
    }
  }

  /** 标题的纯文本（去掉 \thanks 和换行） */
  function plainTitle(c) {
    var raw = c.title.src.text.slice(c.title.r.s, c.title.r.e).replace(/\\thanks\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '').replace(/\\\\/g, ' ')
    var src = new Source(raw, 0)
    return stripTags(new P(c, src, 0, raw.length, new Out(c, true)).run().result()).replace(/\s+/g, ' ').trim()
  }

  function renderOnce(text, opts, prevLabels) {
    var o2 = {}
    for (var k in opts) o2[k] = opts[k]
    o2.prevLabels = prevLabels
    var c = new Ctx(o2)
    var src = new Source(text)
    // 有 \chapter 就按书籍编号；中文文档（ctex、xeCJK）用中文名称
    if (/\\chapter\*?\s*[{[]/.test(text)) c.setBook()
    var KMAC = { '\\SI': '#1\\,\\mathrm{#2}', '\\si': '\\mathrm{#1}', '\\num': '#1', '\\qty': '#1\\,\\mathrm{#2}', '\\unit': '\\mathrm{#1}', '\\degree': '^\\circ', '\\celsius': '^\\circ\\mathrm{C}', '\\abs': '\\left|#1\\right|', '\\norm': '\\left\\|#1\\right\\|', '\\dd': '\\mathrm{d}', '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}', '\\pdv': '\\frac{\\partial #1}{\\partial #2}', '\\eval': '\\left.#1\\right|', '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}', '\\QQ': '\\mathbb{Q}', '\\CC': '\\mathbb{C}', '\\bm': '\\boldsymbol{#1}', '\\mathbbm': '\\mathbb{#1}', '\\intertext': '\\text{#1}\\\\', '\\shortintertext': '\\text{#1}\\\\', '\\coloneqq': '\\mathrel{:=}', '\\eqqcolon': '\\mathrel{=:}', '\\ensuremath': '#1', '\\textup': '\\text{#1}', '\\upmu': '\\mu', '\\uppi': '\\pi' }
    for (var km in KMAC) c.kmacros[km] = KMAC[km]
    c.kkey = null
    var b = text.search(/\\begin\s*\{document\}/)
    var html
    var out = new Out(c, false)
    if (b >= 0) {
      // 导言区：只处理定义，丢掉输出
      c.inPreamble = true
      new P(c, src, 0, b, new Out(c, false)).run()
      c.inPreamble = false
      var start = text.indexOf('}', b) + 1
      var e = text.search(/\\end\s*\{document\}/)
      new P(c, src, start, e > start ? e : text.length, out).run()
    } else {
      new P(c, src, 0, text.length, out).run()
    }
    html = out.result()
    // 参考文献
    var bib = {}
    c.bibFiles.forEach(function (f) {
      var t = c.files[f]
      if (t === undefined) c.need[f] = true
      else if (t) {
        var parsed = parseBib(t)
        for (var k in parsed) bib[k] = parsed[k]
      }
    })
    var bibKeys = Object.keys(bib)
    var cited = c.nociteAll ? c.cites.concat(bibKeys.filter(function (k) { return !c.citeSeen[k] })) : c.cites
    var bibNum = {}
    var n = 0
    cited.forEach(function (k) {
      if (bib[k] && !c.bibitems[k]) bibNum[k] = ++n
    })
    var p0 = new P(c, src, 0, 0, new Out(c, true))
    html = html.replace(PH_RE, function (all, kind, key) {
      switch (kind) {
        case 'TOC':
          return tocHtml(c)
        case 'LOF':
        case 'LOT':
          return lofHtml(c, kind === 'LOF' ? c.lof : c.lot, c.name(kind === 'LOF' ? 'lof' : 'lot'))
        case 'BIB': {
          var items = cited.filter(function (k) {
            return bib[k] && !c.bibitems[k]
          })
          if (!items.length) {
            if (!c.bibFiles.length) return ''
            return '<section class="bib"><h2 class="sec nonum">' + c.name('refs') + '</h2><p class="muted">' + (c.zh ? '还没有引用文献（\\cite）。' : 'No citations yet (\\cite).') + '</p></section>'
          }
          return (
            '<section class="bib"><h2 class="sec nonum">' + (c.book ? c.name('bib') : c.name('refs')) + '</h2><ul class="list biblist">' +
            items
              .map(function (k) {
                return '<li id="bib-' + k.replace(/[^\w-]/g, '_') + '"><span class="lbl">[' + bibNum[k] + ']</span>' + p0.bibEntry(bib[k]) + '</li>'
              })
              .join('') +
            '</ul></section>'
          )
        }
        case 'CITE': {
          var bi = c.bibitems[key]
          if (bi) return '<a class="ref" href="#' + bi.id + '">' + esc(bi.label) + '</a>'
          if (bibNum[key]) return '<a class="ref" href="#bib-' + key.replace(/[^\w-]/g, '_') + '">' + bibNum[key] + '</a>'
          return '<span class="ref missing" title="' + esc(key) + '">?</span>'
        }
        case 'CITEA':
          return bib[key] ? esc(bibLastName(bib[key].f.author || bib[key].f.editor)) : esc(key)
        case 'CITEY':
          return bib[key] ? esc(bib[key].f.year || '') : '?'
        default: {
          var l = c.labels[key]
          if (!l || (l.num === '' && kind !== 'NREF' && kind !== 'PREF')) return '<span class="ref missing" title="' + esc(key) + '">??</span>'
          var text = l.num
          if (kind === 'EQREF') text = '(' + l.num + ')'
          else if (kind === 'PREF') text = '↗'
          else if (kind === 'NREF') text = l.title ? esc(l.title) : l.num
          else if (kind === 'AREF') text = refName(c, l) + text
          return '<a class="ref" href="#' + l.id + '">' + text + '</a>'
        }
      }
    })
    if (c.footnotes.length) {
      html +=
        '<section class="footnotes"><ol>' +
        c.footnotes
          .map(function (f) {
            return '<li id="' + f.id + '"><span class="lbl">' + esc(f.n) + '</span>' + f.html + '</li>'
          })
          .join('') +
        '</ol></section>'
    }
    html = html.replace(//g, '')
    return { html: html, ctx: c, bibKeys: bibKeys }
  }

  function refName(c, l) {
    var zh = c.zh
    switch (l.type) {
      case 'chapter':
        return zh ? '第 ' : 'Chapter '
      case 'section':
      case 'subsection':
      case 'subsubsection':
        return zh ? '节 ' : 'Section '
      case 'figure':
        return zh ? '图 ' : 'Figure '
      case 'table':
        return zh ? '表 ' : 'Table '
      case 'equation':
        return zh ? '式 ' : 'Equation '
      case 'theorem':
        return (l.title || '') + ' '
      default:
        return ''
    }
  }

  function tocHtml(c) {
    var items = c.toc.filter(function (x) {
      return !x.star && x.level <= (c.book ? 3 : 4)
    })
    var min = items.reduce(function (m, x) {
      return Math.min(m, x.level)
    }, 9)
    return (
      '<nav class="toc"><h2 class="sec nonum">' + c.name('contents') + '</h2>' +
      items
        .map(function (x) {
          return '<a class="toc-item lv' + (x.level - min) + '" href="#' + x.id + '">' + (x.num ? '<span class="secnum">' + x.num + '</span>' : '') + '<span class="toc-t">' + x.title + '</span></a>'
        })
        .join('') +
      '</nav>'
    )
  }
  function lofHtml(c, list, title) {
    return (
      '<nav class="toc"><h2 class="sec nonum">' + title + '</h2>' +
      list
        .map(function (x) {
          return '<a class="toc-item lv1" href="#' + x.id + '"><span class="secnum">' + x.num + '</span><span class="toc-t">' + x.title + '</span></a>'
        })
        .join('') +
      '</nav>'
    )
  }

  global.TeX2HTML = { render: render, parseBib: parseBib, joinPath: joinPath, clearCache: function () { mathCache.clear() } }
})(typeof window !== 'undefined' ? window : globalThis)
