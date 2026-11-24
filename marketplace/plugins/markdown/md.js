/* Markdown 美化 —— Infinite Studio 插件 */
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
  var docScroll = $('#docScroll')
  var docEl = $('#doc')
  var olList = $('#olList')
  var olStats = $('#olStats')
  var progressEl = $('#progress i')
  var menuEl = $('#menu')

  /* ---------------- 设置（保存在插件自己的 localStorage） ---------------- */

  var DEFAULTS = { mode: 'read', theme: 'auto', fontSize: 15, width: 'mid', number: true, lineNo: true, outline: true }
  var WIDTHS = { narrow: 640, mid: 760, wide: 960, full: 0 }
  var settings = (function () {
    var s = {}
    try {
      s = JSON.parse(localStorage.getItem('md-settings') || '{}') || {}
    } catch (e) {
      s = {}
    }
    var out = {}
    for (var k in DEFAULTS) out[k] = s[k] !== undefined && typeof s[k] === typeof DEFAULTS[k] ? s[k] : DEFAULTS[k]
    return out
  })()
  function saveSettings() {
    try {
      localStorage.setItem('md-settings', JSON.stringify(settings))
    } catch (e) {
      /* 忽略 */
    }
  }

  var THEMES = [
    { id: 'auto', zh: '跟随 IDE', en: 'Follow IDE', dz: '深浅色自动切换', de: 'Light / dark with the IDE' },
    { id: 'ink', zh: '墨夜', en: 'Ink', dz: '深色', de: 'Dark', dot: '#e08a5f', bg: '#1b1c1f' },
    { id: 'paper', zh: '纸白', en: 'Paper', dz: '浅色', de: 'Light', dot: '#c2552b', bg: '#fbfbfa' },
    { id: 'book', zh: '书卷', en: 'Book', dz: '衬线，适合长文', de: 'Serif, for long reads', dot: '#8b5a2b', bg: '#f5efe3' },
    { id: 'terminal', zh: '终端', en: 'Terminal', dz: '等宽，保留标记', de: 'Monospace', dot: '#4fd18b', bg: '#0f1412' }
  ]

  /* ---------------- 文件状态 ---------------- */

  var text = '' // 编辑中的内容（换行统一为 \n）
  var savedText = ''
  var sentText = null
  var eol = '\n'
  var bom = ''
  var filePath = ''
  var fileName = 'README.md'
  var loaded = false

  /* ---------------- 图标 ---------------- */

  function svg(d, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + d + '</svg>'
  }
  var ICON = {
    h: svg('<path d="M5 5v14M14 5v14M5 12h9M18 10l2-1v10"/>'),
    quote: svg('<path d="M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6"/>'),
    ul: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
    ol: svg('<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 14.5c0-1 .8-1.5 1.5-1.5s1.5.5 1.5 1.3c0 1.2-3 2.2-3 3.7h3"/>'),
    task: svg('<rect x="3.5" y="4.5" width="7" height="7" rx="1.5"/><path d="M5.3 8l1.3 1.3L9 6.8M14 8h7M3.5 15.5h7v4h-7zM14 17.5h7"/>'),
    code: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M10 9.5v10"/>'),
    mark: svg('<path d="M4 20h16"/><path d="M14.5 4.5l4 4L10 17H6v-4z"/>'),
    outline: svg('<path d="M4 6h16M8 12h12M8 18h12"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    exportI: svg('<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>'),
    text: svg('<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>'),
    copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8.5"/>'),
    note: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', ' stroke-width="2"'),
    tip: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>', ' stroke-width="2"'),
    important: svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v10a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/><path d="M12 7.5v4.5M12 14.5v.5"/>', ' stroke-width="2"'),
    warning: svg('<path d="M10.3 4.3L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17v.5"/>', ' stroke-width="2"'),
    caution: svg('<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M12 8v5M12 16v.5"/>', ' stroke-width="2"')
  }
  var CALLOUT = {
    note: ['提示', 'Note'],
    info: ['提示', 'Info'],
    tip: ['技巧', 'Tip'],
    hint: ['技巧', 'Hint'],
    important: ['重要', 'Important'],
    warning: ['注意', 'Warning'],
    attention: ['注意', 'Attention'],
    caution: ['警告', 'Caution'],
    danger: ['危险', 'Danger'],
    bug: ['问题', 'Bug']
  }
  var CALLOUT_KIND = { info: 'note', hint: 'tip', attention: 'warning', danger: 'caution', bug: 'caution' }

  /* ---------------- 小工具 ---------------- */

  function el(tag, attrs) {
    var e = document.createElement(tag)
    if (attrs)
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null || v === false) continue
        if (k === 'html') e.innerHTML = v
        else if (k === 'text') e.textContent = v
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2).toLowerCase(), v)
        else e.setAttribute(k, v === true ? '' : v)
      }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]
      if (c == null) continue
      e.append(c)
    }
    return e
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function debounce(fn, ms) {
    var t = 0
    return function () {
      clearTimeout(t)
      t = setTimeout(fn, ms)
    }
  }
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(s).catch(function () {
        fallbackCopy(s)
      })
    fallbackCopy(s)
    return Promise.resolve()
  }
  function fallbackCopy(s) {
    var ta = el('textarea')
    ta.value = s
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }

  /* ---------------- Markdown 解析 ---------------- */

  // ==高亮==
  marked.use({
    gfm: true,
    breaks: false,
    extensions: [
      {
        name: 'mark',
        level: 'inline',
        start: function (src) {
          var i = src.indexOf('==')
          return i < 0 ? undefined : i
        },
        tokenizer: function (src) {
          var m = /^==(?=\S)([\s\S]*?\S)==(?!=)/.exec(src)
          if (m) return { type: 'mark', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) }
        },
        renderer: function (tok) {
          return '<mark>' + this.parser.parseInline(tok.tokens) + '</mark>'
        }
      }
    ],
    renderer: {
      // 图片先不给 src：相对路径要通过 IDE 读取，远程图片插件不能加载
      image: function (tok) {
        return '<img data-src="' + esc(tok.href || '') + '" alt="' + esc(tok.text || '') + '"' + (tok.title ? ' title="' + esc(tok.title) + '"' : '') + '>'
      }
    }
  })

  function frontMatter(src) {
    var m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src)
    if (!m) return { meta: null, body: src, lines: 0 }
    var meta = []
    var last = null
    m[1].split('\n').forEach(function (line) {
      var li = /^\s+-\s+(.*)$/.exec(line)
      if (li && last) {
        if (!Array.isArray(last.value)) last.value = last.value ? [last.value] : []
        last.value.push(unquote(li[1]))
        return
      }
      var kv = /^([\w\-. ]+?)\s*:\s*(.*)$/.exec(line)
      if (!kv) return
      var v = kv[2].trim()
      if (/^\[.*\]$/.test(v))
        v = v
          .slice(1, -1)
          .split(',')
          .map(function (x) {
            return unquote(x.trim())
          })
          .filter(Boolean)
      else v = unquote(v)
      last = { key: kv[1].trim(), value: v }
      meta.push(last)
    })
    return { meta: meta, body: src.slice(m[0].length), lines: m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0) }
  }
  function unquote(s) {
    return s.replace(/^(['"])(.*)\1$/, '$2')
  }

  function slug(s) {
    return (
      s
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-') || 'section'
    )
  }

  var CN_NUM = '零一二三四五六七八九十'
  function cnNum(n) {
    if (n <= 10) return CN_NUM[n]
    if (n < 20) return '十' + CN_NUM[n - 10]
    if (n < 100) return CN_NUM[Math.floor(n / 10)] + '十' + (n % 10 ? CN_NUM[n % 10] : '')
    return String(n)
  }

  /* ---------------- 渲染 ---------------- */

  var blocks = [] // [{ line, el }] 预览里每个块对应的源码行（滚动同步用）
  var headings = [] // [{ el, level, label, text }]
  var assetUrls = new Map() // 相对路径 → blob URL
  var assetPending = new Map()

  function renderDoc() {
    var fm = frontMatter(text)
    var tokens
    try {
      tokens = marked.lexer(fm.body)
    } catch (e) {
      docEl.replaceChildren(el('pre', { text: String(e && e.message) }))
      return
    }
    var line = fm.lines
    var html = ''
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i]
      var start = line
      line += (tok.raw.match(/\n/g) || []).length
      if (tok.type === 'space') continue
      var one = [tok]
      one.links = tokens.links
      var inner
      try {
        inner = marked.parser(one)
      } catch (e) {
        inner = '<pre>' + esc(tok.raw) + '</pre>'
      }
      html += '<div class="blk" data-line="' + start + '">' + inner + '</div>'
    }
    var frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['data-src'], FORBID_TAGS: ['style'] })

    decorate(frag)

    var nodes = []
    if (fm.meta && fm.meta.length) nodes.push(metaCard(fm.meta))
    var titleMeta = fm.meta && fm.meta.find(function (x) { return x.key.toLowerCase() === 'title' && typeof x.value === 'string' })
    if (titleMeta && !frag.querySelector('h1')) {
      var h1 = el('h1', { text: titleMeta.value })
      nodes.push(el('div', { class: 'blk', 'data-line': '0' }, h1))
    }
    nodes.push(frag)
    if (!text.trim()) {
      nodes = [el('div', { class: 'empty' }, el('b', { text: T('空文档', 'Empty document') }), T('切换到“分栏”或“源码”开始写作', 'Switch to Split or Source to start writing'))]
    }
    docEl.replaceChildren.apply(docEl, nodes)

    // 标题、块的位置索引
    blocks = Array.prototype.map.call(docEl.querySelectorAll('.blk'), function (b) {
      return { line: Number(b.getAttribute('data-line')) || 0, el: b }
    })
    collectHeadings()
    buildOutline()
    loadImages()
    updateStats()
    updateProgress()
  }

  function metaCard(meta) {
    var card = el('div', { class: 'fm' })
    var chipKeys = { tags: 1, tag: 1, categories: 1, category: 1, keywords: 1, labels: 1 }
    var palette = ['var(--accent)', 'var(--c-note)', 'var(--c-tip)', 'var(--c-important)', 'var(--c-warning)']
    var ci = 0
    var info = []
    meta.forEach(function (m) {
      var k = m.key.toLowerCase()
      if (k === 'title') return
      if (chipKeys[k]) {
        var vals = Array.isArray(m.value) ? m.value : String(m.value).split(/[,，]\s*/)
        vals.filter(Boolean).forEach(function (v) {
          var c = el('span', { class: 'chip', text: v })
          c.style.setProperty('--chip', palette[ci++ % palette.length])
          card.append(c)
        })
      } else if (m.value !== '' && !(Array.isArray(m.value) && !m.value.length)) {
        info.push(Array.isArray(m.value) ? m.value.join(', ') : m.value)
      }
    })
    card.append(el('span', { class: 'grow' }))
    card.append(el('span', { text: info.slice(0, 4).join(' · ') + (info.length ? ' · ' : '') + readingTime() }))
    return card
  }

  function countText(s) {
    var cjk = (s.match(/[㐀-鿿豈-﫿]/g) || []).length
    var w = (s.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length
    return { cjk: cjk, words: w }
  }
  function readingTime() {
    var c = countText(text.replace(/```[\s\S]*?```/g, ''))
    var min = Math.max(1, Math.round(c.cjk / 400 + c.words / 220))
    return T('约 ' + min + ' 分钟读完', min + ' min read')
  }

  function decorate(root) {
    // 标题：id + 编号
    var hs = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
    var h1Count = 0
    hs.forEach(function (h) {
      if (h.tagName === 'H1') h1Count++
    })
    var base = h1Count <= 1 ? 2 : 1
    var counters = [0, 0, 0]
    var used = {}
    var book = main.dataset.theme === 'book'
    hs.forEach(function (h) {
      var level = Number(h.tagName[1])
      var id = slug(h.textContent)
      if (used[id] != null) id = id + '-' + ++used[id]
      else used[id] = 0
      h.id = id
      var d = level - base
      if (d < 0 || d > 2) return
      counters[d]++
      for (var j = d + 1; j < 3; j++) counters[j] = 0
      var label
      if (d === 0) label = book ? cnNum(counters[0]) + ' · ' : (counters[0] < 10 ? '0' : '') + counters[0]
      else label = counters.slice(0, d + 1).join('.')
      h.dataset.label = d === 0 && book ? cnNum(counters[0]) : label
      h.prepend(el('span', { class: 'hn', text: label }))
    })

    // 提示块 > [!NOTE]
    root.querySelectorAll('blockquote').forEach(function (bq) {
      var p = bq.firstElementChild
      if (!p || p.tagName !== 'P') return
      var tn = p.firstChild
      if (!tn || tn.nodeType !== 3) return
      var m = /^\s*\[!(\w+)\]([+-]?)[ \t]*([^\n]*)\n?/.exec(tn.nodeValue)
      if (!m) return
      var type = m[1].toLowerCase()
      if (!CALLOUT[type]) return
      var kind = CALLOUT_KIND[type] || type
      tn.nodeValue = tn.nodeValue.slice(m[0].length)
      // 去掉标记后，第一段开头可能剩下 <br>
      if (!m[3] && p.firstChild === tn && !tn.nodeValue && tn.nextSibling && tn.nextSibling.nodeName === 'BR') tn.nextSibling.remove()
      if (!p.textContent.trim() && !p.querySelector('img,code')) p.remove()
      var title = m[3].trim() || T(CALLOUT[type][0], CALLOUT[type][1])
      var box = el('div', { class: 'callout ' + kind }, el('div', { class: 'ct', html: ICON[kind] }, title))
      while (bq.firstChild) box.append(bq.firstChild)
      bq.replaceWith(box)
    })

    // 代码块
    root.querySelectorAll('pre > code').forEach(function (code) {
      var pre = code.parentNode
      var m = /language-([\w#+.-]+)/.exec(code.className || '')
      var lang = m ? m[1] : ''
      var src = code.textContent.replace(/\n$/, '')
      var lines = mdHighlight(src, lang)
      var c = el('code')
      c.innerHTML = lines
        .map(function (l) {
          return '<span class="l">' + l + '</span>'
        })
        .join('')
      var copyBtn = el('button', { type: 'button', html: ICON.copy, 'aria-label': T('复制代码', 'Copy code') }, T('复制', 'Copy'))
      copyBtn.addEventListener('click', function () {
        copyText(src).then(function () {
          copyBtn.innerHTML = ICON.check
          copyBtn.append(T('已复制', 'Copied'))
          setTimeout(function () {
            copyBtn.innerHTML = ICON.copy
            copyBtn.append(T('复制', 'Copy'))
          }, 1400)
        })
      })
      var head = el('div', { class: 'code-head' }, lang ? el('span', { class: 'lang', text: lang }) : null, el('span', { class: 'grow' }), el('span', { text: T(lines.length + ' 行', lines.length + ' lines') }), copyBtn)
      var box = el('div', { class: 'code' }, head, el('pre', {}, c))
      pre.replaceWith(box)
    })

    // 任务清单
    var idx = 0
    root.querySelectorAll('li > input[type="checkbox"], li > p:first-child > input[type="checkbox"]:first-child').forEach(function (cb) {
      var li = cb.closest('li')
      cb.removeAttribute('disabled')
      cb.dataset.task = String(idx++)
      li.classList.add('task')
      if (cb.checked) li.classList.add('done')
    })
    root.querySelectorAll('ul, ol').forEach(function (list) {
      var items = Array.prototype.filter.call(list.children, function (li) {
        return li.classList.contains('task')
      })
      if (items.length < 2) return
      var done = items.filter(function (li) {
        return li.classList.contains('done')
      }).length
      var pct = Math.round((done / items.length) * 100)
      var track = el('span', { class: 'track' }, el('i', { style: 'width:' + pct + '%' }))
      list.before(el('div', { class: 'tasks-bar' }, track, el('span', { text: T(done + ' / ' + items.length + ' 完成', done + ' / ' + items.length + ' done') })))
    })

    // 表格：横向滚动的外框
    root.querySelectorAll('table').forEach(function (t) {
      var w = el('div', { class: 'tbl' })
      t.replaceWith(w)
      w.append(t)
    })

    // 链接
    root.querySelectorAll('a[href]').forEach(function (a) {
      if (/^https?:\/\//i.test(a.getAttribute('href'))) a.classList.add('ext')
    })

    // 原始 HTML 里的 <img src>：同样改为延迟加载
    root.querySelectorAll('img[src]').forEach(function (img) {
      img.setAttribute('data-src', img.getAttribute('src'))
      img.removeAttribute('src')
    })
  }

  function loadImages() {
    docEl.querySelectorAll('img[data-src]').forEach(function (img) {
      var s = img.getAttribute('data-src')
      if (!s) return
      if (/^data:image\//i.test(s)) {
        img.src = s
        return
      }
      if (/^(https?:)?\/\//i.test(s)) {
        // 插件页面不能联网：显示为可点击的占位
        var a = el('a', { class: 'img-remote', href: s, title: s, html: ICON.image })
        a.append((img.getAttribute('alt') || T('图片', 'Image')) + ' · ' + T('远程图片，点击在浏览器中打开', 'Remote image, click to open in browser'))
        img.replaceWith(a)
        return
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        img.classList.add('broken')
        return
      }
      var cached = assetUrls.get(s)
      if (cached) {
        img.src = cached
        return
      }
      if (cached === null) {
        img.classList.add('broken')
        img.title = T('找不到图片：', 'Image not found: ') + s
        return
      }
      if (!assetPending.has(s)) {
        assetPending.set(
          s,
          studio
            .readAsset(s)
            .then(function (blob) {
              assetUrls.set(s, blob ? URL.createObjectURL(blob) : null)
            })
            .catch(function () {
              assetUrls.set(s, null)
            })
            .then(function () {
              assetPending.delete(s)
              loadImages()
              scheduleSync()
            })
        )
      }
    })
  }

  function clearAssets() {
    assetUrls.forEach(function (u) {
      if (u) URL.revokeObjectURL(u)
    })
    assetUrls.clear()
  }

  /* ---------------- 大纲、进度、统计 ---------------- */

  function collectHeadings() {
    headings = Array.prototype.map.call(docEl.querySelectorAll('h1,h2,h3,h4'), function (h) {
      var n = h.querySelector('.hn')
      return { el: h, level: Number(h.tagName[1]), label: h.dataset.label || '', text: (n ? h.textContent.slice(n.textContent.length) : h.textContent).trim() }
    })
  }

  var olButtons = []
  function buildOutline() {
    $('#outline .ol-title').textContent = T('大纲', 'OUTLINE')
    var minLevel = headings.reduce(function (m, h) {
      return Math.min(m, h.level)
    }, 9)
    olButtons = headings
      .filter(function (h) {
        return h.level - minLevel <= 2
      })
      .map(function (h) {
        var depth = h.level - minLevel
        var b = el('button', { type: 'button', class: 'd' + depth, title: h.text }, h.label && depth < 2 && main.dataset.number !== 'off' && main.dataset.theme !== 'terminal' ? el('span', { class: 'n', text: h.label.replace(/ · $/, '') }) : null, el('span', { class: 't', text: h.text }))
        b.addEventListener('click', function () {
          docScroll.scrollTo({ top: h.el.offsetTop + docEl.offsetTop - 16, behavior: 'smooth' })
        })
        b._h = h
        return b
      })
    if (!olButtons.length) olList.replaceChildren(el('div', { style: 'padding:4px 8px;color:var(--muted)', text: T('没有标题', 'No headings') }))
    else olList.replaceChildren.apply(olList, olButtons)
    updateActiveHeading()
  }

  function updateActiveHeading() {
    var top = docScroll.scrollTop - docEl.offsetTop + 40
    var cur = null
    for (var i = 0; i < olButtons.length; i++) {
      if (olButtons[i]._h.el.offsetTop <= top) cur = olButtons[i]
      else break
    }
    if (!cur && olButtons.length) cur = olButtons[0]
    olButtons.forEach(function (b) {
      b.classList.toggle('on', b === cur)
    })
  }

  function updateProgress() {
    var max = docScroll.scrollHeight - docScroll.clientHeight
    var p = max > 0 ? Math.min(1, Math.max(0, docScroll.scrollTop / max)) : 1
    progressEl.style.width = (p * 100).toFixed(1) + '%'
    var r = $('#olRead')
    if (r) r.textContent = T('已读 ', 'Read ') + Math.round(p * 100) + '%'
  }

  function updateStats() {
    var c = countText(docEl.textContent || '')
    var codeCount = docEl.querySelectorAll('.code').length
    var words = c.cjk + c.words
    olStats.replaceChildren(
      el('span', { text: T(words.toLocaleString() + ' 字', words.toLocaleString() + ' words') + (codeCount ? ' · ' + T(codeCount + ' 个代码块', codeCount + ' code blocks') : '') }),
      el('span', { text: readingTime() }),
      el('span', { id: 'olRead' })
    )
  }

  /* ---------------- 源码高亮（编辑器下层） ---------------- */

  var INLINE_RE = /(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1|(!?)\[([^\]\n]*)\]\(([^)\n]*)\)|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|~~(?=\S)([^\n]*?\S)~~|==(?=\S)([^\n]*?\S)==|(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|<\/?[A-Za-z][^>\n]*>|https?:\/\/[^\s<>()]+/g

  function m(s) {
    return '<span class="s-m">' + esc(s) + '</span>'
  }
  function inline(s) {
    var out = ''
    var last = 0
    INLINE_RE.lastIndex = 0
    var r
    while ((r = INLINE_RE.exec(s))) {
      var start = r.index
      var html
      if (r[1]) html = m(r[1]) + '<span class="s-c">' + esc(r[2]) + '</span>' + m(r[1])
      else if (r[5] !== undefined) html = m(r[3] + '[') + '<span class="s-link">' + esc(r[4]) + '</span>' + m('](') + '<span class="s-url">' + esc(r[5]) + '</span>' + m(')')
      else if (r[6] !== undefined) html = m('**') + '<span class="s-b">' + esc(r[6]) + '</span>' + m('**')
      else if (r[7] !== undefined) html = m('__') + '<span class="s-b">' + esc(r[7]) + '</span>' + m('__')
      else if (r[8] !== undefined) html = m('~~') + '<span class="s-del">' + esc(r[8]) + '</span>' + m('~~')
      else if (r[9] !== undefined) html = m('==') + '<span class="s-mark">' + esc(r[9]) + '</span>' + m('==')
      else if (r[11] !== undefined) html = esc(r[10]) + m('*') + '<span class="s-i">' + esc(r[11]) + '</span>' + m('*')
      else if (r[13] !== undefined) html = esc(r[12]) + m('_') + '<span class="s-i">' + esc(r[13]) + '</span>' + m('_')
      else if (r[0][0] === '<') html = '<span class="s-tag">' + esc(r[0]) + '</span>'
      else html = '<span class="s-url">' + esc(r[0]) + '</span>'
      out += esc(s.slice(last, start)) + html
      last = INLINE_RE.lastIndex
      if (r[0].length === 0) INLINE_RE.lastIndex++
    }
    return out + esc(s.slice(last))
  }

  function hlLine(line, st, n) {
    var r
    if (st.fence) {
      r = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (r && r[1][0] === st.fence[0] && r[1].length >= st.fence.length) {
        st.fence = null
        return m(line)
      }
      return '<span class="s-code">' + esc(line) + '</span>'
    }
    if (st.fm) {
      if (/^(---|\.\.\.)\s*$/.test(line)) {
        st.fm = false
        return m(line)
      }
      r = /^(\s*)([\w\-. ]+?)(\s*:)(.*)$/.exec(line)
      if (r) return esc(r[1]) + '<span class="s-fm">' + esc(r[2]) + '</span>' + m(r[3]) + esc(r[4])
      return esc(line)
    }
    if (n === 0 && /^---\s*$/.test(line)) {
      st.fm = true
      return m(line)
    }
    r = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    if (r) {
      st.fence = r[2]
      return esc(r[1]) + m(r[2]) + '<span class="s-fm">' + esc(r[3]) + '</span>'
    }
    r = /^(\s{0,3})(#{1,6})(\s+)(.*)$/.exec(line)
    if (r) return esc(r[1]) + m(r[2]) + r[3] + '<span class="s-h' + (r[2].length === 1 ? ' s-h1' : '') + '">' + inline(r[4]) + '</span>'
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return m(line)
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.indexOf('-') >= 0 && line.indexOf('|') >= 0) return m(line)
    var pre = ''
    r = /^(\s*(?:>\s?)+)/.exec(line)
    if (r) {
      pre += m(r[1])
      line = line.slice(r[1].length)
      var c = /^\[!(\w+)\].*$/.exec(line)
      if (c) return pre + '<span class="s-list">' + esc(line) + '</span>'
    }
    r = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\](?=\s))?/.exec(line)
    if (r) {
      pre += esc(r[1]) + '<span class="s-list">' + esc(r[2]) + '</span>' + r[3] + (r[4] ? '<span class="s-list">' + esc(r[4]) + '</span>' : '')
      line = line.slice(r[0].length)
    }
    if (/^\s*\|/.test(line)) {
      return (
        pre +
        line
          .split('|')
          .map(function (cell) {
            return inline(cell)
          })
          .join(m('|'))
      )
    }
    return pre + inline(line)
  }

  var lineEls = []
  function renderSource() {
    var lines = text.split('\n')
    var st = { fence: null, fm: false }
    var html = ''
    for (var i = 0; i < lines.length; i++) {
      var h = hlLine(lines[i], st, i)
      html += '<div class="ln" data-n="' + (i + 1) + '">' + (h || '<br>') + '</div>'
    }
    hlEl.innerHTML = html
    lineEls = hlEl.children
    curLine = -1
    markCurrentLine()
  }

  var curLine = -1
  function caretLine() {
    var v = srcEl.value
    var pos = srcEl.selectionStart
    var n = 0
    for (var i = v.indexOf('\n'); i >= 0 && i < pos; i = v.indexOf('\n', i + 1)) n++
    return n
  }
  function markCurrentLine() {
    if (main.dataset.mode === 'read') return
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

  /* ---------------- 编辑 ---------------- */

  var renderDocSoon = debounce(function () {
    renderDoc()
    scheduleSync()
  }, 140)

  function onTextChanged() {
    text = srcEl.value
    renderSource()
    if (main.dataset.mode !== 'source') renderDocSoon()
    studio.setDirty(text !== savedText)
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

  function wrapSel(pre, post, placeholder) {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var b = srcEl.selectionEnd
    var sel = v.slice(a, b)
    if (v.slice(a - pre.length, a) === pre && v.slice(b, b + post.length) === post) {
      replaceRange(a - pre.length, b + post.length, sel, a - pre.length, b - pre.length)
      return
    }
    if (sel.length > pre.length + post.length && sel.startsWith(pre) && sel.endsWith(post)) {
      var inner = sel.slice(pre.length, sel.length - post.length)
      replaceRange(a, b, inner, a, a + inner.length)
      return
    }
    var body = sel || placeholder
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

  var PREFIX_RE = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)?/
  function togglePrefix(kind) {
    var r = lineRange()
    var lines = srcEl.value.slice(r[0], r[1]).split('\n')
    var test = { quote: /^\s*>\s?/, ul: /^\s*[-*+]\s+(?!\[[ xX]\])/, ol: /^\s*\d{1,9}[.)]\s+/, task: /^\s*[-*+]\s+\[[ xX]\]\s+/ }[kind]
    var all = lines.every(function (l) {
      return !l.trim() || test.test(l)
    })
    var out = lines.map(function (l, i) {
      if (!l.trim() && lines.length > 1) return l
      if (all) return l.replace(test, function (x) { return x.match(/^\s*/)[0] })
      var mm = PREFIX_RE.exec(l)
      var indent = mm[1]
      var rest = l.slice(mm[0].length)
      if (kind === 'quote') return '> ' + l
      var p = kind === 'ul' ? '- ' : kind === 'task' ? '- [ ] ' : i + 1 + '. '
      return indent + p + rest
    })
    var s = out.join('\n')
    replaceRange(r[0], r[1], s, r[0] + s.length)
  }

  function cycleHeading() {
    var r = lineRange()
    var v = srcEl.value
    var l = v.slice(r[0], v.indexOf('\n', r[0]) < 0 ? v.length : v.indexOf('\n', r[0]))
    var mm = /^(#{1,6})\s+/.exec(l)
    var next = !mm ? '## ' : mm[1].length >= 4 ? '' : mm[1] + '# '
    var rest = mm ? l.slice(mm[0].length) : l
    var s = next + rest
    replaceRange(r[0], r[0] + l.length, s, r[0] + s.length)
  }

  function insertCode() {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var b = srcEl.selectionEnd
    var sel = v.slice(a, b)
    if (sel.indexOf('\n') >= 0 || (!sel && (a === 0 || v[a - 1] === '\n') && (b === v.length || v[b] === '\n'))) {
      var body = sel || ''
      var s = '```\n' + body + (body.endsWith('\n') || !body ? '' : '\n') + '```'
      replaceRange(a, b, s, a + 3)
    } else wrapSel('`', '`', T('代码', 'code'))
  }

  function insertLink() {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var b = srcEl.selectionEnd
    var sel = v.slice(a, b)
    if (/^https?:\/\/\S+$/.test(sel)) {
      replaceRange(a, b, '[' + T('链接', 'link') + '](' + sel + ')', a + 1, a + 1 + T('链接', 'link').length)
      return
    }
    var label = sel || T('链接文字', 'link text')
    var s = '[' + label + '](https://)'
    var urlAt = a + label.length + 3
    replaceRange(a, b, s, sel ? urlAt : a + 1, sel ? urlAt + 8 : a + 1 + label.length)
  }

  function insertTable() {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var lead = a > 0 && v[a - 1] !== '\n' ? '\n\n' : a > 1 && v[a - 2] !== '\n' ? '\n' : ''
    var h1 = T('列 1', 'Column 1')
    var s = lead + '| ' + h1 + ' | ' + T('列 2', 'Column 2') + ' | ' + T('列 3', 'Column 3') + ' |\n| --- | --- | --- |\n|  |  |  |\n'
    replaceRange(a, srcEl.selectionEnd, s, a + lead.length + 2, a + lead.length + 2 + h1.length)
  }

  function indentLines(out) {
    var r = lineRange()
    var lines = srcEl.value.slice(r[0], r[1]).split('\n')
    var s = lines
      .map(function (l) {
        return out ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l
      })
      .join('\n')
    replaceRange(r[0], r[1], s, r[0], r[0] + s.length)
  }

  /** 回车时延续列表 */
  function continueList() {
    var v = srcEl.value
    var a = srcEl.selectionStart
    if (a !== srcEl.selectionEnd) return false
    var ls = v.lastIndexOf('\n', a - 1) + 1
    var line = v.slice(ls, a)
    var mm = /^(\s*(?:>\s?)*)(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (!mm) {
      var q = /^(\s*(?:>\s?)+)(.*)$/.exec(line)
      if (!q) return false
      if (!q[2].trim()) {
        replaceRange(ls, a, '', ls)
        return true
      }
      replaceRange(a, a, '\n' + q[1])
      return true
    }
    if (!mm[6].trim()) {
      // 空的列表项：结束列表
      replaceRange(ls, a, mm[1], ls + mm[1].length)
      return true
    }
    var marker = mm[3]
    var num = /^(\d+)([.)])$/.exec(marker)
    if (num) marker = Number(num[1]) + 1 + num[2]
    replaceRange(a, a, '\n' + mm[1] + mm[2] + marker + mm[4] + (mm[5] ? '[ ] ' : ''))
    return true
  }

  srcEl.addEventListener('input', function () {
    onTextChanged()
    ensureCaretVisible()
  })
  srcEl.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey
    var k = e.key.toLowerCase()
    if (mod && !e.altKey) {
      var act = null
      if (k === 'b' && !e.shiftKey) act = function () { wrapSel('**', '**', T('粗体', 'bold')) }
      else if (k === 'i' && !e.shiftKey) act = function () { wrapSel('*', '*', T('斜体', 'italic')) }
      else if (k === 'k' && !e.shiftKey) act = insertLink
      else if (k === 'e' && !e.shiftKey) act = insertCode
      else if (k === 'x' && e.shiftKey) act = function () { wrapSel('~~', '~~', T('删除线', 'strikethrough')) }
      else if (k === 'h' && e.shiftKey) act = function () { wrapSel('==', '==', T('高亮', 'highlight')) }
      if (act) {
        e.preventDefault()
        act()
        return
      }
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault()
      var v = srcEl.value
      if (srcEl.selectionStart === srcEl.selectionEnd && !e.shiftKey && !/^\s*([-*+]|\d+[.)])\s/.test(v.slice(v.lastIndexOf('\n', srcEl.selectionStart - 1) + 1))) replaceRange(srcEl.selectionStart, srcEl.selectionEnd, '  ')
      else indentLines(e.shiftKey)
      return
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      if (continueList()) e.preventDefault()
    }
  })
  ;['keyup', 'mouseup', 'focus', 'blur', 'select'].forEach(function (ev) {
    srcEl.addEventListener(ev, markCurrentLine)
  })
  document.addEventListener('selectionchange', function () {
    if (document.activeElement === srcEl) markCurrentLine()
  })

  /** 阅读视图里勾选任务：改源码里第 i 个任务 */
  function toggleTask(i, checked) {
    var lines = text.split('\n')
    var fence = null
    var count = 0
    var inFm = lines[0] && /^---\s*$/.test(lines[0])
    for (var n = inFm ? 1 : 0; n < lines.length; n++) {
      var l = lines[n]
      if (inFm) {
        if (/^(---|\.\.\.)\s*$/.test(l)) inFm = false
        continue
      }
      var f = /^\s*(`{3,}|~{3,})/.exec(l)
      if (f) {
        if (!fence) fence = f[1]
        else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
        continue
      }
      if (fence) continue
      var mm = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/.exec(l)
      if (!mm) continue
      if (count++ === i) {
        lines[n] = mm[1] + (checked ? 'x' : ' ') + mm[3] + l.slice(mm[0].length)
        var keep = docScroll.scrollTop
        text = lines.join('\n')
        srcEl.value = text
        renderSource()
        renderDoc()
        docScroll.scrollTop = keep
        studio.setDirty(text !== savedText)
        return
      }
    }
  }

  /* ---------------- 文档里的点击 ---------------- */

  docEl.addEventListener('click', function (e) {
    var a = e.target.closest('a[href]')
    if (a) {
      e.preventDefault()
      var href = a.getAttribute('href')
      if (href[0] === '#') {
        var id = href.slice(1)
        try {
          id = decodeURIComponent(id)
        } catch (err) {
          /* 保持原样 */
        }
        var target = document.getElementById(id) || document.getElementById(slug(id))
        if (target && docEl.contains(target)) docScroll.scrollTo({ top: target.offsetTop + docEl.offsetTop - 16, behavior: 'smooth' })
      } else if (/^(https?:|mailto:)/i.test(href)) studio.openExternal(href)
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) studio.openLink(href)
      return
    }
  })
  docEl.addEventListener('change', function (e) {
    var cb = e.target
    if (cb && cb.dataset && cb.dataset.task != null) toggleTask(Number(cb.dataset.task), cb.checked)
  })
  // 分栏模式：双击预览里的段落，跳到对应源码
  docEl.addEventListener('dblclick', function (e) {
    if (main.dataset.mode !== 'split') return
    var b = e.target.closest('.blk')
    if (!b) return
    var n = Number(b.getAttribute('data-line')) || 0
    var ln = lineEls[n]
    if (!ln) return
    var v = srcEl.value
    var pos = 0
    for (var i = 0; i < n; i++) pos = v.indexOf('\n', pos) + 1
    srcEl.focus()
    srcEl.setSelectionRange(pos, pos)
    srcScroll.scrollTop = Math.max(0, ln.offsetTop - srcScroll.clientHeight / 3)
    markCurrentLine()
  })

  /* ---------------- 滚动同步（分栏） ---------------- */

  var lockUntil = { src: 0, doc: 0 }
  function lineAtScroll() {
    var y = srcScroll.scrollTop
    var lo = 0
    var hi = lineEls.length - 1
    if (hi < 0) return 0
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1
      if (lineEls[mid].offsetTop <= y) lo = mid
      else hi = mid - 1
    }
    var ln = lineEls[lo]
    return lo + Math.min(1, Math.max(0, (y - ln.offsetTop) / Math.max(1, ln.offsetHeight)))
  }
  function srcToDoc() {
    if (main.dataset.mode !== 'split' || !blocks.length) return
    var maxSrc = srcScroll.scrollHeight - srcScroll.clientHeight
    var target
    if (srcScroll.scrollTop <= 0) target = 0
    else if (srcScroll.scrollTop >= maxSrc - 1) target = docScroll.scrollHeight
    else {
      var L = lineAtScroll()
      var i = 0
      while (i + 1 < blocks.length && blocks[i + 1].line <= L) i++
      var b = blocks[i]
      var nx = blocks[i + 1]
      var y0 = b.el.offsetTop
      var y1 = nx ? nx.el.offsetTop : docEl.offsetHeight
      var l1 = nx ? nx.line : lineEls.length
      var f = l1 > b.line ? Math.min(1, Math.max(0, (L - b.line) / (l1 - b.line))) : 0
      if (L < b.line) f = 0
      target = docEl.offsetTop + y0 + f * (y1 - y0) - 24
    }
    lockUntil.doc = Date.now() + 120
    docScroll.scrollTop = target
  }
  function docToSrc() {
    if (main.dataset.mode !== 'split' || !blocks.length || !lineEls.length) return
    var maxDoc = docScroll.scrollHeight - docScroll.clientHeight
    var target
    if (docScroll.scrollTop <= 0) target = 0
    else if (docScroll.scrollTop >= maxDoc - 1) target = srcScroll.scrollHeight
    else {
      var y = docScroll.scrollTop - docEl.offsetTop + 24
      var i = 0
      while (i + 1 < blocks.length && blocks[i + 1].el.offsetTop <= y) i++
      var b = blocks[i]
      var nx = blocks[i + 1]
      var y0 = b.el.offsetTop
      var y1 = nx ? nx.el.offsetTop : docEl.offsetHeight
      var f = y1 > y0 ? Math.min(1, Math.max(0, (y - y0) / (y1 - y0))) : 0
      var l1 = nx ? nx.line : lineEls.length
      var L = b.line + f * (l1 - b.line)
      var li = Math.min(lineEls.length - 1, Math.floor(L))
      var ln = lineEls[li]
      target = ln.offsetTop + (L - li) * ln.offsetHeight
    }
    lockUntil.src = Date.now() + 120
    srcScroll.scrollTop = target
  }
  var syncRaf = 0
  function scheduleSync() {
    if (main.dataset.mode !== 'split' || syncRaf) return
    syncRaf = requestAnimationFrame(function () {
      syncRaf = 0
      srcToDoc()
    })
  }
  srcScroll.addEventListener('scroll', function () {
    if (Date.now() < lockUntil.src) return
    srcToDoc()
  })
  docScroll.addEventListener('scroll', function () {
    updateProgress()
    updateActiveHeading()
    if (Date.now() < lockUntil.doc) return
    docToSrc()
  })

  /* ---------------- 主题、模式、设置 ---------------- */

  function resolvedTheme() {
    if (settings.theme !== 'auto') return settings.theme
    return studio.theme && studio.theme.light ? 'paper' : 'ink'
  }

  function applySettings(rerender) {
    var prevTheme = main.dataset.theme
    main.dataset.theme = resolvedTheme()
    if (settings.theme === 'auto') main.setAttribute('data-auto', '')
    else main.removeAttribute('data-auto')
    main.dataset.mode = settings.mode
    document.body.dataset.mode = settings.mode
    main.dataset.number = settings.number ? 'on' : 'off'
    main.dataset.lineno = settings.lineNo ? 'on' : 'off'
    main.dataset.outline = settings.outline ? 'on' : 'off'
    main.dataset.width = settings.width
    main.style.setProperty('--fs', settings.fontSize + 'px')
    main.style.setProperty('--measure', (WIDTHS[settings.width] || 760) + 'px')
    if (rerender || prevTheme !== main.dataset.theme) {
      if (loaded) renderDoc()
    }
    buildBar()
  }

  function setMode(mode) {
    if (settings.mode === mode) return
    // 切换前记下阅读位置，切换后尽量对齐
    var fromDoc = settings.mode !== 'source'
    var L = fromDoc ? docLine() : lineAtScroll()
    settings.mode = mode
    saveSettings()
    applySettings(false)
    if (mode !== 'source') renderDoc()
    if (mode !== 'read') renderSource()
    requestAnimationFrame(function () {
      if (mode !== 'source') scrollDocToLine(L)
      if (mode !== 'read') {
        var ln = lineEls[Math.min(lineEls.length - 1, Math.floor(L))]
        if (ln) {
          lockUntil.src = Date.now() + 120
          srcScroll.scrollTop = ln.offsetTop
        }
        srcEl.focus({ preventScroll: true })
      }
    })
  }
  function docLine() {
    var y = docScroll.scrollTop - docEl.offsetTop + 24
    var line = 0
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].el.offsetTop <= y) line = blocks[i].line
      else break
    }
    return line
  }
  function scrollDocToLine(L) {
    var b = null
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].line <= L) b = blocks[i]
      else break
    }
    lockUntil.doc = Date.now() + 120
    docScroll.scrollTop = b ? docEl.offsetTop + b.el.offsetTop - 24 : 0
  }

  /* ---------------- 工具栏 ---------------- */

  function tb(icon, title, fn, opts) {
    opts = opts || {}
    var b = el('button', { type: 'button', class: 'tb' + (opts.on ? ' on' : '') + (opts.boxed ? ' boxed' : ''), title: title, 'aria-label': opts.label ? null : title, id: opts.id, html: icon })
    if (opts.label) b.append(el('span', { class: 'lbl', text: opts.label }))
    b.addEventListener('mousedown', function (e) {
      // 格式按钮不抢编辑器的焦点和选区
      if (opts.keepFocus) e.preventDefault()
    })
    b.addEventListener('click', fn)
    return b
  }

  function buildBar() {
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': T('显示模式', 'View mode') })
    ;[
      ['read', T('阅读', 'Read')],
      ['split', T('分栏', 'Split')],
      ['source', T('源码', 'Source')]
    ].forEach(function (x) {
      var b = el('button', { type: 'button', class: settings.mode === x[0] ? 'on' : null, 'aria-pressed': String(settings.mode === x[0]) }, x[1])
      b.addEventListener('click', function () {
        setMode(x[0])
      })
      seg.append(b)
    })

    var k = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'
    var fmt = el(
      'div',
      { id: 'fmt' },
      tb(ICON.h, T('标题（循环切换 ## / ### / ####）', 'Heading (cycles ## / ### / ####)'), cycleHeading, { keepFocus: true }),
      tb('<b>B</b>', T('粗体', 'Bold') + ' (' + k + 'B)', function () { wrapSel('**', '**', T('粗体', 'bold')) }, { keepFocus: true }),
      tb('<i>I</i>', T('斜体', 'Italic') + ' (' + k + 'I)', function () { wrapSel('*', '*', T('斜体', 'italic')) }, { keepFocus: true }),
      tb('<s>S</s>', T('删除线', 'Strikethrough') + ' (' + k + 'Shift+X)', function () { wrapSel('~~', '~~', T('删除线', 'strikethrough')) }, { keepFocus: true }),
      tb(ICON.mark, T('高亮', 'Highlight') + ' (' + k + 'Shift+H)', function () { wrapSel('==', '==', T('高亮', 'highlight')) }, { keepFocus: true }),
      tb(ICON.code, T('代码', 'Code') + ' (' + k + 'E)', insertCode, { keepFocus: true }),
      tb(ICON.link, T('链接', 'Link') + ' (' + k + 'K)', insertLink, { keepFocus: true }),
      el('span', { class: 'sep' }),
      tb(ICON.quote, T('引用', 'Quote'), function () { togglePrefix('quote') }, { keepFocus: true }),
      tb(ICON.ul, T('无序列表', 'Bulleted list'), function () { togglePrefix('ul') }, { keepFocus: true }),
      tb(ICON.ol, T('有序列表', 'Numbered list'), function () { togglePrefix('ol') }, { keepFocus: true }),
      tb(ICON.task, T('任务清单', 'Task list'), function () { togglePrefix('task') }, { keepFocus: true }),
      tb(ICON.table, T('插入表格', 'Insert table'), insertTable, { keepFocus: true })
    )

    var th = THEMES.find(function (x) { return x.id === settings.theme }) || THEMES[0]
    var themeBtn = tb('', T('主题', 'Theme'), function (e) { openThemeMenu(e.currentTarget) }, { boxed: true, label: T(th.zh, th.en) })
    themeBtn.prepend(themeDot(th))

    bar.replaceChildren(
      seg,
      el('span', { class: 'sep', id: 'fmtSep' }),
      fmt,
      el('span', { class: 'sp' }),
      themeBtn,
      tb(ICON.gear, T('排版设置', 'Typography settings'), function (e) { openSettings(e.currentTarget) }),
      tb(ICON.outline, T('显示大纲', 'Show outline'), function () {
        settings.outline = !settings.outline
        saveSettings()
        applySettings(false)
      }, { on: settings.outline, id: 'olBtn' }),
      tb(ICON.exportI, T('导出为 HTML', 'Export as HTML'), exportHtml),
      tb(ICON.text, T('用文本编辑器打开', 'Open in text editor'), function () { studio.openText() })
    )
  }

  function themeDot(th) {
    var d = el('span', { class: 'dot' })
    if (th.id === 'auto') d.style.background = 'linear-gradient(135deg, #fbfbfa 50%, #1b1c1f 50%)'
    else d.style.background = th.dot
    return d
  }

  /* ---------------- 弹出菜单 ---------------- */

  var menuOwner = null
  function closeMenu() {
    menuEl.hidden = true
    menuOwner = null
  }
  function openMenu(anchor, build) {
    if (menuOwner === anchor && !menuEl.hidden) return closeMenu()
    menuEl.replaceChildren()
    build(menuEl)
    menuEl.hidden = false
    menuOwner = anchor
    var r = anchor.getBoundingClientRect()
    var w = menuEl.offsetWidth
    menuEl.style.top = r.bottom + 6 + 'px'
    menuEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px'
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
  window.addEventListener('resize', closeMenu)
  window.addEventListener('blur', closeMenu)

  function openThemeMenu(anchor) {
    openMenu(anchor, function (m) {
      THEMES.forEach(function (th) {
        var b = el('button', { type: 'button', class: 'mi' }, el('span', { class: 'ck', html: settings.theme === th.id ? ICON.check : '' }), themeDot(th), T(th.zh, th.en), el('span', { class: 'desc', text: T(th.dz, th.de) }))
        b.addEventListener('click', function () {
          settings.theme = th.id
          saveSettings()
          closeMenu()
          applySettings(true)
        })
        m.append(b)
      })
    })
  }

  function switchRow(label, key) {
    var sw = el('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(!!settings[key]), 'aria-label': label })
    sw.addEventListener('click', function () {
      settings[key] = !settings[key]
      sw.setAttribute('aria-checked', String(settings[key]))
      saveSettings()
      applySettings(key === 'number')
    })
    return el('div', { class: 'row' }, el('span', { text: label }), sw)
  }

  function openSettings(anchor) {
    openMenu(anchor, function (m) {
      m.style.width = '280px'
      var val = el('span', { class: 'val', text: settings.fontSize + ' px' })
      var range = el('input', { type: 'range', min: '12', max: '22', step: '1', value: String(settings.fontSize), 'aria-label': T('正文字号', 'Font size') })
      range.addEventListener('input', function () {
        settings.fontSize = Number(range.value)
        val.textContent = settings.fontSize + ' px'
        main.style.setProperty('--fs', settings.fontSize + 'px')
        saveSettings()
      })
      var seg = el('div', { class: 'seg' })
      ;[
        ['narrow', T('窄', 'Narrow')],
        ['mid', T('适中', 'Medium')],
        ['wide', T('宽', 'Wide')],
        ['full', T('铺满', 'Full')]
      ].forEach(function (x) {
        var b = el('button', { type: 'button', class: settings.width === x[0] ? 'on' : null }, x[1])
        b.addEventListener('click', function () {
          settings.width = x[0]
          saveSettings()
          seg.querySelectorAll('button').forEach(function (o) {
            o.classList.toggle('on', o === b)
          })
          main.dataset.width = x[0]
          main.style.setProperty('--measure', (WIDTHS[x[0]] || 760) + 'px')
        })
        seg.append(b)
      })
      var reset = el('button', { type: 'button', class: 'mi' }, T('恢复默认', 'Reset to defaults'))
      reset.addEventListener('click', function () {
        var mode = settings.mode
        for (var k in DEFAULTS) settings[k] = DEFAULTS[k]
        settings.mode = mode
        saveSettings()
        closeMenu()
        applySettings(true)
      })
      m.append(
        el('div', { class: 'hd', text: T('排版', 'TYPOGRAPHY') }),
        el('div', { class: 'row' }, el('span', { text: T('正文字号', 'Font size') }), val),
        el('div', { class: 'row', style: 'padding-top:0' }, range),
        el('div', { class: 'row', style: 'padding-bottom:2px' }, el('span', { text: T('行宽', 'Line width') })),
        seg,
        el('hr'),
        el('div', { class: 'hd', text: T('元素', 'ELEMENTS') }),
        switchRow(T('标题自动编号', 'Number headings'), 'number'),
        switchRow(T('代码块行号', 'Code line numbers'), 'lineNo'),
        switchRow(T('右侧大纲与阅读进度', 'Outline and progress'), 'outline'),
        el('hr'),
        reset
      )
    })
  }

  /* ---------------- 导出 HTML ---------------- */

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

  function exportHtml() {
    buildHtml()
      .then(function (html) {
        return studio.exportFile(fileName.replace(/\.[^.]+$/, '') + '.html', html)
      })
      .catch(function (e) {
        studio.toast(T('导出失败：', 'Export failed: ') + (e && e.message))
      })
  }

  /** 排版好的文档 → 独立的 HTML 文件（样式、图片都内嵌） */
  function buildHtml() {
    if (settings.mode === 'source') renderDoc()
    var clone = docEl.cloneNode(true)
    clone.querySelectorAll('.code-head button').forEach(function (b) {
      b.remove()
    })
    clone.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.setAttribute('disabled', '')
      if (cb.checked) cb.setAttribute('checked', '')
    })
    var imgs = Array.prototype.slice.call(clone.querySelectorAll('img[src^="blob:"]'))
    var vars = ['--bg', '--fg', '--strong', '--muted', '--line', '--card', '--code-bg', '--code-head', '--icode-bg', '--icode-fg', '--accent', '--link', '--mark-bg', '--mark-fg', '--src-mark', '--c-note', '--c-tip', '--c-important', '--c-warning', '--c-caution', '--ok', '--hl-kw', '--hl-str', '--hl-com', '--hl-num', '--hl-fn', '--hl-type', '--hl-attr', '--hl-tag', '--font-body', '--font-head', '--font-code', '--fs', '--measure', '--st-font-code']
    var cs = getComputedStyle(main)
    var rootVars = vars
      .map(function (v) {
        return v + ':' + cs.getPropertyValue(v).trim() + ';'
      })
      .join('')
    return Promise.all([
      fetch('md.css').then(function (r) {
        return r.text()
      }),
      Promise.all(
        imgs.map(function (img) {
          return blobToDataUrl(img.src).then(function (d) {
            if (d) img.src = d
          })
        })
      )
    ])
      .then(function (res) {
        var css = res[0]
        var title = (headings[0] && headings[0].text) || fileName.replace(/\.[^.]+$/, '')
        var html =
          '<!doctype html>\n<html lang="' + (studio.locale === 'en' ? 'en' : 'zh-CN') + '">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n<style>\n' +
          css +
          '\nhtml,body{height:auto;overflow:auto}body{display:block}\n#main#main{display:block;min-height:100vh;padding:48px 24px 96px;' + rootVars + '}\n</style>\n</head>\n<body>\n<div id="main" data-theme="' + main.dataset.theme + '" data-number="' + main.dataset.number + '" data-lineno="' + main.dataset.lineno + '" data-width="' + main.dataset.width + '">\n<article class="md">' +
          clone.innerHTML +
          '</article>\n</div>\n</body>\n</html>\n'
        return html
      })
  }

  /* ---------------- AI 工具（IDE 里的 AI 助手调用） ---------------- */

  function blockLine(node) {
    var b = node.closest ? node.closest('.blk') : null
    return b ? (Number(b.getAttribute('data-line')) || 0) + 1 : null
  }

  studio.tools.register('getOutline', function () {
    if (settings.mode === 'source') renderDoc()
    var c = countText(docEl.textContent || '')
    var boxes = docEl.querySelectorAll('input[type="checkbox"]')
    var done = Array.prototype.filter.call(boxes, function (b) { return b.checked }).length
    var fm = frontMatter(text)
    var links = []
    docEl.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href')
      if (href && href[0] !== '#' && links.indexOf(href) < 0 && links.length < 200) links.push(href)
    })
    return {
      file: fileName,
      headings: headings.map(function (hd) {
        return { level: hd.level, text: hd.text, line: blockLine(hd.el) }
      }),
      words: c.cjk + c.words,
      readingTime: readingTime(),
      codeBlocks: docEl.querySelectorAll('.code').length,
      tasks: boxes.length ? { done: done, total: boxes.length } : undefined,
      frontMatter: fm.meta && fm.meta.length ? fm.meta.map(function (x) { return x.key }) : undefined,
      links: links.length ? links : undefined,
      brokenImages: Array.prototype.map.call(docEl.querySelectorAll('img.broken'), function (i) { return i.getAttribute('data-src') || '' })
    }
  })

  studio.tools.register('exportHtml', async function (a) {
    var p = typeof a.path === 'string' && a.path.trim() ? a.path.trim().replace(/\\/g, '/') : ''
    if (!p) throw new Error('`path` is required (an .html file relative to the workspace root)')
    if (!/\.html?$/i.test(p)) throw new Error('`path` must end with .html')
    var html = await buildHtml()
    await studio.fs.write('/' + p.replace(/^\/+/, ''), html)
    return 'Wrote ' + p + ' (' + Math.round(html.length / 1024) + ' KB, styles and images inlined, theme: ' + main.dataset.theme + ')'
  })

  studio.tools.register('screenshot', function (a) {
    if (a.mode === 'read' || a.mode === 'split' || a.mode === 'source') setMode(a.mode)
    else if (settings.mode === 'source') setMode('read')
    var line = Math.floor(Number(a.line))
    // 窗口在后台时 requestAnimationFrame 可能不触发：用定时器
    return new Promise(function (r) {
      setTimeout(function () {
        if (line > 0 && settings.mode !== 'source') scrollDocToLine(line - 1)
        setTimeout(function () {
          r((settings.mode === 'read' ? 'Reading view' : settings.mode === 'split' ? 'Split view' : 'Source') + (line > 0 ? ' at line ' + line : ''))
        }, 150)
      }, 30)
    })
  })

  /* ---------------- 和 IDE 的连接 ---------------- */

  var askDone = false
  function registerAsk() {
    if (askDone || !studio.has('agent.send')) return
    askDone = true
    studio.commands
      .register('ask-ai', T('把选中的内容发给 AI 助手', 'Send the selection to the AI assistant'), function () {
        var sel = document.activeElement === srcEl ? srcEl.value.slice(srcEl.selectionStart, srcEl.selectionEnd) : String(window.getSelection() || '')
        var quote = sel.trim()
          ? sel
              .trim()
              .split('\n')
              .map(function (l) { return '> ' + l })
              .join('\n')
          : ''
        studio.agent.send(quote, { file: true }).catch(function (e) { studio.toast(e.message) })
      })
      .catch(function () {})
  }

  studio.onLoad(function (content, info) {
    registerAsk()
    var hasCr = content.indexOf('\r\n') >= 0
    var hasBom = content.charCodeAt(0) === 0xfeff
    var norm = (hasBom ? content.slice(1) : content).replace(/\r\n?/g, '\n')
    var sameFile = info && info.path === filePath
    // 自己保存后磁盘变化引起的重新加载：内容一样就不动
    if (loaded && sameFile && norm === text) {
      savedText = norm
      studio.setDirty(false)
      return
    }
    eol = hasCr ? '\r\n' : '\n'
    bom = hasBom ? '﻿' : ''
    if (!sameFile) clearAssets()
    filePath = (info && info.path) || ''
    fileName = (info && info.fileName) || fileName
    document.title = fileName
    text = savedText = norm
    srcEl.value = norm
    var keepDoc = sameFile ? docScroll.scrollTop : 0
    var keepSrc = sameFile ? srcScroll.scrollTop : 0
    loaded = true
    applySettings(false)
    renderSource()
    renderDoc()
    docScroll.scrollTop = keepDoc
    srcScroll.scrollTop = keepSrc
    if (!sameFile && settings.mode === 'source') srcEl.focus({ preventScroll: true })
  })

  studio.onSave(function () {
    sentText = text
    return bom + (eol === '\n' ? text : text.replace(/\n/g, eol))
  })

  studio.onSaved(function () {
    if (sentText != null) savedText = sentText
    sentText = null
    if (text !== savedText) studio.setDirty(true)
  })

  studio.onTheme(function () {
    if (!loaded) return
    if (settings.theme === 'auto') applySettings(false)
  })

  applySettings(false)
  renderSource()
})()
