/* HTML 预览 —— Infinite Studio 插件 */
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
  var stage = $('#stage')
  var frameBox = $('#frameBox')
  var device = $('#device')
  var sizeLbl = $('#size')
  var consoleEl = $('#console')
  var logList = $('#logList')
  var emptyEl = $('#empty')
  var menuEl = $('#menu')

  /* ---------------- 设置（保存在插件自己的 localStorage） ---------------- */

  var DEFAULTS = { mode: 'preview', device: 'fill', landscape: false, scripts: true, network: true, console: false, live: true }
  var settings = (function () {
    var s = {}
    try {
      s = JSON.parse(localStorage.getItem('hp-settings') || '{}') || {}
    } catch (e) {
      s = {}
    }
    var out = {}
    for (var k in DEFAULTS) out[k] = s[k] !== undefined && typeof s[k] === typeof DEFAULTS[k] ? s[k] : DEFAULTS[k]
    return out
  })()
  function saveSettings() {
    try {
      localStorage.setItem('hp-settings', JSON.stringify(settings))
    } catch (e) {
      /* 忽略 */
    }
  }

  var DEVICES = {
    fill: { zh: '自适应', en: 'Fit', w: 0, h: 0 },
    desktop: { zh: '桌面', en: 'Desktop', w: 1440, h: 900 },
    laptop: { zh: '笔记本', en: 'Laptop', w: 1280, h: 800 },
    tablet: { zh: '平板', en: 'Tablet', w: 820, h: 1180 },
    mobile: { zh: '手机', en: 'Phone', w: 390, h: 844 }
  }

  /* ---------------- 文件状态 ---------------- */

  var text = ''
  var savedText = ''
  var sentText = null
  var eol = '\n'
  var bom = ''
  var filePath = ''
  var fileName = 'index.html'
  var loaded = false

  /** 预览里网页的 localStorage 等：按文件保存在内存里，刷新预览后还在 */
  var storages = new Map()
  function storageFor(p) {
    if (!storages.has(p)) storages.set(p, { local: {}, session: {}, cookie: {} })
    return storages.get(p)
  }

  /* ---------------- 图标 ---------------- */

  function svg(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'
  }
  var ICON = {
    reload: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    fill: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9l-2 3 2 3M16 9l2 3-2 3"/>'),
    desktop: svg('<rect x="2.5" y="4" width="19" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
    laptop: svg('<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19l-2-4h-15z"/>'),
    tablet: svg('<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M11 18.5h2"/>'),
    mobile: svg('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>'),
    rotate: svg('<rect x="3" y="9" width="12" height="12" rx="1.5"/><path d="M14 3a7 7 0 0 1 7 7M14 3l2.5-1.5M14 3l1.5 2.5"/>'),
    script: svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'),
    terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17"/>'),
    exportI: svg('<path d="M12 4v11M7.5 8.5L12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>'),
    text: svg('<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>'),
    more: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    clear: svg('<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    bolt: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>')
  }

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
  function debounce(fn, ms) {
    var t = 0
    var f = function () {
      clearTimeout(t)
      t = setTimeout(fn, ms)
    }
    f.cancel = function () {
      clearTimeout(t)
    }
    return f
  }
  function randomToken() {
    var a = new Uint32Array(3)
    crypto.getRandomValues(a)
    return Array.prototype.map.call(a, function (x) { return x.toString(36) }).join('')
  }

  /* ---------------- 构建和显示预览 ---------------- */

  var loader = newLoader()
  function newLoader() {
    return new HP.Loader(function (p) {
      return studio.readAsset(p)
    })
  }

  /** token → { frame }：每次构建一个新的预览框，加载完再换下旧的（不闪白） */
  var frames = new Map()
  var current = null // { token, frame }
  var buildSeq = 0
  var lastScroll = { x: 0, y: 0 }
  var started = 0

  var OFFLINE_CSP = "default-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:"

  function bootFor(token) {
    return function (depth, dir) {
      if (!settings.scripts) return ''
      return HP.bootSource({
        token: token,
        origin: location.origin,
        depth: depth,
        dir: dir,
        scroll: depth === 0 ? lastScroll : null,
        storage: storageFor(filePath),
        text: {
          res: T('资源加载失败', 'Failed to load'),
          csp: T('已拦截（断网预览）：', 'Blocked (offline preview):'),
          form: T('表单提交已拦截：预览里不会跳转', 'Form submission blocked: the preview does not navigate'),
          line: T('行', 'line')
        }
      })
    }
  }

  function refresh(hard) {
    if (!loaded || settings.mode === 'source') return
    if (hard) loader = newLoader()
    var seq = ++buildSeq
    var token = randomToken()
    loader.begin()
    loader.cyclic = null
    started = performance.now()
    HP.build(text, {
      loader: loader,
      dir: '',
      depth: 0,
      boot: bootFor(token),
      csp: settings.network ? null : OFFLINE_CSP,
      noScript: !settings.scripts
    })
      .then(function (html) {
        if (seq !== buildSeq) return
        mount(token, html)
        clearLog()
        loader.missing.forEach(function (p) {
          addLog('warn', T('找不到文件：', 'File not found: ') + p)
        })
        if (loader.cyclic) addLog('warn', T('模块循环引用，预览里无法加载：', 'Circular module import, cannot load in preview: ') + loader.cyclic)
        studio.watchAssets(Array.from(loader.used))
      })
      .catch(function (e) {
        if (seq !== buildSeq) return
        addLog('error', T('预览失败：', 'Preview failed: ') + ((e && e.message) || e))
      })
  }

  var mountSeq = 0
  var latestToken = ''
  function mount(token, html) {
    var f = document.createElement('iframe')
    f.className = 'pv pending'
    f.title = T('网页预览', 'Page preview')
    f.setAttribute('sandbox', settings.scripts ? 'allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads' : 'allow-downloads')
    f.setAttribute('allow', 'fullscreen; autoplay; clipboard-write')
    var rec = { frame: f, seq: ++mountSeq, token: token }
    frames.set(token, rec)
    latestToken = token
    var shown = false
    var show = function () {
      if (shown || !frames.has(token)) return
      shown = true
      // 更新的预览已经显示了：这个作废
      if (current && current.seq > rec.seq) {
        f.remove()
        frames.delete(token)
        return
      }
      // 比它早的预览都撤掉
      frames.forEach(function (v, k) {
        if (v.seq < rec.seq) {
          v.frame.remove()
          frames.delete(k)
        }
      })
      f.classList.remove('pending')
      current = rec
      emptyEl.hidden = true
    }
    f.addEventListener('load', show)
    setTimeout(show, 1500) // 页面一直在加载（大图、长连接）时也先换上
    f.srcdoc = html
    device.append(f)
  }

  /* ---------------- 设备尺寸 ---------------- */

  function layoutDevice() {
    var d = DEVICES[settings.device] || DEVICES.fill
    main.dataset.device = settings.device
    if (!d.w) {
      frameBox.style.width = frameBox.style.height = ''
      device.style.width = device.style.height = device.style.transform = ''
      sizeLbl.hidden = true
      return
    }
    var turn = settings.landscape && (settings.device === 'tablet' || settings.device === 'mobile')
    var w = turn ? d.h : d.w
    var h = turn ? d.w : d.h
    var aw = stage.clientWidth - 40
    var ah = stage.clientHeight - 64
    var scale = Math.min(1, aw / w, ah / h)
    if (!(scale > 0)) scale = 1
    // 外框占缩放后的尺寸，里面的网页按设备尺寸布局再整体缩小
    frameBox.style.width = Math.round(w * scale) + 'px'
    frameBox.style.height = Math.round(h * scale) + 'px'
    device.style.width = w + 'px'
    device.style.height = h + 'px'
    device.style.transform = scale < 1 ? 'scale(' + scale + ')' : ''
    sizeLbl.hidden = false
    sizeLbl.textContent = w + ' × ' + h + (scale < 1 ? ' · ' + Math.round(scale * 100) + '%' : '')
  }
  new ResizeObserver(function () {
    layoutDevice()
  }).observe(stage)

  /* ---------------- 控制台 ---------------- */

  var logs = []
  var counts = { error: 0, warn: 0 }
  function clearLog() {
    logs = []
    counts = { error: 0, warn: 0 }
    logList.replaceChildren()
    updateBadge()
  }
  function addLog(level, msg, where) {
    if (level !== 'error' && level !== 'warn' && level !== 'debug') level = 'info'
    var last = logs[logs.length - 1]
    if (last && last.level === level && last.msg === msg && last.where === (where || '')) {
      last.count++
      last.cnt.textContent = String(last.count)
      last.cnt.hidden = false
    } else {
      if (logs.length >= 1000) {
        var old = logs.shift()
        old.row.remove()
      }
      var cnt = el('span', { class: 'cnt', hidden: true })
      var row = el('div', { class: 'log ' + level }, cnt, el('span', { class: 'msg', text: msg }), where ? el('span', { class: 'where', text: where }) : null)
      var stick = logList.scrollTop + logList.clientHeight >= logList.scrollHeight - 4
      logList.append(row)
      if (stick) logList.scrollTop = logList.scrollHeight
      logs.push({ level: level, msg: msg, where: where || '', count: 1, cnt: cnt, row: row })
    }
    if (level === 'error' || level === 'warn') {
      counts[level]++
      updateBadge()
    }
  }
  function updateBadge() {
    var b = $('#conBtn')
    if (!b) return
    var n = counts.error + counts.warn
    var badge = b.querySelector('.badge')
    if (!n) {
      if (badge) badge.remove()
      return
    }
    if (!badge) {
      badge = el('span', { class: 'badge' })
      b.append(badge)
    }
    badge.className = 'badge' + (counts.error ? ' err' : '')
    badge.textContent = n > 99 ? '99+' : String(n)
  }
  function toggleConsole(on) {
    settings.console = on == null ? !settings.console : on
    saveSettings()
    consoleEl.hidden = !settings.console
    buildBar()
  }

  /* ---------------- 预览框发来的消息 ---------------- */

  /** 消息来自 token 对应的预览框（或它里面嵌套的本地网页） */
  function fromFrame(src, token) {
    var rec = frames.get(token)
    if (!rec || !src) return null
    var w = rec.frame.contentWindow
    for (var i = 0; i < 5 && src; i++) {
      if (src === w) return rec
      if (src === window || src === src.parent) break
      src = src.parent
    }
    return null
  }

  window.addEventListener('message', function (e) {
    var m = e.data
    if (!m || typeof m !== 'object' || typeof m.__hp !== 'string') return
    var rec = fromFrame(e.source, m.__hp)
    if (!rec) return
    var isCurrent = m.__hp === latestToken
    switch (m.t) {
      case 'console':
        if (isCurrent) addLog(m.level, String(m.text), m.where ? String(m.where) : '')
        break
      case 'clear':
        if (isCurrent) clearLog()
        break
      case 'fetch': {
        var p = typeof m.href === 'string' ? HP.join('', m.href) : null
        ;(p ? loader.blob(p) : Promise.resolve(null))
          .then(function (b) {
            return b ? b.arrayBuffer().then(function (buf) { return { data: buf, mime: b.type } }) : null
          })
          .then(function (r) {
            var msg = { __hp: m.__hp, t: 'fetch', id: m.id, data: r ? r.data : null, mime: r ? r.mime : '' }
            e.source.postMessage(msg, '*', r ? [r.data] : [])
          })
        if (p) studio.watchAssets(Array.from(loader.used))
        break
      }
      case 'link':
        if (typeof m.href === 'string') {
          var target = HP.join('', m.href)
          if (target) studio.openLink(target)
        }
        break
      case 'open':
        if (typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) studio.openExternal(m.url)
        break
      case 'storage':
        if (m.data && typeof m.data === 'object' && (m.kind === 'local' || m.kind === 'session' || m.kind === 'cookie')) storageFor(filePath)[m.kind] = m.data
        break
      case 'scroll':
        if (isCurrent) lastScroll = { x: +m.x || 0, y: +m.y || 0 }
        break
      case 'loaded':
        if (isCurrent) {
          var ms = Math.round(performance.now() - started)
          $('#status').textContent = T('已加载 · ', 'Loaded · ') + ms + ' ms'
        }
        break
      case 'key':
        onFrameKey(m)
        break
    }
  })

  /** 焦点在预览框里时按的快捷键 */
  function onFrameKey(m) {
    var mod = m.ctrlKey || m.metaKey
    if (m.key === 'F5' || (mod && /^r$/i.test(m.key))) return refresh(true)
    if (m.key === 'F12') return toggleConsole()
    // 其余的交给 SDK（Ctrl S 保存，其他组合键转给 IDE）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, code: m.code, ctrlKey: !!m.ctrlKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey, metaKey: !!m.metaKey, bubbles: true, cancelable: true }))
  }

  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey
    if (e.key === 'F5' || (mod && !e.shiftKey && /^r$/i.test(e.key))) {
      e.preventDefault()
      refresh(true)
    } else if (e.key === 'F12') {
      e.preventDefault()
      toggleConsole()
    }
  })

  /* ---------------- 源码编辑器 ---------------- */

  var lineEls = []
  var curLine = -1
  function renderSource() {
    var lines = hpHighlight(text)
    var html = ''
    for (var i = 0; i < lines.length; i++) html += '<div class="ln" data-n="' + (i + 1) + '">' + (lines[i] || '<br>') + '</div>'
    hlEl.innerHTML = html
    lineEls = hlEl.children
    curLine = -1
    markCurrentLine()
  }
  function caretLine() {
    var v = srcEl.value
    var pos = srcEl.selectionStart
    var n = 0
    for (var i = v.indexOf('\n'); i >= 0 && i < pos; i = v.indexOf('\n', i + 1)) n++
    return n
  }
  function markCurrentLine() {
    if (settings.mode === 'preview') return
    var n = document.activeElement === srcEl ? caretLine() : -1
    if (n === curLine) return
    if (lineEls[curLine]) lineEls[curLine].classList.remove('cur')
    curLine = n
    if (lineEls[n]) lineEls[n].classList.add('cur')
  }

  var liveRefresh = debounce(function () {
    refresh(false)
  }, 450)
  var renderSoon = debounce(renderSource, 30)

  function onTextChanged() {
    text = srcEl.value
    if (text.length > 120000) renderSoon()
    else renderSource()
    studio.setDirty(text !== savedText)
    if (settings.mode === 'split' && settings.live) liveRefresh()
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

  var VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i

  srcEl.addEventListener('input', onTextChanged)
  srcEl.addEventListener('keydown', function (e) {
    var v = srcEl.value
    var a = srcEl.selectionStart
    var b = srcEl.selectionEnd
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      var ls = v.lastIndexOf('\n', a - 1) + 1
      if (a === b && !e.shiftKey) return replaceRange(a, b, '  ')
      var le = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b)
      if (le < 0) le = v.length
      var block = v.slice(ls, le)
      var out = e.shiftKey ? block.replace(/^( {1,2}|\t)/gm, '') : block.replace(/^/gm, '  ')
      replaceRange(ls, le, out, ls, ls + out.length)
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      e.preventDefault()
      var lineStart = v.lastIndexOf('\n', a - 1) + 1
      var indent = /^[ \t]*/.exec(v.slice(lineStart, a))[0]
      var before = v.slice(lineStart, a)
      var after = v.slice(b)
      // 在 <div>|</div> 之间回车：中间空一行并缩进
      var open = /<([a-zA-Z][\w-]*)(?:\s[^<>]*)?>\s*$/.exec(before)
      if (open && !VOID.test(open[1]) && new RegExp('^\\s*</' + open[1] + '\\s*>').test(after)) {
        var ins = '\n' + indent + '  \n' + indent
        replaceRange(a, b, ins, a + indent.length + 3)
        return
      }
      if (/[{[(]\s*$/.test(before) || (open && !VOID.test(open[1]))) indent += '  '
      replaceRange(a, b, '\n' + indent)
    } else if (e.key === '>' && a === b && !e.ctrlKey && !e.metaKey) {
      // 输入开始标签的 > 时补上结束标签
      var m = /<([a-zA-Z][\w-]*)(?:\s[^<>]*)?$/.exec(v.slice(Math.max(0, a - 300), a))
      if (m && !VOID.test(m[1]) && v[a - 1] !== '/' && !new RegExp('^</' + m[1] + '>').test(v.slice(a))) {
        e.preventDefault()
        replaceRange(a, b, '></' + m[1] + '>', a + 1)
      }
    }
  })
  ;['keyup', 'click', 'focus', 'blur', 'select'].forEach(function (ev) {
    srcEl.addEventListener(ev, markCurrentLine)
  })
  document.addEventListener('selectionchange', function () {
    if (document.activeElement === srcEl) markCurrentLine()
  })

  /* ---------------- 模式 ---------------- */

  function applySettings() {
    main.dataset.mode = settings.mode
    document.body.dataset.mode = settings.mode
    consoleEl.hidden = !settings.console || settings.mode === 'source'
    buildBar()
    layoutDevice()
  }

  function setMode(mode) {
    if (settings.mode === mode) return
    var wasSource = settings.mode === 'source'
    settings.mode = mode
    saveSettings()
    applySettings()
    if (mode !== 'preview') {
      renderSource()
      requestAnimationFrame(function () {
        srcEl.focus({ preventScroll: true })
      })
    }
    if (mode !== 'source' && (wasSource || !current)) refresh(false)
  }

  /* ---------------- 工具栏 ---------------- */

  function tb(icon, title, fn, opts) {
    opts = opts || {}
    var b = el('button', { type: 'button', class: 'tb' + (opts.on ? ' on' : '') + (opts.off ? ' off' : ''), title: title, 'aria-label': title, 'aria-pressed': opts.toggle ? String(!!opts.on) : null, id: opts.id, html: icon })
    if (opts.label) b.append(el('span', { class: 'lbl', text: opts.label }))
    b.addEventListener('click', fn)
    return b
  }

  function buildBar() {
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': T('显示模式', 'View mode') })
    ;[
      ['preview', T('预览', 'Preview')],
      ['split', T('分栏', 'Split')],
      ['source', T('源码', 'Source')]
    ].forEach(function (x) {
      var b = el('button', { type: 'button', class: settings.mode === x[0] ? 'on' : null, 'aria-pressed': String(settings.mode === x[0]) }, x[1])
      b.addEventListener('click', function () {
        setMode(x[0])
      })
      seg.append(b)
    })

    var d = DEVICES[settings.device] || DEVICES.fill
    var devBtn = tb(ICON[settings.device] || ICON.fill, T('预览尺寸', 'Viewport size'), function (e) { openDeviceMenu(e.currentTarget) }, { label: T(d.zh, d.en), id: 'devBtn' })
    devBtn.classList.add('boxed')
    var rotatable = settings.device === 'tablet' || settings.device === 'mobile'

    var conBtn = tb(ICON.terminal, T('控制台', 'Console') + ' (F12)', function () { toggleConsole() }, { on: settings.console, id: 'conBtn', toggle: true })

    bar.replaceChildren(
      seg,
      el('span', { class: 'sep pv-only' }),
      el('div', { class: 'grp pv-only' },
        tb(ICON.reload, T('刷新预览', 'Reload preview') + ' (F5)', function () { refresh(true) }),
        devBtn,
        rotatable ? tb(ICON.rotate, T('横竖屏切换', 'Rotate'), function () {
          settings.landscape = !settings.landscape
          saveSettings()
          layoutDevice()
        }, { on: settings.landscape, toggle: true }) : null,
        el('span', { id: 'status', class: 'status' })
      ),
      el('span', { class: 'sp' }),
      el('div', { class: 'grp pv-only' },
        tb(ICON.script, settings.scripts ? T('脚本：已启用（点击关闭）', 'Scripts: on (click to turn off)') : T('脚本：已关闭（点击启用）', 'Scripts: off (click to turn on)'), function () {
          settings.scripts = !settings.scripts
          saveSettings()
          buildBar()
          refresh(false)
        }, { on: settings.scripts, off: !settings.scripts, toggle: true }),
        tb(ICON.globe, settings.network ? T('联网：网页可以加载网络资源（点击断网预览）', 'Network: the page can load online resources (click to go offline)') : T('断网预览：只加载本地文件（点击允许联网）', 'Offline: only local files are loaded (click to allow network)'), function () {
          settings.network = !settings.network
          saveSettings()
          buildBar()
          refresh(false)
        }, { on: settings.network, off: !settings.network, toggle: true }),
        conBtn
      ),
      tb(ICON.more, T('更多', 'More'), function (e) { openMoreMenu(e.currentTarget) })
    )
    updateBadge()
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
    menuEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px'
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

  function menuItem(icon, label, desc, checked, fn) {
    var b = el('button', { type: 'button', class: 'mi' }, el('span', { class: 'ck', html: checked ? ICON.check : '' }), icon ? el('span', { class: 'ic', html: icon }) : null, el('span', { text: label }), desc ? el('span', { class: 'desc', text: desc }) : null)
    b.addEventListener('click', function () {
      closeMenu()
      fn()
    })
    return b
  }

  function openDeviceMenu(anchor) {
    openMenu(anchor, function (m) {
      Object.keys(DEVICES).forEach(function (k) {
        var d = DEVICES[k]
        m.append(
          menuItem(ICON[k], T(d.zh, d.en), d.w ? d.w + ' × ' + d.h : T('铺满', 'Full size'), settings.device === k, function () {
            settings.device = k
            saveSettings()
            buildBar()
            layoutDevice()
          })
        )
      })
    })
  }

  function openMoreMenu(anchor) {
    openMenu(anchor, function (m) {
      m.append(
        menuItem(ICON.bolt, T('分栏时边写边刷新', 'Live reload while typing (split)'), '', settings.live, function () {
          settings.live = !settings.live
          saveSettings()
        }),
        menuItem(ICON.clear, T('清除网页存储', 'Clear page storage'), 'localStorage / cookie', false, function () {
          storages.delete(filePath)
          refresh(true)
          studio.toast(T('已清除预览网页的存储', 'Page storage cleared'))
        }),
        el('hr'),
        menuItem(ICON.exportI, T('导出为单文件 HTML', 'Export as single-file HTML'), T('内嵌本地资源', 'Inlines local files'), false, exportBundle),
        menuItem(ICON.text, T('用文本编辑器打开', 'Open in text editor'), '', false, function () {
          studio.openText()
        })
      )
    })
  }

  /* ---------------- 导出单文件 ---------------- */

  function exportBundle() {
    var L = newLoader()
    HP.build(text, { loader: L, dir: '', depth: 0, boot: null, csp: null })
      .then(function (html) {
        var base = fileName.replace(/\.[^.]+$/, '')
        return studio.exportFile(base + '.bundle.html', html).then(function () {
          if (L.missing.size) studio.toast(T('有 ', '') + L.missing.size + T(' 个文件没找到，没有内嵌', ' missing file(s) were not inlined'))
        })
      })
      .catch(function (e) {
        studio.toast(T('导出失败：', 'Export failed: ') + ((e && e.message) || e))
      })
  }

  /* ---------------- 控制台面板按钮 ---------------- */

  $('#conClear').addEventListener('click', clearLog)
  $('#conClose').addEventListener('click', function () {
    toggleConsole(false)
  })

  /* ---------------- 和 IDE 的连接 ---------------- */

  studio.onLoad(function (content, info) {
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
    if (!sameFile) {
      loader = newLoader()
      lastScroll = { x: 0, y: 0 }
    }
    filePath = (info && info.path) || ''
    fileName = (info && info.fileName) || fileName
    document.title = fileName
    emptyEl.textContent = T('正在生成预览…', 'Building preview…')
    text = savedText = norm
    var keep = sameFile ? srcScroll.scrollTop : 0
    srcEl.value = norm
    loaded = true
    applySettings()
    if (settings.mode !== 'preview') renderSource()
    srcScroll.scrollTop = keep
    refresh(false)
  })

  studio.onSave(function () {
    sentText = text
    return bom + (eol === '\n' ? text : text.replace(/\n/g, eol))
  })

  studio.onSaved(function () {
    if (sentText != null) savedText = sentText
    sentText = null
    if (text !== savedText) studio.setDirty(true)
    // 预览模式下没有边写边刷新：保存后刷新一次
    if (settings.mode === 'split' && !settings.live) refresh(false)
  })

  // 网页引用的 CSS / JS / 图片在磁盘上变了：重新读取并刷新
  var assetRefresh = debounce(function () {
    refresh(true)
  }, 150)
  studio.onAssetChanged(assetRefresh)

  applySettings()
})()
