/* HTML 预览 —— 把网页和它引用的本地文件组装成一个能放进 iframe srcdoc 的页面
 *
 * 预览框是没有同源权限的沙箱 iframe（拿不到插件页面、拿不到 IDE），
 * 它的地址是 about:srcdoc，相对路径解析不到工作区里的文件，所以这里先把本地资源换掉：
 *   <link rel="stylesheet">  →  <style>（CSS 里的 url() / @import 也一并处理）
 *   <script src>             →  data: URL（保留 defer / async / module 的语义）
 *   ES 模块里的相对 import    →  递归换成 data: URL
 *   图片 / 字体 / 音视频       →  data: URL
 *   <iframe src="x.html">    →  srcdoc（递归，最多 3 层）
 * http(s) 地址保持原样（联网开关决定能不能加载）。
 *
 * HP.build(html, opts) → Promise<string>
 */
;(function () {
  'use strict'

  var ABS = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

  /** 相对地址（不是 http:、data:、#锚点、//host） */
  function isLocal(u) {
    u = (u || '').trim()
    return !!u && !ABS.test(u) && u[0] !== '#' && u[0] !== '?'
  }

  /** 拆出地址末尾的 ?query#hash */
  function splitSuffix(u) {
    var m = /^([^?#]*)([?#][\s\S]*)?$/.exec(u.trim())
    return { path: m[1], hash: (m[2] || '').replace(/^[^#]*/, '') }
  }

  /**
   * 相对于 html 文件的路径：dir 是 ''、'a/b/' 或 '/a/'，结果可能以 ../ 开头。
   * 以 / 开头的地址（站点根目录）对应工作区根目录，结果也以 / 开头。
   */
  function join(dir, href) {
    var p = splitSuffix(href).path
    if (!p) return null
    var root = p[0] === '/' || p[0] === '\\'
    if (!root) root = dir[0] === '/'
    var out = []
    ;((p[0] === '/' || p[0] === '\\' ? '' : dir) + p).split(/[\\/]/).forEach(function (seg) {
      if (seg === '' || seg === '.') return
      if (seg === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop()
        else if (!root) out.push('..')
      } else out.push(seg)
    })
    if (!out.length) return null
    return (root ? '/' : '') + out.join('/')
  }

  function dirOf(p) {
    var i = p.lastIndexOf('/')
    return i < 0 ? '' : p.slice(0, i + 1)
  }

  function b64(s) {
    return btoa(unescape(encodeURIComponent(s)))
  }

  function blobToDataUrl(blob) {
    return new Promise(function (res) {
      var fr = new FileReader()
      fr.onload = function () {
        res(String(fr.result))
      }
      fr.onerror = function () {
        res('')
      }
      fr.readAsDataURL(blob)
    })
  }

  /* ---------------- 资源读取（带缓存） ---------------- */

  /**
   * read(path) → Promise<Blob | null>，path 相对于 html 文件
   * 同一个 Loader 在多次构建之间复用（边写边看时不用每次都重新读文件）；文件变了就换一个新的。
   */
  function Loader(read) {
    this.read = read
    this.blobs = new Map()
    this.urls = new Map()
    this.mods = new Map()
    this.begin()
  }
  Loader.prototype.begin = function () {
    this.used = new Set()
    this.missing = new Set()
  }
  Loader.prototype.blob = function (path) {
    this.used.add(path)
    var self = this
    if (!this.blobs.has(path))
      this.blobs.set(
        path,
        Promise.resolve()
          .then(function () {
            return self.read(path)
          })
          .catch(function () {
            return null
          })
      )
    return this.blobs.get(path).then(function (b) {
      if (!b) self.missing.add(path)
      return b
    })
  }
  Loader.prototype.text = function (path) {
    return this.blob(path).then(function (b) {
      return b ? b.text() : null
    })
  }
  /** mime 为空时用读取结果自带的类型 */
  Loader.prototype.dataUrl = function (path, mime) {
    var key = path + '\n' + (mime || '')
    var self = this
    if (!this.urls.has(key))
      this.urls.set(
        key,
        this.blob(path).then(function (b) {
          if (!b) return null
          return blobToDataUrl(mime ? new Blob([b], { type: mime }) : b)
        })
      )
    else this.blob(path) // 记录用到了这个文件（监视变化）
    return this.urls.get(key)
  }

  /* ---------------- CSS ---------------- */

  var CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]*))\s*\)/gi
  var CSS_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi

  /** 把 CSS 里的相对 url() / @import 换成内联内容。dir：这段 CSS 所在目录（相对于 html） */
  function css(text, dir, L, depth) {
    depth = depth || 0
    var imports = []
    text.replace(CSS_IMPORT, function (all, a, b, c, d, e, media) {
      var href = a || b || c || d || e || ''
      if (isLocal(href) && depth < 8) imports.push(href)
      return all
    })
    var tasks = imports.map(function (href) {
      var p = join(dir, href)
      return p
        ? L.text(p).then(function (t) {
            return t == null ? null : css(t, dirOf(p), L, depth + 1)
          })
        : Promise.resolve(null)
    })
    return Promise.all(tasks).then(function (done) {
      var map = new Map()
      imports.forEach(function (h, i) {
        map.set(h, done[i])
      })
      text = text.replace(CSS_IMPORT, function (all, a, b, c, d, e, media) {
        var href = a || b || c || d || e || ''
        if (!map.has(href) || map.get(href) == null) return all
        var body = map.get(href)
        media = (media || '').trim()
        // layer() / supports() 这里不展开，只保留媒体查询
        if (media && !/^(layer|supports)\b/i.test(media)) return '@media ' + media + ' {\n' + body + '\n}'
        return body
      })
      return urls(text, dir, L)
    })
  }

  /** 只处理 url() */
  function urls(text, dir, L) {
    var found = []
    text.replace(CSS_URL, function (all, a, b, c) {
      var href = a != null ? a : b != null ? b : c
      if (isLocal(href)) found.push(href)
      return all
    })
    if (!found.length) return Promise.resolve(text)
    var uniq = Array.from(new Set(found))
    return Promise.all(
      uniq.map(function (href) {
        var p = join(dir, href)
        return p ? L.dataUrl(p) : null
      })
    ).then(function (done) {
      var map = new Map()
      uniq.forEach(function (h, i) {
        if (done[i]) map.set(h, done[i] + splitSuffix(h).hash)
      })
      return text.replace(CSS_URL, function (all, a, b, c) {
        var href = a != null ? a : b != null ? b : c
        return map.has(href) ? 'url("' + map.get(href) + '")' : all
      })
    })
  }

  /* ---------------- ES 模块 ---------------- */

  var IMPORT_RE = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\}\s*)from\s*|\bimport\s*\(\s*)(["'])([^"'\n]+)\2/g
  var REL_SPEC = /^\.{1,2}\//

  /** 模块代码里的相对 import 换成 data: URL */
  function rewriteImports(code, dir, L, stack) {
    var specs = []
    code.replace(IMPORT_RE, function (all, pre, q, spec) {
      if (REL_SPEC.test(spec)) specs.push(spec)
      return all
    })
    if (!specs.length) return Promise.resolve(code)
    var uniq = Array.from(new Set(specs))
    return Promise.all(
      uniq.map(function (s) {
        var p = join(dir, s)
        return p ? moduleUrl(p, L, stack) : null
      })
    ).then(function (done) {
      var map = new Map()
      uniq.forEach(function (s, i) {
        if (done[i]) map.set(s, done[i])
      })
      return code.replace(IMPORT_RE, function (all, pre, q, spec) {
        return map.has(spec) ? pre + q + map.get(spec) + q : all
      })
    })
  }

  function moduleUrl(path, L, stack) {
    stack = stack || []
    if (stack.indexOf(path) >= 0) {
      L.cyclic = path
      return Promise.resolve(null)
    }
    if (L.mods.has(path)) {
      L.blob(path)
      return L.mods.get(path)
    }
    var p = L.text(path).then(function (t) {
      if (t == null) return null
      return rewriteImports(t, dirOf(path), L, stack.concat(path)).then(function (code) {
        return blobToDataUrl(new Blob([code], { type: 'text/javascript' }))
      })
    })
    L.mods.set(path, p)
    return p
  }

  /* ---------------- HTML ---------------- */

  var CLASSIC = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script(?:1\.\d)?|text\/jscript|text\/livescript)$/

  function doctypeOf(doc) {
    var d = doc.doctype
    if (!d) return ''
    var s = '<!DOCTYPE ' + d.name
    if (d.publicId) s += ' PUBLIC "' + d.publicId + '"'
    if (d.systemId) s += (d.publicId ? '' : ' SYSTEM') + ' "' + d.systemId + '"'
    return s + '>\n'
  }

  function srcset(value, dir, L) {
    var parts = value.split(',')
    return Promise.all(
      parts.map(function (part) {
        var m = /^\s*(\S+)([\s\S]*)$/.exec(part)
        if (!m || !isLocal(m[1])) return part
        var p = join(dir, m[1])
        return (p ? L.dataUrl(p) : Promise.resolve(null)).then(function (u) {
          return u ? u + m[2] : part
        })
      })
    ).then(function (out) {
      return out.join(',')
    })
  }

  /**
   * opts:
   *   loader   Loader
   *   dir      当前文档所在目录（相对于根 html），根文档为 ''
   *   depth    iframe 嵌套层数
   *   boot     function (depth, dir) → 注入到 <head> 最前面的脚本源码（可为空）
   *   csp      注入的 CSP（断网预览时用），可为空
   *   noScript 脚本关闭：链接不跳转
   */
  function build(html, opts) {
    var L = opts.loader
    var depth = opts.depth || 0
    var dir = opts.dir || ''
    var doc = new DOMParser().parseFromString(html, 'text/html')
    var remote = false

    var base = doc.querySelector('base[href]')
    if (base) {
      var bh = base.getAttribute('href').trim()
      if (ABS.test(bh)) remote = true
      else {
        var j = join(dir, bh)
        dir = /[\\/]$/.test(bh) || bh === '.' ? (j ? j + '/' : '') : j ? dirOf(j) : dir
        base.parentNode.removeChild(base)
      }
    }
    var local = function (u) {
      return !remote && isLocal(u)
    }
    var tasks = []
    var srcdocs = []
    var all = function (sel) {
      return Array.prototype.slice.call(doc.querySelectorAll(sel))
    }

    // 样式表
    all('link[href]').forEach(function (link) {
      var href = link.getAttribute('href')
      var rel = ' ' + (link.getAttribute('rel') || '').toLowerCase().replace(/\s+/g, ' ') + ' '
      if (!local(href)) return
      var p = join(dir, href)
      if (rel.indexOf(' stylesheet ') >= 0) {
        if (!p) return
        tasks.push(
          L.text(p).then(function (t) {
            if (t == null) return
            // 换成 data: 地址（不插入多行 <style>，页面报错的行号才和源码对得上）
            return css(t, dirOf(p), L).then(function (out) {
              link.setAttribute('data-href', href)
              link.setAttribute('href', 'data:text/css;base64,' + b64(out))
            })
          })
        )
      } else if (/ (icon|apple-touch-icon|mask-icon) /.test(rel)) {
        if (p)
          tasks.push(
            L.dataUrl(p).then(function (u) {
              if (u) link.setAttribute('href', u)
            })
          )
      } else if (/ (preload|modulepreload|prefetch|manifest|prerender) /.test(rel)) {
        link.parentNode.removeChild(link)
      }
    })

    // <style> 和 style="" 里的 url()
    all('style').forEach(function (st) {
      var t = st.textContent
      if (!/url\(|@import/i.test(t)) return
      tasks.push(
        css(t, dir, L).then(function (out) {
          st.textContent = out.replace(/<\/style/gi, '<\\/style')
        })
      )
    })
    all('[style]').forEach(function (el) {
      var t = el.getAttribute('style')
      if (!/url\(/i.test(t)) return
      tasks.push(
        urls(t, dir, L).then(function (out) {
          el.setAttribute('style', out)
        })
      )
    })

    // 图片、音视频等
    ;[
      ['img', 'src'],
      ['source', 'src'],
      ['video', 'src'],
      ['video', 'poster'],
      ['audio', 'src'],
      ['track', 'src'],
      ['input', 'src'],
      ['embed', 'src'],
      ['object', 'data'],
      ['image', 'href'],
      ['image', 'xlink:href'],
      ['feImage', 'href']
    ].forEach(function (x) {
      all(x[0] + '[' + x[1].replace(':', '\\:') + ']').forEach(function (el) {
        var v = el.getAttribute(x[1])
        if (!local(v)) return
        var p = join(dir, v)
        if (!p) return
        tasks.push(
          L.dataUrl(p).then(function (u) {
            if (u) el.setAttribute(x[1], u + splitSuffix(v).hash)
          })
        )
      })
    })
    all('img[srcset], source[srcset]').forEach(function (el) {
      if (remote) return
      tasks.push(
        srcset(el.getAttribute('srcset'), dir, L).then(function (v) {
          el.setAttribute('srcset', v)
        })
      )
    })

    // 脚本
    all('script').forEach(function (s) {
      var type = (s.getAttribute('type') || '').trim().toLowerCase()
      var src = s.getAttribute('src')
      var isModule = type === 'module'
      if (src != null) {
        if (!local(src)) return
        var p = join(dir, src)
        if (!p) return
        if (isModule)
          tasks.push(
            moduleUrl(p, L).then(function (u) {
              if (u) s.setAttribute('src', u)
            })
          )
        else if (!type || CLASSIC.test(type))
          tasks.push(
            L.dataUrl(p, 'text/javascript').then(function (u) {
              if (u) s.setAttribute('src', u)
            })
          )
        else
          // text/babel 之类：交给页面自己的加载器，换成内联
          tasks.push(
            L.text(p).then(function (t) {
              if (t == null) return
              s.removeAttribute('src')
              s.textContent = t.replace(/<\/script/gi, '<\\/script')
            })
          )
      } else if (isModule && !remote) {
        tasks.push(
          rewriteImports(s.textContent, dir, L, []).then(function (code) {
            s.textContent = code.replace(/<\/script/gi, '<\\/script')
          })
        )
      } else if (type === 'importmap' && !remote) {
        var map
        try {
          map = JSON.parse(s.textContent)
        } catch (e) {
          return
        }
        var fix = function (obj) {
          if (!obj || typeof obj !== 'object') return Promise.resolve()
          return Promise.all(
            Object.keys(obj).map(function (k) {
              var v = obj[k]
              if (typeof v !== 'string' || !isLocal(v) || /\/$/.test(v)) return null
              var p = join(dir, v)
              return p
                ? moduleUrl(p, L).then(function (u) {
                    if (u) obj[k] = u
                  })
                : null
            })
          )
        }
        var scopes = map.scopes && typeof map.scopes === 'object' ? Object.keys(map.scopes).map(function (k) { return map.scopes[k] }) : []
        tasks.push(
          Promise.all([fix(map.imports)].concat(scopes.map(fix))).then(function () {
            s.textContent = JSON.stringify(map).replace(/<\/script/gi, '<\\/script')
          })
        )
      }
    })

    // 嵌套的本地网页
    all('iframe[src], frame[src]').forEach(function (f) {
      var v = f.getAttribute('src')
      if (!local(v) || depth >= 3) return
      var p = join(dir, v)
      if (!p || !/\.x?html?$/i.test(p)) return
      tasks.push(
        L.text(p).then(function (t) {
          if (t == null) return
          return build(t, { loader: L, dir: dirOf(p), depth: depth + 1, boot: opts.boot, csp: opts.csp, noScript: opts.noScript }).then(function (inner) {
            // 先放占位符，序列化后再换成转义好的内容：换行写成 &#10;，不改变外层页面的行号
            var key = 'hp-srcdoc-' + srcdocs.length
            srcdocs.push(inner)
            f.removeAttribute('src')
            f.setAttribute('srcdoc', key)
          })
        })
      )
    })

    // 脚本关闭时链接没人拦截，点了会把预览框导航到空白页：去掉跳转
    if (opts.noScript)
      all('a[href], area[href]').forEach(function (a) {
        var h = a.getAttribute('href')
        if (h && h.trim()[0] !== '#') {
          a.setAttribute('data-href', h)
          a.setAttribute('href', 'javascript:void 0')
        }
      })

    return Promise.all(tasks).then(function () {
      var head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body)
      var first = head.firstChild
      if (opts.csp) {
        var meta = doc.createElement('meta')
        meta.setAttribute('http-equiv', 'Content-Security-Policy')
        meta.setAttribute('content', opts.csp)
        head.insertBefore(meta, first)
      }
      var boot = opts.boot ? opts.boot(depth, dir) : ''
      if (boot) {
        // 用 data: 地址而不是内联：同样在页面脚本之前同步执行，但不占行，报错的行号和源码对得上
        var sc = doc.createElement('script')
        sc.setAttribute('data-studio-preview', '')
        sc.setAttribute('src', 'data:text/javascript;base64,' + b64(boot))
        head.insertBefore(sc, first)
      }
      var out = doctypeOf(doc) + doc.documentElement.outerHTML
      srcdocs.forEach(function (inner, i) {
        var esc = inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;')
        out = out.replace('srcdoc="hp-srcdoc-' + i + '"', function () {
          return 'srcdoc="' + esc + '"'
        })
      })
      return out
    })
  }

  window.HP = { build: build, Loader: Loader, join: join, dirOf: dirOf, isLocal: isLocal }
})()
