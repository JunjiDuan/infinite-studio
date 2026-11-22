/**
 * Infinite Studio 插件 SDK（编辑器页面用）
 *
 * 插件页面运行在 iframe 里，只能通过这里的函数和 IDE 通信：
 *   studio.onLoad((content, info) => {...})   打开 / 重新加载文件。content 是字符串（文本文件）或 ArrayBuffer（binary: true）
 *   studio.onSave(() => content)              IDE 要保存时调用，返回要写入文件的内容（可以返回 Promise）
 *   studio.setDirty(true / false)             标记有没有未保存的修改（标签上显示圆点）
 *   studio.save()                             主动保存（Ctrl S 已自动处理）
 *   studio.onTheme((theme) => {...})          IDE 主题变化；CSS 变量 --st-bg、--st-text 等会自动更新
 *   studio.exportFile(name, data)             另存为对话框，data 是字符串 / ArrayBuffer / Uint8Array / Blob
 *   studio.toast(text)                        IDE 底部提示
 *   studio.openExternal(url)                  用系统浏览器打开 https 链接
 *   studio.openText()                         用 IDE 的文本编辑器打开当前文件
 *   studio.openLink(href)                     打开相对于当前文件的链接（只限工作区内）
 *   studio.readAsset(href)                    读取相对于当前文件的图片 → Promise<Blob | null>（只限工作区内）
 *   studio.locale                             'zh' | 'en'
 */
;(function () {
  'use strict'
  var parentOrigin = '*'
  var handlers = { load: null, save: null, theme: [], saved: [] }
  var seq = 0
  var pending = {}
  var dirty = false

  function send(msg, transfer) {
    msg.studio = 1
    window.parent.postMessage(msg, parentOrigin, transfer || [])
  }

  function request(msg) {
    var id = ++seq
    msg.id = id
    return new Promise(function (resolve) {
      pending[id] = resolve
      send(msg, msg.data instanceof ArrayBuffer ? [msg.data] : [])
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

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return
    var m = e.data
    if (!m || m.studio !== 1) return
    switch (m.type) {
      case 'load':
        parentOrigin = e.origin && e.origin !== 'null' ? e.origin : '*'
        if (m.locale) studio.locale = m.locale
        applyTheme(m.theme)
        dirty = false
        if (handlers.load) handlers.load(m.content, { fileName: m.fileName, path: m.path })
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
        handlers.saved.forEach(function (fn) {
          fn()
        })
        break
      case 'response':
        if (pending[m.id]) {
          pending[m.id](m.value)
          delete pending[m.id]
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

  var studio = {
    locale: 'zh',
    theme: null,
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
      return Promise.resolve(typeof Blob !== 'undefined' && data instanceof Blob ? data.arrayBuffer() : data).then(function (d) {
        if (d instanceof Uint8Array) d = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)
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
