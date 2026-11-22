/**
 * PPTX 包模型：zip 条目、XML 解析缓存、关系（.rels）、内容类型、主题、颜色与填充、文本样式继承。
 * 渲染在 render.js，编辑界面在 app.js。
 */
;(function () {
  'use strict'

  var NS = {
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    pr: 'http://schemas.openxmlformats.org/package/2006/relationships',
    ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
    c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
    dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
    dsp: 'http://schemas.microsoft.com/office/drawing/2008/diagram',
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main'
  }
  var REL = {
    slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
    layout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
    master: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
    theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
    image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    notes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
    notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
    chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
    officeDoc: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
  }
  var CT = {
    slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
  }
  var XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

  /* ---------------- XML 小工具 ---------------- */

  /** 直接子元素（按本地名） */
  function kid(el, name) {
    if (!el) return null
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c
    return null
  }
  function kids(el, name) {
    var out = []
    if (!el) return out
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name) out.push(c)
    return out
  }
  /** 路径：path(el, 'spPr', 'xfrm', 'off') */
  function path(el) {
    for (var i = 1; i < arguments.length && el; i++) el = kid(el, arguments[i])
    return el || null
  }
  function desc(el, name) {
    return el ? Array.prototype.slice.call(el.getElementsByTagNameNS('*', name)) : []
  }
  function attr(el, name, def) {
    if (!el) return def
    var v = el.getAttribute(name)
    return v == null ? def : v
  }
  function num(el, name, def) {
    var v = attr(el, name, null)
    if (v == null || v === '') return def
    var n = Number(v)
    return isNaN(n) ? def : n
  }
  function bool(el, name, def) {
    var v = attr(el, name, null)
    if (v == null) return def
    return v === '1' || v === 'true' || v === 'on'
  }
  function rid(el, name) {
    return el ? el.getAttributeNS(NS.r, name || 'embed') || el.getAttribute('r:' + (name || 'embed')) || '' : ''
  }
  /** 新建带前缀的元素 */
  function mk(doc, q, attrs) {
    var i = q.indexOf(':')
    var pre = q.slice(0, i)
    var el = doc.createElementNS(NS[pre], q)
    if (attrs) for (var k in attrs) if (attrs[k] != null) setAttr(el, k, attrs[k])
    return el
  }
  function setAttr(el, k, v) {
    if (k.indexOf('r:') === 0) el.setAttributeNS(NS.r, k, String(v))
    else el.setAttribute(k, String(v))
  }
  /** 取子元素，没有就按 schema 顺序插入 */
  function ensure(el, q, order) {
    var name = q.slice(q.indexOf(':') + 1)
    var c = kid(el, name)
    if (c) return c
    c = mk(el.ownerDocument, q)
    insertOrdered(el, c, order)
    return c
  }
  /** 按 order（本地名列表）找到插入位置 */
  function insertOrdered(parent, child, order) {
    if (!order) return parent.appendChild(child)
    var idx = order.indexOf(child.localName)
    for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
      var j = order.indexOf(c.localName)
      if (j > idx || (j < 0 && idx >= 0 && c.localName === 'extLst')) {
        parent.insertBefore(child, c)
        return child
      }
    }
    parent.appendChild(child)
    return child
  }
  function removeKid(el, name) {
    var c = kid(el, name)
    if (c) el.removeChild(c)
  }
  var FILL_NAMES = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']
  var SPPR_ORDER = ['xfrm', 'custGeom', 'prstGeom', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'ln', 'effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst']
  var RPR_ORDER = ['ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']
  var PPR_ORDER = ['lnSpc', 'spcBef', 'spcAft', 'buClrTx', 'buClr', 'buSzTx', 'buSzPct', 'buSzPts', 'buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr', 'extLst']
  var LN_ORDER = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'prstDash', 'custDash', 'round', 'bevel', 'miter', 'headEnd', 'tailEnd', 'extLst']

  /** 把 spPr / rPr 里的填充换成 solidFill srgbClr（hex 为 null 时设为 noFill） */
  function setSolidFill(el, hex, order) {
    FILL_NAMES.forEach(function (n) {
      removeKid(el, n)
    })
    var doc = el.ownerDocument
    if (hex == null) {
      insertOrdered(el, mk(doc, 'a:noFill'), order)
      return
    }
    var f = mk(doc, 'a:solidFill')
    f.appendChild(mk(doc, 'a:srgbClr', { val: hex.replace('#', '').toUpperCase() }))
    insertOrdered(el, f, order)
  }

  function resolvePath(base, target) {
    if (!target) return ''
    if (target.charAt(0) === '/') return target.slice(1)
    var dir = base.slice(0, base.lastIndexOf('/') + 1)
    var parts = (dir + target).split('/')
    var out = []
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') out.pop()
      else if (parts[i] && parts[i] !== '.') out.push(parts[i])
    }
    return out.join('/')
  }
  /** 从 from 部件指向 to 部件的相对路径 */
  function relativePath(from, to) {
    var a = from.split('/').slice(0, -1)
    var b = to.split('/')
    var i = 0
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
    var up = []
    for (var j = i; j < a.length; j++) up.push('..')
    return up.concat(b.slice(i)).join('/')
  }
  function relsName(part) {
    var i = part.lastIndexOf('/')
    return part.slice(0, i + 1) + '_rels/' + part.slice(i + 1) + '.rels'
  }

  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf', ico: 'image/x-icon' }
  function extOf(name) {
    var m = /\.([^./]+)$/.exec(name)
    return m ? m[1].toLowerCase() : ''
  }

  /* ---------------- 包 ---------------- */

  var enc = new TextEncoder()
  var dec = new TextDecoder('utf-8')
  var serializer = new XMLSerializer()
  var parser = new DOMParser()

  function isXml(name) {
    return /\.(xml|rels|vml)$/i.test(name)
  }

  function serialize(doc) {
    var s = serializer.serializeToString(doc)
    s = s.replace(/^<\?xml[^>]*\?>\s*/, '')
    return XML_DECL + s
  }

  function Pkg() {
    this.recs = new Map()
    this.order = []
    this.urls = new Map()
  }

  Pkg.prototype.load = async function (buf) {
    var entries = Zip.read(buf)
    var self = this
    await Promise.all(
      entries.map(async function (e) {
        if (e.name.charAt(e.name.length - 1) === '/') return
        var rec = { name: e.name, entry: e, orig: null, str: null, doc: null, ver: 0, cache: null, cacheVer: -1, bytes: null }
        if (isXml(e.name)) {
          var b = await e.data()
          var s = dec.decode(b)
          if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
          rec.orig = rec.str = s
        }
        self.recs.set(e.name, rec)
      })
    )
    entries.forEach(function (e) {
      if (self.recs.has(e.name)) self.order.push(e.name)
    })
    // 图片先解压好，渲染时同步拿 URL
    var media = []
    this.recs.forEach(function (rec, name) {
      if (MIME[extOf(name)] && !isXml(name)) media.push(name)
    })
    await Promise.all(
      media.map(function (n) {
        return self.recs
          .get(n)
          .entry.data()
          .then(function (b) {
            self.urls.set(n, URL.createObjectURL(new Blob([b], { type: MIME[extOf(n)] })))
          })
          .catch(function () {})
      })
    )
  }

  Pkg.prototype.has = function (name) {
    return this.recs.has(name)
  }
  Pkg.prototype.doc = function (name) {
    var rec = this.recs.get(name)
    if (!rec) return null
    if (!rec.doc) {
      if (rec.str == null) return null
      var d = parser.parseFromString(rec.str, 'application/xml')
      if (d.getElementsByTagName('parsererror').length) return null
      rec.doc = d
    }
    return rec.doc
  }
  Pkg.prototype.root = function (name) {
    var d = this.doc(name)
    return d ? d.documentElement : null
  }
  /** 标记 XML 已修改 */
  Pkg.prototype.touch = function (name) {
    var rec = this.recs.get(name)
    if (rec) rec.ver++
  }
  Pkg.prototype.text = function (name) {
    var rec = this.recs.get(name)
    if (!rec) return null
    return this._textOf(rec)
  }
  Pkg.prototype.setXml = function (name, str) {
    var rec = this.recs.get(name)
    if (!rec) {
      rec = { name: name, entry: null, orig: null, str: null, doc: null, ver: 0, cache: null, cacheVer: -1, bytes: null }
      this.recs.set(name, rec)
      this.order.push(name)
    }
    rec.str = str
    rec.doc = null
    rec.ver++
  }
  Pkg.prototype.setBytes = function (name, bytes) {
    var rec = { name: name, entry: null, orig: null, str: null, doc: null, ver: 0, cache: null, cacheVer: -1, bytes: bytes }
    if (!this.recs.has(name)) this.order.push(name)
    this.recs.set(name, rec)
    var mime = MIME[extOf(name)]
    if (mime) {
      if (this.urls.has(name)) URL.revokeObjectURL(this.urls.get(name))
      this.urls.set(name, URL.createObjectURL(new Blob([bytes], { type: mime })))
    }
  }
  /** 复制部件（二进制部件直接共用原来的压缩数据） */
  Pkg.prototype.copyEntry = function (src, dst) {
    var rec = this.recs.get(src)
    if (!rec) return
    if (isXml(src)) return this.setXml(dst, this.text(src))
    if (!this.recs.has(dst)) this.order.push(dst)
    this.recs.set(dst, { name: dst, entry: rec.entry, orig: null, str: null, doc: null, ver: 0, cache: null, cacheVer: -1, bytes: rec.bytes })
    if (this.urls.has(src)) this.urls.set(dst, this.urls.get(src))
  }
  Pkg.prototype.remove = function (name) {
    if (!this.recs.delete(name)) return
    var i = this.order.indexOf(name)
    if (i >= 0) this.order.splice(i, 1)
  }
  Pkg.prototype.mediaUrl = function (name) {
    return this.urls.get(name) || ''
  }
  Pkg.prototype.bytes = async function (name) {
    var rec = this.recs.get(name)
    if (!rec) return null
    if (rec.bytes) return rec.bytes
    if (isXml(name)) return enc.encode(this.text(name))
    return rec.entry.data()
  }
  /** 给新部件找一个不重名的名字：uniqueName('ppt/slides/slide', '.xml') */
  Pkg.prototype.uniqueName = function (prefix, ext) {
    for (var i = 1; ; i++) if (!this.recs.has(prefix + i + ext)) return prefix + i + ext
  }

  /** 撤销用的快照：只记字符串 / 引用，开销很小 */
  Pkg.prototype.snapshot = function () {
    var self = this
    return {
      order: this.order.slice(),
      recs: this.order.map(function (n) {
        var r = self.recs.get(n)
        return { name: n, entry: r.entry, orig: r.orig, bytes: r.bytes, str: isXml(n) ? self.text(n) : null }
      })
    }
  }
  Pkg.prototype.restore = function (snap) {
    var self = this
    var old = this.recs
    this.recs = new Map()
    this.order = snap.order.slice()
    snap.recs.forEach(function (s) {
      var prev = old.get(s.name)
      // 字符串没变就保留解析好的 DOM（引用不变，渲染缓存也能复用）
      if (prev && prev.doc && s.str != null && self._textOf(prev) === s.str) {
        self.recs.set(s.name, prev)
        return
      }
      self.recs.set(s.name, { name: s.name, entry: s.entry, orig: s.orig, str: s.str, doc: null, ver: 0, cache: null, cacheVer: -1, bytes: s.bytes })
    })
    // 恢复被删掉的图片 URL
    snap.recs.forEach(function (s) {
      if (s.bytes && MIME[extOf(s.name)] && !self.urls.has(s.name)) self.urls.set(s.name, URL.createObjectURL(new Blob([s.bytes], { type: MIME[extOf(s.name)] })))
    })
  }
  Pkg.prototype._textOf = function (rec) {
    // 解析过但没改过的部件原样返回，保存时直接复制原压缩数据
    if (rec.doc && rec.ver > 0) {
      if (rec.cacheVer !== rec.ver) {
        rec.cache = serialize(rec.doc)
        rec.cacheVer = rec.ver
      }
      return rec.cache
    }
    return rec.str
  }

  Pkg.prototype.save = async function () {
    var self = this
    var files = []
    // [Content_Types].xml 放第一个
    var names = this.order.slice().sort(function (a, b) {
      return (a === '[Content_Types].xml' ? 0 : 1) - (b === '[Content_Types].xml' ? 0 : 1)
    })
    names.forEach(function (n) {
      var rec = self.recs.get(n)
      if (!rec) return
      if (isXml(n)) {
        var s = self.text(n)
        if (rec.entry && s === rec.orig) files.push({ name: n, entry: rec.entry })
        else files.push({ name: n, data: enc.encode(s) })
      } else if (rec.bytes) files.push({ name: n, data: rec.bytes })
      else files.push({ name: n, entry: rec.entry })
    })
    return Zip.write(files)
  }

  /* ---------- 关系 ---------- */

  Pkg.prototype.rels = function (part) {
    var root = this.root(relsName(part))
    var out = []
    if (!root) return out
    kids(root, 'Relationship').forEach(function (r) {
      var external = attr(r, 'TargetMode') === 'External'
      out.push({ id: attr(r, 'Id', ''), type: attr(r, 'Type', ''), target: external ? attr(r, 'Target', '') : resolvePath(part, attr(r, 'Target', '')), external: external, el: r })
    })
    return out
  }
  Pkg.prototype.rel = function (part, id) {
    var list = this.rels(part)
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }
  Pkg.prototype.relOfType = function (part, type) {
    var list = this.rels(part)
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i]
    return null
  }
  Pkg.prototype.relsDoc = function (part) {
    var name = relsName(part)
    if (!this.has(name)) this.setXml(name, XML_DECL + '<Relationships xmlns="' + NS.pr + '"></Relationships>')
    return name
  }
  /** 添加关系，返回 rId；targetAbs 为包内绝对路径（或外部 URL） */
  Pkg.prototype.addRel = function (part, type, targetAbs, external) {
    var name = this.relsDoc(part)
    var root = this.root(name)
    var used = {}
    kids(root, 'Relationship').forEach(function (r) {
      used[attr(r, 'Id')] = 1
    })
    var n = 1
    while (used['rId' + n]) n++
    var el = root.ownerDocument.createElementNS(NS.pr, 'Relationship')
    el.setAttribute('Id', 'rId' + n)
    el.setAttribute('Type', type)
    el.setAttribute('Target', external ? targetAbs : relativePath(part, targetAbs))
    if (external) el.setAttribute('TargetMode', 'External')
    root.appendChild(el)
    this.touch(name)
    return 'rId' + n
  }
  Pkg.prototype.removeRel = function (part, id) {
    var name = relsName(part)
    var root = this.root(name)
    if (!root) return
    kids(root, 'Relationship').forEach(function (r) {
      if (attr(r, 'Id') === id) root.removeChild(r)
    })
    this.touch(name)
  }

  /* ---------- 内容类型 ---------- */

  Pkg.prototype.addOverride = function (part, type) {
    var root = this.root('[Content_Types].xml')
    if (!root) return
    var pn = '/' + part
    var found = kids(root, 'Override').some(function (o) {
      return attr(o, 'PartName') === pn
    })
    if (found) return
    var el = root.ownerDocument.createElementNS(NS.ct, 'Override')
    el.setAttribute('PartName', pn)
    el.setAttribute('ContentType', type)
    root.appendChild(el)
    this.touch('[Content_Types].xml')
  }
  Pkg.prototype.removeOverride = function (part) {
    var root = this.root('[Content_Types].xml')
    if (!root) return
    var pn = '/' + part
    kids(root, 'Override').forEach(function (o) {
      if (attr(o, 'PartName') === pn) root.removeChild(o)
    })
    this.touch('[Content_Types].xml')
  }
  Pkg.prototype.overrideType = function (part) {
    var root = this.root('[Content_Types].xml')
    var pn = '/' + part
    var t = null
    kids(root, 'Override').forEach(function (o) {
      if (attr(o, 'PartName') === pn) t = attr(o, 'ContentType')
    })
    return t
  }
  Pkg.prototype.ensureDefault = function (ext, type) {
    var root = this.root('[Content_Types].xml')
    if (!root) return
    var has = kids(root, 'Default').some(function (d) {
      return String(attr(d, 'Extension', '')).toLowerCase() === ext
    })
    if (has) return
    var el = root.ownerDocument.createElementNS(NS.ct, 'Default')
    el.setAttribute('Extension', ext)
    el.setAttribute('ContentType', type)
    root.insertBefore(el, root.firstElementChild)
    this.touch('[Content_Types].xml')
  }

  /* ---------------- 颜色 ---------------- */

  var PRESET = {
    black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF', gray: '808080', grey: '808080',
    darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', purple: '800080', navy: '000080', maroon: '800000', olive: '808000', teal: '008080', silver: 'C0C0C0', lime: '00FF00',
    darkBlue: '00008B', darkRed: '8B0000', darkGreen: '006400', brown: 'A52A2A', pink: 'FFC0CB', gold: 'FFD700', ltGray: 'D3D3D3', dkGray: 'A9A9A9'
  }
  var SYS = { window: 'FFFFFF', windowText: '000000', btnFace: 'F0F0F0', btnText: '000000', highlight: '0078D7', highlightText: 'FFFFFF', grayText: '6D6D6D', menu: 'F0F0F0', menuText: '000000' }

  function hexToRgb(h) {
    h = String(h || '000000').replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    var n = parseInt(h.slice(0, 6), 16) || 0
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  function rgbToHex(c) {
    return (
      '#' +
      c
        .map(function (v) {
          v = Math.max(0, Math.min(255, Math.round(v)))
          return (v < 16 ? '0' : '') + v.toString(16)
        })
        .join('')
    )
  }
  function rgbToHsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255
    var max = Math.max(r, g, b), min = Math.min(r, g, b)
    var h = 0, s = 0, l = (max + min) / 2
    if (max !== min) {
      var d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h /= 6
    }
    return [h, s, l]
  }
  function hslToRgb(hsl) {
    var h = hsl[0], s = hsl[1], l = hsl[2]
    if (s === 0) return [l * 255, l * 255, l * 255]
    function f(p, q, t) {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s
    var p = 2 * l - q
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255]
  }

  function toLin(x) {
    x /= 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  function toS(v) {
    v = Math.max(0, Math.min(1, v))
    return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255
  }

  var COLOR_TAGS = { srgbClr: 1, schemeClr: 1, sysClr: 1, prstClr: 1, scrgbClr: 1, hslClr: 1 }

  /** 在 el 的子元素里找颜色元素 */
  function colorEl(el) {
    if (!el) return null
    if (COLOR_TAGS[el.localName]) return el
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (COLOR_TAGS[c.localName]) return c
    return null
  }

  /**
   * 解析颜色。ctx: { theme, clrMap, phClr }
   * 返回 { hex, alpha } 或 null
   */
  function color(el, ctx) {
    var c = colorEl(el)
    if (!c) return null
    var rgb, alpha = 1
    switch (c.localName) {
      case 'srgbClr':
        rgb = hexToRgb(attr(c, 'val'))
        break
      case 'sysClr':
        rgb = hexToRgb(attr(c, 'lastClr') || SYS[attr(c, 'val')] || '000000')
        break
      case 'prstClr':
        rgb = hexToRgb(PRESET[attr(c, 'val')] || '000000')
        break
      case 'scrgbClr':
        rgb = [num(c, 'r', 0), num(c, 'g', 0), num(c, 'b', 0)].map(function (v) {
          v /= 100000
          v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
          return v * 255
        })
        break
      case 'hslClr':
        rgb = hslToRgb([num(c, 'hue', 0) / 21600000, num(c, 'sat', 0) / 100000, num(c, 'lum', 0) / 100000])
        break
      case 'schemeClr':
        var v = attr(c, 'val')
        if (v === 'phClr') {
          if (!ctx || !ctx.phClr) return null
          rgb = hexToRgb(ctx.phClr.hex)
          alpha = ctx.phClr.alpha
        } else {
          var hex = schemeHex(v, ctx)
          rgb = hexToRgb(hex || '000000')
        }
        break
    }
    // 颜色变换
    for (var m = c.firstElementChild; m; m = m.nextElementSibling) {
      var val = num(m, 'val', 0) / 100000
      var hsl
      switch (m.localName) {
        case 'alpha':
          alpha *= val
          break
        case 'alphaMod':
          alpha *= val
          break
        case 'lumMod':
          hsl = rgbToHsl(rgb)
          hsl[2] = Math.min(1, hsl[2] * val)
          rgb = hslToRgb(hsl)
          break
        case 'lumOff':
          hsl = rgbToHsl(rgb)
          hsl[2] = Math.max(0, Math.min(1, hsl[2] + val))
          rgb = hslToRgb(hsl)
          break
        case 'satMod':
          hsl = rgbToHsl(rgb)
          hsl[1] = Math.max(0, Math.min(1, hsl[1] * val))
          rgb = hslToRgb(hsl)
          break
        case 'tint':
          // tint / shade 在线性 RGB 里计算（和 Office 一致）
          rgb = rgb.map(function (x) {
            return toS(toLin(x) * val + (1 - val))
          })
          break
        case 'shade':
          rgb = rgb.map(function (x) {
            return toS(toLin(x) * val)
          })
          break
        case 'inv':
          rgb = rgb.map(function (x) {
            return 255 - x
          })
          break
        case 'gray':
          var g = rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11
          rgb = [g, g, g]
          break
      }
    }
    return { hex: rgbToHex(rgb), alpha: alpha }
  }

  function schemeHex(v, ctx) {
    if (!ctx || !ctx.theme) return null
    var map = ctx.clrMap || {}
    var key = map[v] || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[v] || v
    return ctx.theme.colors[key] || null
  }

  function css(c) {
    if (!c) return 'transparent'
    if (c.alpha >= 0.999) return c.hex
    var rgb = hexToRgb(c.hex)
    return 'rgba(' + rgb.join(',') + ',' + c.alpha.toFixed(3) + ')'
  }

  /* ---------------- 主题 ---------------- */

  var themeCache = new WeakMap()
  function theme(pkg, name) {
    var root = pkg.root(name)
    if (!root) return { colors: {}, fonts: { major: {}, minor: {} }, fills: [], lines: [], bgFills: [] }
    var hit = themeCache.get(root)
    if (hit) return hit
    var colors = {}
    var cs = desc(root, 'clrScheme')[0]
    kids(cs).forEach(function (k) {
      var c = color(k, null)
      if (c) colors[k.localName] = c.hex.slice(1)
    })
    function font(kind) {
      var f = desc(root, kind + 'Font')[0]
      var out = { latin: attr(kid(f, 'latin'), 'typeface', ''), ea: attr(kid(f, 'ea'), 'typeface', ''), cs: attr(kid(f, 'cs'), 'typeface', ''), scripts: {} }
      // 按语言选用的字体（例如 zh-CN 文字用 Hans）
      kids(f, 'font').forEach(function (x) {
        out.scripts[attr(x, 'script', '')] = attr(x, 'typeface', '')
      })
      return out
    }
    var fmt = desc(root, 'fmtScheme')[0]
    var t = {
      colors: colors,
      fonts: { major: font('major'), minor: font('minor') },
      fills: kids(path(fmt, 'fillStyleLst')),
      lines: kids(path(fmt, 'lnStyleLst')),
      bgFills: kids(path(fmt, 'bgFillStyleLst'))
    }
    themeCache.set(root, t)
    return t
  }

  function clrMap(el) {
    var m = {}
    if (!el) return m
    for (var i = 0; i < el.attributes.length; i++) m[el.attributes[i].name] = el.attributes[i].value
    return m
  }

  /* ---------------- 填充 ---------------- */

  /**
   * 解析填充元素（noFill/solidFill/gradFill/blipFill/...），返回：
   *   { type: 'none' } | { type: 'solid', color } | { type: 'grad', stops: [{pos, color}], angle, path } | { type: 'img', url, tile } | null
   */
  function fill(el, ctx, part) {
    if (!el) return null
    switch (el.localName) {
      case 'noFill':
        return { type: 'none' }
      case 'solidFill':
        var c = color(el, ctx)
        return c ? { type: 'solid', color: c } : null
      case 'gradFill':
        var stops = kids(path(el, 'gsLst'), 'gs')
          .map(function (gs) {
            return { pos: num(gs, 'pos', 0) / 1000, color: color(gs, ctx) || { hex: '#000000', alpha: 1 } }
          })
          .sort(function (a, b) {
            return a.pos - b.pos
          })
        if (!stops.length) return null
        var lin = kid(el, 'lin')
        var pth = kid(el, 'path')
        return { type: 'grad', stops: stops, angle: lin ? num(lin, 'ang', 0) / 60000 : 90, path: pth ? attr(pth, 'path', 'circle') : null }
      case 'blipFill':
        var blip = kid(el, 'blip')
        var id = rid(blip, 'embed')
        var r = id && ctx && ctx.pkg ? ctx.pkg.rel(part || ctx.part, id) : null
        return { type: 'img', url: r ? ctx.pkg.mediaUrl(r.target) : '', tile: !!kid(el, 'tile') }
      case 'pattFill':
        var fg = color(kid(el, 'fgClr'), ctx)
        var bg = color(kid(el, 'bgClr'), ctx)
        return fg || bg ? { type: 'solid', color: mix(fg, bg) } : null
      case 'grpFill':
        return ctx && ctx.grpFill ? ctx.grpFill : null
    }
    return null
  }
  function mix(a, b) {
    if (!a) return b
    if (!b) return a
    var x = hexToRgb(a.hex), y = hexToRgb(b.hex)
    return { hex: rgbToHex([0, 1, 2].map(function (i) { return (x[i] + y[i]) / 2 })), alpha: 1 }
  }
  /** 在 el 的子元素里找填充 */
  function fillOf(el, ctx, part) {
    if (!el) return null
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (FILL_NAMES.indexOf(c.localName) >= 0) return fill(c, ctx, part)
    return null
  }
  /** 填充 → CSS background */
  function fillCss(f) {
    if (!f || f.type === 'none') return 'transparent'
    if (f.type === 'solid') return css(f.color)
    if (f.type === 'grad') {
      var st = f.stops
        .map(function (s) {
          return css(s.color) + ' ' + s.pos.toFixed(1) + '%'
        })
        .join(', ')
      if (f.path) return 'radial-gradient(circle, ' + st + ')'
      return 'linear-gradient(' + (f.angle + 90).toFixed(1) + 'deg, ' + st + ')'
    }
    if (f.type === 'img') return f.url ? 'url("' + f.url + '") center / ' + (f.tile ? 'auto' : '100% 100%') + (f.tile ? ' repeat' : ' no-repeat') : 'transparent'
    return 'transparent'
  }

  /** 主题样式矩阵引用：fillRef / lnRef / effectRef / fontRef */
  function styleFill(ref, ctx) {
    if (!ref) return null
    var idx = num(ref, 'idx', 0)
    var ph = color(ref, ctx)
    var c2 = Object.assign({}, ctx, { phClr: ph })
    if (idx === 0) return { type: 'none' }
    if (idx >= 1001) return fill(ctx.theme.bgFills[idx - 1001], c2)
    var el = ctx.theme.fills[idx - 1]
    var f = fill(el, c2)
    if (!f && ph) return { type: 'solid', color: ph }
    return f
  }
  function styleLine(ref, ctx) {
    if (!ref) return null
    var idx = num(ref, 'idx', 0)
    if (idx === 0) return null
    var ph = color(ref, ctx)
    var el = ctx.theme.lines[idx - 1]
    return { el: el, ctx: Object.assign({}, ctx, { phClr: ph }) }
  }

  /** 线条：spPr 里的 a:ln 叠加 style lnRef */
  function line(ln, styleRef, ctx) {
    var base = styleLine(styleRef, ctx)
    var out = { w: 0, color: null, dash: null, head: null, tail: null, cap: 'flat' }
    function apply(l, c) {
      if (!l) return
      if (l.hasAttribute('w')) out.w = num(l, 'w', 0)
      if (l.hasAttribute('cap')) out.cap = attr(l, 'cap')
      var f = fillOf(l, c)
      if (f) out.color = f.type === 'none' ? 'none' : f.type === 'solid' ? f.color : f.type === 'grad' ? f.stops[0].color : out.color
      var d = kid(l, 'prstDash')
      if (d) out.dash = attr(d, 'val', 'solid')
      var he = kid(l, 'headEnd')
      if (he) out.head = attr(he, 'type', 'none')
      var te = kid(l, 'tailEnd')
      if (te) out.tail = attr(te, 'type', 'none')
    }
    if (base) {
      apply(base.el, base.ctx)
      if (!out.color && base.ctx.phClr) out.color = base.ctx.phClr
    }
    apply(ln, ctx)
    if (!out.color || out.color === 'none') return null
    if (!out.w) out.w = base || ln ? 9525 : 0
    if (!out.w) return null
    return out
  }

  /* ---------------- 演示文稿结构 ---------------- */

  function Presentation(pkg) {
    this.pkg = pkg
    var main = pkg.rels('').filter(function (r) {
      return r.type === REL.officeDoc
    })[0]
    this.path = main ? main.target : 'ppt/presentation.xml'
    var root = pkg.root(this.path)
    if (!root || root.localName !== 'presentation') throw new Error('presentation.xml')
    var sz = path(root, 'sldSz')
    this.cx = num(sz, 'cx', 12192000)
    this.cy = num(sz, 'cy', 6858000)
  }
  Presentation.prototype.root = function () {
    return this.pkg.root(this.path)
  }
  /** 幻灯片列表：[{ el(sldId), rid, path }] */
  Presentation.prototype.slides = function () {
    var pkg = this.pkg
    var p = this.path
    return kids(path(this.root(), 'sldIdLst'), 'sldId')
      .map(function (s) {
        var r = pkg.rel(p, rid(s, 'id'))
        return { el: s, rid: rid(s, 'id'), id: attr(s, 'id'), path: r ? r.target : '' }
      })
      .filter(function (s) {
        return s.path && pkg.has(s.path)
      })
  }
  /** 一张幻灯片（或版式 / 母版）的渲染上下文 */
  Presentation.prototype.chain = function (slidePath) {
    var pkg = this.pkg
    var root = pkg.root(slidePath)
    var kind = root ? root.localName : ''
    var out = { slide: null, layout: null, master: null }
    if (kind === 'sld') {
      out.slide = slidePath
      var lr = pkg.relOfType(slidePath, REL.layout)
      out.layout = lr ? lr.target : null
    } else if (kind === 'sldLayout') out.layout = slidePath
    else if (kind === 'sldMaster') out.master = slidePath
    if (out.layout) {
      var mr = pkg.relOfType(out.layout, REL.master)
      out.master = mr ? mr.target : null
    }
    var tr = out.master ? pkg.relOfType(out.master, REL.theme) : null
    out.theme = theme(pkg, tr ? tr.target : '')
    var mroot = out.master ? pkg.root(out.master) : null
    var map = clrMap(path(mroot, 'clrMap'))
    // 版式 / 幻灯片的 clrMapOvr
    ;[out.layout, out.slide].forEach(function (pp) {
      var ov = pp ? path(pkg.root(pp), 'clrMapOvr', 'overrideClrMapping') : null
      if (ov) map = clrMap(ov)
    })
    out.clrMap = map
    out.pkg = pkg
    return out
  }
  /** 所有版式：[{ path, name, master }] */
  Presentation.prototype.layouts = function () {
    var pkg = this.pkg
    var pp = this.path
    var out = []
    kids(path(this.root(), 'sldMasterIdLst'), 'sldMasterId').forEach(function (m) {
      var r = pkg.rel(pp, rid(m, 'id'))
      if (!r) return
      var mroot = pkg.root(r.target)
      kids(path(mroot, 'sldLayoutIdLst'), 'sldLayoutId').forEach(function (l) {
        var lr = pkg.rel(r.target, rid(l, 'id'))
        if (!lr || !pkg.has(lr.target)) return
        var cSld = path(pkg.root(lr.target), 'cSld')
        out.push({ path: lr.target, name: attr(cSld, 'name', ''), type: attr(pkg.root(lr.target), 'type', ''), master: r.target })
      })
    })
    return out
  }

  /* ---------------- 占位符 ---------------- */

  function phOf(sp) {
    var nv = kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || kid(sp, 'nvGraphicFramePr') || kid(sp, 'nvGrpSpPr') || kid(sp, 'nvCxnSpPr')
    var ph = path(nv, 'nvPr', 'ph')
    if (!ph) return null
    return { type: attr(ph, 'type', 'obj'), idx: attr(ph, 'idx', null), el: ph }
  }
  function phShapes(root) {
    var out = []
    var tree = path(root, 'cSld', 'spTree')
    ;(function walk(t) {
      kids(t).forEach(function (c) {
        if (c.localName === 'grpSp') walk(c)
        else if (phOf(c)) out.push(c)
      })
    })(tree)
    return out
  }
  var TYPE_ALIAS = { ctrTitle: 'title', subTitle: 'body', obj: 'body' }
  /** 在版式 / 母版里找对应的占位符 */
  function findPh(root, ph, byTypeOnly) {
    if (!root || !ph) return null
    var list = phShapes(root)
    var i, q
    if (!byTypeOnly && ph.idx != null) {
      for (i = 0; i < list.length; i++) {
        q = phOf(list[i])
        if (q.idx === ph.idx) return list[i]
      }
    }
    for (i = 0; i < list.length; i++) {
      q = phOf(list[i])
      if (q.type === ph.type) return list[i]
    }
    var t = TYPE_ALIAS[ph.type] || ph.type
    for (i = 0; i < list.length; i++) {
      q = phOf(list[i])
      if ((TYPE_ALIAS[q.type] || q.type) === t) return list[i]
    }
    return null
  }
  /** 占位符继承链：[版式里的形状, 母版里的形状]（可能为 null） */
  function phChain(chain, sp, pkg) {
    var ph = phOf(sp)
    if (!ph) return []
    var out = []
    var lroot = chain.layout && chain.slide ? pkg.root(chain.layout) : null
    var mroot = chain.master ? pkg.root(chain.master) : null
    var inLayout = chain.slide ? findPh(lroot, ph) : null
    if (inLayout) out.push(inLayout)
    var lph = inLayout ? phOf(inLayout) : ph
    var inMaster = findPh(mroot, { type: lph.type, idx: null }, true)
    if (inMaster && inMaster !== sp) out.push(inMaster)
    return out
  }

  window.OX = {
    NS: NS, REL: REL, CT: CT, XML_DECL: XML_DECL,
    kid: kid, kids: kids, path: path, desc: desc, attr: attr, num: num, bool: bool, rid: rid, mk: mk, setAttr: setAttr,
    ensure: ensure, insertOrdered: insertOrdered, removeKid: removeKid, setSolidFill: setSolidFill,
    SPPR_ORDER: SPPR_ORDER, RPR_ORDER: RPR_ORDER, PPR_ORDER: PPR_ORDER, LN_ORDER: LN_ORDER, FILL_NAMES: FILL_NAMES,
    resolvePath: resolvePath, relativePath: relativePath, relsName: relsName, extOf: extOf, MIME: MIME,
    Pkg: Pkg, Presentation: Presentation, serialize: serialize,
    color: color, css: css, toLin: toLin, toS: toS, hexToRgb: hexToRgb, rgbToHex: rgbToHex, fill: fill, fillOf: fillOf, fillCss: fillCss,
    styleFill: styleFill, line: line, theme: theme, phOf: phOf, phChain: phChain, findPh: findPh, schemeHex: schemeHex
  }
})()
