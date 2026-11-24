/**
 * DOCX 包模型：zip 条目、XML 解析缓存、关系（.rels）、内容类型。
 * （通用部分和演示文稿插件的 ooxml.js 相同）
 */
;(function () {
  'use strict'

  var NS = {
    w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    pr: 'http://schemas.openxmlformats.org/package/2006/relationships',
    ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
    m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    v: 'urn:schemas-microsoft-com:vml',
    w14: 'http://schemas.microsoft.com/office/word/2010/wordml'
  }
  var REL = {
    officeDoc: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
    theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
    image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
    footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
    footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
    settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings'
  }
  var CT = {
    numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'
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

  window.OX = {
    NS: NS, REL: REL, CT: CT, XML_DECL: XML_DECL,
    kid: kid, kids: kids, path: path, desc: desc, attr: attr, num: num, bool: bool, rid: rid, mk: mk, setAttr: setAttr,
    ensure: ensure, insertOrdered: insertOrdered, removeKid: removeKid,
    resolvePath: resolvePath, relativePath: relativePath, relsName: relsName, extOf: extOf, MIME: MIME,
    Pkg: Pkg, serialize: serialize
  }
})()
