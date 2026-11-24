/**
 * Infinite Studio 插件 SDK（编辑器页面用）
 *
 * 插件页面运行在 iframe 里，只能通过这里的函数和 IDE 通信。完整说明见 marketplace/README.md。
 *
 * 基础（接口版本 1，所有 IDE 都支持）
 *   studio.onLoad((content, info) => {...})   打开 / 重新加载文件。content 是字符串（文本文件）或 ArrayBuffer（binary: true）
 *   studio.onSave(() => content)              IDE 要保存时调用，返回要写入文件的内容（可以返回 Promise）
 *   studio.onSaved(() => {...})               保存完成
 *   studio.setDirty(true / false)             标记有没有未保存的修改（标签上显示圆点）
 *   studio.save()                             主动保存（Ctrl S 已自动处理）
 *   studio.onTheme((theme) => {...})          IDE 主题变化；CSS 变量 --st-bg、--st-text 等会自动更新
 *   studio.exportFile(name, data)             另存为对话框，data 是字符串 / ArrayBuffer / Uint8Array / Blob
 *   studio.toast(text)                        IDE 底部提示
 *   studio.openExternal(url)                  用系统浏览器打开 https 链接
 *   studio.openText()                         用 IDE 的文本编辑器打开当前文件
 *   studio.openLink(href)                     打开相对于当前文件的链接（只限工作区内）
 *   studio.readAsset(href)                    读取相对于当前文件的任意文件 → Promise<Blob | null>（只限工作区内）
 *   studio.watchAssets([href...])             监视这些文件，变了就调用 onAssetChanged(paths)
 *   studio.locale                             'zh' | 'en'
 *
 * 扩展（接口版本 2）：调用失败时 Promise 会 reject；IDE 太旧时 reject 并说明需要更新
 *   studio.api                                IDE 支持的接口版本（旧 IDE 为 1）
 *   studio.has('fs.write')                    这个 IDE 支不支持某个方法
 *   studio.call(method, ...args)              通用调用（下面的函数都是它的简写）
 *   studio.fs.read / readText / write / stat / exists / list / files / mkdir / delete / move / watch
 *   studio.dialog.open / save
 *   studio.clipboard.readText / writeText
 *   studio.net.fetch(url, init)               主进程发请求，不受跨域限制（需要 network 权限）
 *   studio.editor.open / openText / setTitle / save / reload
 *   studio.ui.toast / confirm / openExternal
 *   studio.terminal.run(command, { cwd, title })   （需要 terminal 权限）
 *   studio.commands.register(id, title, fn)   在命令面板里加命令（插件编辑器显示时）
 *   studio.onShow(fn)                         插件标签切到前台
 *
 * AI 联动（接口版本 5）
 *   studio.tools.register(name, fn)           实现 manifest.agentTools 里声明的工具：fn(args) → 结果（可以返回 Promise）
 *                                             结果：字符串 / 可 JSON 化的对象 / { content: [...] }（MCP 格式）；抛错表示失败
 *   studio.tools.image(src, caption)          把 canvas / Blob / data URL 转成图片结果（Promise）
 *   studio.agent.send(text, { file })         把文字放进 IDE 里 AI 对话的输入框；file: true 时一起 @ 当前文件
 *
 * 路径：相对于当前文件；以 / 开头时相对于工作区根目录。只能访问工作区里的文件。
 */
;(function () {
  'use strict'
  var parentOrigin = '*'
  var handlers = { load: null, save: null, theme: [], saved: [], asset: [], show: [] }
  var commands = {}
  var tools = {}
  /** 最近一次 onLoad 处理完（onLoad 返回 Promise 时等它）：AI 工具在这之后才执行 */
  var loaded = null
  var seq = 0
  var pending = {}
  var dirty = false
  var methods = []

  function send(msg, transfer) {
    msg.studio = 1
    window.parent.postMessage(msg, parentOrigin, transfer || [])
  }

  /** 发请求等回复：回复里有 error 时 reject */
  function request(msg, transfer) {
    var id = ++seq
    msg.id = id
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject }
      send(msg, transfer || (msg.data instanceof ArrayBuffer ? [msg.data] : []))
    })
  }

  function applyTheme(t) {
    if (!t) return
    var s = document.documentElement.style
    var map = { bg: '--st-bg', panel: '--st-panel', line: '--st-line', sel: '--st-sel', text: '--st-text', muted: '--st-muted', accent: '--st-accent', font: '--st-font-code' }
    for (var k in map) if (t[k]) s.setProperty(map[k], t[k])
    document.documentElement.style.colorScheme = t.light ? 'light' : 'dark'
    document.documentElement.dataset.theme = t.light ? 'light' : 'dark'
    studio.theme = t
    handlers.theme.forEach(function (fn) {
      fn(t)
    })
  }

  function each(list, arg) {
    list.forEach(function (fn) {
      try {
        fn(arg)
      } catch (e) {
        console.error(e)
      }
    })
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return
    var m = e.data
    if (!m || m.studio !== 1) return
    switch (m.type) {
      case 'load':
        parentOrigin = e.origin && e.origin !== 'null' ? e.origin : '*'
        if (m.locale) studio.locale = m.locale
        studio.api = typeof m.api === 'number' ? m.api : 1
        methods = Array.isArray(m.methods) ? m.methods : []
        studio.permissions = Array.isArray(m.permissions) ? m.permissions : []
        applyTheme(m.theme)
        dirty = false
        var ret = null
        try {
          if (handlers.load) ret = handlers.load(m.content, { fileName: m.fileName, path: m.path, relPath: m.relPath || null })
        } catch (err) {
          console.error(err)
        }
        loaded = Promise.resolve(ret).catch(function () {})
        break
      case 'tool':
        runTool(m)
        break
      case 'theme':
        applyTheme(m.theme)
        break
      case 'getContent':
        Promise.resolve()
          .then(function () {
            if (!handlers.save) throw new Error('no onSave handler')
            return handlers.save()
          })
          .then(function (v) {
            if (typeof Blob !== 'undefined' && v instanceof Blob) return v.arrayBuffer()
            return v
          })
          .then(function (v) {
            send({ type: 'response', id: m.id, value: v })
          })
          .catch(function (err) {
            send({ type: 'response', id: m.id, value: null })
            studio.toast(String((err && err.message) || err))
          })
        break
      case 'saved':
        dirty = false
        each(handlers.saved)
        break
      case 'assetChanged':
        each(handlers.asset, Array.isArray(m.paths) ? m.paths : [])
        break
      case 'show':
        each(handlers.show)
        break
      case 'command':
        if (commands[m.id]) {
          try {
            commands[m.id]()
          } catch (err) {
            console.error(err)
          }
        }
        break
      case 'response':
        if (pending[m.id]) {
          var p = pending[m.id]
          delete pending[m.id]
          if (m.error) p.reject(new Error(String(m.error)))
          else p.resolve(m.value)
        }
        break
    }
  })

  // 快捷键：Ctrl S 保存；编辑器没处理的 Ctrl / Cmd 组合键交给 IDE（命令面板、关闭标签等）
  var EDITING = /^[acvxzyfhgd]$/i
  window.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      studio.save()
      return
    }
    // 插件自己处理的快捷键请在 document 或元素上监听并调用 preventDefault，这里就不会再转发
    if (e.defaultPrevented) return
    var fkey = /^F\d{1,2}$/.test(e.key)
    var combo = mod && ((e.key.length === 1 && !EDITING.test(e.key)) || e.key === 'Tab')
    if (!fkey && !combo) return
    e.preventDefault()
    send({ type: 'key', key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey })
  })

  /* ---------------- AI 工具 ---------------- */

  function toolResult(v) {
    if (v && typeof v === 'object' && Array.isArray(v.content)) return v
    if (v === undefined || v === null) return { content: [{ type: 'text', text: 'OK' }] }
    if (typeof v === 'string') return { content: [{ type: 'text', text: v }] }
    return { content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] }
  }

  function runTool(m) {
    var fn = tools[m.name]
    var wait = loaded || new Promise(function (r) {
      // 文件还没加载：等 load 消息
      var timer = setInterval(function () {
        if (loaded) {
          clearInterval(timer)
          r(loaded)
        }
      }, 50)
    })
    Promise.resolve(wait)
      .then(function () {
        if (!fn) throw new Error('This plugin does not implement the tool "' + m.name + '"')
        return fn(m.args && typeof m.args === 'object' ? m.args : {})
      })
      .then(function (v) {
        send({ type: 'response', id: m.id, value: toolResult(v) })
      })
      .catch(function (err) {
        send({ type: 'response', id: m.id, error: String((err && err.message) || err) })
      })
  }

  function blobToBase64(b) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader()
      fr.onload = function () {
        resolve(String(fr.result))
      }
      fr.onerror = function () {
        reject(fr.error)
      }
      fr.readAsDataURL(b)
    })
  }

  /** canvas / Blob / data URL → { content: [image, text?] } */
  function toolImage(src, caption) {
    var p
    if (typeof src === 'string') p = Promise.resolve(src)
    else if (typeof Blob !== 'undefined' && src instanceof Blob) p = blobToBase64(src)
    else if (src && typeof src.toBlob === 'function')
      p = new Promise(function (r) {
        src.toBlob(r, 'image/png')
      }).then(blobToBase64)
    else return Promise.reject(new Error('image source must be a canvas, Blob or data URL'))
    return p.then(function (url) {
      var mm = /^data:([^;,]+);base64,(.*)$/.exec(url)
      if (!mm) throw new Error('invalid image')
      var content = [{ type: 'image', data: mm[2], mimeType: mm[1] }]
      if (caption) content.push({ type: 'text', text: String(caption) })
      return { content: content }
    })
  }

  /** Blob / Uint8Array → ArrayBuffer（字符串原样） */
  function toData(d) {
    if (typeof Blob !== 'undefined' && d instanceof Blob) return d.arrayBuffer()
    if (d instanceof Uint8Array) return Promise.resolve(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
    return Promise.resolve(d)
  }

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1)
    if (studio.api < 2) return Promise.reject(new Error(studio.t('需要更新 Infinite Studio 才能使用：', 'This needs a newer Infinite Studio: ') + method))
    return request({ type: 'call', method: method, args: args })
  }

  var studio = {
    locale: 'zh',
    theme: null,
    api: 1,
    permissions: [],
    onLoad: function (fn) {
      handlers.load = fn
    },
    onSave: function (fn) {
      handlers.save = fn
    },
    onSaved: function (fn) {
      handlers.saved.push(fn)
    },
    onTheme: function (fn) {
      handlers.theme.push(fn)
      if (studio.theme) fn(studio.theme)
    },
    onShow: function (fn) {
      handlers.show.push(fn)
    },
    setDirty: function (v) {
      v = !!v
      if (v === dirty) return
      dirty = v
      send({ type: 'dirty', dirty: v })
    },
    isDirty: function () {
      return dirty
    },
    save: function () {
      send({ type: 'save' })
    },
    exportFile: function (name, data) {
      return toData(data).then(function (d) {
        return request({ type: 'export', name: name, data: d })
      })
    },
    toast: function (text) {
      send({ type: 'toast', text: String(text) })
    },
    openExternal: function (url) {
      send({ type: 'openExternal', url: String(url) })
    },
    openText: function () {
      send({ type: 'openText' })
    },
    openLink: function (href) {
      send({ type: 'openLink', href: String(href) })
    },
    readAsset: function (href) {
      return request({ type: 'readAsset', href: String(href) }).then(function (v) {
        return v && v.data ? new Blob([v.data], { type: v.mime || '' }) : null
      })
    },
    watchAssets: function (hrefs) {
      send({ type: 'watch', hrefs: Array.prototype.slice.call(hrefs || []).map(String) })
    },
    /** fn(paths)：变了的文件（watchAssets / fs.watch 给的原路径） */
    onAssetChanged: function (fn) {
      handlers.asset.push(fn)
    },

    /* ---------------- 接口版本 2 ---------------- */

    has: function (method) {
      return methods.indexOf(method) >= 0
    },
    call: call,
    fs: {
      /** → ArrayBuffer */
      read: function (path) {
        return call('fs.read', path)
      },
      readText: function (path) {
        return call('fs.read', path, { encoding: 'utf8' })
      },
      readJSON: function (path) {
        return call('fs.read', path, { encoding: 'utf8' }).then(JSON.parse)
      },
      /** 写当前文件以外的文件需要 workspace-write 权限；会自动建上级目录 */
      write: function (path, data) {
        return toData(data).then(function (d) {
          return call('fs.write', path, d)
        })
      },
      /** → { type: 'file' | 'dir', size, mtime } | null */
      stat: function (path) {
        return call('fs.stat', path)
      },
      exists: function (path) {
        return call('fs.exists', path)
      },
      /** → [{ name, type, path }] */
      list: function (dir) {
        return call('fs.list', dir || '.')
      },
      /** 工作区里的所有文件 → ['/src/a.js', ...]；opts.extension 过滤扩展名 */
      files: function (opts) {
        return call('fs.files', opts || {})
      },
      mkdir: function (path) {
        return call('fs.mkdir', path)
      },
      /** 移到回收站 */
      delete: function (path) {
        return call('fs.delete', path)
      },
      move: function (from, to) {
        return call('fs.move', from, to)
      },
      /** 变化时调用 onAssetChanged(paths) */
      watch: function (paths) {
        return call('fs.watch', Array.prototype.slice.call(paths || []).map(String))
      }
    },
    dialog: {
      /** 让用户选文件（可以在工作区外）→ [{ name, data }]；opts: { title, extensions, multiple, encoding: 'utf8' } */
      open: function (opts) {
        return call('dialog.open', opts || {})
      },
      /** 另存为 → 保存的路径，取消时为 null */
      save: function (name, data) {
        return toData(data).then(function (d) {
          return call('dialog.save', name, d)
        })
      }
    },
    clipboard: {
      writeText: function (text) {
        return call('clipboard.writeText', String(text))
      },
      /** 需要 clipboard-read 权限 */
      readText: function () {
        return call('clipboard.readText')
      }
    },
    net: {
      /**
       * 需要 network 权限。init: { method, headers, body, timeout }
       * → { status, statusText, url, headers, body: ArrayBuffer, text(), json() }
       */
      fetch: function (url, init) {
        init = init || {}
        return toData(init.body).then(function (body) {
          var o = { method: init.method, headers: init.headers, timeout: init.timeout, body: body }
          return call('net.fetch', String(url), o).then(function (r) {
            r.ok = r.status >= 200 && r.status < 300
            r.text = function () {
              return Promise.resolve(new TextDecoder().decode(r.body))
            }
            r.json = function () {
              return r.text().then(JSON.parse)
            }
            return r
          })
        })
      }
    },
    editor: {
      /** 在 IDE 里打开工作区文件；opts: { line, col, text: true 用文本编辑器 } */
      open: function (path, opts) {
        return call('editor.open', path, opts || {})
      },
      openText: function () {
        return call('editor.openText')
      },
      setTitle: function (title) {
        return call('editor.setTitle', String(title))
      },
      save: function () {
        return call('editor.save')
      },
      /** 从磁盘重新读取当前文件（会再次调用 onLoad） */
      reload: function () {
        return call('editor.reload')
      }
    },
    ui: {
      toast: function (text) {
        return call('ui.toast', String(text))
      },
      confirm: function (message) {
        return call('ui.confirm', String(message))
      },
      openExternal: function (url) {
        return call('ui.openExternal', String(url))
      }
    },
    terminal: {
      /** 需要 terminal 权限；每次 IDE 运行期间第一次会询问用户。opts: { cwd, title } */
      run: function (command, opts) {
        return call('terminal.run', String(command), opts || {})
      }
    },
    tools: {
      /** 实现 manifest.agentTools 里的工具 */
      register: function (name, fn) {
        tools[String(name)] = fn
      },
      image: toolImage
    },
    agent: {
      /** 把文字放进 AI 对话的输入框（不会自动发送）；opts.file: true 时一起引用当前文件 */
      send: function (text, opts) {
        return call('agent.send', String(text == null ? '' : text), opts || {})
      }
    },
    commands: {
      register: function (id, title, fn) {
        commands[id] = fn
        return call('commands.register', id, title)
      },
      unregister: function (id) {
        delete commands[id]
        return call('commands.unregister', id)
      }
    },

    /** 中英文：t('中文', 'English') */
    t: function (zh, en) {
      return studio.locale === 'en' ? en : zh
    }
  }
  window.studio = studio

  // 页面脚本都执行完后再通知 IDE（让插件先注册 onLoad）
  if (document.readyState === 'complete') setTimeout(function () { send({ type: 'ready' }) })
  else window.addEventListener('load', function () { send({ type: 'ready' }) })
})()
