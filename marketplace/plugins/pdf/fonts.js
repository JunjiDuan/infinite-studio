/**
 * 字体：PDF 标准字体只能写西文（WinAnsi），中文等其他文字要嵌入用户选的字体文件（TTF / OTF / TTC）。
 * 选好的字体存在插件自己的 IndexedDB 里，下次打开不用再选。
 */
;(function () {
  'use strict'

  /** WinAnsi 里 0x80–0x9F 位置上的字符（其余是 Latin-1） */
  var CP1252 = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'

  /** 文字能不能用 PDF 标准字体写（不能时要用嵌入的字体） */
  function isWinAnsi(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      if (c === 10 || c === 13 || c === 9) continue
      if (c >= 32 && c < 127) continue
      if (c >= 160 && c < 256) continue
      if (CP1252.indexOf(s[i]) >= 0) continue
      return false
    }
    return true
  }

  /* ---------------- TTC → 单个字体 ---------------- */

  /** TrueType Collection 里取第 index 个字体，拼成独立的 TTF / OTF（fontkit 嵌入不支持 TTC） */
  function extractTtc(bytes, index) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    var tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
    if (tag !== 'ttcf') return bytes
    var num = dv.getUint32(8)
    if (!num) throw new Error('empty font collection')
    var off = dv.getUint32(12 + 4 * Math.min(index || 0, num - 1))
    var numTables = dv.getUint16(off + 4)
    var tables = []
    var total = 12 + 16 * numTables
    for (var i = 0; i < numTables; i++) {
      var r = off + 12 + 16 * i
      var t = { rec: r, offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) }
      tables.push(t)
      total += (t.length + 3) & ~3
    }
    var out = new Uint8Array(total)
    var odv = new DataView(out.buffer)
    out.set(bytes.subarray(off, off + 12), 0)
    var pos = 12 + 16 * numTables
    tables.forEach(function (t, i) {
      var r = 12 + 16 * i
      out.set(bytes.subarray(t.rec, t.rec + 16), r)
      odv.setUint32(r + 8, pos)
      out.set(bytes.subarray(t.offset, t.offset + t.length), pos)
      pos += (t.length + 3) & ~3
    })
    return out
  }

  /* ---------------- IndexedDB ---------------- */

  function db() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('pdf-editor', 1)
      req.onupgradeneeded = function () {
        req.result.createObjectStore('kv')
      }
      req.onsuccess = function () {
        resolve(req.result)
      }
      req.onerror = function () {
        reject(req.error)
      }
    })
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('kv', mode)
        var req = fn(tx.objectStore('kv'))
        tx.oncomplete = function () {
          resolve(req && req.result)
        }
        tx.onerror = function () {
          reject(tx.error)
        }
      })
    })
  }

  /* ---------------- 当前的 Unicode 字体 ---------------- */

  var FAMILY = 'PdfUnicodeFont'
  var current = null // { name, bytes }
  var face = null
  var listeners = []

  function apply(f) {
    current = f
    if (face) {
      document.fonts.delete(face)
      face = null
    }
    var notify = function () {
      metricsCache = {}
      listeners.forEach(function (fn) {
        fn(current)
      })
    }
    if (f) {
      try {
        face = new FontFace(FAMILY, f.bytes.slice().buffer)
        document.fonts.add(face)
        face.load().then(notify, notify)
      } catch (e) {
        console.error(e)
      }
    }
    notify()
  }

  /** 页面加载时读出上次选的字体 */
  function init() {
    return idb('readonly', function (s) {
      return s.get('unicodeFont')
    })
      .then(function (v) {
        if (v && v.bytes) apply({ name: v.name, bytes: new Uint8Array(v.bytes) })
      })
      .catch(function () {})
  }

  /** 用户选的字体文件 → 保存并启用。会先用 fontkit 试读，读不了时抛错 */
  function set(name, data) {
    var bytes = extractTtc(new Uint8Array(data), 0)
    var font = window.fontkit.create(bytes)
    if (!font || typeof font.layout !== 'function') throw new Error('unsupported font')
    var f = { name: font.fullName || font.familyName || name, bytes: bytes }
    apply(f)
    return idb('readwrite', function (s) {
      return s.put({ name: f.name, bytes: bytes.buffer }, 'unicodeFont')
    })
      .catch(function () {})
      .then(function () {
        return f
      })
  }

  function clear() {
    apply(null)
    return idb('readwrite', function (s) {
      return s.delete('unicodeFont')
    }).catch(function () {})
  }

  /* ---------------- 界面字体 ---------------- */

  /** 文字对象的字体族（界面显示用，尽量和 PDF 里的标准字体一样宽） */
  var CSS = {
    sans: 'Arial, Helvetica, "Liberation Sans", sans-serif',
    serif: '"Times New Roman", Times, "Liberation Serif", serif',
    mono: '"Courier New", Courier, "Liberation Mono", monospace'
  }

  function cssFamily(family, text) {
    if (!isWinAnsi(text || '')) {
      var cjk = family === 'serif' ? '"SimSun", "Songti SC", serif' : '"Microsoft YaHei", "PingFang SC", sans-serif'
      return current ? '"' + FAMILY + '", ' + cjk : cjk
    }
    return CSS[family] || CSS.sans
  }

  /**
   * 文字基线的位置：PDF 里每行基线在行顶 + BASELINE × 字号（与字体无关）。
   * 浏览器按字体自己的上下伸部排版，这里算出要往下挪多少（字号的倍数），让屏幕上的基线和 PDF 一致。
   */
  var BASELINE = 0.95
  var LINE = 1.25
  var metricsCache = {}
  var probe = null
  function cssShift(fontCss) {
    if (fontCss in metricsCache) return metricsCache[fontCss]
    if (!probe) probe = document.createElement('canvas').getContext('2d')
    probe.font = '100px ' + fontCss
    var m = probe.measureText('Hg国')
    var a = (m.fontBoundingBoxAscent || 90) / 100
    var d = (m.fontBoundingBoxDescent || 22) / 100
    var css = (LINE - (a + d)) / 2 + a
    var v = BASELINE - css
    metricsCache[fontCss] = v
    return v
  }

  window.PdfFonts = {
    isWinAnsi: isWinAnsi,
    init: init,
    set: set,
    clear: clear,
    get: function () {
      return current
    },
    onChange: function (fn) {
      listeners.push(fn)
    },
    cssFamily: cssFamily,
    cssShift: cssShift,
    BASELINE: BASELINE,
    LINE: LINE
  }
})()
