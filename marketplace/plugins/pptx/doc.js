/**
 * 对演示文稿 XML 的修改操作：幻灯片增删移、插入形状 / 图片 / 表格、位置大小、文本写回、复制粘贴、保存前清理。
 * 所有函数直接改 DOM，并对改过的部件调用 pkg.touch()。
 */
;(function () {
  'use strict'
  var OX = window.OX
  var NS = OX.NS
  var REL = OX.REL
  var EMU = 9525
  var SECTION_URI = '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}'

  function Doc(pkg) {
    this.pkg = pkg
    this.pres = new OX.Presentation(pkg)
  }

  /* ---------------- 幻灯片 ---------------- */

  Doc.prototype.slides = function () {
    return this.pres.slides()
  }

  Doc.prototype.nextSlideId = function () {
    var max = 255
    OX.kids(OX.path(this.pres.root(), 'sldIdLst'), 'sldId').forEach(function (s) {
      max = Math.max(max, OX.num(s, 'id', 0))
    })
    return max + 1
  }

  /** 把新幻灯片部件挂到 presentation.xml 里，位置 index（插在它前面） */
  Doc.prototype.attachSlide = function (part, index, sectionOf) {
    var pkg = this.pkg
    var pp = this.pres.path
    var rid = pkg.addRel(pp, REL.slide, part)
    var root = this.pres.root()
    var lst = OX.path(root, 'sldIdLst')
    if (!lst) {
      lst = OX.mk(root.ownerDocument, 'p:sldIdLst')
      var after = OX.path(root, 'notesMasterIdLst') || OX.path(root, 'sldMasterIdLst')
      root.insertBefore(lst, after ? after.nextElementSibling : root.firstElementChild)
    }
    var id = this.nextSlideId()
    var el = OX.mk(root.ownerDocument, 'p:sldId', { id: id, 'r:id': rid })
    var list = OX.kids(lst, 'sldId')
    lst.insertBefore(el, list[index] || null)
    pkg.addOverride(part, OX.CT.slide)
    // 节：新幻灯片放进参考幻灯片所在的节
    var sec = this.sections()
    if (sec) {
      var target = null
      if (sectionOf) target = this.sectionOfId(sectionOf)
      if (!target) target = OX.kids(sec)[0]
      if (target) {
        var ids = OX.kid(target, 'sldIdLst')
        if (!ids) ids = target.appendChild(OX.mk(root.ownerDocument, 'p14:sldIdLst'))
        var ref = null
        OX.kids(ids, 'sldId').forEach(function (s) {
          if (OX.attr(s, 'id') === String(sectionOf)) ref = s
        })
        var n = root.ownerDocument.createElementNS(NS.p14, 'p14:sldId')
        n.setAttribute('id', id)
        ids.insertBefore(n, ref ? ref.nextElementSibling : null)
      }
    }
    pkg.touch(pp)
    return id
  }

  Doc.prototype.sections = function () {
    var root = this.pres.root()
    var out = null
    OX.kids(OX.kid(root, 'extLst'), 'ext').forEach(function (e) {
      if (OX.attr(e, 'uri') === SECTION_URI) out = OX.kid(e, 'sectionLst')
    })
    return out
  }
  Doc.prototype.sectionOfId = function (id) {
    var sec = this.sections()
    var hit = null
    OX.kids(sec, 'section').forEach(function (s) {
      OX.kids(OX.kid(s, 'sldIdLst'), 'sldId').forEach(function (x) {
        if (OX.attr(x, 'id') === String(id)) hit = s
      })
    })
    return hit
  }
  /** 节名：[{ name, first(幻灯片序号) }] */
  Doc.prototype.sectionNames = function () {
    var sec = this.sections()
    if (!sec) return []
    var order = {}
    this.slides().forEach(function (s, i) {
      order[s.id] = i
    })
    var out = []
    OX.kids(sec, 'section').forEach(function (s) {
      var first = Infinity
      OX.kids(OX.kid(s, 'sldIdLst'), 'sldId').forEach(function (x) {
        var i = order[OX.attr(x, 'id')]
        if (i != null) first = Math.min(first, i)
      })
      if (first < Infinity) out.push({ name: OX.attr(s, 'name', ''), first: first })
    })
    return out
  }
  function removeFromSections(sec, id) {
    if (!sec) return
    OX.kids(sec, 'section').forEach(function (s) {
      OX.kids(OX.kid(s, 'sldIdLst'), 'sldId').forEach(function (x) {
        if (OX.attr(x, 'id') === String(id)) x.parentNode.removeChild(x)
      })
    })
  }

  /** 用版式新建幻灯片，插在 index 处，返回部件路径 */
  Doc.prototype.addSlide = function (layoutPath, index, sectionOf) {
    var pkg = this.pkg
    var lroot = pkg.root(layoutPath)
    var part = pkg.uniqueName('ppt/slides/slide', '.xml')
    var shapes = ''
    var id = 2
    OX.kids(OX.path(lroot, 'cSld', 'spTree')).forEach(function (sp) {
      var ph = OX.phOf(sp)
      if (!ph || ph.type === 'dt' || ph.type === 'ftr' || ph.type === 'sldNum' || ph.type === 'hdr') return
      var name = OX.attr(OX.desc(sp, 'cNvPr')[0], 'name', 'Placeholder')
      var attrs = (ph.el.getAttribute('type') ? ' type="' + ph.el.getAttribute('type') + '"' : '') + (ph.el.getAttribute('orient') ? ' orient="' + ph.el.getAttribute('orient') + '"' : '') + (ph.el.getAttribute('sz') ? ' sz="' + ph.el.getAttribute('sz') + '"' : '') + (ph.idx != null ? ' idx="' + ph.idx + '"' : '')
      shapes +=
        '<p:sp><p:nvSpPr><p:cNvPr id="' + id++ + '" name="' + esc(name) + '"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph' + attrs + '/></p:nvPr></p:nvSpPr><p:spPr/>' +
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p></p:txBody></p:sp>'
    })
    var xml =
      OX.XML_DECL +
      '<p:sld xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '" xmlns:p="' + NS.p + '"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      shapes +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    pkg.setXml(part, xml)
    pkg.addRel(part, REL.layout, layoutPath)
    this.attachSlide(part, index, sectionOf)
    return part
  }

  /** 复制部件（图表、SmartArt 这类不能被两张幻灯片共用的），返回新路径 */
  Doc.prototype.copyPart = function (src) {
    var pkg = this.pkg
    var self = this
    var m = /^(.*?)(\d*)(\.[^./]+)$/.exec(src)
    var name = pkg.uniqueName(m[1], m[3])
    pkg.copyEntry(src, name)
    var ct = pkg.overrideType(src)
    if (ct) pkg.addOverride(name, ct)
    var rn = OX.relsName(src)
    if (pkg.has(rn)) {
      // 子部件（图表内嵌的工作簿、图表样式等）也要各自一份：PowerPoint 不接受两个图表共用一个工作簿
      pkg.setXml(OX.relsName(name), pkg.text(rn))
      var root = pkg.root(OX.relsName(name))
      OX.kids(root, 'Relationship').forEach(function (r) {
        if (OX.attr(r, 'TargetMode') === 'External') return
        var target = OX.resolvePath(src, OX.attr(r, 'Target', ''))
        if (!pkg.has(target) || !/^ppt\/(charts|diagrams|embeddings|drawings)\//.test(target)) return
        r.setAttribute('Target', OX.relativePath(name, self.copyPart(target)))
      })
      pkg.touch(OX.relsName(name))
    }
    return name
  }
  function deepCopyRel(r) {
    return !r.external && /^ppt\/(charts|diagrams)\/[^/]+\.xml$/.test(r.target)
  }

  Doc.prototype.duplicateSlide = function (index) {
    var pkg = this.pkg
    var s = this.slides()[index]
    if (!s) return null
    var part = pkg.uniqueName('ppt/slides/slide', '.xml')
    pkg.setXml(part, pkg.text(s.path))
    var self = this
    pkg.relsDoc(part)
    var root = pkg.root(OX.relsName(part))
    pkg.rels(s.path).forEach(function (r) {
      if (r.type === REL.notes) return
      var el = root.ownerDocument.createElementNS(NS.pr, 'Relationship')
      el.setAttribute('Id', r.id)
      el.setAttribute('Type', r.type)
      if (r.external) {
        el.setAttribute('Target', r.target)
        el.setAttribute('TargetMode', 'External')
      } else el.setAttribute('Target', OX.relativePath(part, deepCopyRel(r) ? self.copyPart(r.target) : r.target))
      root.appendChild(el)
    })
    pkg.touch(OX.relsName(part))
    this.attachSlide(part, index + 1, s.id)
    return part
  }

  Doc.prototype.deleteSlide = function (index) {
    var pkg = this.pkg
    var s = this.slides()[index]
    if (!s) return
    var pp = this.pres.path
    s.el.parentNode.removeChild(s.el)
    pkg.removeRel(pp, s.rid)
    removeFromSections(this.sections(), s.id)
    // 自定义放映里的引用
    OX.desc(this.pres.root(), 'sld').forEach(function (x) {
      if (x.parentNode && x.parentNode.localName === 'sldLst' && OX.rid(x, 'id') === s.rid) x.parentNode.removeChild(x)
    })
    pkg.touch(pp)
    var notes = pkg.relOfType(s.path, REL.notes)
    if (notes) this.removePart(notes.target)
    this.removePart(s.path)
  }

  Doc.prototype.removePart = function (part) {
    var pkg = this.pkg
    pkg.remove(part)
    pkg.remove(OX.relsName(part))
    pkg.removeOverride(part)
  }

  Doc.prototype.moveSlide = function (from, to) {
    var list = this.slides()
    if (from === to || !list[from] || to < 0 || to >= list.length) return false
    var el = list[from].el
    var lst = el.parentNode
    lst.removeChild(el)
    var rest = OX.kids(lst, 'sldId')
    lst.insertBefore(el, rest[to] || null)
    // 节：移到新位置前一张所在的节（第一张则跟后一张）
    var sec = this.sections()
    if (sec) {
      var now = this.slides()
      var ref = now[to - 1] || now[to + 1]
      if (ref) {
        removeFromSections(sec, list[from].id)
        var target = this.sectionOfId(ref.id)
        if (target) {
          var ids = OX.kid(target, 'sldIdLst')
          var n = el.ownerDocument.createElementNS(NS.p14, 'p14:sldId')
          n.setAttribute('id', list[from].id)
          var refEl = null
          OX.kids(ids, 'sldId').forEach(function (x) {
            if (OX.attr(x, 'id') === ref.id) refEl = x
          })
          if (now[to - 1]) ids.insertBefore(n, refEl ? refEl.nextElementSibling : null)
          else ids.insertBefore(n, refEl)
        }
      }
    }
    this.pkg.touch(this.pres.path)
    return true
  }

  Doc.prototype.setHidden = function (index, hidden) {
    var s = this.slides()[index]
    var root = this.pkg.root(s.path)
    if (hidden) root.setAttribute('show', '0')
    else root.removeAttribute('show')
    this.pkg.touch(s.path)
  }
  Doc.prototype.isHidden = function (index) {
    var s = this.slides()[index]
    return s ? OX.attr(this.pkg.root(s.path), 'show', '1') === '0' : false
  }

  /* ---------------- 形状 ---------------- */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  Doc.prototype.tree = function (part) {
    return OX.path(this.pkg.root(part), 'cSld', 'spTree')
  }
  Doc.prototype.nextShapeId = function (part) {
    var max = 1
    OX.desc(this.pkg.root(part), 'cNvPr').forEach(function (c) {
      max = Math.max(max, OX.num(c, 'id', 0))
    })
    return max + 1
  }
  /** 解析一段带命名空间的 XML 片段，插入到 spTree 末尾（extLst 之前） */
  Doc.prototype.insertXml = function (part, xml) {
    var wrap = '<w xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '" xmlns:p="' + NS.p + '">' + xml + '</w>'
    var frag = new DOMParser().parseFromString(wrap, 'application/xml').documentElement.firstElementChild
    var tree = this.tree(part)
    var node = tree.ownerDocument.importNode(frag, true)
    var ext = OX.kid(tree, 'extLst')
    tree.insertBefore(node, ext)
    this.pkg.touch(part)
    return node
  }

  var DEFAULT_STYLE =
    '<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>'
  var LINE_STYLE = '<p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style>'

  function xfrmXml(b) {
    return '<a:xfrm><a:off x="' + Math.round(b.x) + '" y="' + Math.round(b.y) + '"/><a:ext cx="' + Math.round(b.w) + '" cy="' + Math.round(b.h) + '"/></a:xfrm>'
  }

  /** 插入预设形状。b：EMU */
  Doc.prototype.addShape = function (part, prst, b, name) {
    var id = this.nextShapeId(part)
    if (prst === 'line' || prst === 'straightConnector1') {
      return this.insertXml(
        part,
        '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="' + id + '" name="' + esc(name + ' ' + id) + '"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>' + xfrmXml(b) + '<a:prstGeom prst="' + prst + '"><a:avLst/></a:prstGeom>' + (prst === 'straightConnector1' ? '<a:ln><a:tailEnd type="triangle"/></a:ln>' : '') + '</p:spPr>' + LINE_STYLE + '</p:cxnSp>'
      )
    }
    return this.insertXml(
      part,
      '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(name + ' ' + id) + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' + xfrmXml(b) + '<a:prstGeom prst="' + prst + '"><a:avLst/></a:prstGeom></p:spPr>' + DEFAULT_STYLE +
        '<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p></p:txBody></p:sp>'
    )
  }

  Doc.prototype.addTextBox = function (part, b, name, text) {
    var id = this.nextShapeId(part)
    var run = text
      ? text
          .split(/\r?\n/)
          .map(function (line) {
            return '<a:p>' + (line ? '<a:r><a:rPr lang="zh-CN" altLang="en-US" dirty="0"/><a:t>' + esc(line) + '</a:t></a:r>' : '<a:endParaRPr lang="zh-CN" altLang="en-US" dirty="0"/>') + '</a:p>'
          })
          .join('')
      : '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US" dirty="0"/></a:p>'
    return this.insertXml(
      part,
      '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(name + ' ' + id) + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>' + xfrmXml(b) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
        '<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>' + run + '</p:txBody></p:sp>'
    )
  }

  Doc.prototype.addPicture = function (part, bytes, ext, b, name) {
    var pkg = this.pkg
    var media = pkg.uniqueName('ppt/media/image', '.' + ext)
    pkg.setBytes(media, bytes)
    pkg.ensureDefault(ext, OX.MIME[ext] || 'application/octet-stream')
    var rid = pkg.addRel(part, REL.image, media)
    var id = this.nextShapeId(part)
    return this.insertXml(
      part,
      '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="' + esc(name + ' ' + id) + '"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
        '<p:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>' + xfrmXml(b) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )
  }

  function cellXml() {
    return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN" altLang="en-US" dirty="0"/></a:p></a:txBody><a:tcPr/></a:tc>'
  }
  Doc.prototype.addTable = function (part, rows, cols, b, name) {
    var id = this.nextShapeId(part)
    var cw = Math.round(b.w / cols)
    var rh = 370840
    var grid = ''
    for (var c = 0; c < cols; c++) grid += '<a:gridCol w="' + cw + '"/>'
    var trs = ''
    for (var r = 0; r < rows; r++) {
      trs += '<a:tr h="' + rh + '">'
      for (var c2 = 0; c2 < cols; c2++) trs += cellXml()
      trs += '</a:tr>'
    }
    return this.insertXml(
      part,
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="' + esc(name + ' ' + id) + '"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
        '<p:xfrm><a:off x="' + Math.round(b.x) + '" y="' + Math.round(b.y) + '"/><a:ext cx="' + cw * cols + '" cy="' + rh * rows + '"/></p:xfrm>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>' + grid + '</a:tblGrid>' + trs + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    )
  }

  /* ---------- 表格行列 ---------- */

  function tblOf(frame) {
    return OX.desc(frame, 'tbl')[0] || null
  }
  function newCell(doc) {
    var w = new DOMParser().parseFromString('<w xmlns:a="' + NS.a + '">' + cellXml() + '</w>', 'application/xml').documentElement.firstElementChild
    return doc.importNode(w, true)
  }
  Doc.prototype.tableOp = function (part, frame, op, r, c) {
    var tbl = tblOf(frame)
    if (!tbl) return false
    var doc = tbl.ownerDocument
    var rows = OX.kids(tbl, 'tr')
    var grid = OX.kid(tbl, 'tblGrid')
    var cols = OX.kids(grid, 'gridCol')
    var ext = OX.path(frame, 'xfrm', 'ext')
    if (op === 'rowAbove' || op === 'rowBelow') {
      var src = rows[r]
      var tr = doc.createElementNS(NS.a, 'a:tr')
      tr.setAttribute('h', OX.attr(src, 'h', '370840'))
      OX.kids(src, 'tc').forEach(function () {
        tr.appendChild(newCell(doc))
      })
      var extLst = OX.kid(tr, 'extLst')
      tbl.insertBefore(tr, op === 'rowAbove' ? src : src.nextElementSibling)
      if (ext) ext.setAttribute('cy', OX.num(ext, 'cy', 0) + OX.num(src, 'h', 370840))
      void extLst
    } else if (op === 'colLeft' || op === 'colRight') {
      var gc = cols[c]
      var ng = doc.createElementNS(NS.a, 'a:gridCol')
      ng.setAttribute('w', OX.attr(gc, 'w', '1219200'))
      grid.insertBefore(ng, op === 'colLeft' ? gc : gc.nextElementSibling)
      rows.forEach(function (row) {
        var tcs = OX.kids(row, 'tc')
        var cell = newCell(doc)
        var ref = tcs[c]
        row.insertBefore(cell, op === 'colLeft' ? ref : ref ? ref.nextElementSibling : null)
      })
      if (ext) ext.setAttribute('cx', OX.num(ext, 'cx', 0) + OX.num(gc, 'w', 0))
    } else if (op === 'delRow') {
      if (rows.length <= 1) return false
      if (ext) ext.setAttribute('cy', Math.max(0, OX.num(ext, 'cy', 0) - OX.num(rows[r], 'h', 0)))
      tbl.removeChild(rows[r])
    } else if (op === 'delCol') {
      if (cols.length <= 1) return false
      if (ext) ext.setAttribute('cx', Math.max(0, OX.num(ext, 'cx', 0) - OX.num(cols[c], 'w', 0)))
      grid.removeChild(cols[c])
      rows.forEach(function (row) {
        var tc = OX.kids(row, 'tc')[c]
        if (tc) row.removeChild(tc)
      })
    }
    this.pkg.touch(part)
    return true
  }

  /* ---------- 位置 / 大小 ---------- */

  /** 元素的 xfrm（没有就按继承值创建） */
  Doc.prototype.xfrmOf = function (el, create, inherited) {
    var x
    if (el.localName === 'graphicFrame') {
      x = OX.kid(el, 'xfrm')
      if (!x && create) {
        x = OX.mk(el.ownerDocument, 'p:xfrm')
        el.insertBefore(x, OX.kid(el, 'graphic'))
      }
    } else {
      var spPr = OX.kid(el, 'spPr') || OX.kid(el, 'grpSpPr')
      if (!spPr) {
        if (!create) return null
        spPr = OX.mk(el.ownerDocument, 'p:spPr')
        var after = OX.kid(el, 'nvSpPr') || OX.kid(el, 'nvPicPr') || OX.kid(el, 'nvCxnSpPr') || OX.kid(el, 'blipFill')
        el.insertBefore(spPr, after ? after.nextElementSibling : el.firstElementChild)
      }
      x = OX.kid(spPr, 'xfrm')
      if (!x && create) x = OX.ensure(spPr, 'a:xfrm', OX.SPPR_ORDER)
    }
    if (x && create && !OX.kid(x, 'off')) {
      var off = OX.mk(el.ownerDocument, 'a:off', { x: inherited ? inherited.x : 0, y: inherited ? inherited.y : 0 })
      var ext = OX.mk(el.ownerDocument, 'a:ext', { cx: inherited ? inherited.w : 0, cy: inherited ? inherited.h : 0 })
      x.insertBefore(ext, x.firstElementChild)
      x.insertBefore(off, ext)
    }
    return x
  }

  /** 设置位置大小（EMU）。cur：当前（可能是继承的）框 */
  Doc.prototype.setBox = function (part, el, b, cur) {
    var targets = [el]
    if (el.localName === 'AlternateContent') {
      targets = []
      OX.kids(el).forEach(function (br) {
        var t = OX.kids(br)[0]
        if (t) targets.push(t)
      })
    }
    var self = this
    targets.forEach(function (t) {
      var x = self.xfrmOf(t, true, cur)
      var off = OX.kid(x, 'off')
      var ext = OX.kid(x, 'ext')
      var oldW = OX.num(ext, 'cx', 0), oldH = OX.num(ext, 'cy', 0)
      if (t.localName === 'grpSp' && !OX.kid(x, 'chOff')) {
        // 组合：保留子坐标系，子元素随之缩放
        x.appendChild(OX.mk(t.ownerDocument, 'a:chOff', { x: OX.attr(off, 'x', 0), y: OX.attr(off, 'y', 0) }))
        x.appendChild(OX.mk(t.ownerDocument, 'a:chExt', { cx: oldW, cy: oldH }))
      }
      off.setAttribute('x', Math.round(b.x))
      off.setAttribute('y', Math.round(b.y))
      ext.setAttribute('cx', Math.max(0, Math.round(b.w)))
      ext.setAttribute('cy', Math.max(0, Math.round(b.h)))
      if (b.rot != null) {
        var r = Math.round((((b.rot % 360) + 360) % 360) * 60000)
        if (r) x.setAttribute('rot', r)
        else x.removeAttribute('rot')
      }
      // 表格：按比例缩放列宽 / 行高
      var tbl = t.localName === 'graphicFrame' ? tblOf(t) : null
      if (tbl && oldW && oldH && (Math.round(b.w) !== oldW || Math.round(b.h) !== oldH)) {
        var sx = b.w / oldW, sy = b.h / oldH
        OX.kids(OX.kid(tbl, 'tblGrid'), 'gridCol').forEach(function (g) {
          g.setAttribute('w', Math.max(1, Math.round(OX.num(g, 'w', 0) * sx)))
        })
        OX.kids(tbl, 'tr').forEach(function (tr) {
          tr.setAttribute('h', Math.max(1, Math.round(OX.num(tr, 'h', 0) * sy)))
        })
      }
    })
    this.pkg.touch(part)
  }

  Doc.prototype.remove = function (part, el) {
    el.parentNode.removeChild(el)
    this.pkg.touch(part)
  }

  /** 叠放次序：'front' | 'back' | 'forward' | 'backward' */
  Doc.prototype.order = function (part, el, how) {
    var tree = el.parentNode
    var list = OX.kids(tree).filter(function (c) {
      return c.localName !== 'nvGrpSpPr' && c.localName !== 'grpSpPr' && c.localName !== 'extLst'
    })
    var i = list.indexOf(el)
    if (i < 0) return false
    var ext = OX.kid(tree, 'extLst')
    if (how === 'front') tree.insertBefore(el, ext)
    else if (how === 'back') tree.insertBefore(el, list[0])
    else if (how === 'forward') {
      if (i === list.length - 1) return false
      tree.insertBefore(el, list[i + 1].nextElementSibling)
    } else if (how === 'backward') {
      if (i === 0) return false
      tree.insertBefore(el, list[i - 1])
    }
    this.pkg.touch(part)
    return true
  }

  /* ---------- 填充 / 线条 / 文本格式 ---------- */

  Doc.prototype.setFill = function (part, el, hex) {
    var spPr = OX.kid(el, 'spPr')
    if (!spPr) return false
    OX.setSolidFill(spPr, hex, OX.SPPR_ORDER)
    this.pkg.touch(part)
    return true
  }
  Doc.prototype.setLine = function (part, el, hex) {
    var spPr = OX.kid(el, 'spPr')
    if (!spPr) return false
    var ln = OX.ensure(spPr, 'a:ln', OX.SPPR_ORDER)
    if (hex && !ln.hasAttribute('w')) ln.setAttribute('w', '12700')
    OX.setSolidFill(ln, hex, OX.LN_ORDER)
    this.pkg.touch(part)
    return true
  }
  Doc.prototype.setLineWidth = function (part, el, pt) {
    var spPr = OX.kid(el, 'spPr')
    if (!spPr) return false
    var ln = OX.ensure(spPr, 'a:ln', OX.SPPR_ORDER)
    ln.setAttribute('w', Math.round(pt * 12700))
    this.pkg.touch(part)
    return true
  }

  /** 文本体里所有 run 的 rPr（含 endParaRPr） */
  function allRPr(txBody, create) {
    var out = []
    OX.kids(txBody, 'p').forEach(function (p) {
      OX.kids(p).forEach(function (r) {
        if (r.localName === 'r' || r.localName === 'fld') {
          var rPr = OX.kid(r, 'rPr')
          if (!rPr && create) {
            rPr = OX.mk(r.ownerDocument, 'a:rPr', { lang: 'zh-CN', altLang: 'en-US' })
            r.insertBefore(rPr, r.firstElementChild)
          }
          if (rPr) out.push(rPr)
        } else if (r.localName === 'endParaRPr') out.push(r)
      })
    })
    return out
  }
  Doc.prototype.textBodies = function (el) {
    if (el.localName === 'graphicFrame') return OX.desc(el, 'txBody')
    var t = OX.kid(el, 'txBody')
    return t ? [t] : []
  }
  /** 对整个形状的文字设置格式：{ b, i, u, sz(pt), color(hex), algn, sizeStep(±) }；sizeOf(rPr) 返回当前字号 */
  Doc.prototype.formatShape = function (part, el, fmt, sizeOf) {
    var bodies = this.textBodies(el)
    if (!bodies.length) return false
    bodies.forEach(function (tb) {
      allRPr(tb, true).forEach(function (rPr) {
        if (fmt.b != null) rPr.setAttribute('b', fmt.b ? '1' : '0')
        if (fmt.i != null) rPr.setAttribute('i', fmt.i ? '1' : '0')
        if (fmt.u != null) rPr.setAttribute('u', fmt.u ? 'sng' : 'none')
        if (fmt.sz != null) rPr.setAttribute('sz', Math.round(fmt.sz * 100))
        if (fmt.sizeStep) {
          var cur = sizeOf ? sizeOf(rPr) : 18
          rPr.setAttribute('sz', Math.max(100, Math.round(stepSize(cur, fmt.sizeStep) * 100)))
        }
        if (fmt.color !== undefined) OX.setSolidFill(rPr, fmt.color, OX.RPR_ORDER)
      })
      if (fmt.algn) {
        OX.kids(tb, 'p').forEach(function (p) {
          var pPr = OX.kid(p, 'pPr')
          if (!pPr) {
            pPr = OX.mk(p.ownerDocument, 'a:pPr')
            p.insertBefore(pPr, p.firstElementChild)
          }
          pPr.setAttribute('algn', fmt.algn)
        })
      }
      if (fmt.anchor) {
        var bp = OX.kid(tb, 'bodyPr')
        if (bp) bp.setAttribute('anchor', fmt.anchor)
      }
    })
    this.pkg.touch(part)
    return true
  }
  var SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96]
  function stepSize(cur, dir) {
    if (dir > 0) {
      for (var i = 0; i < SIZES.length; i++) if (SIZES[i] > cur + 0.01) return SIZES[i]
      return cur + 8
    }
    for (var j = SIZES.length - 1; j >= 0; j--) if (SIZES[j] < cur - 0.01) return SIZES[j]
    return Math.max(1, cur - 1)
  }

  /** 确保形状有文本体（矩形等没有文字的形状双击编辑时用） */
  Doc.prototype.ensureTxBody = function (part, el) {
    if (el.localName !== 'sp') return null
    var tb = OX.kid(el, 'txBody')
    if (tb) return tb
    var doc = el.ownerDocument
    tb = OX.mk(doc, 'p:txBody')
    tb.appendChild(OX.mk(doc, 'a:bodyPr', { rtlCol: 0, anchor: 'ctr' }))
    tb.appendChild(OX.mk(doc, 'a:lstStyle'))
    var p = OX.mk(doc, 'a:p')
    p.appendChild(OX.mk(doc, 'a:pPr', { algn: 'ctr' }))
    p.appendChild(OX.mk(doc, 'a:endParaRPr', { lang: 'zh-CN', altLang: 'en-US' }))
    tb.appendChild(p)
    var ext = OX.kid(el, 'extLst')
    el.insertBefore(tb, ext)
    this.pkg.touch(part)
    return tb
  }

  /* ---------- 文本写回 ---------- */

  function rgbHex(s) {
    var m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    var v = m[1].split(',').map(function (x) {
      return parseFloat(x)
    })
    if (v.length > 3 && v[3] === 0) return 'transparent'
    return OX.rgbToHex(v.slice(0, 3)).toLowerCase()
  }
  function toRPr(src, doc) {
    var r = OX.mk(doc, 'a:rPr')
    if (src) {
      for (var i = 0; i < src.attributes.length; i++) r.setAttribute(src.attributes[i].name, src.attributes[i].value)
      OX.kids(src).forEach(function (c) {
        r.appendChild(c.cloneNode(true))
      })
    } else {
      r.setAttribute('lang', 'zh-CN')
      r.setAttribute('altLang', 'en-US')
    }
    r.removeAttribute('dirty')
    r.removeAttribute('err')
    return r
  }
  function underlined(node, stop) {
    for (var e = node; e && e !== stop; e = e.parentElement) {
      var d = getComputedStyle(e).textDecorationLine || ''
      if (d.indexOf('underline') >= 0) return true
    }
    return false
  }

  /**
   * 把编辑后的 .tb 写回 txBody。info：Render.textMap 里的记录
   */
  Doc.prototype.commitText = function (part, tb, info) {
    var txBody = info.txBody
    var doc = txBody.ownerDocument
    var fontScale = info.fontScale || 1
    var origPs = OX.kids(txBody, 'p')
    // 段落元素：.p；直接放在 tb 里的文字归入一个新段落
    var blocks = []
    var loose = null
    Array.prototype.slice.call(tb.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && (n.classList.contains('p') || n.tagName === 'DIV' || n.tagName === 'P')) {
        loose = null
        blocks.push(n)
      } else {
        if (!loose) {
          loose = document.createElement('div')
          loose.dataset.p = blocks.length ? blocks[blocks.length - 1].dataset.p || '' : '0'
          blocks.push(loose)
          loose._items = []
        }
        loose._items.push(n)
      }
    })
    var newPs = blocks.map(function (blk) {
      var pi = Number(blk.dataset.p)
      var orig = origPs[isNaN(pi) ? origPs.length - 1 : Math.min(pi, origPs.length - 1)] || null
      var base = {}
      try {
        base = JSON.parse(blk.dataset.base || (blocks[0] && blocks[0].dataset.base) || '{}')
      } catch (e) {}
      var origRuns = orig
        ? OX.kids(orig).filter(function (c) {
            return c.localName === 'r' || c.localName === 'br' || c.localName === 'fld'
          })
        : []
      var p = OX.mk(doc, 'a:p')
      var pPr = orig && OX.kid(orig, 'pPr') ? OX.kid(orig, 'pPr').cloneNode(true) : null
      if (blk.dataset.algn) {
        pPr = pPr || OX.mk(doc, 'a:pPr')
        pPr.setAttribute('algn', blk.dataset.algn)
      }
      if (blk.dataset.lvl != null) {
        pPr = pPr || OX.mk(doc, 'a:pPr')
        if (Number(blk.dataset.lvl) > 0) pPr.setAttribute('lvl', blk.dataset.lvl)
        else pPr.removeAttribute('lvl')
      }
      if (pPr) p.appendChild(pPr)
      var endSrc = orig ? OX.kid(orig, 'endParaRPr') : null
      var lastRPr = null
      var segs = []
      // 遍历文本节点和 <br>
      var nodes = blk._items || [blk]
      var walk = function (n) {
        if (n.nodeType === 3) {
          if (n.nodeValue) segs.push({ text: n.nodeValue, node: n })
          return
        }
        if (n.nodeType !== 1) return
        if (n.classList && n.classList.contains('bu')) return
        if (n.tagName === 'BR') {
          segs.push({ br: true, node: n })
          return
        }
        Array.prototype.slice.call(n.childNodes).forEach(walk)
      }
      nodes.forEach(walk)
      // 段落末尾的 <br> 是浏览器为空行放的占位
      while (segs.length && segs[segs.length - 1].br) segs.pop()
      var runs = []
      segs.forEach(function (s) {
        var host = s.node.nodeType === 3 ? s.node.parentElement : s.node
        var span = host.closest ? host.closest('span.r') : null
        if (span && !blk.contains(span)) span = null
        var oi = span ? Number(span.dataset.r) : -1
        var origRun = origRuns[oi] || null
        if (s.br) {
          var br = OX.mk(doc, 'a:br')
          br.appendChild(toRPr(lastRPr || (origRun && OX.kid(origRun, 'rPr')) || endSrc, doc))
          runs.push({ el: br })
          return
        }
        var srcRPr = origRun ? OX.kid(origRun, 'rPr') : lastRPr || endSrc
        var rPr = toRPr(srcRPr, doc)
        var ref = span ? { b: span.dataset.b === '1', i: span.dataset.i === '1', u: span.dataset.u === '1', z: Number(span.dataset.z), c: span.dataset.c } : { b: !!base.b, i: !!base.i, u: !!base.u, z: base.sz, c: base.c }
        var cs = getComputedStyle(host)
        var b = parseInt(cs.fontWeight, 10) >= 600
        var it = cs.fontStyle === 'italic'
        var u = underlined(host, blk.parentElement)
        var pt = (parseFloat(cs.fontSize) * 0.75) / fontScale
        var col = rgbHex(cs.color)
        if (b !== ref.b) rPr.setAttribute('b', b ? '1' : '0')
        if (it !== ref.i) rPr.setAttribute('i', it ? '1' : '0')
        if (u !== ref.u) rPr.setAttribute('u', u ? 'sng' : 'none')
        if (!(span && span.style.verticalAlign) && ref.z && Math.abs(pt - ref.z) > 0.3) rPr.setAttribute('sz', Math.round(pt * 2) * 50)
        if (col && col !== 'transparent' && ref.c && col !== String(ref.c).toLowerCase()) OX.setSolidFill(rPr, col, OX.RPR_ORDER)
        lastRPr = rPr
        // 字段（页码等）：文字没改就保留
        if (origRun && origRun.localName === 'fld' && span && s.node.parentElement === span && span.textContent === s.text) {
          var f = origRun.cloneNode(true)
          var oldR = OX.kid(f, 'rPr')
          if (oldR) f.replaceChild(rPr, oldR)
          runs.push({ el: f })
          return
        }
        runs.push({ rPr: rPr, text: s.text, key: new XMLSerializer().serializeToString(rPr) })
      })
      // 合并相邻同格式的 run
      var merged = []
      runs.forEach(function (r) {
        var last = merged[merged.length - 1]
        if (r.text != null && last && last.text != null && last.key === r.key) last.text += r.text
        else merged.push(r)
      })
      merged.forEach(function (r) {
        if (r.el) return p.appendChild(r.el)
        var run = OX.mk(doc, 'a:r')
        run.appendChild(r.rPr)
        var t = OX.mk(doc, 'a:t')
        t.textContent = r.text.replace(/ /g, ' ')
        run.appendChild(t)
        p.appendChild(run)
      })
      var end = endSrc ? endSrc.cloneNode(true) : OX.mk(doc, 'a:endParaRPr', { lang: 'zh-CN', altLang: 'en-US' })
      if (lastRPr && !endSrc) {
        ;['sz', 'b', 'i'].forEach(function (k) {
          if (lastRPr.hasAttribute(k)) end.setAttribute(k, lastRPr.getAttribute(k))
        })
      }
      end.removeAttribute('dirty')
      p.appendChild(end)
      return p
    })
    if (!newPs.length) {
      var p0 = OX.mk(doc, 'a:p')
      var first = origPs[0]
      if (first && OX.kid(first, 'pPr')) p0.appendChild(OX.kid(first, 'pPr').cloneNode(true))
      p0.appendChild(OX.mk(doc, 'a:endParaRPr', { lang: 'zh-CN', altLang: 'en-US' }))
      newPs.push(p0)
    }
    origPs.forEach(function (p) {
      txBody.removeChild(p)
    })
    var ext = OX.kid(txBody, 'extLst')
    newPs.forEach(function (p) {
      txBody.insertBefore(p, ext)
    })
    this.pkg.touch(part)
  }

  /* ---------- 备注 ---------- */

  Doc.prototype.setNotes = function (slidePath, text) {
    var pkg = this.pkg
    var r = pkg.relOfType(slidePath, REL.notes)
    if (!r) {
      if (!text) return false
      r = { target: this.createNotes(slidePath) }
      if (!r.target) return false
    }
    var root = pkg.root(r.target)
    var body = null
    OX.desc(root, 'sp').forEach(function (sp) {
      var ph = OX.phOf(sp)
      if (ph && ph.type === 'body' && !body) body = sp
    })
    if (!body) return false
    var doc = root.ownerDocument
    var tb = OX.kid(body, 'txBody')
    if (!tb) {
      tb = OX.mk(doc, 'p:txBody')
      tb.appendChild(OX.mk(doc, 'a:bodyPr'))
      tb.appendChild(OX.mk(doc, 'a:lstStyle'))
      body.appendChild(tb)
    }
    OX.kids(tb, 'p').forEach(function (p) {
      tb.removeChild(p)
    })
    String(text)
      .split('\n')
      .forEach(function (line) {
        var p = OX.mk(doc, 'a:p')
        if (line) {
          var run = OX.mk(doc, 'a:r')
          run.appendChild(OX.mk(doc, 'a:rPr', { lang: 'zh-CN', altLang: 'en-US' }))
          var t = OX.mk(doc, 'a:t')
          t.textContent = line
          run.appendChild(t)
          p.appendChild(run)
        } else p.appendChild(OX.mk(doc, 'a:endParaRPr', { lang: 'zh-CN', altLang: 'en-US' }))
        tb.appendChild(p)
      })
    pkg.touch(r.target)
    return true
  }
  Doc.prototype.notesMaster = function () {
    var r = this.pkg.relOfType(this.pres.path, REL.notesMaster)
    return r && this.pkg.has(r.target) ? r.target : null
  }
  /** 演示文稿没有备注母版时补一个（主题复制自第一个母版的主题） */
  Doc.prototype.createNotesMaster = function () {
    var pkg = this.pkg
    var pp = this.pres.path
    var root = this.pres.root()
    var mid = OX.kid(OX.path(root, 'sldMasterIdLst'), 'sldMasterId')
    var mr = mid ? pkg.rel(pp, OX.rid(mid, 'id')) : null
    var tr = mr ? pkg.relOfType(mr.target, REL.theme) : null
    if (!tr) return null
    var theme = pkg.uniqueName('ppt/theme/theme', '.xml')
    pkg.setXml(theme, pkg.text(tr.target))
    pkg.addOverride(theme, 'application/vnd.openxmlformats-officedocument.theme+xml')
    var part = pkg.uniqueName('ppt/notesMasters/notesMaster', '.xml')
    var lvls = ''
    for (var i = 1; i <= 9; i++) lvls += '<a:lvl' + i + 'pPr marL="' + (i - 1) * 457200 + '" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl' + i + 'pPr>'
    var xml =
      OX.XML_DECL +
      '<p:notesMaster xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '" xmlns:p="' + NS.p + '"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle>' + lvls + '</p:notesStyle></p:notesMaster>'
    pkg.setXml(part, xml)
    pkg.addRel(part, REL.theme, theme)
    pkg.addOverride(part, 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml')
    var rid = pkg.addRel(pp, REL.notesMaster, part)
    var lst = OX.mk(root.ownerDocument, 'p:notesMasterIdLst')
    lst.appendChild(OX.mk(root.ownerDocument, 'p:notesMasterId', { 'r:id': rid }))
    var after = OX.path(root, 'sldMasterIdLst')
    root.insertBefore(lst, after.nextElementSibling)
    if (!OX.path(root, 'notesSz')) OX.insertOrdered(root, OX.mk(root.ownerDocument, 'p:notesSz', { cx: 6858000, cy: 9144000 }), ['sldMasterIdLst', 'notesMasterIdLst', 'handoutMasterIdLst', 'sldIdLst', 'sldSz', 'notesSz'])
    pkg.touch(pp)
    return part
  }

  /** 新建备注页（没有备注母版就先建一个） */
  Doc.prototype.createNotes = function (slidePath) {
    var nm = this.notesMaster() || this.createNotesMaster()
    if (!nm) return null
    var pkg = this.pkg
    var part = pkg.uniqueName('ppt/notesSlides/notesSlide', '.xml')
    var xml =
      OX.XML_DECL +
      '<p:notes xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '" xmlns:p="' + NS.p + '"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
    pkg.setXml(part, xml)
    pkg.addRel(part, REL.notesMaster, nm)
    pkg.addRel(part, REL.slide, slidePath)
    pkg.addRel(slidePath, REL.notes, part)
    pkg.addOverride(part, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml')
    return part
  }

  /* ---------- 复制粘贴 ---------- */

  /** 复制元素：记下它引用的关系，粘贴到别的幻灯片时重建 */
  Doc.prototype.copy = function (part, el) {
    var pkg = this.pkg
    var rels = {}
    var all = [el].concat(Array.prototype.slice.call(el.getElementsByTagName('*')))
    all.forEach(function (e) {
      for (var i = 0; i < e.attributes.length; i++) {
        var a = e.attributes[i]
        if (a.namespaceURI === NS.r) {
          var r = pkg.rel(part, a.value)
          if (r) rels[a.value] = { type: r.type, target: r.target, external: r.external }
        }
      }
    })
    return { xml: new XMLSerializer().serializeToString(el), rels: rels, part: part }
  }
  Doc.prototype.paste = function (part, clip, offset) {
    var pkg = this.pkg
    var self = this
    var node = new DOMParser().parseFromString(clip.xml, 'application/xml').documentElement
    var tree = this.tree(part)
    node = tree.ownerDocument.importNode(node, true)
    var map = {}
    var all = [node].concat(Array.prototype.slice.call(node.getElementsByTagName('*')))
    all.forEach(function (e) {
      for (var i = 0; i < e.attributes.length; i++) {
        var a = e.attributes[i]
        if (a.namespaceURI !== NS.r) continue
        var r = clip.rels[a.value]
        if (!r) continue
        if (clip.part === part && !deepCopyRel(r)) continue
        if (!map[a.value]) {
          var target = deepCopyRel(r) ? self.copyPart(r.target) : r.target
          map[a.value] = pkg.addRel(part, r.type, target, r.external)
        }
        a.value = map[a.value]
      }
    })
    var id = this.nextShapeId(part)
    OX.desc(node, 'cNvPr').forEach(function (c) {
      c.setAttribute('id', id++)
    })
    if (node.localName === 'cNvPr') node.setAttribute('id', id++)
    if (offset) {
      var x = this.xfrmOf(node.localName === 'AlternateContent' ? OX.kids(OX.kids(node)[0])[0] : node, false)
      var off = OX.kid(x, 'off')
      if (off) {
        off.setAttribute('x', OX.num(off, 'x', 0) + offset)
        off.setAttribute('y', OX.num(off, 'y', 0) + offset)
      }
    }
    tree.insertBefore(node, OX.kid(tree, 'extLst'))
    pkg.touch(part)
    return node
  }

  /* ---------- 保存前清理 ---------- */

  /** 删除没有任何关系指向的媒体 / 图表 / SmartArt 等部件 */
  Doc.prototype.collectGarbage = function () {
    var pkg = this.pkg
    for (var round = 0; round < 4; round++) {
      var used = {}
      pkg.order.forEach(function (n) {
        if (!/\.rels$/.test(n)) return
        var m = /^(.*)_rels\/(.*)\.rels$/.exec(n)
        if (!m) return
        var src = m[1] + m[2]
        if (src && !pkg.has(src)) return
        pkg.rels(src).forEach(function (r) {
          if (!r.external) used[r.target] = 1
        })
      })
      var dead = pkg.order.filter(function (n) {
        return /^ppt\/(media|charts|diagrams|embeddings|notesSlides)\//.test(n) && !/\/_rels\//.test(n) && !used[n]
      })
      if (!dead.length) break
      var self = this
      dead.forEach(function (n) {
        self.removePart(n)
      })
    }
    // 孤立的 .rels
    pkg.order.slice().forEach(function (n) {
      var m = /^(.*)_rels\/(.*)\.rels$/.exec(n)
      if (m && m[1] + m[2] && !pkg.has(m[1] + m[2])) pkg.remove(n)
    })
  }

  Doc.prototype.save = async function () {
    this.collectGarbage()
    // app.xml 里的幻灯片数
    var app = this.pkg.root('docProps/app.xml')
    var n = OX.kid(app, 'Slides')
    if (n && n.textContent !== String(this.slides().length)) {
      n.textContent = String(this.slides().length)
      this.pkg.touch('docProps/app.xml')
    }
    return this.pkg.save()
  }

  Doc.EMU = EMU
  window.Doc = Doc
})()
