/**
 * 读写 PDF（pdf-lib）。
 *
 * 编辑模型：页面列表（来自哪个文件的第几页、额外旋转）+ 每页上添加的对象（文字、形状、图片…）。
 * 保存时在原文件上原地调整页面（保留书签、表单、元数据等），把对象画进每页末尾新加的内容流。
 *
 * 再次打开时仍可编辑：页面字典里记下这次加的内容流和资源名（/InfStudio），以及对象的 JSON。
 * 打开时把这些内容流从页面上摘掉，对象还原成可编辑的；被别的软件改过、对不上时就保持原样（已经画进页面）。
 */
;(function () {
  'use strict'
  var L = window.PDFLib
  var F = window.PdfFonts
  var KEY = 'InfStudio'
  var N = function (s) {
    return L.PDFName.of(s)
  }
  var t = function (zh, en) {
    return window.studio ? window.studio.t(zh, en) : zh
  }

  /* ---------------- 工具 ---------------- */

  function hex(c) {
    var m = /^#?([0-9a-f]{6})$/i.exec(c || '')
    var n = m ? parseInt(m[1], 16) : 0
    return L.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
  }

  function refTags(arr) {
    var out = []
    if (arr instanceof L.PDFArray) for (var i = 0; i < arr.size(); i++) if (arr.get(i) instanceof L.PDFRef) out.push(arr.get(i).tag)
    return out
  }

  /** 页面 /Contents 里的内容流引用 */
  function contentTags(doc, page) {
    var c = page.node.get(N('Contents'))
    if (c instanceof L.PDFRef) {
      var v = doc.context.lookup(c)
      if (v instanceof L.PDFArray) return refTags(v)
      return [c.tag]
    }
    return refTags(c)
  }

  var RES_CATS = ['Font', 'XObject', 'ExtGState']
  function resNames(page) {
    var out = []
    var res = page.node.Resources()
    if (!res) return out
    RES_CATS.forEach(function (cat) {
      var d = res.lookupMaybe(N(cat), L.PDFDict)
      if (d)
        d.keys().forEach(function (k) {
          out.push(cat + '/' + k.asString().slice(1))
        })
    })
    return out
  }

  function decodeStream(s) {
    if (s instanceof L.PDFRawStream) return L.decodePDFRawStream(s).decode()
    if (s && typeof s.getContents === 'function') return s.getContents()
    return null
  }

  function b2s(bytes) {
    return new TextDecoder().decode(bytes)
  }

  /** 删掉从文件根部到不了的对象（删掉的页面、上次保存时画的旧内容、旧字体…） */
  function collectGarbage(doc) {
    var ctx = doc.context
    var seen = new Set()
    var stack = []
    var ti = ctx.trailerInfo
    if (ti.Root) stack.push(ti.Root)
    if (ti.Info) stack.push(ti.Info)
    while (stack.length) {
      var o = stack.pop()
      if (o instanceof L.PDFRef) {
        if (seen.has(o.tag)) continue
        seen.add(o.tag)
        o = ctx.lookup(o)
        if (!o) continue
      }
      if (o instanceof L.PDFDict) {
        o.entries().forEach(function (e) {
          stack.push(e[1])
        })
      } else if (o instanceof L.PDFArray) {
        for (var i = 0; i < o.size(); i++) stack.push(o.get(i))
      } else if (o && o.dict instanceof L.PDFDict) {
        stack.push(o.dict)
      }
    }
    ctx.enumerateIndirectObjects().forEach(function (e) {
      if (!seen.has(e[0].tag)) ctx.delete(e[0])
    })
  }

  /* ---------------- 打开 ---------------- */

  /** 摘掉上次保存时画进页面的对象，还原成 JSON。返回 { data, changed } */
  function readOverlay(doc, page) {
    var info = page.node.lookupMaybe(N(KEY), L.PDFDict)
    if (!info) return { data: null, changed: false }
    page.node.delete(N(KEY))
    var data = null
    try {
      var tags = refTags(info.lookupMaybe(N('Streams'), L.PDFArray))
      var contents = page.node.get(N('Contents'))
      var arr = contents instanceof L.PDFRef ? doc.context.lookup(contents) : contents
      var present = new Set(refTags(arr))
      if (tags.length && arr instanceof L.PDFArray && tags.every((x) => present.has(x))) {
        var kept = []
        for (var i = 0; i < arr.size(); i++) {
          var el = arr.get(i)
          if (!(el instanceof L.PDFRef && tags.indexOf(el.tag) >= 0)) kept.push(el)
        }
        page.node.set(N('Contents'), doc.context.obj(kept))
        var res = page.node.Resources()
        var names = info.lookupMaybe(N('Res'), L.PDFArray)
        if (res && names)
          for (var j = 0; j < names.size(); j++) {
            var s = names.get(j)
            var str = s && typeof s.decodeText === 'function' ? s.decodeText() : ''
            var k = str.indexOf('/')
            if (k < 0) continue
            var d = res.lookupMaybe(N(str.slice(0, k)), L.PDFDict)
            if (d) d.delete(N(str.slice(k + 1)))
          }
        var json = JSON.parse(b2s(decodeStream(info.lookup(N('Data')))))
        var imgsArr = info.lookupMaybe(N('Imgs'), L.PDFArray)
        var images = {}
        Object.keys(json.imgs || {}).forEach(function (id) {
          var m = json.imgs[id]
          var st = imgsArr && imgsArr.lookup(m.i)
          var bytes = st && decodeStream(st)
          if (bytes) images[id] = { type: m.type, bytes: new Uint8Array(bytes) }
        })
        data = {
          objs: (json.objs || []).filter(function (o) {
            return o.type !== 'image' || images[o.img]
          }),
          images: images
        }
      }
    } catch (e) {
      console.error(e)
      data = null
    }
    return { data: data, changed: true }
  }

  /**
   * 打开文件：→ { base, overlays, meta, editable, reason }
   * base 是摘掉了可编辑对象之后的 PDF（用 pdf.js 显示、保存时在它上面改）；overlays[i] 是第 i 页的对象
   */
  async function prepare(bytes) {
    var doc
    try {
      doc = await L.PDFDocument.load(bytes, { updateMetadata: false })
    } catch (e) {
      var enc = (e && (e.name === 'EncryptedPDFError' || /encrypt/i.test(String(e.message)))) || false
      return { base: bytes, overlays: [], meta: null, editable: false, reason: enc ? 'encrypted' : 'parse', error: String((e && e.message) || e) }
    }
    var pages = doc.getPages()
    var overlays = []
    var changed = false
    pages.forEach(function (p) {
      var r = readOverlay(doc, p)
      overlays.push(r.data)
      if (r.changed) changed = true
    })
    var meta = {
      title: doc.getTitle() || '',
      author: doc.getAuthor() || '',
      subject: doc.getSubject() || '',
      keywords: doc.getKeywords() || '',
      creator: doc.getCreator() || ''
    }
    var base = changed ? await doc.save({ updateFieldAppearances: false }) : bytes
    return { base: base, overlays: overlays, meta: meta, editable: true, pageCount: pages.length }
  }

  /** 新建的空白文档（A4） */
  async function blank() {
    var doc = await L.PDFDocument.create()
    doc.addPage([595.28, 841.89])
    return doc.save()
  }

  /* ---------------- 画对象 ---------------- */

  var STD = {
    sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique']
  }

  function Painter(doc) {
    this.doc = doc
    this.fonts = {}
    this.images = {}
    this.uni = null
  }

  Painter.prototype.font = async function (o) {
    var text = o.text || ''
    if (F.isWinAnsi(text)) {
      var list = STD[o.font] || STD.sans
      var name = list[(o.bold ? 1 : 0) + (o.italic ? 2 : 0)]
      if (!this.fonts[name]) this.fonts[name] = await this.doc.embedFont(L.StandardFonts[name])
      return { font: this.fonts[name], synth: false }
    }
    if (!this.uni) {
      var f = F.get()
      if (!f) throw new Error(t('文字里有中文等字符，需要先选择一个中文字体（菜单 → 中文字体）才能保存', 'The text contains characters that need a Unicode font. Choose one first (Menu → Unicode font).'))
      this.uni = await this.doc.embedFont(f.bytes, { subset: true })
    }
    return { font: this.uni, synth: true }
  }

  Painter.prototype.image = async function (id, img) {
    if (this.images[id]) return this.images[id]
    var e = img.type === 'png' ? await this.doc.embedPng(img.bytes) : await this.doc.embedJpg(img.bytes)
    this.images[id] = e
    return e
  }

  /** 文字 / 图片的局部坐标（未旋转的框，左上角为原点，y 向下）→ 页面坐标（y 向下） */
  function local(o, lx, ly) {
    var rot = o.rot || 0
    var W = rot % 180 ? o.h : o.w
    var H = rot % 180 ? o.w : o.h
    var cx = o.x + W / 2
    var cy = o.y + H / 2
    var dx = lx - o.w / 2
    var dy = ly - o.h / 2
    var a = (rot * Math.PI) / 180
    var c = Math.round(Math.cos(a))
    var s = Math.round(Math.sin(a))
    return [cx + dx * c - dy * s, cy + dx * s + dy * c]
  }

  function inkPath(paths) {
    var d = ''
    paths.forEach(function (p) {
      if (p.length < 2) return
      d += 'M' + p[0] + ' ' + p[1]
      if (p.length === 2) {
        d += 'L' + (p[0] + 0.01) + ' ' + p[1]
        return
      }
      for (var i = 2; i < p.length - 2; i += 2) {
        var mx = (p[i] + p[i + 2]) / 2
        var my = (p[i + 1] + p[i + 3]) / 2
        d += 'Q' + p[i] + ' ' + p[i + 1] + ' ' + mx + ' ' + my
      }
      d += 'L' + p[p.length - 2] + ' ' + p[p.length - 1]
    })
    return d
  }

  /** 箭头两翼的端点 */
  function arrowHead(o) {
    var ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1)
    var len = Math.max(6, (o.lw || 2) * 4)
    var a1 = ang + Math.PI - 0.45
    var a2 = ang + Math.PI + 0.45
    return [o.x2 + len * Math.cos(a1), o.y2 + len * Math.sin(a1), o.x2 + len * Math.cos(a2), o.y2 + len * Math.sin(a2)]
  }

  /** 把一页上的对象画进 page。pg: { vx, vy, h }（pdf.js 的显示区域） */
  Painter.prototype.draw = async function (page, pg, objs, images) {
    var vx = pg.vx || 0
    var vy = pg.vy || 0
    var H = pg.h
    var X = function (x) {
      return vx + x
    }
    var Y = function (y) {
      return vy + H - y
    }
    var self = this
    var round = L.LineCapStyle.Round

    // 先画所有文字下面的遮盖（盖住原来的文字），再按顺序画对象
    objs.forEach(function (o) {
      if (o.type === 'text' && o.cover) {
        var c = o.cover
        page.drawRectangle({ x: X(c.x), y: Y(c.y + c.h), width: c.w, height: c.h, color: hex(c.color || '#ffffff') })
      }
    })

    for (var i = 0; i < objs.length; i++) {
      var o = objs[i]
      var op = o.opacity == null ? 1 : o.opacity
      switch (o.type) {
        case 'text': {
          var text = (o.text || '').replace(/\t/g, '    ').replace(/\r/g, '')
          if (!text.trim()) break
          var f = await self.font(o)
          var lines = text.split('\n')
          var rot = o.rot || 0
          for (var li = 0; li < lines.length; li++) {
            if (!lines[li]) continue
            var p = local(o, 0, (li * F.LINE + F.BASELINE) * o.size)
            var opts = { x: X(p[0]), y: Y(p[1]), size: o.size, font: f.font, color: hex(o.color), opacity: op, rotate: L.degrees(-rot) }
            if (f.synth && o.italic) opts.ySkew = L.degrees(12)
            page.drawText(lines[li], opts)
            if (f.synth && o.bold) {
              var q = local(o, o.size * 0.03, (li * F.LINE + F.BASELINE) * o.size)
              page.drawText(lines[li], Object.assign({}, opts, { x: X(q[0]), y: Y(q[1]) }))
            }
          }
          break
        }
        case 'rect':
        case 'highlight': {
          var hl = o.type === 'highlight'
          var r = {
            x: X(o.x),
            y: Y(o.y + o.h),
            width: o.w,
            height: o.h
          }
          if (hl) {
            r.color = hex(o.fill || o.color || '#ffe14d')
            r.opacity = op
            r.blendMode = L.BlendMode.Multiply
          } else {
            if (o.fill) {
              r.color = hex(o.fill)
              r.opacity = op
            }
            if (o.stroke && o.lw > 0) {
              r.borderColor = hex(o.stroke)
              r.borderWidth = o.lw
              r.borderOpacity = op
            }
            if (!r.color && !r.borderColor) break
          }
          page.drawRectangle(r)
          break
        }
        case 'ellipse': {
          var e = { x: X(o.x + o.w / 2), y: Y(o.y + o.h / 2), xScale: o.w / 2, yScale: o.h / 2 }
          if (o.fill) {
            e.color = hex(o.fill)
            e.opacity = op
          }
          if (o.stroke && o.lw > 0) {
            e.borderColor = hex(o.stroke)
            e.borderWidth = o.lw
            e.borderOpacity = op
          }
          if (!e.color && !e.borderColor) break
          page.drawEllipse(e)
          break
        }
        case 'line':
        case 'arrow': {
          var d = 'M' + o.x1 + ' ' + o.y1 + 'L' + o.x2 + ' ' + o.y2
          if (o.type === 'arrow') {
            var hd = arrowHead(o)
            d += 'M' + hd[0] + ' ' + hd[1] + 'L' + o.x2 + ' ' + o.y2 + 'L' + hd[2] + ' ' + hd[3]
          }
          page.drawSvgPath(d, { x: vx, y: vy + H, borderColor: hex(o.stroke), borderWidth: o.lw || 2, borderOpacity: op, borderLineCap: round })
          break
        }
        case 'ink': {
          var path = inkPath(o.paths || [])
          if (path) page.drawSvgPath(path, { x: vx, y: vy + H, borderColor: hex(o.stroke), borderWidth: o.lw || 2, borderOpacity: op, borderLineCap: round })
          break
        }
        case 'image': {
          var img = images[o.img]
          if (!img) break
          var emb = await self.image(o.img, img)
          var bl = local(o, 0, o.h)
          page.drawImage(emb, { x: X(bl[0]), y: Y(bl[1]), width: o.w, height: o.h, rotate: L.degrees(-(o.rot || 0)), opacity: op })
          break
        }
      }
    }
  }

  /** 记下这页新加的内容流、资源名和对象，下次打开时还原成可编辑的 */
  function writeOverlay(doc, page, before, beforeRes, objs, images) {
    var after = contentTags(doc, page)
    var added = after.filter(function (x) {
      return before.indexOf(x) < 0
    })
    if (!added.length) return
    var arr = page.node.lookup(N('Contents'))
    var refs = []
    if (arr instanceof L.PDFArray)
      for (var i = 0; i < arr.size(); i++) {
        var el = arr.get(i)
        if (el instanceof L.PDFRef && added.indexOf(el.tag) >= 0) refs.push(el)
      }
    var res = resNames(page).filter(function (x) {
      return beforeRes.indexOf(x) < 0
    })
    var used = {}
    var imgRefs = []
    var imgsMeta = {}
    objs.forEach(function (o) {
      if (o.type === 'image' && images[o.img] && !used[o.img]) {
        used[o.img] = true
        imgsMeta[o.img] = { type: images[o.img].type, i: imgRefs.length }
        imgRefs.push(doc.context.register(doc.context.flateStream(images[o.img].bytes)))
      }
    })
    var json = JSON.stringify({ v: 1, objs: objs, imgs: imgsMeta })
    var data = doc.context.register(doc.context.flateStream(new TextEncoder().encode(json)))
    var info = doc.context.obj({})
    info.set(N('Streams'), doc.context.obj(refs))
    info.set(
      N('Res'),
      doc.context.obj(
        res.map(function (s) {
          return L.PDFString.of(s)
        })
      )
    )
    info.set(N('Data'), data)
    info.set(N('Imgs'), doc.context.obj(imgRefs))
    page.node.set(N(KEY), info)
  }

  /* ---------------- 表单 ---------------- */

  async function fillForm(doc, values, painter) {
    var names = Object.keys(values || {})
    if (!names.length) return
    var form = doc.getForm()
    var needUni = false
    names.forEach(function (name) {
      var v = values[name]
      var field
      try {
        field = form.getField(name)
      } catch (e) {
        return
      }
      try {
        if (field instanceof L.PDFTextField) {
          field.setText(String(v == null ? '' : v))
          if (!F.isWinAnsi(String(v || ''))) needUni = true
        } else if (field instanceof L.PDFCheckBox) {
          if (v) field.check()
          else field.uncheck()
        } else if (field instanceof L.PDFRadioGroup) {
          if (v) field.select(String(v))
          else field.clear()
        } else if (field instanceof L.PDFDropdown || field instanceof L.PDFOptionList) {
          var list = Array.isArray(v) ? v.map(String) : v ? [String(v)] : []
          if (list.length) field.select(list.length > 1 ? list : list[0])
          else field.clear()
          list.forEach(function (x) {
            if (!F.isWinAnsi(x)) needUni = true
          })
        }
      } catch (e) {
        console.error(e)
      }
    })
    try {
      if (needUni) {
        if (!F.get()) throw new Error('no unicode font')
        if (!painter.uni) painter.uni = await doc.embedFont(F.get().bytes, { subset: true })
        form.updateFieldAppearances(painter.uni)
      } else form.updateFieldAppearances()
    } catch (e) {
      // 生成不了外观（字体不支持）：让阅读器自己画
      form.acroForm.dict.set(N('NeedAppearances'), L.PDFBool.True)
    }
  }

  /* ---------------- 保存 ---------------- */

  /**
   * model: {
   *   base: Uint8Array,                      打开时 prepare 得到的 PDF
   *   sources: { id: Uint8Array },           插入的其他 PDF
   *   pages: [{ src: 'base' | id | null, index, rot, baseRot, vx, vy, w, h, objs }],
   *   images: { id: { type: 'png' | 'jpg', bytes } },
   *   form: { 字段名: 值 }, meta: { title, author, subject, keywords } | null
   * }
   */
  async function build(model) {
    var doc = await L.PDFDocument.load(model.base, { updateMetadata: false })
    doc.registerFontkit(window.fontkit)
    var originals = doc.getPages()
    var used = {}
    var srcDocs = {}
    var final = []
    for (var i = 0; i < model.pages.length; i++) {
      var pg = model.pages[i]
      if (pg.src === 'base') {
        if (!used[pg.index] && originals[pg.index]) {
          used[pg.index] = true
          final.push(originals[pg.index])
        } else final.push((await doc.copyPages(doc, [pg.index]))[0])
      } else if (pg.src) {
        if (!srcDocs[pg.src]) srcDocs[pg.src] = await L.PDFDocument.load(model.sources[pg.src], { updateMetadata: false })
        final.push((await doc.copyPages(srcDocs[pg.src], [pg.index]))[0])
      } else final.push(null)
    }

    // 页面重新挂到页面树上时父节点可能变了：先把继承来的属性写到页面自己身上
    final.forEach(function (p) {
      if (!p) return
      ;['MediaBox', 'CropBox', 'Resources', 'Rotate'].forEach(function (name) {
        if (p.node.get(N(name))) return
        var v = p.node.getInheritableAttribute(N(name))
        if (v) p.node.set(N(name), v)
      })
    })

    // 表单字段名要在删页之前读（删掉的页上的字段仍然保留在表单里）
    var painter = new Painter(doc)
    if (model.form) await fillForm(doc, model.form, painter)

    for (var k = doc.getPageCount() - 1; k >= 0; k--) doc.removePage(k)
    for (var j = 0; j < model.pages.length; j++) {
      var m = model.pages[j]
      var page = final[j] ? doc.addPage(final[j]) : doc.addPage([m.w, m.h])
      page.setRotation(L.degrees((((m.baseRot || 0) + (m.rot || 0)) % 360 + 360) % 360))
      var objs = m.objs || []
      if (!objs.length) continue
      var before = contentTags(doc, page)
      page.node.normalize()
      var beforeRes = resNames(page)
      await painter.draw(page, m, objs, model.images || {})
      writeOverlay(doc, page, before, beforeRes, objs, model.images || {})
    }

    if (model.meta) {
      var mt = model.meta
      doc.setTitle(mt.title || '', { showInWindowTitleBar: !!mt.title })
      doc.setAuthor(mt.author || '')
      doc.setSubject(mt.subject || '')
      doc.setKeywords(
        (mt.keywords || '')
          .split(/[,，;；]/)
          .map(function (s) {
            return s.trim()
          })
          .filter(Boolean)
      )
      doc.setModificationDate(new Date())
    }

    collectGarbage(doc)
    return doc.save({ updateFieldAppearances: false })
  }

  window.PdfWriter = { prepare: prepare, build: build, blank: blank, local: local, arrowHead: arrowHead, inkPath: inkPath }
})()
