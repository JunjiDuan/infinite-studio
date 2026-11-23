/* 编译结果：.log 里的错误 / 警告，SyncTeX（源码 ↔ PDF 位置） —— Infinite Studio LaTeX 编辑器 */
;(function (global) {
  'use strict'

  /* ================= .log ================= */

  /**
   * 解析 TeX 日志 → [{ severity: 'error' | 'warning' | 'badbox', file, line, message }]
   * file 是日志里的写法（./main.tex、chapters/a.tex、绝对路径），没有时为 null（按主文件处理）。
   */
  function parseLog(log) {
    var out = []
    if (!log) return out
    // TeX 把长行折在 79 列（max_print_line），先把明显被折断的行接回去
    var lines = log.replace(/\r\n?/g, '\n').split('\n')
    var stack = []
    var curFile = function () {
      for (var i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]
      return null
    }
    var seen = {}
    var add = function (sev, file, line, msg) {
      msg = msg.replace(/\s+/g, ' ').trim()
      var key = sev + '|' + file + '|' + line + '|' + msg
      if (seen[key]) return
      seen[key] = true
      out.push({ severity: sev, file: file, line: line, message: msg })
    }
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i]
      var m

      // file:line: message（-file-line-error）
      m = /^((?:[A-Za-z]:)?[^:\n]*?\.(?:tex|sty|cls|ltx|bbl|aux|toc|def|cfg|clo|dtx|bib)):(\d+): (.*)$/.exec(L)
      if (m) {
        var msg = m[3]
        // 把下一两行（l.12 上下文）里有用的部分接上
        var ctx = contextAfter(lines, i)
        add('error', m[1], parseInt(m[2], 10), msg + (ctx ? ' — ' + ctx : ''))
        continue
      }
      // ! 错误（经典格式），行号在后面的 l.NN
      if (/^! /.test(L)) {
        var text = L.slice(2)
        var ln = null
        for (var k = i + 1; k < Math.min(lines.length, i + 30); k++) {
          var lm = /^l\.(\d+)\s?(.*)$/.exec(lines[k])
          if (lm) {
            ln = parseInt(lm[1], 10)
            if (lm[2]) text += ' — ' + lm[2].trim()
            break
          }
        }
        // LaTeX Error 后面常有续行
        if (/LaTeX Error|Package .* Error/.test(text) && lines[i + 1] && !/^\s*$/.test(lines[i + 1]) && !/^(See|Type|l\.\d)/.test(lines[i + 1])) text += ' ' + lines[i + 1].trim()
        add('error', curFile(), ln, text)
        continue
      }
      // LaTeX / 宏包警告（可能跨好几行，续行以 (包名) 开头）
      m = /^((?:LaTeX|Package|Class|LaTeX Font|pdfTeX|Module) ?(\S*) Warning|LaTeX Warning|Package \S+ Warning|Class \S+ Warning):\s*(.*)$/.exec(L)
      if (m) {
        var wmsg = m[3]
        var j = i + 1
        while (j < lines.length && /^\(\S+\)\s/.test(lines[j]) && j < i + 8) {
          wmsg += ' ' + lines[j].replace(/^\(\S+\)\s*/, '')
          j++
        }
        // 没有空行分隔的续行（折行）
        while (j < lines.length && lines[j] && !/^[(!]|Warning|^\s*$|^Overfull|^Underfull|^\[/.test(lines[j]) && j < i + 4 && !/\.$/.test(wmsg)) {
          wmsg += ' ' + lines[j].trim()
          j++
        }
        var wl = /on input line (\d+)/.exec(wmsg)
        if (/^LaTeX Font/.test(m[1])) continue
        add('warning', curFile(), wl ? parseInt(wl[1], 10) : null, (m[2] ? m[2] + ': ' : '') + wmsg)
        continue
      }
      // 坏盒子
      m = /^(Overfull|Underfull) \\[hv]box \((.*?)\) .*?(?:lines? (\d+)(?:--(\d+))?|detected at line (\d+))/.exec(L)
      if (m) {
        add('badbox', curFile(), parseInt(m[3] || m[5], 10) || null, m[1] + ' \\' + (/\\vbox/.test(L) ? 'vbox' : 'hbox') + ' (' + m[2] + ')')
        continue
      }
      if (/^No pages of output\./.test(L)) add('error', null, null, L)
      if (/^(Runaway argument\?|Fatal error occurred|!  ==> Fatal error)/.test(L)) add('error', curFile(), null, L)

      // 跟踪当前文件：“(./chapters/a.tex” 开始，“)” 结束
      trackFiles(L, stack)
    }
    return out
  }

  function contextAfter(lines, i) {
    for (var k = i + 1; k < Math.min(lines.length, i + 12); k++) {
      var lm = /^l\.\d+\s?(.*)$/.exec(lines[k])
      if (lm) return lm[1].trim().slice(-60)
    }
    return ''
  }

  var FILE_RE = /\(((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?[^()\s"]*?\.(?:tex|ltx|sty|cls|bbl|aux|toc|lof|lot|out|def|cfg|clo|fd|ldf|dict|tikz|pgf))|\(|\)/g
  function trackFiles(L, stack) {
    FILE_RE.lastIndex = 0
    var m
    while ((m = FILE_RE.exec(L))) {
      if (m[0] === ')') stack.pop()
      else if (m[0] === '(') stack.push(null)
      else stack.push(/\.(tex|ltx)$/i.test(m[1]) ? m[1] : null)
    }
  }

  /* ================= SyncTeX ================= */

  /**
   * 解析 .synctex（已解压的文本）→ { inputs: {tag: path}, pages: {n: [rec]}, unit, xoff, yoff }
   * rec: { t: 类型字符, tag, line, h, v, W, H, D }，坐标单位是 sp（1bp = 65781.76sp，原点在页面左上角）
   */
  function parseSynctex(text) {
    var res = { inputs: {}, pages: {}, unit: 1, xoff: 0, yoff: 0, mag: 1000 }
    var lines = text.split(/\r?\n/)
    var page = 0
    var recs = null
    var REC = /^([\[\(vhxkg$r])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+)(?:,(-?\d+))?)?/
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i]
      if (!L) continue
      var c = L[0]
      if (c === '{') {
        page = parseInt(L.slice(1), 10)
        recs = res.pages[page] = res.pages[page] || []
        continue
      }
      if (c === '}') {
        recs = null
        continue
      }
      if (recs) {
        var m = REC.exec(L)
        if (m) recs.push({ t: m[1], tag: +m[2], line: +m[3], h: +m[4], v: +m[5], W: m[6] != null ? +m[6] : 0, H: m[7] != null ? +m[7] : 0, D: m[8] != null ? +m[8] : 0 })
        continue
      }
      var im = /^Input:(\d+):(.*)$/.exec(L)
      if (im) {
        res.inputs[im[1]] = im[2]
        continue
      }
      var hm = /^(Unit|X Offset|Y Offset|Magnification):(-?[\d.]+)/.exec(L)
      if (hm) {
        var v = parseFloat(hm[2])
        if (hm[1] === 'Unit') res.unit = v || 1
        else if (hm[1] === 'Magnification') res.mag = v || 1000
        else if (hm[1] === 'X Offset') res.xoff = v
        else res.yoff = v
      }
    }
    // sp → bp
    res.k = (res.unit / 65781.76) * (res.mag / 1000)
    return res
  }

  /** 规范化路径：反斜杠、./、大小写（Windows） */
  function normPath(p) {
    p = String(p || '').replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/^\.\//, '')
    var parts = []
    p.split('/').forEach(function (s) {
      if (s === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (s !== '.') parts.push(s)
    })
    return parts.join('/')
  }

  /** synctex 里的输入文件 → 编号：rel 是相对编译目录的路径（chapters/a.tex） */
  function findTag(sync, rel) {
    var want = normPath(rel).toLowerCase()
    var best = null
    for (var tag in sync.inputs) {
      var p = normPath(sync.inputs[tag]).toLowerCase()
      if (p === want || p.endsWith('/' + want)) {
        if (!best || p.length < normPath(sync.inputs[best]).length) best = tag
      }
    }
    return best == null ? null : +best
  }

  /** 源码行 → PDF 位置 { page, x, y, w, h }（单位 bp，y 从页面顶部往下） */
  function forward(sync, rel, line) {
    var tag = findTag(sync, rel)
    if (tag == null) return null
    var best = null
    var bestScore = Infinity
    for (var pg in sync.pages) {
      var recs = sync.pages[pg]
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i]
        if (r.tag !== tag) continue
        var d = r.line === line ? 0 : r.line < line ? (line - r.line) * 2 : (r.line - line) * 3
        // 同一行里优先 hbox（能框出一整行），其次靠上的
        var score = d * 1e6 + (r.t === '(' || r.t === 'h' ? 0 : 1e5) + (+pg) * 1e3 + r.v / 1e6
        if (score < bestScore) {
          bestScore = score
          best = { r: r, page: +pg }
        }
      }
    }
    if (!best) return null
    var k = sync.k
    var r0 = best.r
    return { page: best.page, x: r0.h * k + sync.xoff, y: (r0.v - (r0.H || 0)) * k + sync.yoff, w: (r0.W || 0) * k, h: ((r0.H || 0) + (r0.D || 0)) * k || 12, line: r0.line }
  }

  /** PDF 位置（bp，y 从顶部往下）→ { file, line } */
  function inverse(sync, page, x, y) {
    var recs = sync.pages[page]
    if (!recs || !recs.length) return null
    var k = sync.k
    var best = null
    var bestArea = Infinity
    var near = null
    var nearD = Infinity
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i]
      var rx = r.h * k + sync.xoff
      var ry = r.v * k + sync.yoff
      if ((r.t === '(' || r.t === 'h') && r.W > 0) {
        var top = ry - r.H * k
        var bottom = ry + r.D * k
        if (x >= rx - 1 && x <= rx + r.W * k + 1 && y >= top - 1 && y <= bottom + 1) {
          var area = r.W * (r.H + r.D)
          if (area < bestArea) {
            bestArea = area
            best = r
          }
        }
      }
      // 退而求其次：离点击处最近的记录（竖直方向更重要）
      var dy = Math.abs(ry - y)
      var dx = Math.max(0, rx - x, x - (rx + (r.W || 0) * k))
      var d = dy * 3 + dx
      if (d < nearD) {
        nearD = d
        near = r
      }
    }
    var hit = best || near
    if (!hit) return null
    // hbox 里挑离点击处最近的字符记录（行号更准）
    if (best) {
      var inner = null
      var innerD = Infinity
      var bx = best.h
      var bv = best.v
      for (var j = 0; j < recs.length; j++) {
        var q = recs[j]
        if (q.t === '(' || q.t === '[' || q.t === 'v') continue
        if (q.v !== bv || q.h < bx || q.h > bx + best.W) continue
        var dd = Math.abs(q.h * k + sync.xoff - x)
        if (dd < innerD) {
          innerD = dd
          inner = q
        }
      }
      if (inner) hit = inner
    }
    return { file: sync.inputs[hit.tag] || null, line: hit.line, tag: hit.tag }
  }

  /** gzip → 文本（浏览器自带的 DecompressionStream） */
  function gunzip(buf) {
    var ds = new DecompressionStream('gzip')
    var stream = new Blob([buf]).stream().pipeThrough(ds)
    return new Response(stream).text()
  }

  /* ================= 魔法注释 ================= */

  /** % !TEX root = main.tex / % !TEX program = xelatex（只看文件开头 30 行） */
  function magic(text) {
    var out = {}
    var head = String(text || '').split('\n', 30)
    for (var i = 0; i < head.length; i++) {
      var m = /^\s*%\s*!\s*TEX\s+(root|program|TS-program)\s*=\s*(.+?)\s*$/i.exec(head[i])
      if (m) out[m[1].toLowerCase() === 'root' ? 'root' : 'program'] = m[2]
    }
    return out
  }

  global.TexTools = { parseLog: parseLog, parseSynctex: parseSynctex, forward: forward, inverse: inverse, gunzip: gunzip, magic: magic, normPath: normPath }
})(typeof window !== 'undefined' ? window : globalThis)
