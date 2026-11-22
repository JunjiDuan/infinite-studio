/* HTML 预览 —— 注入到被预览网页最前面的脚本
 *
 * 这个函数不在插件页面里执行：HP.bootSource(cfg) 把它转成源码字符串，放进预览框的 <head>。
 * 预览框是没有同源权限的沙箱，下面这些事只能在里面做，再用 postMessage 告诉插件：
 *   - 转发 console 输出、脚本错误、资源加载失败
 *   - 拦截链接：外部链接用系统浏览器打开，本地 .html 在 IDE 里打开
 *   - fetch / XMLHttpRequest 读取相对路径的本地文件（由插件代读）
 *   - localStorage / sessionStorage / cookie：沙箱里不能用，换成内存实现（刷新预览后保留）
 *   - 刷新前记住滚动位置；快捷键交回 IDE
 */
;(function () {
  'use strict'

  function boot(cfg) {
    var target = window
    for (var i = 0; i <= cfg.depth; i++) target = target.parent
    var top = cfg.depth === 0

    function post(m, transfer) {
      m.__hp = cfg.token
      try {
        target.postMessage(m, cfg.origin, transfer || [])
      } catch (e) {
        /* 预览已关闭 */
      }
    }

    function isLocal(u) {
      u = String(u == null ? '' : u).trim()
      return !!u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u) && u[0] !== '#' && u[0] !== '?'
    }

    /** 页面里的相对地址 → 相对于根 html 的地址；以 / 开头的（工作区根目录）原样 */
    function fromPage(href) {
      href = String(href).trim()
      return href[0] === '/' ? href : cfg.dir + href
    }

    /* ---------- console ---------- */

    function fmt(v) {
      try {
        if (typeof v === 'string') return v
        if (v === undefined) return 'undefined'
        if (v === null) return 'null'
        if (v instanceof Error) return fixLines(v.stack && v.stack.indexOf(v.message) >= 0 ? v.stack : v.name + ': ' + v.message)
        if (typeof v === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()'
        if (typeof v !== 'object') return String(v)
        if (typeof Element !== 'undefined' && v instanceof Element) return elLabel(v)
        var seen = []
        var s = JSON.stringify(
          v,
          function (k, x) {
            if (typeof x === 'bigint') return x + 'n'
            if (typeof x === 'function') return 'ƒ ' + (x.name || '') + '()'
            if (x === undefined) return 'undefined'
            if (x && typeof x === 'object') {
              if (typeof Element !== 'undefined' && x instanceof Element) return elLabel(x)
              if (seen.indexOf(x) >= 0) return '[Circular]'
              seen.push(x)
              if (x instanceof Map) return { 'Map': Array.from(x.entries()) }
              if (x instanceof Set) return { 'Set': Array.from(x.values()) }
            }
            return x
          },
          2
        )
        if (s === undefined) s = String(v)
        return s.length > 8000 ? s.slice(0, 8000) + ' …' : s
      } catch (e) {
        try {
          return String(v)
        } catch (e2) {
          return '[object]'
        }
      }
    }
    /** 调用栈里的 about:srcdoc:12:3 显示成“行 12:3” */
    function fixLines(s) {
      return String(s).replace(/about:srcdoc:(\d+)(?::(\d+))?/g, function (m, l, c) {
        return cfg.text.line + ' ' + l + (c ? ':' + c : '')
      })
    }
    function elLabel(el) {
      var s = '<' + el.tagName.toLowerCase()
      if (el.id) s += '#' + el.id
      if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).join('.')
      return s + '>'
    }
    /** console.log('%s 个', 3) 这类格式串 */
    function format(args) {
      args = Array.prototype.slice.call(args)
      if (typeof args[0] === 'string' && /%[sdifoOc]/.test(args[0])) {
        var rest = args.slice(1)
        var head = args[0].replace(/%([sdifoOc%])/g, function (m, c) {
          if (c === '%') return '%'
          if (!rest.length) return m
          var v = rest.shift()
          if (c === 'c') return ''
          if (c === 'd' || c === 'i') return String(parseInt(v, 10))
          if (c === 'f') return String(parseFloat(v))
          return fmt(v)
        })
        args = [head].concat(rest)
      }
      return args.map(fmt).join(' ')
    }
    function log(level, text, where) {
      post({ t: 'console', level: level, text: String(text), where: where || '' })
    }

    var con = window.console
    ;['log', 'info', 'warn', 'error', 'debug'].forEach(function (lv) {
      var orig = con[lv]
      con[lv] = function () {
        log(lv === 'log' ? 'info' : lv, format(arguments))
        if (orig) return orig.apply(con, arguments)
      }
    })
    var origTable = con.table
    con.table = function (d) {
      log('info', fmt(d))
      if (origTable) return origTable.apply(con, arguments)
    }
    var origAssert = con.assert
    con.assert = function (ok) {
      if (!ok) log('error', 'Assertion failed' + (arguments.length > 1 ? ': ' + format(Array.prototype.slice.call(arguments, 1)) : ''))
      if (origAssert) return origAssert.apply(con, arguments)
    }
    var origClear = con.clear
    con.clear = function () {
      post({ t: 'clear' })
      if (origClear) return origClear.apply(con, arguments)
    }
    var timers = {}
    con.time = function (l) {
      timers[l || 'default'] = performance.now()
    }
    con.timeEnd = function (l) {
      l = l || 'default'
      if (timers[l] == null) return
      log('info', l + ': ' + (performance.now() - timers[l]).toFixed(1) + ' ms')
      delete timers[l]
    }

    window.addEventListener(
      'error',
      function (e) {
        var el = e.target
        if (el && el !== window && el.tagName) {
          var url = el.currentSrc || el.src || el.href || ''
          if (/^data:/.test(url)) url = el.getAttribute('data-href') || ''
          log('warn', cfg.text.res + ' <' + el.tagName.toLowerCase() + '> ' + (url.length > 200 ? url.slice(0, 200) + '…' : url))
          return
        }
        var srcdoc = !e.filename || /^about:/.test(e.filename)
        var where = e.lineno && !/^data:/.test(e.filename || '') ? (srcdoc ? cfg.text.line + ' ' + e.lineno :e.filename + ':' + e.lineno) + (e.colno ? ':' + e.colno : '') : ''
        // 位置单独显示；错误对象的调用栈只在有多层时才有用
        var msg = e.error instanceof Error ? e.error.name + ': ' + e.error.message : e.message
        var stack = e.error && e.error.stack ? String(e.error.stack).split('\n').slice(1) : []
        if (stack.length > 1) msg += '\n' + fixLines(stack.join('\n'))
        log('error', msg, where)
      },
      true
    )
    window.addEventListener('unhandledrejection', function (e) {
      log('error', 'Uncaught (in promise) ' + fmt(e.reason))
    })
    window.addEventListener('securitypolicyviolation', function (e) {
      log('warn', cfg.text.csp + ' ' + (e.blockedURI || e.violatedDirective))
    })

    /* ---------- 链接、表单、弹窗 ---------- */

    function openUrl(href) {
      href = String(href || '').trim()
      if (/^https?:\/\//i.test(href)) post({ t: 'open', url: href })
      else if (isLocal(href)) post({ t: 'link', href: fromPage(href) })
    }
    window.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0) return
      var a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null
      if (!a || a.hasAttribute('download')) return
      var href = (a.getAttribute('href') || '').trim()
      if (!href || href[0] === '#' || /^javascript:/i.test(href)) return
      e.preventDefault()
      openUrl(href)
    })
    window.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return
      e.preventDefault()
      log('info', cfg.text.form)
    })
    window.open = function (u) {
      if (u) openUrl(u)
      return null
    }

    /* ---------- 读取本地文件：fetch / XMLHttpRequest ---------- */

    var seq = 0
    var pend = {}
    function readLocal(href) {
      return new Promise(function (res) {
        var id = ++seq
        pend[id] = res
        post({ t: 'fetch', id: id, href: fromPage(href) })
      })
    }
    var origFetch = window.fetch
    window.fetch = function (input, init) {
      var method = (init && init.method) || 'GET'
      var url = typeof input === 'string' ? input : typeof URL !== 'undefined' && input instanceof URL ? input.href : null
      if (url != null && isLocal(url) && /^(get|head)$/i.test(method)) {
        return readLocal(url).then(function (r) {
          if (!r) return new Response('Not Found', { status: 404, statusText: 'Not Found' })
          return new Response(/^head$/i.test(method) ? null : r.data, { status: 200, statusText: 'OK', headers: { 'content-type': r.mime || 'application/octet-stream' } })
        })
      }
      return origFetch.apply(this, arguments)
    }
    var XP = XMLHttpRequest.prototype
    var xOpen = XP.open
    var xSend = XP.send
    var xHeader = XP.getResponseHeader
    var xAll = XP.getAllResponseHeaders
    XP.open = function (method, url) {
      this.__hpUrl = typeof url === 'string' && isLocal(url) && /^get$/i.test(method) ? url : null
      if (!this.__hpUrl) return xOpen.apply(this, arguments)
      def(this, 'readyState', 1)
    }
    XP.send = function () {
      var x = this
      if (!x.__hpUrl) return xSend.apply(x, arguments)
      readLocal(x.__hpUrl).then(function (r) {
        var buf = r ? r.data : new ArrayBuffer(0)
        var text = r ? new TextDecoder().decode(buf) : 'Not Found'
        var rt = x.responseType
        var resp = text
        if (rt === 'arraybuffer') resp = buf
        else if (rt === 'blob') resp = new Blob([buf], { type: r ? r.mime : '' })
        else if (rt === 'json') {
          try {
            resp = JSON.parse(text)
          } catch (e) {
            resp = null
          }
        } else if (rt === 'document') resp = new DOMParser().parseFromString(text, /xml/.test(r && r.mime) ? 'application/xml' : 'text/html')
        def(x, 'status', r ? 200 : 404)
        def(x, 'statusText', r ? 'OK' : 'Not Found')
        def(x, 'responseURL', x.__hpUrl)
        def(x, 'response', resp)
        def(x, 'responseText', !rt || rt === 'text' ? text : '')
        x.__hpMime = r ? r.mime : ''
        def(x, 'readyState', 4)
        ;['readystatechange', 'load', 'loadend'].forEach(function (type) {
          x.dispatchEvent(type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, { loaded: buf.byteLength, total: buf.byteLength }))
        })
      })
    }
    XP.getResponseHeader = function (n) {
      if (!this.__hpUrl) return xHeader.apply(this, arguments)
      return /^content-type$/i.test(n) ? this.__hpMime || null : null
    }
    XP.getAllResponseHeaders = function () {
      if (!this.__hpUrl) return xAll.apply(this, arguments)
      return this.__hpMime ? 'content-type: ' + this.__hpMime + '\r\n' : ''
    }
    function def(o, k, v) {
      Object.defineProperty(o, k, { value: v, configurable: true, writable: true })
    }

    /* ---------- localStorage / sessionStorage / cookie ---------- */

    function store(kind, init) {
      var d = Object.create(null)
      for (var k in init || {}) d[k] = String(init[k])
      function sync() {
        post({ t: 'storage', kind: kind, data: Object.assign({}, d) })
      }
      var api = {
        getItem: function (k) {
          k = String(k)
          return k in d ? d[k] : null
        },
        setItem: function (k, v) {
          d[String(k)] = String(v)
          sync()
        },
        removeItem: function (k) {
          delete d[String(k)]
          sync()
        },
        clear: function () {
          for (var k in d) delete d[k]
          sync()
        },
        key: function (i) {
          var ks = Object.keys(d)
          return i >= 0 && i < ks.length ? ks[i] : null
        }
      }
      Object.defineProperty(api, 'length', {
        get: function () {
          return Object.keys(d).length
        }
      })
      return new Proxy(api, {
        get: function (t, k) {
          if (k in t) return t[k]
          return typeof k === 'string' && k in d ? d[k] : undefined
        },
        set: function (t, k, v) {
          if (typeof k === 'string') t.setItem(k, v)
          return true
        },
        has: function (t, k) {
          return k in t || (typeof k === 'string' && k in d)
        },
        deleteProperty: function (t, k) {
          if (typeof k === 'string') t.removeItem(k)
          return true
        },
        ownKeys: function () {
          return Object.keys(d)
        },
        getOwnPropertyDescriptor: function (t, k) {
          if (typeof k === 'string' && k in d) return { value: d[k], enumerable: true, configurable: true, writable: true }
          return undefined
        }
      })
    }
    var ls = store('local', cfg.storage.local)
    var ss = store('session', cfg.storage.session)
    try {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return ls } })
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return ss } })
    } catch (e) {
      /* 忽略 */
    }
    var jar = Object.assign({}, cfg.storage.cookie || {})
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () {
          return Object.keys(jar)
            .map(function (k) {
              return k + '=' + jar[k]
            })
            .join('; ')
        },
        set: function (v) {
          var first = String(v).split(';')[0]
          var i = first.indexOf('=')
          var k = (i < 0 ? '' : first.slice(0, i)).trim()
          var val = (i < 0 ? first : first.slice(i + 1)).trim()
          var expired = /;\s*(max-age\s*=\s*(0|-\d+)|expires\s*=\s*thu,\s*01\s+jan\s+1970)/i.test(String(v))
          if (expired) delete jar[k]
          else jar[k] = val
          post({ t: 'storage', kind: 'cookie', data: Object.assign({}, jar) })
        }
      })
    } catch (e) {
      /* 忽略 */
    }

    /* ---------- 插件发来的消息 ---------- */

    window.addEventListener('message', function (e) {
      if (e.source !== target) return
      var m = e.data
      if (!m || m.__hp !== cfg.token) return
      e.stopImmediatePropagation()
      if (m.t === 'fetch' && pend[m.id]) {
        pend[m.id](m.data ? { data: m.data, mime: m.mime } : null)
        delete pend[m.id]
      } else if (m.t === 'scroll' && top) {
        window.scrollTo(m.x, m.y)
      }
    })

    /* ---------- 滚动位置、快捷键、加载完成 ---------- */

    if (top) {
      var sx = cfg.scroll ? cfg.scroll.x : 0
      var sy = cfg.scroll ? cfg.scroll.y : 0
      var restore = function () {
        if (sx || sy) window.scrollTo(sx, sy)
      }
      document.addEventListener('DOMContentLoaded', restore)
      window.addEventListener('load', function () {
        restore()
        // 图片、字体加载完后页面可能变高，再对一次
        setTimeout(restore, 60)
        post({ t: 'loaded', title: document.title })
      })
      var raf = 0
      window.addEventListener(
        'scroll',
        function () {
          if (raf) return
          raf = requestAnimationFrame(function () {
            raf = 0
            sx = window.scrollX
            sy = window.scrollY
            post({ t: 'scroll', x: sx, y: sy })
          })
        },
        { passive: true }
      )
    }
    window.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey
      var fkey = /^F\d{1,2}$/.test(e.key)
      if (!fkey && !(mod && !e.altKey && e.key.length === 1)) return
      // 页面自己处理过的不转发；Ctrl S / Ctrl R / F5 / F12 总是交给插件
      var always = fkey || /^[srSR]$/.test(e.key)
      if (e.defaultPrevented && !always) return
      if (always) e.preventDefault()
      post({ t: 'key', key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey })
    })
  }

  /** 生成注入用的源码 */
  window.HP = window.HP || {}
  window.HP.bootSource = function (cfg) {
    return '(' + boot.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ');'
  }
})()
