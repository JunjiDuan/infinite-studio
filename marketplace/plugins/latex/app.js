/* LaTeX 编辑器 —— Infinite Studio 插件
 *
 * 左边写 LaTeX，右边看效果：
 *   即时预览  浏览器里直接排版（tex2html.js + KaTeX），边写边更新，不需要安装 TeX
 *   PDF       调用本机的 TeX（xelatex / pdflatex / lualatex / latexmk / tectonic）编译，显示真正的 PDF，
 *             SyncTeX 双向定位，日志里的错误和警告列在下面
 */
;(function () {
  'use strict'

  var $ = function (s) {
    return document.querySelector(s)
  }
  var T = function (zh, en) {
    return studio.t(zh, en)
  }

  var bar = $('#bar')
  var main = $('#main')
  var srcEl = $('#src')
  var hlEl = $('#hl')
  var srcScroll = $('#srcScroll')
  var liveScroll = $('#liveScroll')
  var pageEl = $('#page')
  var pdfScroll = $('#pdfScroll')
  var pdfPagesEl = $('#pdfPages')
  var pdfEmpty = $('#pdfEmpty')
  var pdfTools = $('#pdfTools')
  var problemsEl = $('#problems')
  var statusEl = $('#status')
  var menuEl = $('#menu')
  var acEl = $('#ac')
  var findBar = $('#findBar')
  var splitter = $('#splitter')
  var isMac = /Mac/.test(navigator.platform)
  var K = isMac ? '⌘' : 'Ctrl+'

  /* ================= 设置 ================= */

  var DEFAULTS = { mode: 'split', view: 'live', engine: 'xelatex', custom: '', autoCompile: true, paper: 'white', fontSize: 14, zoom: 1, pdfZoom: 0, split: 50, wrap: true, autoClose: true, complete: true }
  var settings = (function () {
    var s = {}
    try {
      s = JSON.parse(localStorage.getItem('latex-settings') || '{}') || {}
    } catch (e) {
      s = {}
    }
    var out = {}
    for (var k in DEFAULTS) out[k] = s[k] !== undefined && typeof s[k] === typeof DEFAULTS[k] ? s[k] : DEFAULTS[k]
    return out
  })()
  function saveSettings() {
    try {
      localStorage.setItem('latex-settings', JSON.stringify(settings))
    } catch (e) {
      /* 忽略 */
    }
  }

  var ENGINES = [
    { id: 'xelatex', name: 'XeLaTeX', zh: '支持中文和系统字体（推荐）', en: 'Unicode and system fonts (recommended)', cmd: 'xelatex -synctex=1 -interaction=nonstopmode -file-line-error "{file}"' },
    { id: 'pdflatex', name: 'pdfLaTeX', zh: '最常用的英文文档引擎', en: 'Classic engine for English documents', cmd: 'pdflatex -synctex=1 -interaction=nonstopmode -file-line-error "{file}"' },
    { id: 'lualatex', name: 'LuaLaTeX', zh: '支持 Lua 脚本', en: 'With Lua scripting', cmd: 'lualatex -synctex=1 -interaction=nonstopmode -file-line-error "{file}"' },
    { id: 'latexmk', name: 'latexmk · XeLaTeX', zh: '自动处理参考文献和多遍编译', en: 'Runs BibTeX and reruns as needed', cmd: 'latexmk -xelatex -synctex=1 -interaction=nonstopmode -file-line-error "{file}"' },
    { id: 'latexmk-pdf', name: 'latexmk · pdfLaTeX', zh: '自动处理参考文献和多遍编译', en: 'Runs BibTeX and reruns as needed', cmd: 'latexmk -pdf -synctex=1 -interaction=nonstopmode -file-line-error "{file}"' },
    { id: 'tectonic', name: 'Tectonic', zh: '单个程序，缺的宏包自动下载', en: 'Single binary, fetches packages', cmd: 'tectonic --synctex --keep-logs "{file}"' },
    { id: 'custom', name: '', zh: '自定义命令', en: 'Custom command', cmd: '' }
  ]
  function engineById(id) {
    for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i]
    return ENGINES[0]
  }
  function engineName(e) {
    return e.id === 'custom' ? T('自定义命令', 'Custom command') : e.name
  }

  /* ================= 文件状态 ================= */

  var text = ''
  var savedText = ''
  var sentText = null
  var eol = '\n'
  var bom = ''
  var absPath = '' // 系统路径
  var relPath = '/main.tex' // 插件路径（以 / 开头，相对工作区根目录）
  var fileName = 'main.tex'
  var wsRoot = '' // 工作区根目录的系统路径（/ 分隔）
  var loaded = false

  function dirname(p) {
    var i = p.lastIndexOf('/')
    return i <= 0 ? '/' : p.slice(0, i)
  }
  function basename(p) {
    return p.slice(p.lastIndexOf('/') + 1)
  }
  function stripExt(n) {
    return n.replace(/\.[^./]+$/, '')
  }
  function join(base, rel) {
    return TeX2HTML.joinPath(base, rel)
  }
  /** 从 base 目录到 p 的相对路径（都是插件路径） */
  function relative(base, p) {
    var a = base.split('/').filter(Boolean)
    var b = p.split('/').filter(Boolean)
    var i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    var up = []
    for (var k = i; k < a.length; k++) up.push('..')
    return up.concat(b.slice(i)).join('/')
  }
  /** synctex / 日志里的路径 → 插件路径 */
  function toPluginPath(p, dir) {
    if (!p) return null
    var n = TexTools.normPath(p)
    if (/^([A-Za-z]:)?\//.test(n) || /^[A-Za-z]:/.test(n)) {
      var r = wsRoot.toLowerCase()
      if (r && n.toLowerCase().indexOf(r + '/') === 0) return '/' + n.slice(r.length + 1)
      return null
    }
    return join(dir || '/', n)
  }

  /** 主文件（% !TEX root）和编译目录 */
  function rootInfo() {
    var mg = TexTools.magic(text)
    var root = mg.root ? join(dirname(relPath), mg.root) : relPath
    if (!/\.\w+$/.test(root)) root += '.tex'
    return { root: root, dir: dirname(root), base: stripExt(basename(root)), program: mg.program ? mg.program.toLowerCase() : null, isSelf: root === relPath }
  }

  /* ================= 小工具 ================= */

  function el(tag, attrs) {
    var e = document.createElement(tag)
    if (attrs)
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null || v === false) continue
        if (k === 'text') e.textContent = v
        else if (k === 'html') e.innerHTML = v
        else if (k === 'class') e.className = v
        else if (k === 'style') e.style.cssText = v
        else e.setAttribute(k, v === true ? '' : v)
      }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]
      if (c == null || c === false) continue
      e.append(c.nodeType ? c : String(c))
    }
    return e
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function debounce(fn, ms) {
    var t = 0
    var f = function () {
      clearTimeout(t)
      t = setTimeout(fn, typeof ms === 'function' ? ms() : ms)
    }
    f.cancel = function () {
      clearTimeout(t)
    }
    return f
  }
  function svg(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'
  }
  var ICON = {
    play: svg('<path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
    spin: svg('<path d="M12 3a9 9 0 1 0 9 9"/>'),
    caret: '<svg class="caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sect: svg('<path d="M5 6h14M5 12h10M5 18h6"/>'),
    list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    outline: svg('<path d="M4 6h10M4 12h16M8 18h12"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    exportI: svg('<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>'),
    text: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    minus: svg('<path d="M6 12h12"/>'),
    fit: svg('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>'),
    target: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    up: svg('<path d="M6 15l6-6 6 6"/>'),
    down: svg('<path d="M6 9l6 6 6-6"/>'),
    refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/>'),
    warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>')
  }

  /* ================= 源码高亮 ================= */

  var VERB_ENV = /^(verbatim\*?|Verbatim\*?|BVerbatim|lstlisting|minted|comment|filecontents\*?|spverbatim)$/
  var MATH_ENV = /^(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math|dmath|xalignat)\*?$/
  var TITLE_CMD = /^(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title|frametitle)\*?$/

  function hlLine(line, st) {
    var out = ''
    var i = 0
    var n = line.length
    if (st.verb) {
      var endTag = '\\end{' + st.verb + '}'
      var k = line.indexOf(endTag)
      if (k < 0) return '<span class="t-verb">' + esc(line) + '</span>'
      out += '<span class="t-verb">' + esc(line.slice(0, k)) + '</span>'
      st.verb = null
      i = k
    }
    var buf = ''
    var inMath = function () {
      return st.inline || !!st.display
    }
    var flush = function () {
      if (!buf) return
      if (inMath()) out += '<span class="t-math">' + esc(buf) + '</span>'
      else if (st.secAt && st.depth >= st.secAt) out += '<span class="t-sec">' + esc(buf) + '</span>'
      else out += esc(buf)
      buf = ''
    }
    while (i < n) {
      var ch = line[i]
      if (ch === '%') {
        flush()
        var rest = line.slice(i)
        out += '<span class="' + (/^%\s*!\s*TEX/i.test(rest) ? 't-magic' : 't-com') + '">' + esc(rest) + '</span>'
        i = n
        break
      }
      if (ch === '\\') {
        flush()
        var m = /^\\([A-Za-z@]+\*?|[\s\S]?)/.exec(line.slice(i))
        var name = m[1]
        var tok = m[0]
        if (name === 'begin' || name === 'end') {
          var em = /^\\(begin|end)(\s*)\{([^}]*)\}/.exec(line.slice(i))
          if (em) {
            out += '<span class="t-kw">\\' + em[1] + '</span>' + esc(em[2]) + '<span class="t-br">{</span><span class="t-env">' + esc(em[3]) + '</span><span class="t-br">}</span>'
            i += em[0].length
            var env = em[3].trim()
            if (em[1] === 'begin' && VERB_ENV.test(env)) {
              var restV = line.slice(i)
              var k2 = restV.indexOf('\\end{' + env + '}')
              if (k2 < 0) {
                out += '<span class="t-verb">' + esc(restV) + '</span>'
                st.verb = env
                return out
              }
              out += '<span class="t-verb">' + esc(restV.slice(0, k2)) + '</span>'
              i += k2
              continue
            }
            if (MATH_ENV.test(env)) st.display = em[1] === 'begin' ? env : null
            continue
          }
        }
        if (name === '[' || name === '(') {
          if (name === '[') st.display = st.display || '['
          else st.inline = true
          out += '<span class="t-math">' + esc(tok) + '</span>'
          i += tok.length
          continue
        }
        if (name === ']' || name === ')') {
          out += '<span class="t-math">' + esc(tok) + '</span>'
          if (name === ']') {
            if (st.display === '[') st.display = null
          } else st.inline = false
          i += tok.length
          continue
        }
        if (name === '\\' || name === '') {
          out += '<span class="t-sp">' + esc(tok) + '</span>'
          i += tok.length
          continue
        }
        if (inMath()) out += '<span class="t-math"><span class="t-cmd">' + esc(tok) + '</span></span>'
        else if (TITLE_CMD.test(name)) {
          out += '<span class="t-kw">' + esc(tok) + '</span>'
          st.secNext = true
        } else out += '<span class="t-cmd">' + esc(tok) + '</span>'
        i += tok.length
        continue
      }
      if (ch === '$') {
        flush()
        if (line[i + 1] === '$') {
          st.display = st.display === '$$' ? null : st.display || '$$'
          out += '<span class="t-math">$$</span>'
          i += 2
          continue
        }
        st.inline = !st.inline
        out += '<span class="t-math">$</span>'
        i++
        continue
      }
      if (ch === '{' || ch === '}') {
        flush()
        if (ch === '{') {
          st.depth++
          if (st.secNext) {
            st.secAt = st.depth
            st.secNext = false
          }
        }
        out += '<span class="t-br">' + ch + '</span>'
        if (ch === '}') {
          if (st.secAt === st.depth) st.secAt = 0
          st.depth = Math.max(0, st.depth - 1)
        }
        i++
        continue
      }
      if (ch === '&' || ch === '~' || ch === '#') {
        flush()
        out += '<span class="t-sp">' + esc(ch) + '</span>'
        i++
        continue
      }
      if (st.secNext) {
        if (ch === '[') st.secOpt = true
        else if (ch === ']') st.secOpt = false
        else if (!st.secOpt && !/[\s*]/.test(ch)) st.secNext = false
      }
      buf += ch
      i++
    }
    flush()
    if (!line.trim()) {
      st.inline = false
      st.secNext = false
    }
    return out
  }

  var lineEls = []
  var marks = {} // 行号 → 'err' | 'warn'
  function renderSource() {
    var lines = text.split('\n')
    var st = { verb: null, display: null, inline: false, depth: 0, secAt: 0, secNext: false, secOpt: false }
    var html = ''
    for (var i = 0; i < lines.length; i++) {
      var h = hlLine(lines[i], st)
      var mk = marks[i]
      html += '<div class="ln' + (mk ? ' ' + mk : '') + '" data-n="' + (i + 1) + '">' + (h || '<br>') + '</div>'
    }
    hlEl.innerHTML = html
    lineEls = hlEl.children
    curLine = -1
    markCurrentLine()
  }

  var curLine = -1
  function lineAt(pos) {
    var v = srcEl.value
    var n = 0
    for (var i = v.indexOf('\n'); i >= 0 && i < pos; i = v.indexOf('\n', i + 1)) n++
    return n
  }
  function caretLine() {
    return lineAt(srcEl.selectionStart)
  }
  function markCurrentLine() {
    if (settings.mode === 'preview') return
    var n = document.activeElement === srcEl ? caretLine() : -1
    if (n === curLine) return
    if (lineEls[curLine]) lineEls[curLine].classList.remove('cur')
    curLine = n
    if (lineEls[n]) lineEls[n].classList.add('cur')
  }
  function ensureCaretVisible() {
    var ln = lineEls[caretLine()]
    if (!ln) return
    var top = ln.offsetTop
    var bottom = top + ln.offsetHeight
    var vt = srcScroll.scrollTop
    var vh = srcScroll.clientHeight
    if (top < vt + 8) srcScroll.scrollTop = Math.max(0, top - 8)
    else if (bottom > vt + vh - 8) srcScroll.scrollTop = bottom - vh + 8
  }
  function lineStart(n) {
    var v = srcEl.value
    var p = 0
    for (var i = 0; i < n; i++) {
      var j = v.indexOf('\n', p)
      if (j < 0) return v.length
      p = j + 1
    }
    return p
  }
  /** 跳到某行（0 开始），选中行首，滚到视野上方三分之一处 */
  function jumpToLine(n, opts) {
    opts = opts || {}
    if (settings.mode === 'preview') setMode('split')
    n = Math.max(0, Math.min(n, (lineEls.length || 1) - 1))
    var a = lineStart(n)
    srcEl.focus({ preventScroll: true })
    srcEl.setSelectionRange(a, a)
    var ln = lineEls[n]
    if (ln) {
      var target = ln.offsetTop - srcScroll.clientHeight / 3
      lock.src = Date.now() + 200
      srcScroll.scrollTop = Math.max(0, target)
      ln.classList.remove('flash')
      void ln.offsetWidth
      ln.classList.add('flash')
    }
    markCurrentLine()
    updateCursorStatus()
    if (opts.syncView && settings.view === 'live') scrollLiveToLine(n, true)
  }

  /* ================= 编辑 ================= */

  var liveTime = 0
  var renderLiveSoon = debounce(function () {
    renderLive()
  }, function () {
    return liveTime > 80 ? 450 : 180
  })
  var countSoon = debounce(function () {
    updateWordCount()
    refreshOutlineCache()
  }, 600)

  function onTextChanged() {
    text = srcEl.value
    renderSource()
    if (settings.mode !== 'source' && settings.view === 'live') renderLiveSoon()
    studio.setDirty(text !== savedText)
    countSoon()
  }

  /** 用 insertText 改内容，保留撤销记录 */
  function replaceRange(a, b, s, selA, selB) {
    srcEl.focus()
    srcEl.setSelectionRange(a, b)
    if (!document.execCommand('insertText', false, s)) {
      srcEl.setRangeText(s, a, b, 'end')
      onTextChanged()
    }
    if (selA != null) srcEl.setSelectionRange(selA, selB == null ? selA : selB)
  }

  /** 把选中的文字包起来；已经包着时去掉 */
  function wrapSel(pre, post, placeholder) {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var b = srcEl.selectionEnd
    var sel = v.slice(a, b)
    if (v.slice(a - pre.length, a) === pre && v.slice(b, b + post.length) === post) {
      replaceRange(a - pre.length, b + post.length, sel, a - pre.length, b - pre.length)
      return
    }
    if (sel.length > pre.length + post.length && sel.indexOf(pre) === 0 && sel.slice(-post.length) === post) {
      var inner = sel.slice(pre.length, sel.length - post.length)
      replaceRange(a, b, inner, a, a + inner.length)
      return
    }
    var body = sel || placeholder || ''
    replaceRange(a, b, pre + body + post, a + pre.length, a + pre.length + body.length)
  }

  function lineRange() {
    var v = srcEl.value
    var a = v.lastIndexOf('\n', srcEl.selectionStart - 1) + 1
    var bi = srcEl.selectionEnd
    if (bi > srcEl.selectionStart && v[bi - 1] === '\n') bi--
    var b = v.indexOf('\n', bi)
    if (b < 0) b = v.length
    return [a, b]
  }

  /** 插入一段带 $ 光标标记的片段；多行片段按当前行缩进 */
  function insertSnippet(snip, from, to) {
    var v = srcEl.value
    var a = from == null ? srcEl.selectionStart : from
    var b = to == null ? srcEl.selectionEnd : to
    var sel = v.slice(srcEl.selectionStart, srcEl.selectionEnd)
    var ls = v.lastIndexOf('\n', a - 1) + 1
    var indent = /^[ \t]*/.exec(v.slice(ls, a))[0]
    var s = snip.replace(/\n/g, '\n' + indent)
    // 多行片段：前后有别的文字时各自换行
    if (snip.indexOf('\n') >= 0) {
      var le = v.indexOf('\n', b)
      if (v.slice(b, le < 0 ? v.length : le).trim()) s += '\n' + indent
      if (v.slice(ls, a).trim()) s = '\n' + indent + s
    }
    // 选中的文字放到第一个光标位置
    var caret = s.indexOf('$|')
    if (caret >= 0 && sel && from == null) s = s.slice(0, caret) + sel + s.slice(caret)
    var c = s.indexOf('$|')
    s = s.replace(/\$\|/g, '')
    replaceRange(a, b, s, a + (c >= 0 ? c + (sel && from == null ? sel.length : 0) : s.length))
    if (c >= 0 && sel && from == null) srcEl.setSelectionRange(a + c, a + c + sel.length)
  }

  function toggleComment() {
    var r = lineRange()
    var v = srcEl.value
    var lines = v.slice(r[0], r[1]).split('\n')
    var all = lines.every(function (l) {
      return !l.trim() || /^\s*%/.test(l)
    })
    var out = lines.map(function (l) {
      if (!l.trim()) return l
      if (all) return l.replace(/^(\s*)% ?/, '$1')
      return l.replace(/^(\s*)/, '$1% ')
    })
    var s = out.join('\n')
    replaceRange(r[0], r[1], s, r[0], r[0] + s.length)
  }

  function indentLines(outdent) {
    var r = lineRange()
    var v = srcEl.value
    var s = v
      .slice(r[0], r[1])
      .split('\n')
      .map(function (l) {
        return outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l
      })
      .join('\n')
    replaceRange(r[0], r[1], s, r[0], r[0] + s.length)
  }

  function envBalance(v, env) {
    var b = 0
    var re = /(^|[^\\])%[^\n]*|\\(begin|end)\s*\{([^}]*)\}/g
    var m
    while ((m = re.exec(v))) {
      if (!m[2] || m[3].trim() !== env) continue
      b += m[2] === 'begin' ? 1 : -1
    }
    return b
  }

  /** 回车：保持缩进；\item 续行；\begin{…} 后自动补 \end{…} */
  function smartEnter() {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var b = srcEl.selectionEnd
    var ls = v.lastIndexOf('\n', a - 1) + 1
    var before = v.slice(ls, a)
    var le = v.indexOf('\n', b)
    var after = v.slice(b, le < 0 ? v.length : le)
    var indent = /^[ \t]*/.exec(before)[0]
    var mi = /^([ \t]*)\\item\b(\s*)(.*)$/.exec(before)
    if (mi && a === b) {
      if (!mi[3].trim() && !after.trim()) {
        // 空的 \item：去掉它（结束列表）
        replaceRange(ls, a, indent.replace(/( {2}|\t)$/, ''))
        return true
      }
      replaceRange(a, b, '\n' + indent + '\\item ')
      return true
    }
    var mb = /\\begin\{([^}]+)\}(\s*(\[[^\]]*\]|\{[^}]*\}))*\s*$/.exec(before)
    if (mb && a === b && !after.trim()) {
      var env = mb[1].trim()
      var inner = indent + '  '
      var item = /^(itemize|enumerate|description|compactitem|compactenum)$/.test(env) ? '\\item ' : ''
      if (envBalance(v, env) > 0) {
        var s = '\n' + inner + item + '\n' + indent + '\\end{' + env + '}'
        replaceRange(a, b, s, a + 1 + inner.length + item.length)
      } else replaceRange(a, b, '\n' + inner + item)
      return true
    }
    // 光标在 {} 中间：拆成三行
    if (a === b && v[a - 1] === '{' && v[a] === '}') {
      replaceRange(a, b, '\n' + indent + '  \n' + indent, a + 1 + indent.length + 2)
      return true
    }
    replaceRange(a, b, '\n' + indent)
    return true
  }

  srcEl.addEventListener('input', function () {
    onTextChanged()
    ensureCaretVisible()
    if (settings.complete && !acSuppress) updateCompletion(false)
    acSuppress = false
  })

  var PAIRS = { '{': '}', '[': ']', $: '$' }
  srcEl.addEventListener('keydown', function (e) {
    if (e.isComposing) return
    if (!acEl.hidden && acKey(e)) return
    var mod = e.ctrlKey || e.metaKey
    var k = e.key
    var lk = k.length === 1 ? k.toLowerCase() : k
    var act = null
    if (mod && !e.altKey) {
      if (lk === 'b' && !e.shiftKey) act = function () { wrapSel('\\textbf{', '}', '') }
      else if (lk === 'i' && !e.shiftKey) act = function () { wrapSel('\\textit{', '}', '') }
      else if (lk === 'u' && !e.shiftKey) act = function () { wrapSel('\\underline{', '}', '') }
      else if (lk === 'm' && !e.shiftKey) act = function () { wrapSel('$', '$', '') }
      else if (lk === 'm' && e.shiftKey) act = function () { insertSnippet('\\[\n  $|\n\\]') }
      else if (lk === 'e' && !e.shiftKey) act = function () { wrapSel('\\emph{', '}', '') }
      else if (k === '/' || e.code === 'Slash') act = toggleComment
      else if (k === ']') act = function () { indentLines(false) }
      else if (k === '[') act = function () { indentLines(true) }
      else if (k === ' ' || e.code === 'Space') act = function () { updateCompletion(true) }
      else if (k === 'Enter') act = compile
      else if (lk === 'f' && !e.shiftKey) act = function () { openFind(false) }
      else if (lk === 'h' && !e.shiftKey) act = function () { openFind(true) }
    } else if (mod && e.altKey && (lk === 'j' || e.code === 'KeyJ')) act = syncToPdf
    else if (!mod && !e.altKey) {
      var v = srcEl.value
      var a = srcEl.selectionStart
      var b = srcEl.selectionEnd
      if (k === 'Tab') act = function () {
        if (a !== b && v.slice(a, b).indexOf('\n') >= 0) indentLines(e.shiftKey)
        else if (e.shiftKey) indentLines(true)
        else replaceRange(a, b, '  ')
      }
      else if (k === 'Enter' && !e.shiftKey) act = smartEnter
      else if (settings.autoClose && PAIRS[k] && v[a - 1] !== '\\') {
        if (a !== b) act = function () { wrapSel(k, PAIRS[k], '') }
        else if (k === '$' && v[a] === '$') act = function () { srcEl.setSelectionRange(a + 1, a + 1) }
        else if (k !== '$' || !/[\w\\]/.test(v[a] || '')) act = function () { replaceRange(a, b, k + PAIRS[k], a + 1) }
      } else if (settings.autoClose && (k === '}' || k === ']') && a === b && v[a] === k && v[a - 1] !== '\\') {
        act = function () { srcEl.setSelectionRange(a + 1, a + 1) }
      } else if (settings.autoClose && k === 'Backspace' && a === b && a > 0 && PAIRS[v[a - 1]] === v[a] && v[a - 2] !== '\\') {
        act = function () { replaceRange(a - 1, a + 1, '') }
      }
    }
    if (act) {
      e.preventDefault()
      e.stopPropagation()
      act()
    }
  })
  ;['keyup', 'mouseup', 'focus', 'blur', 'select'].forEach(function (ev) {
    srcEl.addEventListener(ev, function () {
      markCurrentLine()
      updateCursorStatus()
    })
  })
  srcEl.addEventListener('blur', function () {
    setTimeout(function () {
      if (document.activeElement !== srcEl && !acEl.matches(':hover')) closeCompletion()
    }, 120)
  })
  srcEl.addEventListener('mousedown', function () {
    closeCompletion()
  })
  document.addEventListener('selectionchange', function () {
    if (document.activeElement === srcEl) {
      markCurrentLine()
      updateCursorStatus()
    }
  })

  /* ================= 补全 ================= */

  // $| 是光标位置
  var CMD_LIST = [
    ['section{$|}', '节', 'Section'], ['subsection{$|}', '小节', 'Subsection'], ['subsubsection{$|}', '小小节', 'Subsubsection'], ['chapter{$|}', '章', 'Chapter'], ['paragraph{$|}', '段落标题', 'Paragraph'], ['part{$|}', '部分', 'Part'],
    ['textbf{$|}', '粗体', 'Bold'], ['textit{$|}', '斜体', 'Italic'], ['emph{$|}', '强调', 'Emphasis'], ['underline{$|}', '下划线', 'Underline'], ['texttt{$|}', '等宽', 'Monospace'], ['textsc{$|}', '小型大写', 'Small caps'], ['textsf{$|}', '无衬线', 'Sans serif'], ['textcolor{$|}{}', '文字颜色', 'Text color'], ['colorbox{$|}{}', '背景色', 'Background'],
    ['label{$|}', '标签', 'Label'], ['ref{$|}', '引用编号', 'Reference'], ['eqref{$|}', '引用公式', 'Equation ref'], ['autoref{$|}', '带名称的引用', 'Named ref'], ['pageref{$|}', '引用页码', 'Page ref'], ['cite{$|}', '引用文献', 'Citation'], ['footnote{$|}', '脚注', 'Footnote'],
    ['url{$|}', '网址', 'URL'], ['href{$|}{}', '链接', 'Link'], ['includegraphics[width=0.8\\linewidth]{$|}', '插入图片', 'Image'], ['caption{$|}', '图表标题', 'Caption'], ['centering', '居中', 'Center'], ['item ', '列表项', 'List item'],
    ['begin{$|}', '环境', 'Environment'], ['usepackage{$|}', '宏包', 'Package'], ['documentclass{$|}', '文档类', 'Class'], ['newcommand{\\$|}{}', '定义命令', 'New command'], ['renewcommand{\\$|}{}', '重定义命令', 'Redefine'], ['input{$|}', '插入文件', 'Input file'], ['include{$|}', '包含章节文件', 'Include'],
    ['title{$|}', '标题', 'Title'], ['author{$|}', '作者', 'Author'], ['date{$|}', '日期', 'Date'], ['maketitle', '生成标题', 'Make title'], ['tableofcontents', '目录', 'Contents'], ['today', '今天', 'Today'], ['appendix', '附录', 'Appendix'],
    ['noindent', '不缩进', 'No indent'], ['newpage', '换页', 'New page'], ['clearpage', '清页', 'Clear page'], ['vspace{$|}', '垂直空白', 'Vertical space'], ['hspace{$|}', '水平空白', 'Horizontal space'], ['hfill', '填充', 'Fill'], ['bigskip', '大间距', 'Big skip'], ['medskip', '中间距', 'Medium skip'], ['smallskip', '小间距', 'Small skip'], ['linebreak', '断行', 'Line break'],
    ['bibliography{$|}', '参考文献文件', 'Bibliography'], ['bibliographystyle{$|}', '文献样式', 'Bib style'], ['addbibresource{$|}', '参考文献（biblatex）', 'Bib resource'], ['printbibliography', '列出参考文献', 'Print bibliography'], ['bibitem{$|}', '文献条目', 'Bib item'],
    ['LaTeX', '', ''], ['TeX', '', ''], ['ldots', '…', ''], ['dots', '…', ''], ['quad', '空格', 'Space'], ['qquad', '两个空格', 'Double space'],
    ['frac{$|}{}', '分数', 'Fraction'], ['dfrac{$|}{}', '显示分数', 'Display fraction'], ['tfrac{$|}{}', '小分数', 'Text fraction'], ['sqrt{$|}', '根号', 'Square root'], ['sqrt[$|]{}', 'n 次根号', 'n-th root'], ['sum_{$|}^{}', '求和', 'Sum'], ['prod_{$|}^{}', '连乘', 'Product'], ['int_{$|}^{}', '积分', 'Integral'], ['iint', '二重积分', 'Double integral'], ['oint', '环路积分', 'Contour integral'], ['lim_{$|}', '极限', 'Limit'],
    ['infty', '∞', ''], ['partial', '∂', ''], ['nabla', '∇', ''], ['cdot', '·', ''], ['cdots', '⋯', ''], ['vdots', '⋮', ''], ['ddots', '⋱', ''], ['times', '×', ''], ['div', '÷', ''], ['pm', '±', ''], ['mp', '∓', ''], ['leq', '≤', ''], ['geq', '≥', ''], ['neq', '≠', ''], ['approx', '≈', ''], ['equiv', '≡', ''], ['sim', '∼', ''], ['propto', '∝', ''], ['ll', '≪', ''], ['gg', '≫', ''],
    ['in', '∈', ''], ['notin', '∉', ''], ['subset', '⊂', ''], ['subseteq', '⊆', ''], ['supset', '⊃', ''], ['cup', '∪', ''], ['cap', '∩', ''], ['emptyset', '∅', ''], ['forall', '∀', ''], ['exists', '∃', ''], ['neg', '¬', ''], ['land', '∧', ''], ['lor', '∨', ''],
    ['to', '→', ''], ['rightarrow', '→', ''], ['leftarrow', '←', ''], ['Rightarrow', '⇒', ''], ['Leftarrow', '⇐', ''], ['Leftrightarrow', '⇔', ''], ['iff', '⟺', ''], ['implies', '⟹', ''], ['mapsto', '↦', ''], ['uparrow', '↑', ''], ['downarrow', '↓', ''],
    ['alpha', 'α', ''], ['beta', 'β', ''], ['gamma', 'γ', ''], ['Gamma', 'Γ', ''], ['delta', 'δ', ''], ['Delta', 'Δ', ''], ['epsilon', 'ϵ', ''], ['varepsilon', 'ε', ''], ['zeta', 'ζ', ''], ['eta', 'η', ''], ['theta', 'θ', ''], ['Theta', 'Θ', ''], ['vartheta', 'ϑ', ''], ['iota', 'ι', ''], ['kappa', 'κ', ''], ['lambda', 'λ', ''], ['Lambda', 'Λ', ''], ['mu', 'μ', ''], ['nu', 'ν', ''], ['xi', 'ξ', ''], ['Xi', 'Ξ', ''], ['pi', 'π', ''], ['Pi', 'Π', ''], ['rho', 'ρ', ''], ['varrho', 'ϱ', ''], ['sigma', 'σ', ''], ['Sigma', 'Σ', ''], ['tau', 'τ', ''], ['upsilon', 'υ', ''], ['phi', 'ϕ', ''], ['varphi', 'φ', ''], ['Phi', 'Φ', ''], ['chi', 'χ', ''], ['psi', 'ψ', ''], ['Psi', 'Ψ', ''], ['omega', 'ω', ''], ['Omega', 'Ω', ''],
    ['mathbb{$|}', '黑板粗体 ℝ', 'Blackboard ℝ'], ['mathcal{$|}', '花体 𝒜', 'Calligraphic'], ['mathbf{$|}', '粗体', 'Bold'], ['mathrm{$|}', '正体', 'Roman'], ['mathit{$|}', '斜体', 'Italic'], ['mathscr{$|}', '手写体', 'Script'], ['mathfrak{$|}', '哥特体', 'Fraktur'], ['boldsymbol{$|}', '粗体符号', 'Bold symbol'], ['operatorname{$|}', '算子名', 'Operator'], ['text{$|}', '公式里的文字', 'Text in math'],
    ['left( $| \\right)', '自动大小括号', 'Auto-size ()'], ['left[ $| \\right]', '自动大小方括号', 'Auto-size []'], ['left\\{ $| \\right\\}', '自动大小花括号', 'Auto-size {}'], ['left| $| \\right|', '绝对值', 'Absolute value'], ['langle $| \\rangle', '尖括号', 'Angle brackets'],
    ['hat{$|}', 'â', ''], ['bar{$|}', 'ā', ''], ['vec{$|}', '向量', 'Vector'], ['tilde{$|}', 'ã', ''], ['dot{$|}', 'ȧ', ''], ['ddot{$|}', 'ä', ''], ['overline{$|}', '上划线', 'Overline'], ['underline{$|}', '下划线', 'Underline'], ['overbrace{$|}^{}', '上括号', 'Overbrace'], ['underbrace{$|}_{}', '下括号', 'Underbrace'], ['binom{$|}{}', '组合数', 'Binomial'],
    ['sin', '', ''], ['cos', '', ''], ['tan', '', ''], ['log', '', ''], ['ln', '', ''], ['exp', '', ''], ['max', '', ''], ['min', '', ''], ['sup', '', ''], ['inf', '', ''], ['det', '', ''], ['arg', '', ''],
    ['tag{$|}', '公式编号', 'Equation tag'], ['nonumber', '不编号', 'No number'], ['displaystyle', '显示样式', 'Display style'], ['mathrm{d}', '微分 d', 'Differential d']
  ]
  var ENV_LIST = [
    ['equation', '编号公式', 'Numbered equation'], ['equation*', '不编号公式', 'Unnumbered equation'], ['align', '多行对齐公式', 'Aligned equations'], ['align*', '多行对齐（不编号）', 'Aligned (no numbers)'], ['gather', '多行居中公式', 'Gathered equations'], ['multline', '长公式折行', 'Multi-line equation'], ['cases', '分段函数', 'Cases'],
    ['itemize', '无序列表', 'Bulleted list'], ['enumerate', '编号列表', 'Numbered list'], ['description', '描述列表', 'Description list'],
    ['figure', '图', 'Figure'], ['table', '表', 'Table'], ['tabular', '表格内容', 'Tabular'], ['subfigure', '子图', 'Subfigure'], ['minipage', '小页', 'Minipage'],
    ['center', '居中', 'Center'], ['flushleft', '左对齐', 'Flush left'], ['flushright', '右对齐', 'Flush right'], ['quote', '引用', 'Quote'], ['quotation', '长引用', 'Quotation'], ['abstract', '摘要', 'Abstract'],
    ['theorem', '定理', 'Theorem'], ['lemma', '引理', 'Lemma'], ['definition', '定义', 'Definition'], ['proof', '证明', 'Proof'], ['corollary', '推论', 'Corollary'], ['proposition', '命题', 'Proposition'], ['remark', '注', 'Remark'], ['example', '例', 'Example'],
    ['matrix', '矩阵', 'Matrix'], ['pmatrix', '圆括号矩阵', '(matrix)'], ['bmatrix', '方括号矩阵', '[matrix]'], ['vmatrix', '行列式', 'Determinant'], ['array', '阵列', 'Array'], ['aligned', '对齐块', 'Aligned block'], ['split', '拆分公式', 'Split'],
    ['verbatim', '原样文本', 'Verbatim'], ['lstlisting', '代码', 'Code listing'], ['minted', '高亮代码', 'Minted code'], ['document', '正文', 'Document'], ['thebibliography', '参考文献列表', 'Bibliography'], ['frame', '幻灯片', 'Slide (beamer)'], ['block', '块（beamer）', 'Block (beamer)'], ['columns', '分栏（beamer）', 'Columns (beamer)'], ['tikzpicture', 'TikZ 绘图', 'TikZ drawing'], ['multicols', '多栏', 'Multiple columns']
  ]
  var ENV_SNIPPET = {
    figure: '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{$|}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}',
    table: '\\begin{table}[htbp]\n  \\centering\n  \\caption{$|}\n  \\label{tab:}\n  \\begin{tabular}{ccc}\n    \\hline\n    A & B & C \\\\\n    \\hline\n    1 & 2 & 3 \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}',
    tabular: '\\begin{tabular}{$|ccc}\n  \\hline\n  A & B & C \\\\\n  \\hline\n\\end{tabular}',
    itemize: '\\begin{itemize}\n  \\item $|\n\\end{itemize}',
    enumerate: '\\begin{enumerate}\n  \\item $|\n\\end{enumerate}',
    description: '\\begin{description}\n  \\item[$|] \n\\end{description}',
    subfigure: '\\begin{subfigure}{0.48\\linewidth}\n  \\centering\n  \\includegraphics[width=\\linewidth]{$|}\n  \\caption{}\n\\end{subfigure}',
    minipage: '\\begin{minipage}{0.48\\linewidth}\n  $|\n\\end{minipage}',
    cases: '\\begin{cases}\n  $| & \\text{if } \\\\\n   & \\text{otherwise}\n\\end{cases}',
    array: '\\begin{array}{$|cc}\n  \n\\end{array}',
    lstlisting: '\\begin{lstlisting}[language=Python]\n$|\n\\end{lstlisting}',
    minted: '\\begin{minted}{python}\n$|\n\\end{minted}',
    frame: '\\begin{frame}{$|}\n  \n\\end{frame}',
    block: '\\begin{block}{$|}\n  \n\\end{block}',
    columns: '\\begin{columns}\n  \\begin{column}{0.5\\textwidth}\n    $|\n  \\end{column}\n  \\begin{column}{0.5\\textwidth}\n  \\end{column}\n\\end{columns}',
    multicols: '\\begin{multicols}{2}\n  $|\n\\end{multicols}',
    thebibliography: '\\begin{thebibliography}{99}\n  \\bibitem{$|} \n\\end{thebibliography}',
    theorem: '\\begin{theorem}\n  $|\n\\end{theorem}',
    proof: '\\begin{proof}\n  $|\n\\end{proof}'
  }

  var ac = { items: [], idx: 0, from: 0, to: 0, kind: '' }
  var acSuppress = false
  var fileList = null
  var fileListAt = 0

  function textBefore() {
    var v = srcEl.value
    var pos = srcEl.selectionStart
    var ls = v.lastIndexOf('\n', pos - 1) + 1
    return { v: v, pos: pos, before: v.slice(ls, pos) }
  }
  function inComment(before) {
    return /(^|[^\\])(\\\\)*%/.test(before)
  }

  function labelsNow() {
    var set = {}
    var re = /\\label\s*\{([^}]+)\}/g
    var m
    while ((m = re.exec(text))) set[m[1].trim()] = 1
    if (lastRender) lastRender.labels.forEach(function (l) { set[l] = 1 })
    return Object.keys(set)
  }
  function bibKeysNow() {
    var set = {}
    var re = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
    var m
    while ((m = re.exec(text))) set[m[1].trim()] = 1
    if (lastRender) lastRender.bibKeys.forEach(function (k) { set[k] = 1 })
    return Object.keys(set)
  }
  function userMacros() {
    var out = []
    var re = /\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([A-Za-z@]+)\}?(?:\s*\[(\d)\])?/g
    var m
    while ((m = re.exec(text))) out.push([m[1] + (m[2] && +m[2] > 0 ? '{$|}' + new Array(+m[2]).join('{}') : ''), T('自定义', 'custom'), T('自定义', 'custom')])
    return out
  }
  function envsNow() {
    var set = {}
    var re = /\\(?:newenvironment|newtheorem)\*?\s*\{([^}]+)\}/g
    var m
    var out = ENV_LIST.slice()
    while ((m = re.exec(text))) if (!set[m[1]]) {
      set[m[1]] = 1
      out.push([m[1], T('自定义', 'custom'), 'custom'])
    }
    return out
  }

  function getFiles() {
    if (fileList && Date.now() - fileListAt < 15000) return Promise.resolve(fileList)
    if (!studio.has('fs.files')) return Promise.resolve([])
    return studio.fs
      .files()
      .then(function (list) {
        fileList = list || []
        fileListAt = Date.now()
        return fileList
      })
      .catch(function () {
        return []
      })
  }

  function updateCompletion(force) {
    if (srcEl.selectionStart !== srcEl.selectionEnd) return closeCompletion()
    var c = textBefore()
    var before = c.before
    if (inComment(before)) return closeCompletion()
    var m
    var items = []
    var prefix = ''
    var kind = ''
    var from = c.pos
    if ((m = /\\(?:[a-zA-Z]*ref|cref|Cref|autoref|nameref|vref)\*?\{([^{}]*)$/.exec(before))) {
      kind = 'label'
      prefix = m[1].split(',').pop().replace(/^\s+/, '')
      from = c.pos - prefix.length
      items = labelsNow().map(function (l) {
        return { label: l, insert: l, hint: '', k: 'L' }
      })
    } else if ((m = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/.exec(before))) {
      kind = 'cite'
      prefix = m[1].split(',').pop().replace(/^\s+/, '')
      from = c.pos - prefix.length
      items = bibKeysNow().map(function (l) {
        return { label: l, insert: l, hint: '', k: 'B' }
      })
    } else if ((m = /\\(begin|end)\{([^{}]*)$/.exec(before))) {
      kind = m[1] === 'begin' ? 'begin' : 'end'
      prefix = m[2]
      from = c.pos - prefix.length
      items = envsNow().map(function (x) {
        return { label: x[0], insert: x[0], hint: T(x[1], x[2]), k: 'E' }
      })
    } else if ((m = /\\(includegraphics(?:\[[^\]]*\])?|input|include|subfile|bibliography|addbibresource|lstinputlisting(?:\[[^\]]*\])?)\{([^{}]*)$/.exec(before))) {
      kind = 'file'
      var cmd = m[1].replace(/\[.*$/, '')
      prefix = m[2].split(',').pop().replace(/^\s+/, '')
      from = c.pos - prefix.length
      var exts = cmd === 'includegraphics' ? /\.(png|jpe?g|pdf|eps|svg|gif|webp)$/i : cmd === 'bibliography' || cmd === 'addbibresource' ? /\.bib$/i : cmd === 'lstinputlisting' ? /./ : /\.tex$/i
      var dir = rootInfo().dir
      var reqFrom = from
      getFiles().then(function (list) {
        var t = textBefore()
        if (t.pos < reqFrom) return
        var its = list
          .filter(function (p) {
            return exts.test(p) && p !== relPath
          })
          .map(function (p) {
            var r = relative(dir, p)
            if (cmd === 'input' || cmd === 'include' || cmd === 'subfile' || cmd === 'bibliography') r = r.replace(/\.(tex|bib)$/i, '')
            return { label: r, insert: r, hint: '', k: 'F' }
          })
        showCompletion(filterItems(its, t.v.slice(reqFrom, t.pos)), reqFrom, 'file')
      })
      return
    } else if ((m = /(^|[^\\])\\([A-Za-z]*)$/.exec(before))) {
      kind = 'cmd'
      prefix = m[2]
      if (!prefix && !force) return closeCompletion()
      from = c.pos - prefix.length - 1
      var seen = {}
      items = userMacros()
        .concat(CMD_LIST)
        .filter(function (x) {
          var name = x[0].replace(/[{[(\s$|].*$/, '')
          if (seen[x[0]]) return false
          seen[x[0]] = 1
          return name.length > 0
        })
        .map(function (x) {
          var name = x[0].replace(/[{[(\s$|].*$/, '')
          return { label: '\\' + name, sort: name, insert: '\\' + x[0], hint: T(x[1], x[2] || x[1]), k: '\\' }
        })
    } else return closeCompletion()
    var list = filterItems(items, kind === 'cmd' ? prefix : prefix, kind === 'cmd')
    if (!list.length) return closeCompletion()
    // 唯一完全匹配的命令不弹出（已经打完了）
    if (kind === 'cmd' && !force && list.length === 1 && list[0].sort === prefix && list[0].insert === '\\' + prefix) return closeCompletion()
    showCompletion(list, from, kind)
  }

  function filterItems(items, prefix, isCmd) {
    var p = prefix.toLowerCase()
    var a = []
    var b = []
    for (var i = 0; i < items.length; i++) {
      var key = (isCmd ? items[i].sort : items[i].label).toLowerCase()
      if (!p || key.indexOf(p) === 0) a.push(items[i])
      else if (p.length > 1 && key.indexOf(p) > 0) b.push(items[i])
    }
    a.sort(function (x, y) {
      var kx = isCmd ? x.sort : x.label
      var ky = isCmd ? y.sort : y.label
      // 大小写完全对上的排前面，短的排前面
      var cx = kx.indexOf(prefix) === 0 ? 0 : 1
      var cy = ky.indexOf(prefix) === 0 ? 0 : 1
      return cx - cy || kx.length - ky.length || (kx < ky ? -1 : 1)
    })
    return a.concat(b).slice(0, 80)
  }

  function showCompletion(list, from, kind) {
    if (!list.length) return closeCompletion()
    ac.items = list
    ac.idx = 0
    ac.from = from
    ac.kind = kind
    acEl.replaceChildren()
    list.forEach(function (it, i) {
      var row = el('div', { class: 'it' + (i === 0 ? ' on' : ''), role: 'option' }, el('span', { class: 'k', text: it.k }), el('span', { text: it.label }), it.hint ? el('span', { class: 'h', text: it.hint }) : null)
      row.addEventListener('mousedown', function (e) {
        e.preventDefault()
        ac.idx = i
        acceptCompletion()
      })
      acEl.append(row)
    })
    acEl.hidden = false
    positionCompletion()
  }
  function positionCompletion() {
    var r = caretRect()
    if (!r) return closeCompletion()
    var vr = srcScroll.getBoundingClientRect()
    // 光标滚出编辑区时收起
    if (r.bottom < vr.top || r.top > vr.bottom) return closeCompletion()
    var h = acEl.offsetHeight
    var w = acEl.offsetWidth
    var top = r.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
    acEl.style.top = top + 'px'
    acEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 18)) + 'px'
  }
  function closeCompletion() {
    acEl.hidden = true
    ac.items = []
  }
  function acKey(e) {
    var k = e.key
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      ac.idx = (ac.idx + (k === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length
      Array.prototype.forEach.call(acEl.children, function (c, i) {
        c.classList.toggle('on', i === ac.idx)
      })
      var cur = acEl.children[ac.idx]
      if (cur) cur.scrollIntoView({ block: 'nearest' })
      e.preventDefault()
      return true
    }
    if (k === 'Enter' || k === 'Tab') {
      e.preventDefault()
      acceptCompletion()
      return true
    }
    if (k === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeCompletion()
      return true
    }
    return false
  }
  function acceptCompletion() {
    var it = ac.items[ac.idx]
    if (!it) return closeCompletion()
    var v = srcEl.value
    var pos = srcEl.selectionStart
    var kind = ac.kind
    closeCompletion()
    acSuppress = true
    if (kind === 'cmd') {
      // 在已有命令名中间补全（\tex|tbf）时替换整个命令名；后面是普通文字时不动它
      var end = pos
      var tail = /^[A-Za-z]*/.exec(v.slice(pos))[0]
      var whole = v.slice(ac.from + 1, pos) + tail
      if (tail && CMD_LIST.some(function (x) { return x[0].replace(/[{[(\s$|].*$/, '') === whole })) end = pos + tail.length
      if (it.insert === '\\begin{$|}') {
        replaceRange(ac.from, end, '\\begin{', ac.from + 7)
        acSuppress = false
        updateCompletion(true)
        return
      }
      insertSnippet(it.insert.indexOf('$|') >= 0 ? it.insert : it.insert + '$|', ac.from, end)
      return
    }
    if (kind === 'begin') {
      var env = it.insert
      var bs = v.lastIndexOf('\\begin{', pos)
      var closeAt = v[pos] === '}' ? pos + 1 : pos
      var vWithout = v.slice(0, bs) + v.slice(closeAt)
      if (envBalance(vWithout, env) >= 0 && ENV_SNIPPET[env]) {
        insertSnippet(ENV_SNIPPET[env], bs, closeAt)
        return
      }
      if (envBalance(vWithout, env) >= 0) {
        var item = /^(itemize|enumerate|description)$/.test(env) ? '\\item ' : ''
        insertSnippet('\\begin{' + env + '}\n  ' + item + '$|\n\\end{' + env + '}', bs, closeAt)
        return
      }
      replaceRange(ac.from, closeAt, env + '}')
      return
    }
    // 标签、文献、文件、\end：补全名称并跳过已有的 }
    var e2 = pos
    while (e2 < v.length && /[^},\s]/.test(v[e2])) e2++
    var hasClose = v[e2] === '}'
    replaceRange(ac.from, e2, it.insert + (hasClose ? '' : '}'), ac.from + it.insert.length + 1)
  }

  /** 光标在屏幕上的位置：在高亮层对应的行里找到同一列 */
  function caretRect() {
    var pos = srcEl.selectionStart
    var n = caretLine()
    var lineEl = lineEls[n]
    if (!lineEl) return null
    var col = pos - lineStart(n)
    var walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
    var node = null
    var remain = col
    var cur
    while ((cur = walker.nextNode())) {
      node = cur
      if (remain <= cur.length) break
      remain -= cur.length
    }
    var r = document.createRange()
    if (node) {
      var off = Math.min(remain, node.length)
      r.setStart(node, off)
      r.setEnd(node, off)
    } else {
      r.selectNodeContents(lineEl)
      r.collapse(true)
    }
    var rects = r.getClientRects()
    var rect = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect()
    if (!rect || (!rect.height && !rect.width)) {
      var lr = lineEl.getBoundingClientRect()
      return { left: lr.left, top: lr.top, bottom: lr.bottom }
    }
    return rect
  }
  acEl.addEventListener('mousedown', function (e) {
    e.preventDefault()
  })

  /* ================= 查找替换 ================= */

  var find = null
  function buildFind() {
    var q = el('input', { type: 'text', placeholder: T('查找', 'Find'), 'aria-label': T('查找', 'Find'), spellcheck: 'false' })
    var r = el('input', { type: 'text', placeholder: T('替换为', 'Replace with'), 'aria-label': T('替换为', 'Replace with'), spellcheck: 'false' })
    var cnt = el('span', { class: 'cnt' })
    var caseBtn = el('button', { type: 'button', class: 'tb', title: T('区分大小写', 'Match case'), text: 'Aa' })
    var btn = function (icon, title, fn) {
      var b = el('button', { type: 'button', class: 'tb', title: title, 'aria-label': title, html: icon })
      b.addEventListener('click', fn)
      return b
    }
    var row2 = el('div', { class: 'frow' }, r, btn(T('替换', 'Rep'), T('替换', 'Replace'), function () { replaceOne() }), btn(T('全部', 'All'), T('全部替换', 'Replace all'), replaceAll))
    findBar.replaceChildren(
      el('div', { class: 'frow' }, q, cnt, caseBtn, btn(ICON.up, T('上一个', 'Previous') + ' (Shift+Enter)', function () { findNext(-1) }), btn(ICON.down, T('下一个', 'Next') + ' (Enter)', function () { findNext(1) }), btn(ICON.close, T('关闭', 'Close') + ' (Esc)', closeFind)),
      row2
    )
    caseBtn.addEventListener('click', function () {
      find.matchCase = !find.matchCase
      caseBtn.classList.toggle('on', find.matchCase)
      updateFindCount()
    })
    q.addEventListener('input', function () {
      updateFindCount()
      var c = textBefore()
      findFrom(c.pos - (srcEl.selectionEnd - srcEl.selectionStart), 1, true)
    })
    var keys = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.target === r) {
          if (e.ctrlKey || e.metaKey) replaceAll()
          else replaceOne()
        } else findNext(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeFind()
      }
    }
    q.addEventListener('keydown', keys)
    r.addEventListener('keydown', keys)
    find = { q: q, r: r, cnt: cnt, row2: row2, matchCase: false }
  }
  function openFind(replace) {
    if (!find) buildFind()
    findBar.hidden = false
    find.row2.hidden = !replace
    var sel = srcEl.value.slice(srcEl.selectionStart, srcEl.selectionEnd)
    if (sel && sel.indexOf('\n') < 0) find.q.value = sel
    ;(replace && find.q.value ? find.r : find.q).focus()
    find.q.select()
    updateFindCount()
  }
  function closeFind() {
    findBar.hidden = true
    srcEl.focus()
  }
  function norm(s) {
    return find.matchCase ? s : s.toLowerCase()
  }
  function allMatches() {
    var q = find.q.value
    if (!q) return []
    var v = norm(srcEl.value)
    var nq = norm(q)
    var out = []
    for (var i = v.indexOf(nq); i >= 0 && out.length < 10000; i = v.indexOf(nq, i + nq.length)) out.push(i)
    return out
  }
  function updateFindCount() {
    var all = allMatches()
    var a = srcEl.selectionStart
    var idx = all.indexOf(a)
    find.cnt.textContent = find.q.value ? (idx >= 0 ? idx + 1 + '/' : '') + all.length : ''
  }
  function findFrom(from, dir, keepFocus) {
    var all = allMatches()
    if (!all.length) {
      updateFindCount()
      return
    }
    var hit
    if (dir > 0) {
      hit = all.find(function (i) { return i >= from })
      if (hit == null) hit = all[0]
    } else {
      for (var k = all.length - 1; k >= 0; k--) if (all[k] < from) {
        hit = all[k]
        break
      }
      if (hit == null) hit = all[all.length - 1]
    }
    var active = document.activeElement
    srcEl.setSelectionRange(hit, hit + find.q.value.length)
    var n = lineAt(hit)
    var ln = lineEls[n]
    if (ln) {
      var vt = srcScroll.scrollTop
      if (ln.offsetTop < vt + 40 || ln.offsetTop > vt + srcScroll.clientHeight - 60) srcScroll.scrollTop = Math.max(0, ln.offsetTop - srcScroll.clientHeight / 3)
      ln.classList.remove('flash')
      void ln.offsetWidth
      ln.classList.add('flash')
    }
    if (keepFocus || active !== srcEl) active && active.focus && active.focus()
    updateFindCount()
  }
  function findNext(dir) {
    findFrom(dir > 0 ? srcEl.selectionEnd : srcEl.selectionStart, dir, true)
  }
  function replaceOne() {
    var q = find.q.value
    if (!q) return
    var a = srcEl.selectionStart
    var sel = srcEl.value.slice(a, srcEl.selectionEnd)
    if (norm(sel) === norm(q)) {
      var active = document.activeElement
      replaceRange(a, srcEl.selectionEnd, find.r.value, a + find.r.value.length)
      active.focus()
    }
    findNext(1)
  }
  function replaceAll() {
    var all = allMatches()
    if (!all.length) return
    var q = find.q.value
    var v = srcEl.value
    var out = ''
    var last = 0
    all.forEach(function (i) {
      out += v.slice(last, i) + find.r.value
      last = i + q.length
    })
    out += v.slice(last)
    var active = document.activeElement
    replaceRange(0, v.length, out, 0)
    active.focus()
    studio.toast(T('已替换 ' + all.length + ' 处', 'Replaced ' + all.length))
    updateFindCount()
  }

  /* ================= 即时预览 ================= */

  var lastRender = null
  var fileCache = {} // 插件路径 → 文本 | null
  var fileLoading = {}
  var imgCache = {} // data-paths → { url, wPt } | { missing: true } | { note }
  var imgLoading = {}
  var pendingLive = true

  function renderLive() {
    if (!loaded) return
    if (settings.mode === 'source' || settings.view !== 'live') {
      pendingLive = true
      return
    }
    pendingLive = false
    var ri = rootInfo()
    var t0 = performance.now()
    var r
    try {
      r = TeX2HTML.render(text, { katex: window.katex, files: fileCache, base: ri.dir })
    } catch (err) {
      console.error(err)
      pageEl.innerHTML = '<div class="empty">' + esc(T('预览出错：', 'Preview failed: ') + (err && err.message)) + '</div>'
      return
    }
    lastRender = r
    pageEl.dataset.lang = r.lang
    pageEl.innerHTML = r.html.trim() ? r.html : '<div class="empty">' + esc(T('开始输入 LaTeX，这里会实时显示排版效果', 'Start typing LaTeX — the typeset result appears here')) + '</div>'
    liveTime = performance.now() - t0
    decorateImages()
    loadNeeded(r.need)
    blocksDirty = true
    updatePreviewStatus()
  }

  function loadNeeded(list) {
    list.forEach(function (p) {
      if (fileLoading[p] || p in fileCache) return
      fileLoading[p] = true
      studio.fs
        .readText(p)
        .then(
          function (t) {
            fileCache[p] = t
          },
          function () {
            fileCache[p] = null
          }
        )
        .then(function () {
          delete fileLoading[p]
          watchAdd([p])
          renderLiveSoon()
        })
    })
  }

  var IMG_EXT = ['', '.pdf', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.bmp', '.eps', '.ps']
  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' }

  function decorateImages() {
    pageEl.querySelectorAll('img.gfx').forEach(function (img) {
      var key = img.dataset.paths
      var hit = imgCache[key]
      if (hit) return applyImage(img, hit)
      img.dataset.state = 'loading'
      img.alt = img.dataset.src
      if (imgLoading[key]) return
      imgLoading[key] = true
      resolveImage(key)
        .then(
          function (res) {
            imgCache[key] = res || { missing: true }
          },
          function () {
            imgCache[key] = { missing: true }
          }
        )
        .then(function () {
          delete imgLoading[key]
          pageEl.querySelectorAll('img.gfx').forEach(function (x) {
            if (x.dataset.paths === key) applyImage(x, imgCache[key])
          })
          blocksDirty = true
        })
    })
  }
  function applyImage(img, res) {
    if (res.missing || res.note) {
      img.dataset.state = 'missing'
      img.removeAttribute('src')
      img.alt = res.note || T('找不到图片：', 'Image not found: ') + img.dataset.src
      return
    }
    delete img.dataset.state
    if (img.getAttribute('src') !== res.url) img.src = res.url
    var st = img.getAttribute('style') || ''
    if (!/(^|;)\s*(width|height)\s*:/.test(st) && res.wPt) {
      // 没指定大小：按图片自身尺寸（pt），乘 scale
      var sm = /--scale:\s*([\d.]+)/.exec(st)
      var sc = sm ? parseFloat(sm[1]) : 1
      img.style.width = ((res.wPt * sc) / 12).toFixed(3) + 'em'
    }
  }
  async function resolveImage(key) {
    var paths = key.split('|')
    var found = null
    for (var i = 0; i < paths.length && !found; i++) {
      var hasExt = /\.[A-Za-z0-9]{2,4}$/.test(paths[i])
      for (var j = 0; j < IMG_EXT.length; j++) {
        if (IMG_EXT[j] === '' && !hasExt) continue
        if (IMG_EXT[j] !== '' && hasExt) continue
        var p = paths[i] + IMG_EXT[j]
        var st = await studio.fs.stat(p).catch(function () {
          return null
        })
        if (st && st.type === 'file') {
          found = p
          break
        }
      }
    }
    if (!found) return null
    watchAdd([found])
    var ext = (/\.([A-Za-z0-9]+)$/.exec(found) || [])[1].toLowerCase()
    if (ext === 'eps' || ext === 'ps') return { note: T('EPS 图片请在 PDF 模式下查看：', 'EPS images show in PDF mode: ') + basename(found), path: found }
    var buf = await studio.fs.read(found)
    if (ext === 'pdf') {
      var r = await pdfThumb(buf)
      r.path = found
      return r
    }
    var blob = new Blob([buf], { type: MIME[ext] || 'application/octet-stream' })
    var url = URL.createObjectURL(blob)
    var dims = await new Promise(function (res) {
      var im = new Image()
      im.onload = function () {
        res([im.naturalWidth, im.naturalHeight])
      }
      im.onerror = function () {
        res([0, 0])
      }
      im.src = url
    })
    // 位图默认按 72 dpi（pdfLaTeX 没有分辨率信息时的做法），最多占满版心
    return { url: url, wPt: dims[0] ? Math.min(dims[0], 1200) : 0, path: found }
  }
  /** PDF 图片：渲染第一页 */
  async function pdfThumb(buf) {
    var lib = await loadPdfjs()
    var doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise
    try {
      var page = await doc.getPage(1)
      var vp1 = page.getViewport({ scale: 1 })
      var scale = Math.min(4, 1600 / vp1.width) * 1
      var vp = page.getViewport({ scale: scale })
      var canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas: canvas }).promise
      var blob = await new Promise(function (res) {
        canvas.toBlob(res, 'image/png')
      })
      return { url: URL.createObjectURL(blob), wPt: vp1.width }
    } finally {
      destroyDoc(doc)
    }
  }

  /* 预览里的点击 */
  pageEl.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]')
    if (!a) return
    e.preventDefault()
    var href = a.getAttribute('href')
    if (href[0] === '#') {
      var t = pageEl.querySelector('[id="' + CSS.escape(href.slice(1)) + '"]')
      if (t) {
        var top = t.getBoundingClientRect().top - liveScroll.getBoundingClientRect().top + liveScroll.scrollTop - 60
        lock.view = Date.now() + 400
        liveScroll.scrollTo({ top: top, behavior: 'smooth' })
        flashEl(t)
      }
    } else if (/^(https?:|mailto:)/i.test(href)) studio.openExternal(href)
  })
  pageEl.addEventListener('dblclick', function (e) {
    var t = e.target.closest && e.target.closest('[data-line]')
    if (!t) return
    e.preventDefault()
    window.getSelection && window.getSelection().removeAllRanges()
    jumpToLine(+t.dataset.line)
  })
  function flashEl(t) {
    t.classList.remove('flash')
    void t.offsetWidth
    t.classList.add('flash')
  }

  /* ================= 滚动同步（即时预览） ================= */

  var blocks = []
  var blocksDirty = true
  var lock = { src: 0, view: 0 }

  function collectBlocks() {
    blocks = []
    var last = -1
    var base = liveScroll.getBoundingClientRect().top - liveScroll.scrollTop
    pageEl.querySelectorAll('[data-line]').forEach(function (x) {
      var l = +x.dataset.line
      if (l < last) return
      var top = x.getBoundingClientRect().top - base
      if (blocks.length && top < blocks[blocks.length - 1].top) return
      blocks.push({ line: l, top: top })
      last = l
    })
    blocksDirty = false
  }
  function srcTopLine() {
    var y = srcScroll.scrollTop + 14
    var lo = 0
    var hi = lineEls.length - 1
    if (hi < 0) return 0
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1
      if (lineEls[mid].offsetTop <= y) lo = mid
      else hi = mid - 1
    }
    var ln = lineEls[lo]
    return lo + Math.max(0, Math.min(1, (y - ln.offsetTop) / Math.max(1, ln.offsetHeight)))
  }
  function scrollLiveToLine(L, smooth) {
    if (blocksDirty) collectBlocks()
    if (!blocks.length) return
    var i = 0
    while (i + 1 < blocks.length && blocks[i + 1].line <= L) i++
    var a = blocks[i]
    var b = blocks[i + 1]
    var y = a.top
    if (b && b.line > a.line && L > a.line) y = a.top + ((b.top - a.top) * (L - a.line)) / (b.line - a.line)
    if (L < a.line) y = (a.top * L) / Math.max(1, a.line)
    lock.view = Date.now() + (smooth ? 500 : 120)
    var top = Math.max(0, y - 30)
    if (smooth) liveScroll.scrollTo({ top: top, behavior: 'smooth' })
    else liveScroll.scrollTop = top
  }
  function viewTopLine() {
    if (blocksDirty) collectBlocks()
    if (!blocks.length) return 0
    var y = liveScroll.scrollTop + 30
    var i = 0
    while (i + 1 < blocks.length && blocks[i + 1].top <= y) i++
    var a = blocks[i]
    var b = blocks[i + 1]
    if (y < a.top) return (a.line * y) / Math.max(1, a.top)
    if (!b) return a.line
    return a.line + ((b.line - a.line) * (y - a.top)) / Math.max(1, b.top - a.top)
  }
  var syncRaf = 0
  srcScroll.addEventListener('scroll', function () {
    if (!acEl.hidden) positionCompletion()
    if (settings.mode !== 'split' || settings.view !== 'live' || Date.now() < lock.src) return
    cancelAnimationFrame(syncRaf)
    syncRaf = requestAnimationFrame(function () {
      scrollLiveToLine(srcTopLine())
    })
  })
  liveScroll.addEventListener('scroll', function () {
    if (settings.mode !== 'split' || Date.now() < lock.view) return
    cancelAnimationFrame(syncRaf)
    syncRaf = requestAnimationFrame(function () {
      var L = viewTopLine()
      var ln = lineEls[Math.floor(L)]
      if (!ln) return
      lock.src = Date.now() + 120
      srcScroll.scrollTop = Math.max(0, ln.offsetTop + (L - Math.floor(L)) * ln.offsetHeight - 14)
    })
  })
  new ResizeObserver(function () {
    blocksDirty = true
  }).observe(pageEl)

  // Ctrl + 滚轮缩放预览
  liveScroll.addEventListener(
    'wheel',
    function (e) {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setZoom(settings.zoom + (e.deltaY < 0 ? 0.1 : -0.1))
    },
    { passive: false }
  )
  function setZoom(z) {
    settings.zoom = Math.round(Math.max(0.6, Math.min(2.2, z)) * 10) / 10
    main.style.setProperty('--zoom', settings.zoom)
    saveSettings()
    blocksDirty = true
  }

  /* ================= 文件监视 ================= */

  var watchSet = {}
  function watchAdd(list) {
    var changed = false
    list.forEach(function (p) {
      if (p && !watchSet[p]) {
        watchSet[p] = 1
        changed = true
      }
    })
    if (changed && studio.has('fs.watch')) studio.fs.watch(Object.keys(watchSet)).catch(function () {})
  }
  studio.onAssetChanged(function (paths) {
    var live = false
    paths.forEach(function (p) {
      if (p in fileCache) {
        delete fileCache[p]
        live = true
      }
      for (var key in imgCache) {
        var c = imgCache[key]
        if (c && c.path === p) {
          if (c.url) URL.revokeObjectURL(c.url)
          delete imgCache[key]
          live = true
        }
      }
      if (pdf.path && p === pdf.path && !compiling) reloadPdfSoon()
      if (p === logPathOf(rootInfo()) && !compiling) reloadLogSoon()
    })
    if (live) renderLiveSoon()
  })

  /* ================= PDF ================= */

  var CSS_UNITS = 96 / 72
  var pdfjsP = null
  /** pdf.js 6 的文档对象没有 destroy()，要通过 loadingTask 释放 */
  function destroyDoc(d) {
    try {
      if (d && d.loadingTask) d.loadingTask.destroy()
      else if (d && d.destroy) d.destroy()
    } catch (e) {}
  }
  function loadPdfjs() {
    if (!pdfjsP)
      pdfjsP = import('./vendor/pdfjs/pdf.min.mjs').then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href
        return lib
      })
    return pdfjsP
  }
  var pdf = { doc: null, path: '', mtime: 0, pages: [], scale: 1, sync: null, syncFor: 0, gen: 0, observer: null, loading: null }

  function pdfPathOf(ri) {
    return join(ri.dir, ri.base + '.pdf')
  }
  function logPathOf(ri) {
    return join(ri.dir, ri.base + '.log')
  }

  async function loadPdf(force) {
    var ri = rootInfo()
    var path = pdfPathOf(ri)
    var st = await studio.fs.stat(path).catch(function () {
      return null
    })
    watchAdd([path, logPathOf(ri)])
    if (!st) {
      pdf.path = path
      if (pdf.doc) {
        destroyDoc(pdf.doc)
        pdf.doc = null
      }
      pdfPagesEl.replaceChildren()
      showPdfEmpty()
      return
    }
    if (!force && pdf.doc && pdf.path === path && pdf.mtime === st.mtime) return
    var gen = ++pdf.gen
    var buf
    try {
      buf = await studio.fs.read(path)
    } catch (err) {
      return showPdfEmpty(T('无法读取 PDF：', 'Cannot read the PDF: ') + (err && err.message))
    }
    var lib
    var doc
    try {
      lib = await loadPdfjs()
      doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false }).promise
    } catch (err) {
      // 编译到一半的 PDF 可能不完整：稍后再试
      if (gen === pdf.gen) setTimeout(function () { loadPdf(true) }, 1200)
      return
    }
    if (gen !== pdf.gen) {
      destroyDoc(doc)
      return
    }
    var keepPage = currentPdfPage()
    var keepRatio = pdfScroll.scrollHeight ? pdfScroll.scrollTop / pdfScroll.scrollHeight : 0
    var keepLeft = pdfScroll.scrollLeft
    var old = pdf.doc
    pdf.doc = doc
    pdf.path = path
    pdf.mtime = st.mtime
    pdfEmpty.hidden = true
    await buildPages()
    if (old) destroyDoc(old)
    if (pdf.pages.length) pdfScroll.scrollTop = keepRatio * pdfScroll.scrollHeight
    pdfScroll.scrollLeft = keepLeft
    void keepPage
    updatePdfTools()
    loadSynctex(ri)
  }
  var reloadPdfSoon = debounce(function () {
    if (settings.view === 'pdf') loadPdf(true)
    else pdf.mtime = -1
  }, 500)

  function fitScale(w) {
    var avail = pdfScroll.clientWidth - 36
    return Math.max(0.25, Math.min(4, avail / (w * CSS_UNITS)))
  }
  async function buildPages() {
    var doc = pdf.doc
    var n = doc.numPages
    var sizes = []
    var first = await doc.getPage(1)
    var vp1 = first.getViewport({ scale: 1 })
    // 大多数文档每页一样大：先按第一页的尺寸占位，渲染时再按实际尺寸修正
    for (var i = 0; i < n; i++) sizes.push([vp1.width, vp1.height])
    pdf.scale = settings.pdfZoom > 0 ? settings.pdfZoom : fitScale(vp1.width)
    if (pdf.observer) pdf.observer.disconnect()
    var frag = document.createDocumentFragment()
    pdf.pages = sizes.map(function (sz, i) {
      var d = el('div', { class: 'pdfpage', 'data-page': String(i + 1) })
      frag.append(d)
      return { el: d, w: sz[0], h: sz[1], rendered: 0, task: null }
    })
    sizePages()
    pdfPagesEl.replaceChildren(frag)
    pdf.observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) renderPdfPage(+en.target.dataset.page - 1)
        })
      },
      { root: pdfScroll, rootMargin: '800px 0px' }
    )
    pdf.pages.forEach(function (p) {
      pdf.observer.observe(p.el)
    })
  }
  function sizePages() {
    pdf.pages.forEach(function (p) {
      p.el.style.width = Math.floor(p.w * pdf.scale * CSS_UNITS) + 'px'
      p.el.style.height = Math.floor(p.h * pdf.scale * CSS_UNITS) + 'px'
    })
  }
  async function renderPdfPage(i) {
    var p = pdf.pages[i]
    if (!p || p.rendered === pdf.scale) return
    var doc = pdf.doc
    var scale = pdf.scale
    p.rendered = scale
    try {
      var page = await doc.getPage(i + 1)
      if (doc !== pdf.doc) return
      var base = page.getViewport({ scale: 1 })
      if (base.width !== p.w || base.height !== p.h) {
        p.w = base.width
        p.h = base.height
        p.el.style.width = Math.floor(p.w * scale * CSS_UNITS) + 'px'
        p.el.style.height = Math.floor(p.h * scale * CSS_UNITS) + 'px'
      }
      var dpr = Math.min(3, window.devicePixelRatio || 1)
      var vp = page.getViewport({ scale: scale * CSS_UNITS * dpr })
      var canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      if (p.task) p.task.cancel()
      p.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas: canvas })
      await p.task.promise
      p.task = null
      if (doc !== pdf.doc || p.rendered !== scale) return
      var old = p.el.querySelector('canvas')
      if (old) old.replaceWith(canvas)
      else p.el.prepend(canvas)
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return
      p.rendered = 0
    }
  }
  function rescalePdf(scale) {
    if (!pdf.doc) return
    var anchorPage = currentPdfPage()
    var pEl = pdf.pages[anchorPage - 1] && pdf.pages[anchorPage - 1].el
    var rel = pEl ? (pdfScroll.scrollTop - pEl.offsetTop) / Math.max(1, pEl.offsetHeight) : 0
    pdf.scale = scale
    sizePages()
    pdf.pages.forEach(function (p) {
      p.rendered = 0
    })
    if (pEl) pdfScroll.scrollTop = pEl.offsetTop + rel * pEl.offsetHeight
    // 重新触发可见页的渲染
    pdf.pages.forEach(function (p, i) {
      var r = p.el.getBoundingClientRect()
      var vr = pdfScroll.getBoundingClientRect()
      if (r.bottom > vr.top - 800 && r.top < vr.bottom + 800) renderPdfPage(i)
    })
    updatePdfTools()
  }
  function currentPdfPage() {
    if (!pdf.pages.length) return 0
    var y = pdfScroll.scrollTop + pdfScroll.clientHeight / 3
    for (var i = 0; i < pdf.pages.length; i++) {
      var e = pdf.pages[i].el
      if (e.offsetTop + e.offsetHeight > y) return i + 1
    }
    return pdf.pages.length
  }
  pdfScroll.addEventListener('scroll', function () {
    updatePdfPageLabel()
  })
  pdfScroll.addEventListener(
    'wheel',
    function (e) {
      if (!(e.ctrlKey || e.metaKey) || !pdf.doc) return
      e.preventDefault()
      var s = pdf.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)
      s = Math.max(0.25, Math.min(5, s))
      settings.pdfZoom = Math.round(s * 100) / 100
      saveSettings()
      rescalePdf(settings.pdfZoom)
    },
    { passive: false }
  )
  var refit = debounce(function () {
    if (pdf.doc && settings.pdfZoom === 0 && pdf.pages.length) {
      var s = fitScale(pdf.pages[0].w)
      if (Math.abs(s - pdf.scale) > 0.01) rescalePdf(s)
    }
  }, 150)
  new ResizeObserver(refit).observe(pdfScroll)

  var pdfPageLbl = null
  var pdfZoomLbl = null
  function buildPdfTools() {
    var b = function (icon, title, fn) {
      var x = el('button', { type: 'button', class: 'tb', title: title, 'aria-label': title, html: icon })
      x.addEventListener('click', fn)
      return x
    }
    pdfPageLbl = el('span', { class: 'lbl' })
    pdfZoomLbl = el('span', { class: 'lbl' })
    pdfTools.replaceChildren(
      pdfPageLbl,
      el('span', { class: 'sep' }),
      b(ICON.minus, T('缩小', 'Zoom out') + ' (' + K + T('滚轮', 'wheel') + ')', function () { zoomPdf(1 / 1.15) }),
      pdfZoomLbl,
      b(ICON.plus, T('放大', 'Zoom in'), function () { zoomPdf(1.15) }),
      b(ICON.fit, T('适应宽度', 'Fit width'), function () {
        settings.pdfZoom = 0
        saveSettings()
        if (pdf.pages.length) rescalePdf(fitScale(pdf.pages[0].w))
      }),
      b(ICON.target, T('定位到光标所在行', 'Go to the cursor line') + ' (' + K + 'Alt+J)', syncToPdf),
      b(ICON.refresh, T('重新载入 PDF', 'Reload PDF'), function () { loadPdf(true) })
    )
  }
  function zoomPdf(f) {
    if (!pdf.doc) return
    settings.pdfZoom = Math.round(Math.max(0.25, Math.min(5, pdf.scale * f)) * 100) / 100
    saveSettings()
    rescalePdf(settings.pdfZoom)
  }
  function updatePdfTools() {
    if (!pdfPageLbl) buildPdfTools()
    pdfTools.hidden = settings.view !== 'pdf' || !pdf.doc || settings.mode === 'source'
    pdfZoomLbl.textContent = Math.round(pdf.scale * 100) + '%'
    updatePdfPageLabel()
  }
  function updatePdfPageLabel() {
    if (pdfPageLbl && pdf.doc) pdfPageLbl.textContent = currentPdfPage() + ' / ' + pdf.doc.numPages
  }

  function showPdfEmpty(msg) {
    pdfTools.hidden = true
    pdfEmpty.hidden = false
    var eng = engineById(settings.engine)
    var btn = el('button', { type: 'button', class: 'tb primary', html: ICON.play }, T('编译', 'Compile'))
    btn.addEventListener('click', compile)
    var hint = el('div', { class: 'hint' })
    hint.innerHTML = msg
      ? esc(msg)
      : T(
          '用本机安装的 TeX 编译成 PDF（' + esc(engineName(eng)) + '）。需要先安装 <b>TeX Live</b>、<b>MiKTeX</b> 或 <b>Tectonic</b>，并能在终端里运行 <code>' + esc((eng.cmd || settings.custom || '').split(' ')[0] || 'xelatex') + '</code>。<br>不想安装？切回“即时预览”，不用编译也能看排版效果。',
          'Compiles with the TeX installed on this computer (' + esc(engineName(eng)) + '). Install <b>TeX Live</b>, <b>MiKTeX</b> or <b>Tectonic</b> so that <code>' + esc((eng.cmd || settings.custom || '').split(' ')[0] || 'xelatex') + '</code> runs in a terminal.<br>No TeX? Switch back to “Live” to see the typeset result without compiling.'
        )
    pdfEmpty.replaceChildren(el('div', { class: 'big', text: msg ? T('无法显示 PDF', 'Cannot show the PDF') : T('还没有 PDF', 'No PDF yet') }), hint, btn)
  }

  /* ---------- SyncTeX ---------- */

  async function loadSynctex(ri) {
    var base = join(ri.dir, ri.base)
    var st = await studio.fs.stat(base + '.synctex.gz').catch(function () {
      return null
    })
    var gz = !!st
    if (!st)
      st = await studio.fs.stat(base + '.synctex').catch(function () {
        return null
      })
    if (!st) {
      pdf.sync = null
      return
    }
    if (pdf.sync && pdf.syncFor === st.mtime) return
    try {
      var buf = await studio.fs.read(base + (gz ? '.synctex.gz' : '.synctex'))
      var txt = gz ? await TexTools.gunzip(buf) : new TextDecoder().decode(buf)
      pdf.sync = TexTools.parseSynctex(txt)
      pdf.syncFor = st.mtime
    } catch (err) {
      pdf.sync = null
    }
  }

  /** 源码 → PDF */
  async function syncToPdf() {
    if (settings.view !== 'pdf') setView('pdf')
    if (!pdf.doc) await loadPdf(false)
    if (!pdf.doc) return
    var ri = rootInfo()
    if (!pdf.sync) await loadSynctex(ri)
    if (!pdf.sync) {
      studio.toast(T('没有 SyncTeX 信息：编译命令需要带 -synctex=1', 'No SyncTeX data: compile with -synctex=1'))
      return
    }
    var line = caretLine() + 1
    var hit = TexTools.forward(pdf.sync, relative(ri.dir, relPath), line)
    if (!hit) {
      studio.toast(T('在 PDF 里没有找到这一行', 'This line was not found in the PDF'))
      return
    }
    var p = pdf.pages[hit.page - 1]
    if (!p) return
    var k = pdf.scale * CSS_UNITS
    var top = p.el.offsetTop + hit.y * k
    pdfScroll.scrollTo({ top: Math.max(0, top - pdfScroll.clientHeight / 3), behavior: 'smooth' })
    var box = el('div', { class: 'hlbox' })
    var w = hit.w > 4 ? hit.w : p.w - hit.x - 40
    box.style.cssText = 'left:' + (hit.x - 2) * k + 'px;top:' + (hit.y - 2) * k + 'px;width:' + (w + 4) * k + 'px;height:' + (hit.h + 4) * k + 'px'
    p.el.querySelectorAll('.hlbox').forEach(function (x) {
      x.remove()
    })
    p.el.append(box)
    setTimeout(function () {
      box.remove()
    }, 2400)
  }

  /** PDF → 源码（双击） */
  pdfPagesEl.addEventListener('dblclick', async function (e) {
    var pageEl2 = e.target.closest('.pdfpage')
    if (!pageEl2) return
    var n = +pageEl2.dataset.page
    var ri = rootInfo()
    if (!pdf.sync) await loadSynctex(ri)
    if (!pdf.sync) {
      studio.toast(T('没有 SyncTeX 信息：编译命令需要带 -synctex=1', 'No SyncTeX data: compile with -synctex=1'))
      return
    }
    var r = pageEl2.getBoundingClientRect()
    var p = pdf.pages[n - 1]
    var x = ((e.clientX - r.left) / r.width) * p.w
    var y = ((e.clientY - r.top) / r.height) * p.h
    var hit = TexTools.inverse(pdf.sync, n, x, y)
    if (!hit || !hit.line) return
    window.getSelection && window.getSelection().removeAllRanges()
    var target = toPluginPath(hit.file, ri.dir)
    if (!target || target.toLowerCase() === relPath.toLowerCase()) jumpToLine(hit.line - 1)
    else studio.editor.open(target, { line: hit.line }).catch(function () {
      studio.toast(T('无法打开 ', 'Cannot open ') + hit.file)
    })
  })

  /* ================= 编译 ================= */

  var compiling = null
  var lastCompile = null
  var problems = []
  var showProblems = false

  function engineFor(program) {
    if (program) {
      var p = program.replace(/\s.*$/, '')
      if (p === 'latexmk') return engineById('latexmk')
      var e = ENGINES.find(function (x) { return x.id === p })
      if (e) return e
    }
    return engineById(settings.engine)
  }

  async function mtimeOf(p) {
    var st = await studio.fs.stat(p).catch(function () {
      return null
    })
    return st ? st.mtime : 0
  }

  async function compile() {
    if (compiling) {
      studio.toast(T('正在编译…', 'Compiling…'))
      return
    }
    if (!studio.has('terminal.run')) {
      studio.toast(T('需要更新 Infinite Studio 才能编译', 'Compiling needs a newer Infinite Studio'))
      return
    }
    var ri = rootInfo()
    var rootText = ri.isSelf
      ? text
      : await studio.fs.readText(ri.root).catch(function () {
          return null
        })
    if (rootText == null) {
      studio.toast(T('找不到主文件 ', 'Main file not found: ') + ri.root)
      return
    }
    if (!/\\documentclass/.test(rootText)) {
      studio.toast(T('这个文件没有 \\documentclass。如果它是子文件，请在开头加一行 % !TEX root = main.tex 指定主文件', 'This file has no \\documentclass. For a sub-file, add % !TEX root = main.tex at the top'))
      return
    }
    var eng = engineFor(ri.program)
    var cmd = eng.id === 'custom' ? settings.custom.trim() : eng.cmd
    if (!cmd) {
      studio.toast(T('请先在设置里填写自定义编译命令', 'Set the custom compile command in settings first'))
      openSettings(bar.querySelector('#setBtn'))
      return
    }
    cmd = cmd.replace(/\{file\}/g, basename(ri.root)).replace(/\{base\}/g, ri.base)
    if (studio.isDirty()) {
      try {
        await studio.editor.save()
      } catch (e) {
        /* 保存失败时照样编译磁盘上的版本 */
      }
    }
    var logPath = logPathOf(ri)
    var pdfPath = pdfPathOf(ri)
    var before = { log: await mtimeOf(logPath), pdf: await mtimeOf(pdfPath) }
    compiling = { start: Date.now(), ri: ri, logPath: logPath, pdfPath: pdfPath, before: before, eng: eng, stable: 0, lastLog: before.log, lastSize: -1, hinted: false }
    watchAdd([logPath, pdfPath])
    setCompileStatus('busy', T('正在编译…', 'Compiling…') + ' · ' + engineName(eng))
    buildBar()
    try {
      await studio.terminal.run(cmd, { cwd: ri.dir, title: 'LaTeX · ' + basename(ri.root) })
    } catch (err) {
      compiling = null
      var msg = String((err && err.message) || err)
      setCompileStatus('err', /denied/i.test(msg) ? T('已取消编译', 'Compile cancelled') : T('无法运行编译命令：', 'Cannot run the compiler: ') + msg)
      buildBar()
      return
    }
    pollCompile()
  }

  function pollCompile() {
    var c = compiling
    if (!c) return
    c.timer = setTimeout(async function () {
      if (compiling !== c) return
      var lst = await studio.fs.stat(c.logPath).catch(function () {
        return null
      })
      var pst = await studio.fs.stat(c.pdfPath).catch(function () {
        return null
      })
      var elapsed = Date.now() - c.start
      var logM = lst ? lst.mtime : 0
      if (logM && logM !== c.before.log) {
        if (logM === c.lastLog && lst.size === c.lastSize) c.stable++
        else c.stable = 0
        c.lastLog = logM
        c.lastSize = lst.size
        if (c.stable >= 1) {
          var log = await studio.fs.readText(c.logPath).catch(function () {
            return ''
          })
          var done = /Output written on|No pages of output|Fatal error occurred|Emergency stop|job aborted|Transcript written/i.test(log)
          if (done || c.stable >= 8) return finishCompile(c, log, pst)
        }
      } else if (pst && pst.mtime !== c.before.pdf && elapsed > 1500 && c.eng.id === 'tectonic') {
        // Tectonic 没有 --keep-logs 时没有日志
        return finishCompile(c, '', pst)
      }
      if (elapsed > 25000 && !c.hinted && !(logM && logM !== c.before.log)) {
        c.hinted = true
        setCompileStatus('busy', T('还在等编译输出…请看终端里有没有报错（是否安装了 TeX？）', 'Still waiting for output… check the terminal (is TeX installed?)'))
      }
      if (elapsed > 15 * 60 * 1000) {
        compiling = null
        setCompileStatus('err', T('没有等到编译结果', 'No compile result'))
        buildBar()
        return
      }
      pollCompile()
    }, 700)
  }

  function finishCompile(c, log, pst) {
    if (compiling !== c) return
    compiling = null
    var secs = ((Date.now() - c.start) / 1000).toFixed(1)
    setProblems(log, c.ri)
    var errs = problems.filter(function (p) { return p.severity === 'error' }).length
    var newPdf = pst && pst.mtime !== c.before.pdf
    lastCompile = { ok: newPdf && !errs, pdf: newPdf, errs: errs, secs: secs, at: new Date() }
    if (newPdf && !errs) setCompileStatus('ok', T('编译完成', 'Compiled') + ' · ' + secs + ' s')
    else if (newPdf) setCompileStatus('err', T('已生成 PDF，但有 ', 'PDF written with ') + errs + T(' 个错误', ' error(s)'))
    else setCompileStatus('err', T('编译失败', 'Compile failed') + (errs ? ' · ' + errs + T(' 个错误', ' error(s)') : ''))
    if (errs && !showProblems) toggleProblems(true)
    if (newPdf) {
      if (settings.view !== 'pdf') setView('pdf')
      else loadPdf(true)
    }
    buildBar()
  }

  var reloadLogSoon = debounce(async function () {
    var ri = rootInfo()
    var log = await studio.fs.readText(logPathOf(ri)).catch(function () {
      return null
    })
    if (log != null) {
      setProblems(log, ri)
      buildBar()
    }
  }, 700)

  function setProblems(log, ri) {
    problems = TexTools.parseLog(log || '').map(function (p) {
      var path = p.file ? toPluginPath(p.file, ri.dir) : ri.root
      return { severity: p.severity, path: path || ri.root, file: p.file, line: p.line, message: p.message }
    })
    marks = {}
    problems.forEach(function (p) {
      if (!p.line || p.path.toLowerCase() !== relPath.toLowerCase()) return
      var n = p.line - 1
      if (p.severity === 'error') marks[n] = 'err'
      else if (p.severity === 'warning' && !marks[n]) marks[n] = 'warn'
    })
    renderSource()
    renderProblems()
  }

  function renderProblems() {
    problemsEl.hidden = !showProblems
    if (!showProblems) return
    var errs = problems.filter(function (p) { return p.severity === 'error' }).length
    var warns = problems.filter(function (p) { return p.severity === 'warning' }).length
    var bad = problems.length - errs - warns
    var close = el('button', { type: 'button', class: 'tb', title: T('关闭', 'Close'), 'aria-label': T('关闭', 'Close'), html: ICON.close })
    close.addEventListener('click', function () {
      toggleProblems(false)
    })
    var list = el('div', { class: 'ph-list' })
    if (!lastCompile && !problems.length) list.append(el('div', { class: 'empty', text: T('编译后，日志里的错误和警告会列在这里。', 'Errors and warnings from the compile log appear here.') }))
    else if (!problems.length) list.append(el('div', { class: 'empty', text: T('没有错误和警告。', 'No errors or warnings.') }))
    var order = { error: 0, warning: 1, badbox: 2 }
    problems
      .slice()
      .sort(function (a, b) {
        return order[a.severity] - order[b.severity]
      })
      .forEach(function (p) {
        var loc = (p.path === relPath ? '' : basename(p.path)) + (p.line ? (p.path === relPath ? '' : ':') + T('第 ' + p.line + ' 行', 'line ' + p.line) : '')
        var b = el('button', { type: 'button', class: 'pi ' + p.severity }, el('span', { class: 'ic' }), el('span', { class: 'm', text: p.message }), loc ? el('span', { class: 'loc', text: loc }) : null)
        b.addEventListener('click', function () {
          if (!p.line) return
          if (p.path.toLowerCase() === relPath.toLowerCase()) jumpToLine(p.line - 1)
          else studio.editor.open(p.path, { line: p.line }).catch(function () {})
        })
        list.append(b)
      })
    problemsEl.replaceChildren(
      el(
        'div',
        { class: 'ph-head' },
        el('span', { class: 't', text: T('编译日志', 'Compile log') }),
        el('span', { text: errs + T(' 个错误 · ', ' errors · ') + warns + T(' 个警告', ' warnings') + (bad ? ' · ' + bad + T(' 个排版提示', ' bad boxes') : '') }),
        el('span', { class: 'sp', style: 'flex:1' }),
        close
      ),
      list
    )
  }
  function toggleProblems(on) {
    showProblems = on == null ? !showProblems : on
    renderProblems()
    buildBar()
  }

  /* ================= 状态栏 ================= */

  var compileState = { kind: '', text: '' }
  function setCompileStatus(kind, txt) {
    compileState = { kind: kind, text: txt }
    renderStatus()
  }
  var wordCount = 0
  function updateWordCount() {
    var body = text
    var b = body.search(/\\begin\s*\{document\}/)
    if (b >= 0) body = body.slice(b)
    body = body
      .replace(/(^|[^\\])%.*$/gm, '$1')
      .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]*\$|\\\([\s\S]*?\\\)/g, ' ')
      .replace(/\\begin\{(equation|align|gather|multline|verbatim|lstlisting|tikzpicture)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
      .replace(/\\[A-Za-z@]+\*?(\[[^\]]*\])?/g, ' ')
      .replace(/[{}\\&~^_#]/g, ' ')
    var cjk = (body.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length
    var words = (body.replace(/[\u3400-\u9FFF\uF900-\uFAFF]/g, ' ').match(/[A-Za-z0-9\u00C0-\u024F'’-]+/g) || []).length
    wordCount = cjk + words
    renderStatus()
  }
  var cursorText = ''
  function updateCursorStatus() {
    var pos = srcEl.selectionStart
    var n = caretLine()
    var col = pos - lineStart(n) + 1
    var sel = srcEl.selectionEnd - srcEl.selectionStart
    cursorText = T('行 ' + (n + 1) + '，列 ' + col, 'Ln ' + (n + 1) + ', Col ' + col) + (sel ? T('（已选 ' + sel + '）', ' (' + sel + ' selected)') : '')
    var c = statusEl.querySelector('#stCursor')
    if (c) c.textContent = cursorText
  }
  function updatePreviewStatus() {
    renderStatus()
  }
  function renderStatus() {
    var items = []
    if (compileState.text) {
      var cs = el('button', { type: 'button', class: 'si', title: T('显示编译日志', 'Show compile log') }, el('span', { class: 'dot ' + compileState.kind }), compileState.text)
      cs.addEventListener('click', function () {
        toggleProblems(true)
      })
      items.push(cs)
    }
    items.push(el('span', { class: 'sp' }))
    if (lastRender && settings.view === 'live' && settings.mode !== 'source' && lastRender.warnings.length) {
      var w = lastRender.warnings
      var total = w.reduce(function (s, x) { return s + x.count }, 0)
      var wb = el('button', { type: 'button', class: 'si', title: T('即时预览不能完整显示的内容', 'What the live preview cannot fully show') }, T('预览提示 ', 'Preview notes ') + total)
      wb.addEventListener('click', function () {
        openMenu(wb, function (m) {
          m.append(el('div', { class: 'hd', text: T('即时预览没有处理这些命令 / 环境', 'NOT HANDLED BY THE LIVE PREVIEW') }))
          w.slice(0, 40).forEach(function (x) {
            var label = x.kind === 'unclosed' ? x.cmd + T(' 没有对应的 \\end', ' has no \\end') : x.kind === 'env' ? '\\begin{' + x.cmd + '}' : x.cmd
            m.append(el('div', { class: 'mi' }, el('code', { text: label }), el('span', { class: 'desc', text: '×' + x.count })))
          })
          m.append(el('div', { class: 'note', text: T('这些内容在“PDF”模式（本机 TeX 编译）下会正常显示。', 'They show correctly in PDF mode (compiled with your TeX).') }))
        }, true)
      })
      items.push(wb)
    }
    items.push(el('span', { class: 'si', id: 'stCursor', text: cursorText }))
    items.push(el('span', { class: 'si', title: T('字数（中文按字，英文按词，不含命令和公式）', 'Words (CJK characters + words, without commands and math)'), text: T(wordCount + ' 字', wordCount + ' words') }))
    var eng = engineFor(TexTools.magic(text).program)
    var eb = el('button', { type: 'button', class: 'si', title: T('编译引擎', 'TeX engine') }, engineName(eng))
    eb.addEventListener('click', function () {
      openEngineMenu(eb, true)
    })
    items.push(eb)
    statusEl.replaceChildren.apply(statusEl, items)
  }

  /* ================= 大纲 ================= */

  var outline = []
  function refreshOutlineCache() {
    outline = []
    var lines = text.split('\n')
    var re = /\\(part|chapter|section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\])?\s*\{(.*)/
    var LV = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 }
    var inVerb = false
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i]
      if (/\\begin\{(verbatim|lstlisting|minted|comment)\}/.test(l)) inVerb = true
      if (/\\end\{(verbatim|lstlisting|minted|comment)\}/.test(l)) inVerb = false
      if (inVerb) continue
      var s = l.replace(/(^|[^\\])%.*$/, '$1')
      var m = re.exec(s)
      if (!m) continue
      // 取到配对的 }
      var t = m[3]
      var d = 1
      var out = ''
      for (var k = 0; k < t.length && d > 0; k++) {
        if (t[k] === '{') d++
        else if (t[k] === '}') d--
        if (d > 0) out += t[k]
      }
      out = out.replace(/\\[A-Za-z]+\*?\s*/g, '').replace(/[{}$]/g, '').trim()
      outline.push({ level: LV[m[1]], title: out || '…', line: i, star: !!m[2] })
    }
  }
  function openOutline(anchor) {
    openMenu(anchor, function (m) {
      m.style.minWidth = '260px'
      if (!outline.length) {
        m.append(el('div', { class: 'note', text: T('还没有章节。用 \\section{…} 添加章节后，这里会列出大纲。', 'No sections yet. Add \\section{…} and the outline appears here.') }))
        return
      }
      var min = outline.reduce(function (a, x) { return Math.min(a, x.level) }, 9)
      var cur = caretLine()
      var active = -1
      outline.forEach(function (x, i) {
        if (x.line <= cur) active = i
      })
      outline.forEach(function (x, i) {
        var b = el('button', { type: 'button', class: 'ol-item' + (i === active ? ' active' : ''), style: 'padding-left:' + (10 + (x.level - min) * 16) + 'px' + (i === active ? ';background:var(--st-sel)' : '') }, el('span', { class: 't', text: x.title }), el('span', { class: 'ln', text: String(x.line + 1) }))
        b.addEventListener('click', function () {
          closeMenu()
          jumpToLine(x.line, { syncView: true })
        })
        m.append(b)
      })
    })
  }

  /* ================= 模式、视图 ================= */

  function applySettings() {
    main.dataset.mode = settings.mode
    main.dataset.view = settings.view
    main.dataset.wrap = settings.wrap ? 'on' : 'off'
    document.body.dataset.mode = settings.mode
    main.style.setProperty('--efs', settings.fontSize + 'px')
    main.style.setProperty('--zoom', settings.zoom)
    main.style.setProperty('--split', settings.split + '%')
    pageEl.dataset.paper = settings.paper
    pdfPagesEl.dataset.paper = settings.paper
    liveScroll.hidden = settings.view !== 'live'
    pdfScroll.hidden = settings.view !== 'pdf'
    updatePdfTools()
    buildBar()
    renderStatus()
  }

  function setMode(mode) {
    if (settings.mode === mode) return
    var L = settings.mode === 'preview' ? viewTopLine() : srcTopLine()
    settings.mode = mode
    saveSettings()
    applySettings()
    if (mode !== 'source') {
      if (settings.view === 'live' && pendingLive) renderLive()
      if (settings.view === 'pdf') loadPdf(false)
    }
    requestAnimationFrame(function () {
      if (mode !== 'preview') {
        var ln = lineEls[Math.min(lineEls.length - 1, Math.floor(L))]
        if (ln) {
          lock.src = Date.now() + 150
          srcScroll.scrollTop = ln.offsetTop
        }
        srcEl.focus({ preventScroll: true })
      }
      if (mode !== 'source' && settings.view === 'live') {
        blocksDirty = true
        scrollLiveToLine(L)
      }
      refit()
    })
  }

  function setView(view) {
    if (settings.view === view) return
    settings.view = view
    saveSettings()
    if (settings.mode === 'source') settings.mode = 'split'
    applySettings()
    if (view === 'live') {
      if (pendingLive) renderLive()
      requestAnimationFrame(function () {
        blocksDirty = true
        scrollLiveToLine(srcTopLine())
      })
    } else loadPdf(pdf.mtime === -1)
  }

  /* 分隔条 */
  splitter.addEventListener('pointerdown', function (e) {
    e.preventDefault()
    splitter.setPointerCapture(e.pointerId)
    splitter.classList.add('drag')
    var rect = main.getBoundingClientRect()
    var move = function (ev) {
      var pct = ((ev.clientX - rect.left) / rect.width) * 100
      settings.split = Math.round(Math.max(18, Math.min(82, pct)) * 10) / 10
      main.style.setProperty('--split', settings.split + '%')
    }
    var up = function () {
      splitter.classList.remove('drag')
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
      saveSettings()
      blocksDirty = true
      refit()
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
  })
  splitter.addEventListener('dblclick', function () {
    settings.split = 50
    main.style.setProperty('--split', '50%')
    saveSettings()
    refit()
  })

  /* ================= 工具栏 ================= */

  function tb(icon, title, fn, opts) {
    opts = opts || {}
    var b = el('button', { type: 'button', class: 'tb' + (opts.on ? ' on' : '') + (opts.cls ? ' ' + opts.cls : ''), title: title, 'aria-label': opts.label ? null : title, id: opts.id, html: icon })
    if (opts.label) b.append(el('span', { class: 'lbl', text: opts.label }))
    if (opts.disabled) b.disabled = true
    b.addEventListener('mousedown', function (e) {
      // 格式按钮不抢编辑器的焦点和选区
      if (opts.keepFocus) e.preventDefault()
    })
    b.addEventListener('click', fn)
    return b
  }

  function buildBar() {
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': T('显示模式', 'Layout') })
    ;[
      ['source', T('源码', 'Source')],
      ['split', T('分栏', 'Split')],
      ['preview', T('预览', 'Preview')]
    ].forEach(function (x) {
      var b = el('button', { type: 'button', class: settings.mode === x[0] ? 'on' : null, 'aria-pressed': String(settings.mode === x[0]) }, x[1])
      b.addEventListener('click', function () {
        setMode(x[0])
      })
      seg.append(b)
    })

    var fmt = el(
      'div',
      { id: 'fmt' },
      tb('<span class="glyph">B</span>', T('粗体', 'Bold') + ' \\textbf (' + K + 'B)', function () { wrapSel('\\textbf{', '}', '') }, { keepFocus: true }),
      tb('<span class="glyph i">I</span>', T('斜体', 'Italic') + ' \\textit (' + K + 'I)', function () { wrapSel('\\textit{', '}', '') }, { keepFocus: true }),
      tb('<span class="glyph" style="text-decoration:underline">U</span>', T('下划线', 'Underline') + ' \\underline (' + K + 'U)', function () { wrapSel('\\underline{', '}', '') }, { keepFocus: true, cls: 'opt' }),
      tb('<span class="glyph" style="font-family:var(--st-font-code);font-weight:500">T</span>', T('等宽', 'Monospace') + ' \\texttt', function () { wrapSel('\\texttt{', '}', '') }, { keepFocus: true, cls: 'opt' }),
      el('span', { class: 'sep' }),
      tb('<span class="glyph i">x²</span>', T('行内公式', 'Inline math') + ' $…$ (' + K + 'M)', function () { wrapSel('$', '$', '') }, { keepFocus: true }),
      tb('<span class="glyph">∑</span>', T('行间公式', 'Display math') + ' (' + K + 'Shift+M)', function () { insertSnippet('\\begin{equation}\n  $|\n\\end{equation}') }, { keepFocus: true }),
      tb(ICON.sect + ICON.caret, T('章节', 'Sections'), function (e) { openSectionMenu(e.currentTarget) }, { keepFocus: true }),
      tb(ICON.list + ICON.caret, T('列表', 'Lists'), function (e) { openListMenu(e.currentTarget) }, { keepFocus: true, cls: 'opt' }),
      tb(ICON.plus + ICON.caret, T('插入', 'Insert'), function (e) { openInsertMenu(e.currentTarget) }, { keepFocus: true })
    )

    var vseg = el('div', { class: 'seg', id: 'viewSeg', role: 'group', 'aria-label': T('预览方式', 'Preview') })
    ;[
      ['live', T('即时', 'Live'), T('即时预览：在浏览器里直接排版，不需要安装 TeX', 'Live preview: typeset in the browser, no TeX needed')],
      ['pdf', 'PDF', T('PDF：用本机 TeX 编译后的真实结果', 'PDF: the real output compiled by your TeX')]
    ].forEach(function (x) {
      var b = el('button', { type: 'button', class: settings.view === x[0] ? 'on' : null, title: x[2], 'aria-pressed': String(settings.view === x[0]) }, x[1])
      b.addEventListener('click', function () {
        setView(x[0])
      })
      vseg.append(b)
    })

    var busy = !!compiling
    var compileBtn = tb(busy ? ICON.spin : ICON.play, T('编译成 PDF', 'Compile to PDF') + ' (' + K + 'Enter)', compile, { cls: 'primary' + (busy ? ' busy' : ''), label: busy ? T('编译中', 'Compiling') : T('编译', 'Compile') })
    var errs = problems.filter(function (p) { return p.severity === 'error' }).length
    var warns = problems.filter(function (p) { return p.severity === 'warning' }).length
    var probBtn = tb(ICON.warn, T('编译日志：错误和警告', 'Compile log: errors and warnings'), function () { toggleProblems() }, { on: showProblems })
    if (errs) probBtn.append(el('span', { class: 'badge err', text: String(errs) }))
    else if (warns) probBtn.append(el('span', { class: 'badge warn', text: String(warns) }))

    bar.replaceChildren(
      seg,
      el('span', { class: 'sep', id: 'fmtSep' }),
      fmt,
      el('span', { class: 'sp' }),
      vseg,
      compileBtn,
      tb(ICON.caret, T('编译引擎', 'TeX engine'), function (e) { openEngineMenu(e.currentTarget) }, { cls: 'eng' }),
      el('span', { class: 'sep' }),
      tb(ICON.outline, T('大纲', 'Outline'), function (e) { openOutline(e.currentTarget) }),
      probBtn,
      tb(ICON.gear, T('设置', 'Settings'), function (e) { openSettings(e.currentTarget) }, { id: 'setBtn' }),
      tb(ICON.exportI, T('导出', 'Export'), function (e) { openExportMenu(e.currentTarget) }),
      tb(ICON.text, T('用文本编辑器打开', 'Open in text editor'), function () { studio.openText() })
    )
  }

  /* ================= 弹出菜单 ================= */

  var menuOwner = null
  function closeMenu() {
    menuEl.hidden = true
    menuOwner = null
  }
  function openMenu(anchor, build, above) {
    if (menuOwner === anchor && !menuEl.hidden) return closeMenu()
    menuEl.replaceChildren()
    menuEl.style.minWidth = ''
    menuEl.style.width = ''
    build(menuEl)
    menuEl.hidden = false
    menuOwner = anchor
    var r = anchor.getBoundingClientRect()
    var w = menuEl.offsetWidth
    var h = menuEl.offsetHeight
    var top = above ? r.top - h - 6 : r.bottom + 6
    if (!above && top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
    menuEl.style.top = Math.max(8, top) + 'px'
    var left = r.left
    if (left + w > window.innerWidth - 8) left = r.right - w
    menuEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + 'px'
  }
  document.addEventListener('mousedown', function (e) {
    if (menuEl.hidden) return
    if (menuEl.contains(e.target) || (menuOwner && menuOwner.contains(e.target))) return
    closeMenu()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menuEl.hidden) {
      closeMenu()
      e.preventDefault()
    }
  })
  window.addEventListener('blur', closeMenu)

  function menuItem(label, desc, fn, opts) {
    opts = opts || {}
    var b = el('button', { type: 'button', class: 'mi' }, opts.check != null ? el('span', { class: 'ck', html: opts.check ? ICON.check : '' }) : null, el('span', { text: label }), desc ? (opts.code ? el('code', { class: 'desc', text: desc }) : el('span', { class: 'desc', text: desc })) : null)
    b.addEventListener('mousedown', function (e) {
      e.preventDefault()
    })
    b.addEventListener('click', function () {
      closeMenu()
      fn()
    })
    return b
  }

  function openSectionMenu(anchor) {
    openMenu(anchor, function (m) {
      ;[
        ['part', T('部分', 'Part')],
        ['chapter', T('章', 'Chapter')],
        ['section', T('节', 'Section')],
        ['subsection', T('小节', 'Subsection')],
        ['subsubsection', T('小小节', 'Subsubsection')],
        ['paragraph', T('段落标题', 'Paragraph')]
      ].forEach(function (x) {
        m.append(
          menuItem(x[1], '\\' + x[0] + '{}', function () {
            var v = srcEl.value
            var a = srcEl.selectionStart
            var b = srcEl.selectionEnd
            var sel = v.slice(a, b)
            // 当前行已经是章节命令：换级别
            var r = lineRange()
            var line = v.slice(r[0], r[1])
            var mm = /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)/.exec(line)
            if (mm && !sel) {
              replaceRange(r[0], r[0] + mm[0].length, mm[1] + '\\' + x[0] + mm[3])
              return
            }
            insertSnippet('\\' + x[0] + '{$|}')
          }, { code: true })
        )
      })
    })
  }
  function openListMenu(anchor) {
    openMenu(anchor, function (m) {
      m.append(menuItem(T('无序列表', 'Bulleted list'), 'itemize', function () { insertSnippet(listSnippet('itemize')) }, { code: true }))
      m.append(menuItem(T('编号列表', 'Numbered list'), 'enumerate', function () { insertSnippet(listSnippet('enumerate')) }, { code: true }))
      m.append(menuItem(T('描述列表', 'Description'), 'description', function () { insertSnippet('\\begin{description}\n  \\item[$|] \n\\end{description}') }, { code: true }))
      m.append(el('hr'))
      m.append(menuItem(T('列表项', 'Item'), '\\item', function () { insertSnippet('\\item $|') }, { code: true }))
    })
  }
  /** 选中的多行变成列表项 */
  function listSnippet(env) {
    var v = srcEl.value
    var sel = v.slice(srcEl.selectionStart, srcEl.selectionEnd)
    if (sel && sel.indexOf('\n') >= 0) {
      var items = sel
        .split('\n')
        .filter(function (l) { return l.trim() })
        .map(function (l) { return '  \\item ' + l.trim() })
        .join('\n')
      replaceRange(srcEl.selectionStart, srcEl.selectionEnd, '')
      return '\\begin{' + env + '}\n' + items + '$|\n\\end{' + env + '}'
    }
    return '\\begin{' + env + '}\n  \\item $|\n\\end{' + env + '}'
  }
  function openInsertMenu(anchor) {
    openMenu(anchor, function (m) {
      var add = function (label, code, snip) {
        m.append(menuItem(label, code, function () { insertSnippet(snip) }, { code: true }))
      }
      m.append(el('div', { class: 'hd', text: T('公式', 'MATH') }))
      add(T('编号公式', 'Numbered equation'), 'equation', '\\begin{equation}\n  $|\n\\end{equation}')
      add(T('多行对齐公式', 'Aligned equations'), 'align', '\\begin{align}\n  $| &= \\\\\n   &= \n\\end{align}')
      add(T('分段函数', 'Cases'), 'cases', '\\begin{equation}\n  f(x) = \\begin{cases}\n    $| & \\text{if } x > 0 \\\\\n    0 & \\text{otherwise}\n  \\end{cases}\n\\end{equation}')
      add(T('矩阵', 'Matrix'), 'pmatrix', '\\begin{pmatrix}\n  $|a & b \\\\\n  c & d\n\\end{pmatrix}')
      m.append(el('hr'))
      m.append(el('div', { class: 'hd', text: T('图表', 'FIGURES & TABLES') }))
      add(T('图片', 'Figure'), 'figure', ENV_SNIPPET.figure)
      add(T('表格', 'Table'), 'table', ENV_SNIPPET.table)
      add(T('并排子图', 'Subfigures'), 'subfigure', '\\begin{figure}[htbp]\n  \\centering\n  \\begin{subfigure}{0.48\\linewidth}\n    \\centering\n    \\includegraphics[width=\\linewidth]{$|}\n    \\caption{}\n  \\end{subfigure}\n  \\hfill\n  \\begin{subfigure}{0.48\\linewidth}\n    \\centering\n    \\includegraphics[width=\\linewidth]{}\n    \\caption{}\n  \\end{subfigure}\n  \\caption{}\n\\end{figure}')
      m.append(el('hr'))
      m.append(el('div', { class: 'hd', text: T('结构', 'STRUCTURE') }))
      add(T('定理', 'Theorem'), 'theorem', ENV_SNIPPET.theorem)
      add(T('证明', 'Proof'), 'proof', ENV_SNIPPET.proof)
      add(T('代码', 'Code'), 'lstlisting', ENV_SNIPPET.lstlisting)
      add(T('目录', 'Table of contents'), '\\tableofcontents', '\\tableofcontents\n$|')
      add(T('换页', 'Page break'), '\\newpage', '\\newpage\n$|')
      m.append(el('hr'))
      m.append(el('div', { class: 'hd', text: T('引用', 'REFERENCES') }))
      add(T('标签', 'Label'), '\\label', '\\label{$|}')
      add(T('交叉引用', 'Cross-reference'), '\\ref', '\\ref{$|}')
      add(T('引用文献', 'Citation'), '\\cite', '\\cite{$|}')
      add(T('脚注', 'Footnote'), '\\footnote', '\\footnote{$|}')
      add(T('链接', 'Link'), '\\href', '\\href{$|}{}')
    })
  }

  function openEngineMenu(anchor, above) {
    openMenu(anchor, function (m) {
      var mg = TexTools.magic(text).program
      m.append(el('div', { class: 'hd', text: T('编译引擎', 'TEX ENGINE') }))
      ENGINES.forEach(function (e) {
        m.append(
          menuItem(engineName(e), T(e.zh, e.en), function () {
            settings.engine = e.id
            saveSettings()
            if (e.id === 'custom' && !settings.custom.trim()) openSettings(bar.querySelector('#setBtn'))
            buildBar()
            renderStatus()
            if (settings.view === 'pdf' && !pdf.doc) showPdfEmpty()
          }, { check: settings.engine === e.id })
        )
      })
      if (mg) m.append(el('div', { class: 'note', text: T('这个文件用 % !TEX program = ' + mg + ' 指定了引擎，编译时以它为准。', 'This file sets % !TEX program = ' + mg + ', which takes precedence.') }))
    }, above)
  }

  function switchRow(label, key, after) {
    var sw = el('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(!!settings[key]), 'aria-label': label })
    sw.addEventListener('click', function () {
      settings[key] = !settings[key]
      sw.setAttribute('aria-checked', String(settings[key]))
      saveSettings()
      if (after) after()
    })
    return el('div', { class: 'row' }, el('span', { text: label }), sw)
  }
  function rangeRow(label, min, max, step, get, set, fmt) {
    var val = el('span', { class: 'val', text: fmt(get()) })
    var r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()), 'aria-label': label })
    r.addEventListener('input', function () {
      set(Number(r.value))
      val.textContent = fmt(Number(r.value))
    })
    return [el('div', { class: 'row' }, el('span', { text: label }), val), el('div', { class: 'row', style: 'padding-top:0' }, r)]
  }

  function openSettings(anchor) {
    if (!anchor) return
    openMenu(anchor, function (m) {
      m.style.width = '300px'
      m.append(el('div', { class: 'hd', text: T('编辑器', 'EDITOR') }))
      rangeRow(T('字号', 'Font size'), 11, 22, 1, function () { return settings.fontSize }, function (v) {
        settings.fontSize = v
        main.style.setProperty('--efs', v + 'px')
        saveSettings()
      }, function (v) { return v + ' px' }).forEach(function (x) { m.append(x) })
      m.append(switchRow(T('自动换行', 'Word wrap'), 'wrap', applySettings))
      m.append(switchRow(T('自动补全括号和 $', 'Auto-close brackets and $'), 'autoClose'))
      m.append(switchRow(T('命令补全提示', 'Command suggestions'), 'complete'))
      m.append(el('hr'))
      m.append(el('div', { class: 'hd', text: T('预览', 'PREVIEW') }))
      rangeRow(T('缩放', 'Zoom'), 0.6, 2.2, 0.1, function () { return settings.zoom }, setZoom, function (v) { return Math.round(v * 100) + '%' }).forEach(function (x) { m.append(x) })
      var seg = el('div', { class: 'seg' })
      ;[
        ['white', T('白纸', 'White')],
        ['sepia', T('护眼', 'Sepia')],
        ['dark', T('深色', 'Dark')]
      ].forEach(function (x) {
        var b = el('button', { type: 'button', class: settings.paper === x[0] ? 'on' : null }, x[1])
        b.addEventListener('click', function () {
          settings.paper = x[0]
          saveSettings()
          seg.querySelectorAll('button').forEach(function (o) {
            o.classList.toggle('on', o === b)
          })
          pageEl.dataset.paper = x[0]
          pdfPagesEl.dataset.paper = x[0]
        })
        seg.append(b)
      })
      m.append(el('div', { class: 'row', style: 'padding-bottom:2px' }, el('span', { text: T('纸张', 'Paper') })), seg)
      m.append(el('hr'))
      m.append(el('div', { class: 'hd', text: T('编译', 'COMPILE') }))
      m.append(switchRow(T('PDF 模式下保存时自动编译', 'Compile on save (PDF mode)'), 'autoCompile'))
      var input = el('input', { type: 'text', value: settings.custom, placeholder: 'latexmk -pdf -synctex=1 "{file}"', spellcheck: 'false', 'aria-label': T('自定义编译命令', 'Custom compile command') })
      input.addEventListener('change', function () {
        settings.custom = input.value
        if (input.value.trim()) settings.engine = 'custom'
        saveSettings()
        buildBar()
        renderStatus()
      })
      m.append(el('div', { class: 'row', style: 'padding-bottom:2px' }, el('span', { text: T('自定义编译命令', 'Custom command') })), el('div', { class: 'row', style: 'padding-top:0' }, input))
      m.append(el('div', { class: 'note', text: T('{file} 是主文件名，{base} 是不带扩展名的文件名。在主文件所在目录运行。', '{file} is the main file name, {base} the name without extension. Runs in the main file’s folder.') }))
      m.append(el('hr'))
      m.append(el('div', { class: 'note', html: esc(T('快捷键：', 'Shortcuts: ')) + '<br>' + [
        [K + 'Enter', T('编译', 'Compile')],
        [K + 'Alt+J', T('在 PDF 中定位', 'Find in PDF')],
        [K + 'B / I / U / E', T('粗体 / 斜体 / 下划线 / 强调', 'Bold / italic / underline / emph')],
        [K + 'M', T('行内公式', 'Inline math')],
        [K + '/', T('注释', 'Comment')],
        [K + 'Space', T('补全', 'Suggestions')],
        [K + 'F / H', T('查找 / 替换', 'Find / replace')],
        [T('双击预览', 'Double-click preview'), T('跳到源码', 'Go to source')]
      ].map(function (x) { return '<code>' + esc(x[0]) + '</code> ' + esc(x[1]) }).join('<br>') }))
    })
  }

  function openExportMenu(anchor) {
    openMenu(anchor, function (m) {
      m.append(menuItem(T('导出 HTML（即时预览）', 'Export HTML (live preview)'), '', exportHtml))
      m.append(menuItem(T('导出 PDF（编译结果）', 'Export PDF (compiled)'), '', exportPdf))
      m.append(el('hr'))
      m.append(menuItem(T('复制为纯文本', 'Copy as plain text'), '', function () {
        if (!lastRender) renderLiveForce()
        var t = pageEl.innerText
        if (studio.has('clipboard.writeText')) studio.clipboard.writeText(t).then(function () { studio.toast(T('已复制', 'Copied')) })
      }))
    })
  }
  function renderLiveForce() {
    var v = settings.view
    var md = settings.mode
    settings.view = 'live'
    if (md === 'source') settings.mode = 'split'
    renderLive()
    settings.view = v
    settings.mode = md
  }

  /* ================= 导出 ================= */

  function blobToDataUrl(url) {
    return fetch(url)
      .then(function (r) {
        return r.blob()
      })
      .then(function (b) {
        return new Promise(function (res) {
          var fr = new FileReader()
          fr.onload = function () {
            res(fr.result)
          }
          fr.onerror = function () {
            res('')
          }
          fr.readAsDataURL(b)
        })
      })
  }

  async function exportHtml() {
    if (!lastRender || pendingLive) renderLiveForce()
    try {
      var clone = pageEl.cloneNode(true)
      var imgs = Array.prototype.slice.call(clone.querySelectorAll('img[src^="blob:"]'))
      await Promise.all(
        imgs.map(function (img) {
          return blobToDataUrl(img.src).then(function (d) {
            if (d) img.src = d
          })
        })
      )
      clone.querySelectorAll('[data-line]').forEach(function (x) {
        x.removeAttribute('data-line')
      })
      var css = await fetch('latex.css').then(function (r) {
        return r.text()
      })
      // 只要纸张部分的样式
      var pageCss = css.slice(css.indexOf('/* ================= 预览：纸张'), css.indexOf('/* ================= PDF'))
      var title = (lastRender && lastRender.title) || stripExt(fileName)
      var html =
        '<!doctype html>\n<html lang="' + (lastRender && lastRender.lang === 'zh' ? 'zh-CN' : 'en') + '">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n' +
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">\n<style>\n:root{--zoom:1}\nbody{margin:0;background:#e6e7ea;padding:32px 16px}\n' + pageCss + '\n.tex-page{cursor:auto}\n@media print{body{background:#fff;padding:0}.tex-page{box-shadow:none;width:auto;padding:0}}\n</style>\n</head>\n<body>\n<article class="tex-page" data-lang="' + (pageEl.dataset.lang || 'en') + '" data-paper="white">' + clone.innerHTML + '</article>\n</body>\n</html>\n'
      await studio.exportFile(stripExt(fileName) + '.html', html)
    } catch (err) {
      studio.toast(T('导出失败：', 'Export failed: ') + (err && err.message))
    }
  }

  async function exportPdf() {
    var ri = rootInfo()
    var p = pdfPathOf(ri)
    var st = await studio.fs.stat(p).catch(function () {
      return null
    })
    if (!st) {
      studio.toast(T('还没有 PDF，请先编译', 'No PDF yet — compile first'))
      return
    }
    var buf = await studio.fs.read(p)
    if (studio.has('dialog.save')) studio.dialog.save(ri.base + '.pdf', buf).catch(function () {})
    else studio.exportFile(ri.base + '.pdf', buf)
  }

  /* ================= 和 IDE 的连接 ================= */

  studio.onLoad(function (content, info) {
    var hasCr = content.indexOf('\r\n') >= 0
    var hasBom = content.charCodeAt(0) === 0xfeff
    var norm = (hasBom ? content.slice(1) : content).replace(/\r\n?/g, '\n')
    var samePath = info && info.path === absPath
    // 自己保存后磁盘变化引起的重新加载：内容一样就不动
    if (loaded && samePath && norm === text) {
      savedText = norm
      studio.setDirty(false)
      return
    }
    eol = hasCr ? '\r\n' : '\n'
    bom = hasBom ? '\ufeff' : ''
    absPath = (info && info.path) || ''
    relPath = (info && info.relPath) || '/' + ((info && info.fileName) || 'main.tex')
    fileName = (info && info.fileName) || fileName
    var absN = TexTools.normPath(absPath)
    wsRoot = absN.length > relPath.length && absN.toLowerCase().slice(-relPath.length) === relPath.toLowerCase() ? absN.slice(0, absN.length - relPath.length) : ''
    document.title = fileName
    text = savedText = norm
    var keepSel = samePath ? [srcEl.selectionStart, srcEl.selectionEnd] : null
    var keepSrc = samePath ? srcScroll.scrollTop : 0
    var keepView = samePath ? liveScroll.scrollTop : 0
    srcEl.value = norm
    loaded = true
    applySettings()
    renderSource()
    refreshOutlineCache()
    updateWordCount()
    pendingLive = true
    if (settings.mode !== 'source') {
      if (settings.view === 'live') renderLive()
      else loadPdf(false)
    }
    srcScroll.scrollTop = keepSrc
    liveScroll.scrollTop = keepView
    if (keepSel) srcEl.setSelectionRange(Math.min(keepSel[0], norm.length), Math.min(keepSel[1], norm.length))
    if (!samePath) {
      srcEl.focus({ preventScroll: true })
      reloadLogSoon()
      registerCommands()
    }
    updateCursorStatus()
  })

  studio.onSave(function () {
    sentText = text
    return bom + (eol === '\n' ? text : text.replace(/\n/g, eol))
  })

  studio.onSaved(function () {
    if (sentText != null) savedText = sentText
    sentText = null
    if (text !== savedText) studio.setDirty(true)
    if (settings.autoCompile && settings.view === 'pdf' && settings.mode !== 'source' && !compiling) compile()
  })

  studio.onShow(function () {
    if (settings.view === 'pdf' && settings.mode !== 'source' && !compiling) loadPdf(false)
  })

  /* ================= AI 工具（IDE 里的 AI 助手调用） ================= */

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms)
    })
  }
  function problemList(list, max) {
    return list.slice(0, max).map(function (p) {
      var o = { severity: p.severity, message: p.message }
      if (p.path) o.file = p.path.replace(/^\//, '')
      if (p.line) o.line = p.line
      return o
    })
  }
  function compileSummary() {
    var errs = problems.filter(function (p) { return p.severity === 'error' })
    var warns = problems.filter(function (p) { return p.severity === 'warning' })
    var ri = rootInfo()
    return {
      mainFile: ri.root.replace(/^\//, ''),
      pdf: pdfPathOf(ri).replace(/^\//, ''),
      lastCompile: lastCompile ? { ok: lastCompile.ok, pdfWritten: lastCompile.pdf, seconds: +lastCompile.secs, at: lastCompile.at.toISOString() } : null,
      errors: problemList(errs, 50),
      warnings: problemList(warns, 30),
      badBoxes: problems.length - errs.length - warns.length
    }
  }

  studio.tools.register('compile', async function () {
    if (!studio.has('terminal.run')) throw new Error('This version of Infinite Studio cannot run the TeX compiler')
    if (compiling) throw new Error('A compile is already running; wait for it and call latex_getProblems')
    var notes = []
    var orig = studio.toast
    studio.toast = function (m) {
      notes.push(String(m))
      orig(m)
    }
    var before = lastCompile
    try {
      await compile()
    } finally {
      studio.toast = orig
    }
    // compile() 启动终端命令后就返回了：等日志 / PDF 出来
    var t0 = Date.now()
    while (compiling && Date.now() - t0 < 14 * 60 * 1000) await sleep(400)
    if (lastCompile === before) {
      var why = notes.join(' ') || (compileState && compileState.text) || 'unknown reason'
      throw new Error('The compile did not run or produced no result: ' + why + '. If TeX is not installed, the user can install TeX Live / MiKTeX, or use Tectonic.')
    }
    var out = compileSummary()
    out.engine = engineName(engineFor(rootInfo().program))
    if (!out.lastCompile.pdfWritten) out.note = 'No new PDF was written; see errors (and the IDE terminal for the full output).'
    return out
  })

  studio.tools.register('getProblems', function () {
    var out = compileSummary()
    if (lastRender && lastRender.warnings.length)
      out.livePreviewWarnings = lastRender.warnings.slice(0, 30).map(function (w) {
        return w.kind + (w.cmd ? ' \\' + w.cmd : '') + (w.count > 1 ? ' ×' + w.count : '')
      })
    return out
  })

  studio.tools.register('getOutline', function () {
    refreshOutlineCache()
    var ri = rootInfo()
    return {
      file: relPath.replace(/^\//, ''),
      mainFile: ri.root.replace(/^\//, ''),
      engine: engineName(engineFor(ri.program)),
      words: wordCount,
      sections: outline.map(function (o) {
        return { level: ['part', 'chapter', 'section', 'subsection', 'subsubsection'][o.level], title: o.title, line: o.line + 1, starred: o.star || undefined }
      }),
      labels: labelsNow(),
      bibKeys: bibKeysNow()
    }
  })

  studio.tools.register('screenshot', async function (a) {
    var view = a.view === 'pdf' || a.view === 'live' || a.view === 'source' ? a.view : null
    if (view === 'source') setMode('source')
    else {
      if (settings.mode === 'source') setMode('split')
      if (view) setView(view)
    }
    if (settings.view === 'pdf' && settings.mode !== 'source') await loadPdf(false)
    await sleep(80)
    var line = Math.floor(Number(a.line))
    if (line > 0) {
      if (settings.mode !== 'preview') jumpToLine(line - 1)
      if (settings.view === 'live' && settings.mode !== 'source') scrollLiveToLine(line - 1)
      if (settings.view === 'pdf' && settings.mode !== 'source') await syncToPdf().catch(function () {})
    }
    await sleep(200)
    return (settings.mode === 'source' ? 'Source' : settings.view === 'pdf' ? 'PDF preview' : 'Live preview') + (line > 0 ? ' at line ' + line : '')
  })

  var commandsDone = false
  function registerCommands() {
    if (commandsDone || !studio.has('commands.register')) return
    commandsDone = true
    var reg = function (id, title, fn) {
      studio.commands.register(id, title, fn).catch(function () {})
    }
    reg('compile', T('编译成 PDF', 'Compile to PDF'), compile)
    reg('sync', T('在 PDF 中定位光标所在行', 'Show the cursor line in the PDF'), syncToPdf)
    reg('view-live', T('切换到即时预览', 'Switch to live preview'), function () { setView('live') })
    reg('view-pdf', T('切换到 PDF 预览', 'Switch to PDF preview'), function () { setView('pdf') })
    reg('export-html', T('导出 HTML', 'Export HTML'), exportHtml)
    reg('export-pdf', T('导出 PDF', 'Export PDF'), exportPdf)
    reg('log', T('显示编译日志', 'Show compile log'), function () { toggleProblems(true) })
    if (studio.has('agent.send')) {
      reg('ask-ai', T('请 AI 助手修复编译错误', 'Ask the AI assistant to fix the compile errors'), function () {
        var errs = problems.filter(function (p) { return p.severity === 'error' })
        var lines = errs.slice(0, 20).map(function (p) {
          return '- ' + (p.path ? p.path.replace(/^\//, '') : '') + (p.line ? ':' + p.line : '') + ' ' + p.message
        })
        var msg = errs.length ? T('编译 LaTeX 时出现了这些错误，请帮我修复：', 'Compiling this LaTeX file failed with these errors, please fix them:') + '\n' + lines.join('\n') : T('请检查这个 LaTeX 文件。', 'Please review this LaTeX file.')
        studio.agent.send(msg, { file: true }).catch(function (e) { studio.toast(e.message) })
      })
    }
  }

  // 页面里的快捷键（焦点不在编辑器时也有效）
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'Enter' && e.target !== srcEl) {
      e.preventDefault()
      compile()
    } else if (mod && e.altKey && (e.key === 'j' || e.key === 'J' || e.code === 'KeyJ') && e.target !== srcEl) {
      e.preventDefault()
      syncToPdf()
    } else if (mod && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F') && e.target !== srcEl && !findBar.contains(e.target)) {
      e.preventDefault()
      openFind(false)
    }
  })

  applySettings()
  renderSource()
  renderStatus()
})()
