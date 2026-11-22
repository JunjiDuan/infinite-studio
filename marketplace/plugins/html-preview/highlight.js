/* 源码高亮（轻量，不联网）—— HTML 预览插件
 * 改自 Markdown 美化插件的 highlight.js
 * hpHighlight(code) → 每行一段 HTML（已转义）；<script> / <style> 里的内容按 JS / CSS 高亮
 */
;(function () {
  'use strict'

  function words(s) {
    var o = Object.create(null)
    s.split(/\s+/).forEach(function (w) {
      if (w) o[w] = 1
    })
    return o
  }

  var C_LIKE_LIT = 'true false null nullptr NULL undefined NaN Infinity this self super'
  var LANGS = {
    js: {
      kw: 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static switch throw try typeof var void while with yield async await get set as',
      lit: C_LIKE_LIT,
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"\'`',
      types: true
    },
    ts: {
      kw: 'break case catch class const continue debugger default delete do else enum export extends finally for from function if implements import in instanceof interface let new of return static switch throw try typeof var void while with yield async await type namespace declare readonly private protected public abstract keyof infer is as satisfies get set',
      lit: C_LIKE_LIT + ' string number boolean any unknown never object symbol bigint',
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"\'`',
      types: true
    },
    py: {
      kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print',
      lit: 'True False None self cls',
      lc: ['#'],
      str: '"\'',
      triple: true,
      types: true
    },
    sh: {
      kw: 'if then else elif fi for while until do done case esac in function return exit export local readonly unset shift break continue source alias echo cd set eval exec sudo',
      lit: 'true false',
      lc: ['#'],
      str: '"\'',
      vars: true
    },
    ps: {
      kw: 'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using while',
      lit: '$true $false $null',
      lc: ['#'],
      bc: ['<#', '#>'],
      str: '"\'',
      vars: true,
      ci: true
    },
    c: {
      kw: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override final new delete using operator friend explicit constexpr noexcept try catch throw bool auto include define ifdef ifndef endif pragma',
      lit: C_LIKE_LIT,
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"\'',
      types: true,
      pre: true
    },
    java: {
      kw: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record yield sealed permits fun val when object companion data override open internal lateinit suspend in is as',
      lit: C_LIKE_LIT,
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"\'',
      types: true
    },
    cs: {
      kw: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch throw try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await get set record init',
      lit: C_LIKE_LIT,
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"\'',
      types: true
    },
    go: {
      kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
      lit: 'true false nil iota',
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"\'`',
      types: true
    },
    rust: {
      kw: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while',
      lit: 'true false self Self None Some Ok Err',
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"',
      types: true
    },
    swift: {
      kw: 'associatedtype class deinit enum extension func import init inout internal let operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is rethrows throw throws try async await',
      lit: 'true false nil self Self super',
      lc: ['//'],
      bc: ['/*', '*/'],
      str: '"',
      types: true
    },
    php: {
      kw: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public require return static switch throw trait try unset use var while yield',
      lit: 'true false null',
      lc: ['//', '#'],
      bc: ['/*', '*/'],
      str: '"\'',
      vars: true
    },
    rb: {
      kw: 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield require puts attr_accessor',
      lit: 'true false nil self',
      lc: ['#'],
      str: '"\'',
      types: true
    },
    lua: {
      kw: 'and break do else elseif end for function goto if in local not or repeat return then until while',
      lit: 'true false nil',
      lc: ['--'],
      str: '"\'',
      types: false
    },
    sql: {
      kw: 'select from where and or not insert into values update set delete create table drop alter add index view join left right inner outer full on as group by order having limit offset union all distinct case when then else end is null like in between exists primary key foreign references default unique with returning desc asc count sum avg min max',
      lit: 'true false null',
      lc: ['--'],
      bc: ['/*', '*/'],
      str: '"\'`',
      ci: true
    },
    css: { css: true, lc: [], bc: ['/*', '*/'], str: '"\'' },
    json: { kw: '', lit: 'true false null', lc: ['//'], bc: ['/*', '*/'], str: '"', keys: true },
    yaml: { kw: '', lit: 'true false null yes no on off ~', lc: ['#'], str: '"\'', yaml: true },
    toml: { kw: '', lit: 'true false', lc: ['#'], str: '"\'', yaml: true },
    ini: { kw: '', lit: 'true false', lc: [';', '#'], str: '"', yaml: true },
    dockerfile: { kw: 'from run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as', lit: '', lc: ['#'], str: '"\'', ci: true, vars: true },
    makefile: { kw: 'ifeq ifneq ifdef ifndef else endif include define endef export', lit: '', lc: ['#'], str: '"\'', vars: true }
  }
  var ALIAS = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    typescript: 'ts', tsx: 'ts',
    python: 'py', python3: 'py', py3: 'py',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh', fish: 'sh',
    powershell: 'ps', ps1: 'ps', pwsh: 'ps', bat: 'ps', cmd: 'ps',
    cpp: 'c', 'c++': 'c', cc: 'c', h: 'c', hpp: 'c', cxx: 'c', objc: 'c', 'objective-c': 'c', arduino: 'c',
    kotlin: 'java', kt: 'java', scala: 'java', groovy: 'java', dart: 'java',
    csharp: 'cs', 'c#': 'cs', fsharp: 'cs',
    golang: 'go', rs: 'rust', ruby: 'rb',
    scss: 'css', less: 'css', sass: 'css', stylus: 'css',
    jsonc: 'json', json5: 'json',
    yml: 'yaml', conf: 'ini', properties: 'ini', env: 'ini', docker: 'dockerfile', make: 'makefile', mk: 'makefile',
    html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', plist: 'xml',
    mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql', plsql: 'sql',
    patch: 'diff'
  }
  var compiled = {}

  function cfgFor(lang) {
    var l = (lang || '').toLowerCase()
    l = ALIAS[l] || l
    if (l === 'xml' || l === 'diff') return l
    var c = LANGS[l]
    if (!c) return null
    if (!compiled[l]) {
      compiled[l] = {
        kw: words(c.ci ? (c.kw || '').toLowerCase() : c.kw || ''),
        lit: words(c.lit || ''),
        lc: c.lc || [],
        bc: c.bc,
        str: c.str || '',
        triple: !!c.triple,
        types: !!c.types,
        vars: !!c.vars,
        ci: !!c.ci,
        keys: !!c.keys,
        yaml: !!c.yaml,
        css: !!c.css,
        pre: !!c.pre
      }
    }
    return compiled[l]
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  var ID_START = /[A-Za-z_$À-￿]/
  var ID = /[\w$À-￿]/

  /** 通用扫描：返回 [[类名或 '', 文本], ...] */
  function scan(code, c) {
    var out = []
    var n = code.length
    var i = 0
    var lineStart = true
    function push(cls, text) {
      if (!text) return
      var last = out[out.length - 1]
      if (last && last[0] === cls) last[1] += text
      else out.push([cls, text])
    }
    while (i < n) {
      var ch = code[i]
      var rest
      // 块注释
      if (c.bc && code.startsWith(c.bc[0], i)) {
        var e = code.indexOf(c.bc[1], i + c.bc[0].length)
        e = e < 0 ? n : e + c.bc[1].length
        push('hc', code.slice(i, e))
        i = e
        continue
      }
      // 行注释
      var lcHit = false
      for (var k = 0; k < c.lc.length; k++) {
        var lc = c.lc[k]
        if (code.startsWith(lc, i) && (lc !== '#' || i === 0 || /[\s;({]/.test(code[i - 1]))) {
          var eol = code.indexOf('\n', i)
          eol = eol < 0 ? n : eol
          push('hc', code.slice(i, eol))
          i = eol
          lcHit = true
          break
        }
      }
      if (lcHit) continue
      // 预处理指令（C 系）
      if (c.pre && ch === '#' && lineStart) {
        var m0 = /^#\s*\w+/.exec(code.slice(i, i + 40))
        if (m0) {
          push('hk', m0[0])
          i += m0[0].length
          continue
        }
      }
      // 字符串
      if (c.str.indexOf(ch) >= 0) {
        var start = i
        var q = ch
        if (c.triple && code.startsWith(q + q + q, i)) {
          var te = code.indexOf(q + q + q, i + 3)
          i = te < 0 ? n : te + 3
        } else {
          i++
          var multi = q === '`'
          while (i < n && code[i] !== q) {
            if (code[i] === '\\') i++
            else if (code[i] === '\n' && !multi) break
            i++
          }
          if (i < n && code[i] === q) i++
        }
        var s = code.slice(start, i)
        // JSON / YAML 的键
        if (c.keys || c.yaml) {
          rest = code.slice(i, i + 20)
          if (/^\s*:/.test(rest)) {
            push('ha', s)
            continue
          }
        }
        push('hs', s)
        continue
      }
      // YAML / TOML / INI 的键、节
      if (c.yaml && lineStart) {
        var lineEnd = code.indexOf('\n', i)
        var line = code.slice(i, lineEnd < 0 ? n : lineEnd)
        var mk = /^(\s*(?:-\s+)?)([\w.\-$@ ]+?)(\s*[:=])(?=\s|$)/.exec(line)
        var ms = /^\s*\[[^\]]+\]\s*$/.exec(line)
        if (ms) {
          push('hg', line)
          i += line.length
          continue
        }
        if (mk) {
          push('', mk[1])
          push('ha', mk[2])
          push('', mk[3])
          i += mk[0].length
          lineStart = false
          continue
        }
      }
      // CSS
      if (c.css) {
        rest = code.slice(i, i + 200)
        var mp = /^([\w-]+)(\s*:)(?![^{]*\{)/.exec(rest)
        if (mp && (i === 0 || /[\s;{]/.test(code[i - 1]))) {
          push('ha', mp[1])
          push('', mp[2])
          i += mp[0].length
          continue
        }
        var mh = /^#[0-9a-fA-F]{3,8}\b/.exec(rest)
        if (mh) {
          push('hn2', mh[0])
          i += mh[0].length
          continue
        }
        var mat = /^@[\w-]+/.exec(rest)
        if (mat) {
          push('hk', mat[0])
          i += mat[0].length
          continue
        }
        var mu = /^-?\d*\.?\d+(px|em|rem|%|vh|vw|s|ms|deg|fr|ch|pt)?/.exec(rest)
        if (mu && mu[0] && (i === 0 || !ID.test(code[i - 1]))) {
          push('hn2', mu[0])
          i += mu[0].length
          continue
        }
        var msel = /^[.#][\w-]+/.exec(rest)
        if (msel) {
          push('hf', msel[0])
          i += msel[0].length
          continue
        }
      }
      // 变量 $x、${x}
      if (c.vars && ch === '$') {
        var mv = /^\$(\{[^}\n]*\}|[\w]+|[@#?*!$0-9])/.exec(code.slice(i, i + 80))
        if (mv) {
          push(c.lit[mv[0].toLowerCase()] ? 'hn2' : 'ha', mv[0])
          i += mv[0].length
          continue
        }
      }
      // 数字
      if (/[0-9]/.test(ch) && (i === 0 || !ID.test(code[i - 1]))) {
        var mn = /^(0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[a-zA-Z]*/.exec(code.slice(i, i + 60))
        push('hn2', mn[0])
        i += mn[0].length
        continue
      }
      // 标识符
      if (ID_START.test(ch) || (ch === '@' && /[A-Za-z]/.test(code[i + 1] || ''))) {
        var j = i + 1
        while (j < n && (ID.test(code[j]) || (c.css && code[j] === '-'))) j++
        var w = code.slice(i, j)
        var key = c.ci ? w.toLowerCase() : w
        var cls = ''
        if (c.kw[key]) cls = 'hk'
        else if (c.lit[key]) cls = 'hn2'
        else if (ch === '@') cls = 'ht'
        else {
          var after = code.slice(j, j + 3)
          if (/^\s*\(/.test(after) || /^!\(/.test(after)) cls = 'hf'
          else if (c.types && /^[A-Z][a-z0-9]/.test(w)) cls = 'ht'
        }
        push(cls, w)
        i = j
        lineStart = false
        continue
      }
      if (ch === '\n') lineStart = true
      else if (!/\s/.test(ch)) lineStart = false
      push('', ch)
      i++
    }
    return out
  }

  function scanXml(code) {
    var out = []
    var re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!?\/?[A-Za-z][\w:.-]*|\/?>|"[^"]*"|'[^']*'|[\w:.-]+(?==)|&[#\w]+;/g
    var last = 0
    var inTag = false
    var m
    while ((m = re.exec(code))) {
      if (m.index > last) out.push(['', code.slice(last, m.index)])
      var t = m[0]
      var cls = ''
      if (t.startsWith('<!--')) cls = 'hc'
      else if (t.startsWith('<![CDATA[')) cls = 'hs'
      else if (t[0] === '<') {
        cls = 'hg'
        inTag = true
      } else if (t === '>' || t === '/>') {
        cls = 'hg'
        inTag = false
      } else if (t[0] === '"' || t[0] === "'") cls = inTag ? 'hs' : ''
      else if (t[0] === '&') cls = 'hn2'
      else cls = inTag ? 'ha' : ''
      out.push([cls, t])
      last = re.lastIndex
    }
    if (last < code.length) out.push(['', code.slice(last)])
    return out
  }

  function scanDiff(code) {
    return code.split('\n').map(function (l, i, arr) {
      var cls = /^(\+\+\+|---)/.test(l) ? 'hk' : l[0] === '+' ? 'hadd' : l[0] === '-' ? 'hdel' : l.startsWith('@@') ? 'hf' : ''
      return [cls, l + (i < arr.length - 1 ? '\n' : '')]
    })
  }

  /** 把记号拆成行：返回每行的 HTML */
  function toLines(tokens) {
    var lines = ['']
    tokens.forEach(function (tk) {
      var parts = tk[1].split('\n')
      parts.forEach(function (p, idx) {
        if (idx > 0) lines.push('')
        if (!p) return
        lines[lines.length - 1] += tk[0] ? '<span class="' + tk[0] + '">' + esc(p) + '</span>' : esc(p)
      })
    })
    return lines
  }

  /** 普通 HTML 用 scanXml，<script> / <style> 的内容换成对应语言 */
  function scanHtml(code) {
    var out = []
    var add = function (list) {
      for (var i = 0; i < list.length; i++) out.push(list[i])
    }
    var re = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi
    var last = 0
    var m
    while ((m = re.exec(code))) {
      if (m.index > last) add(scanXml(code.slice(last, m.index)))
      add(scanXml(m[1]))
      var inner = m[3]
      if (inner) {
        var typeM = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])
        var type = typeM ? typeM[1].toLowerCase() : ''
        var c
        if (m[2].toLowerCase() === 'style') c = cfgFor('css')
        else if (!type || /javascript|ecmascript|module|babel|jsx/.test(type)) c = cfgFor('js')
        else if (/json|importmap/.test(type)) c = cfgFor('json')
        else if (/html|template|x-tmpl/.test(type)) c = 'xml'
        else c = null
        add(c === 'xml' ? scanXml(inner) : c ? scan(inner, c) : [['', inner]])
      }
      if (m[4]) add(scanXml(m[4]))
      last = re.lastIndex
      if (!m[4] || last >= code.length) break
    }
    if (last < code.length) add(scanXml(code.slice(last)))
    return out
  }

  window.hpHighlight = function (code) {
    return toLines(code.length > 300000 ? [['', code]] : scanHtml(code))
  }
})()
