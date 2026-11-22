/**
 * 预设形状（prstGeom）和自定义形状（custGeom）→ SVG path。
 * 返回 { paths: [{ d, fill: true/false/'darken'/'lighten', stroke: true/false }], text: {l,t,r,b}(文本区域内缩，px) }
 */
;(function () {
  'use strict'
  var OX = window.OX

  function f(n) {
    return Math.round(n * 100) / 100
  }
  function poly(pts) {
    return (
      'M' +
      pts
        .map(function (p) {
          return f(p[0]) + ',' + f(p[1])
        })
        .join(' L') +
      ' Z'
    )
  }
  function ellipse(cx, cy, rx, ry) {
    return 'M' + f(cx - rx) + ',' + f(cy) + ' A' + f(rx) + ',' + f(ry) + ' 0 1 0 ' + f(cx + rx) + ',' + f(cy) + ' A' + f(rx) + ',' + f(ry) + ' 0 1 0 ' + f(cx - rx) + ',' + f(cy) + ' Z'
  }
  function rrect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    if (!r) return poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
    return (
      'M' + f(x + r) + ',' + f(y) + ' L' + f(x + w - r) + ',' + f(y) + ' A' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(x + w) + ',' + f(y + r) +
      ' L' + f(x + w) + ',' + f(y + h - r) + ' A' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(x + w - r) + ',' + f(y + h) +
      ' L' + f(x + r) + ',' + f(y + h) + ' A' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(x) + ',' + f(y + h - r) +
      ' L' + f(x) + ',' + f(y + r) + ' A' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(x + r) + ',' + f(y) + ' Z'
    )
  }
  /** 正多边形 / 星形（内接于外框椭圆） */
  function regular(w, h, n, inner, rot) {
    var pts = []
    var total = inner ? n * 2 : n
    for (var i = 0; i < total; i++) {
      var a = -Math.PI / 2 + (rot || 0) + (i * 2 * Math.PI) / total
      var k = inner && i % 2 ? inner : 1
      pts.push([w / 2 + (w / 2) * k * Math.cos(a), h / 2 + (h / 2) * k * Math.sin(a)])
    }
    return poly(pts)
  }
  function arcPt(cx, cy, rx, ry, deg) {
    var a = (deg * Math.PI) / 180
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  }

  var STAR = { star4: [4, 12500], star5: [5, 19098], star6: [6, 28868], star7: [7, 34601], star8: [8, 37500], star10: [10, 42533], star12: [12, 37500], star16: [16, 37500], star24: [24, 37500], star32: [32, 37500] }
  var POLY = { heptagon: 7, decagon: 10, dodecagon: 12 }

  function preset(name, w, h, av) {
    var ss = Math.min(w, h)
    function a(key, def) {
      return av[key] != null ? av[key] : def
    }
    var P = function (d, extra) {
      return { paths: [{ d: d, fill: true, stroke: true }].concat(extra || []), text: null }
    }
    var d, dx, dy, x1, x2, y1, y2
    switch (name) {
      case 'rect':
      case 'flowChartProcess':
      case 'actionButtonBlank':
        return P(poly([[0, 0], [w, 0], [w, h], [0, h]]))
      case 'roundRect':
        dx = (ss * a('adj', 16667)) / 100000
        return { paths: [{ d: rrect(0, 0, w, h, dx), fill: true, stroke: true }], text: { l: dx * 0.29, t: dx * 0.29, r: dx * 0.29, b: dx * 0.29 } }
      case 'flowChartAlternateProcess':
        return P(rrect(0, 0, w, h, ss * 0.1667))
      case 'flowChartTerminator':
        return P(rrect(0, 0, w, h, ss / 2))
      case 'snip1Rect':
        dx = (ss * a('adj', 16667)) / 100000
        return P(poly([[0, 0], [w - dx, 0], [w, dx], [w, h], [0, h]]))
      case 'snip2SameRect':
        dx = (ss * a('adj1', 16667)) / 100000
        dy = (ss * a('adj2', 0)) / 100000
        return P(poly([[dx, 0], [w - dx, 0], [w, dx], [w, h - dy], [w - dy, h], [dy, h], [0, h - dy], [0, dx]]))
      case 'snip2DiagRect':
        dx = (ss * a('adj1', 0)) / 100000
        dy = (ss * a('adj2', 16667)) / 100000
        return P(poly([[dx, 0], [w - dy, 0], [w, dy], [w, h - dx], [w - dx, h], [dy, h], [0, h - dy], [0, dx]]))
      case 'round1Rect':
        dx = (ss * a('adj', 16667)) / 100000
        return P('M0,0 L' + f(w - dx) + ',0 A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(w) + ',' + f(dx) + ' L' + f(w) + ',' + f(h) + ' L0,' + f(h) + ' Z')
      case 'round2SameRect':
        dx = (ss * a('adj1', 16667)) / 100000
        dy = (ss * a('adj2', 0)) / 100000
        return P(
          'M' + f(dx) + ',0 L' + f(w - dx) + ',0 A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(w) + ',' + f(dx) + ' L' + f(w) + ',' + f(h - dy) + ' A' + f(dy) + ',' + f(dy) + ' 0 0 1 ' + f(w - dy) + ',' + f(h) +
            ' L' + f(dy) + ',' + f(h) + ' A' + f(dy) + ',' + f(dy) + ' 0 0 1 0,' + f(h - dy) + ' L0,' + f(dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(dx) + ',0 Z'
        )
      case 'round2DiagRect':
        dx = (ss * a('adj1', 16667)) / 100000
        return P(
          'M' + f(dx) + ',0 L' + f(w) + ',0 L' + f(w) + ',' + f(h - dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(w - dx) + ',' + f(h) + ' L0,' + f(h) + ' L0,' + f(dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(dx) + ',0 Z'
        )
      case 'ellipse':
      case 'flowChartConnector':
        return { paths: [{ d: ellipse(w / 2, h / 2, w / 2, h / 2), fill: true, stroke: true }], text: { l: w * 0.146, t: h * 0.146, r: w * 0.146, b: h * 0.146 } }
      case 'triangle':
      case 'flowChartExtract':
        x1 = (w * a('adj', 50000)) / 100000
        return { paths: [{ d: poly([[x1, 0], [w, h], [0, h]]), fill: true, stroke: true }], text: { l: w / 4, t: h / 2, r: w / 4, b: 0 } }
      case 'flowChartMerge':
        return P(poly([[0, 0], [w, 0], [w / 2, h]]))
      case 'rtTriangle':
        return P(poly([[0, 0], [w, h], [0, h]]))
      case 'diamond':
      case 'flowChartDecision':
      case 'flowChartSort':
        return { paths: [{ d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]), fill: true, stroke: true }], text: { l: w / 4, t: h / 4, r: w / 4, b: h / 4 } }
      case 'parallelogram':
      case 'flowChartInputOutput':
        dx = name === 'parallelogram' ? Math.min(w, (ss * a('adj', 25000)) / 100000) : w / 5
        return P(poly([[dx, 0], [w, 0], [w - dx, h], [0, h]]))
      case 'trapezoid':
        dx = Math.min(w / 2, (ss * a('adj', 25000)) / 100000)
        return P(poly([[0, h], [dx, 0], [w - dx, 0], [w, h]]))
      case 'flowChartManualOperation':
        return P(poly([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]))
      case 'pentagon':
        return P(poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]))
      case 'hexagon':
      case 'flowChartPreparation':
        dx = name === 'hexagon' ? Math.min(w / 2, (ss * a('adj', 25000)) / 100000) : w / 5
        return P(poly([[dx, 0], [w - dx, 0], [w, h / 2], [w - dx, h], [dx, h], [0, h / 2]]))
      case 'octagon':
        dx = (ss * a('adj', 29289)) / 100000
        return P(poly([[dx, 0], [w - dx, 0], [w, dx], [w, h - dx], [w - dx, h], [dx, h], [0, h - dx], [0, dx]]))
      case 'plus':
      case 'cross':
      case 'mathPlus':
        dx = (ss * a('adj', name === 'mathPlus' ? 23520 : 25000)) / 100000
        if (name === 'mathPlus') {
          var t2 = dx / 2
          return P(poly([[w / 2 - t2, h * 0.1], [w / 2 + t2, h * 0.1], [w / 2 + t2, h / 2 - t2], [w * 0.9, h / 2 - t2], [w * 0.9, h / 2 + t2], [w / 2 + t2, h / 2 + t2], [w / 2 + t2, h * 0.9], [w / 2 - t2, h * 0.9], [w / 2 - t2, h / 2 + t2], [w * 0.1, h / 2 + t2], [w * 0.1, h / 2 - t2], [w / 2 - t2, h / 2 - t2]]))
        }
        return P(poly([[dx, 0], [w - dx, 0], [w - dx, dx], [w, dx], [w, h - dx], [w - dx, h - dx], [w - dx, h], [dx, h], [dx, h - dx], [0, h - dx], [0, dx], [dx, dx]]))
      case 'mathMinus':
        dy = (h * a('adj1', 23520)) / 200000
        return P(poly([[w * 0.1, h / 2 - dy], [w * 0.9, h / 2 - dy], [w * 0.9, h / 2 + dy], [w * 0.1, h / 2 + dy]]))
      case 'mathEqual':
        dy = (h * a('adj1', 23520)) / 100000
        var gap = (h * a('adj2', 11760)) / 200000
        return P(poly([[w * 0.1, h / 2 - gap - dy], [w * 0.9, h / 2 - gap - dy], [w * 0.9, h / 2 - gap], [w * 0.1, h / 2 - gap]]) + ' ' + poly([[w * 0.1, h / 2 + gap], [w * 0.9, h / 2 + gap], [w * 0.9, h / 2 + gap + dy], [w * 0.1, h / 2 + gap + dy]]))
      case 'mathMultiply':
        // 加号绕中心转 45°
        var t3 = (ss * a('adj1', 23520)) / 200000
        var r = ss * 0.4
        var cross = [[-t3, -r], [t3, -r], [t3, -t3], [r, -t3], [r, t3], [t3, t3], [t3, r], [-t3, r], [-t3, t3], [-r, t3], [-r, -t3], [-t3, -t3]]
        var cs = Math.SQRT1_2
        return P(
          poly(
            cross.map(function (q) {
              return [w / 2 + (q[0] - q[1]) * cs, h / 2 + (q[0] + q[1]) * cs]
            })
          )
        )
      case 'homePlate':
        dx = Math.min(w, (ss * a('adj', 50000)) / 100000)
        return P(poly([[0, 0], [w - dx, 0], [w, h / 2], [w - dx, h], [0, h]]))
      case 'chevron':
        dx = Math.min(w, (ss * a('adj', 50000)) / 100000)
        return P(poly([[0, 0], [w - dx, 0], [w, h / 2], [w - dx, h], [0, h], [dx, h / 2]]))
      case 'rightArrow':
      case 'leftArrow':
        y1 = h / 2 - (h * a('adj1', 50000)) / 200000
        y2 = h - y1
        dx = Math.min(w, (ss * a('adj2', 50000)) / 100000)
        d = poly([[0, y1], [w - dx, y1], [w - dx, 0], [w, h / 2], [w - dx, h], [w - dx, y2], [0, y2]])
        return name === 'leftArrow' ? P(poly([[w, y1], [dx, y1], [dx, 0], [0, h / 2], [dx, h], [dx, y2], [w, y2]])) : P(d)
      case 'notchedRightArrow':
        y1 = h / 2 - (h * a('adj1', 50000)) / 200000
        y2 = h - y1
        dx = Math.min(w, (ss * a('adj2', 50000)) / 100000)
        var nx = (dx * (h / 2 - y1)) / (h / 2)
        return P(poly([[0, y1], [w - dx, y1], [w - dx, 0], [w, h / 2], [w - dx, h], [w - dx, y2], [0, y2], [nx, h / 2]]))
      case 'upArrow':
      case 'downArrow':
        x1 = w / 2 - (w * a('adj1', 50000)) / 200000
        x2 = w - x1
        dy = Math.min(h, (ss * a('adj2', 50000)) / 100000)
        if (name === 'upArrow') return P(poly([[x1, h], [x1, dy], [0, dy], [w / 2, 0], [w, dy], [x2, dy], [x2, h]]))
        return P(poly([[x1, 0], [x2, 0], [x2, h - dy], [w, h - dy], [w / 2, h], [0, h - dy], [x1, h - dy]]))
      case 'leftRightArrow':
        y1 = h / 2 - (h * a('adj1', 50000)) / 200000
        y2 = h - y1
        dx = Math.min(w / 2, (ss * a('adj2', 50000)) / 100000)
        return P(poly([[0, h / 2], [dx, 0], [dx, y1], [w - dx, y1], [w - dx, 0], [w, h / 2], [w - dx, h], [w - dx, y2], [dx, y2], [dx, h]]))
      case 'upDownArrow':
        x1 = w / 2 - (w * a('adj1', 50000)) / 200000
        x2 = w - x1
        dy = Math.min(h / 2, (ss * a('adj2', 50000)) / 100000)
        return P(poly([[w / 2, 0], [w, dy], [x2, dy], [x2, h - dy], [w, h - dy], [w / 2, h], [0, h - dy], [x1, h - dy], [x1, dy], [0, dy]]))
      case 'donut':
        dx = (ss * a('adj', 25000)) / 100000
        return { paths: [{ d: ellipse(w / 2, h / 2, w / 2, h / 2) + ' ' + ellipse(w / 2, h / 2, w / 2 - dx, h / 2 - dx), fill: true, stroke: true, evenodd: true }], text: null }
      case 'noSmoking':
        dx = (ss * a('adj', 18750)) / 100000
        return { paths: [{ d: ellipse(w / 2, h / 2, w / 2, h / 2) + ' ' + ellipse(w / 2, h / 2, w / 2 - dx, h / 2 - dx), fill: true, stroke: true, evenodd: true }, { d: 'M' + f(w * 0.2) + ',' + f(h * 0.2) + ' L' + f(w * 0.8) + ',' + f(h * 0.8), fill: false, stroke: true }], text: null }
      case 'frame':
        dx = (ss * a('adj1', 12500)) / 100000
        return { paths: [{ d: poly([[0, 0], [w, 0], [w, h], [0, h]]) + ' ' + poly([[dx, dx], [dx, h - dx], [w - dx, h - dx], [w - dx, dx]]), fill: true, stroke: true }], text: null }
      case 'bevel':
        dx = (ss * a('adj', 12500)) / 100000
        return P(poly([[0, 0], [w, 0], [w, h], [0, h]]), [
          { d: poly([[0, 0], [w, 0], [w - dx, dx], [dx, dx]]), fill: 'lighten', stroke: true },
          { d: poly([[w, 0], [w, h], [w - dx, h - dx], [w - dx, dx]]), fill: 'darken', stroke: true },
          { d: poly([[0, h], [w, h], [w - dx, h - dx], [dx, h - dx]]), fill: 'darken', stroke: true }
        ])
      case 'corner':
        dx = (ss * a('adj1', 50000)) / 100000
        dy = (ss * a('adj2', 50000)) / 100000
        return P(poly([[0, 0], [dy, 0], [dy, h - dx], [w, h - dx], [w, h], [0, h]]))
      case 'halfFrame':
        dx = (ss * a('adj1', 33333)) / 100000
        dy = (ss * a('adj2', 33333)) / 100000
        return P(poly([[0, 0], [w, 0], [w - (w * dx) / h, dx], [dy, dx], [dy, h - (h * dy) / w], [0, h]]))
      case 'can':
      case 'flowChartMagneticDisk':
        dy = name === 'can' ? (ss * a('adj', 25000)) / 200000 : h / 6
        d = 'M0,' + f(dy) + ' A' + f(w / 2) + ',' + f(dy) + ' 0 0 0 ' + f(w) + ',' + f(dy) + ' L' + f(w) + ',' + f(h - dy) + ' A' + f(w / 2) + ',' + f(dy) + ' 0 0 1 0,' + f(h - dy) + ' Z'
        return { paths: [{ d: d, fill: true, stroke: true }, { d: ellipse(w / 2, dy, w / 2, dy), fill: 'lighten', stroke: true }], text: { l: 0, t: dy * 2, r: 0, b: dy } }
      case 'cube':
        dx = (ss * a('adj', 25000)) / 100000
        return {
          paths: [
            { d: poly([[0, dx], [w - dx, dx], [w - dx, h], [0, h]]), fill: true, stroke: true },
            { d: poly([[0, dx], [dx, 0], [w, 0], [w - dx, dx]]), fill: 'lighten', stroke: true },
            { d: poly([[w - dx, dx], [w, 0], [w, h - dx], [w - dx, h]]), fill: 'darken', stroke: true }
          ],
          text: { l: 0, t: dx, r: dx, b: 0 }
        }
      case 'line':
      case 'straightConnector1':
        return { paths: [{ d: 'M0,0 L' + f(w) + ',' + f(h), fill: false, stroke: true }], text: null, line: true }
      case 'bentConnector2':
        return { paths: [{ d: 'M0,0 L' + f(w) + ',0 L' + f(w) + ',' + f(h), fill: false, stroke: true }], text: null, line: true }
      case 'bentConnector3':
      case 'bentConnector4':
      case 'bentConnector5':
        x1 = (w * a('adj1', 50000)) / 100000
        return { paths: [{ d: 'M0,0 L' + f(x1) + ',0 L' + f(x1) + ',' + f(h) + ' L' + f(w) + ',' + f(h), fill: false, stroke: true }], text: null, line: true }
      case 'curvedConnector2':
        return { paths: [{ d: 'M0,0 C' + f(w / 2) + ',0 ' + f(w) + ',' + f(h / 2) + ' ' + f(w) + ',' + f(h), fill: false, stroke: true }], text: null, line: true }
      case 'curvedConnector3':
      case 'curvedConnector4':
      case 'curvedConnector5':
        x1 = (w * a('adj1', 50000)) / 100000
        return { paths: [{ d: 'M0,0 C' + f(x1) + ',0 ' + f(x1) + ',' + f(h) + ' ' + f(w) + ',' + f(h), fill: false, stroke: true }], text: null, line: true }
      case 'flowChartPredefinedProcess':
        return P(poly([[0, 0], [w, 0], [w, h], [0, h]]), [{ d: 'M' + f(w / 8) + ',0 L' + f(w / 8) + ',' + f(h) + ' M' + f((w * 7) / 8) + ',0 L' + f((w * 7) / 8) + ',' + f(h), fill: false, stroke: true }])
      case 'flowChartInternalStorage':
        return P(poly([[0, 0], [w, 0], [w, h], [0, h]]), [{ d: 'M' + f(w / 8) + ',0 L' + f(w / 8) + ',' + f(h) + ' M0,' + f(h / 8) + ' L' + f(w) + ',' + f(h / 8), fill: false, stroke: true }])
      case 'flowChartDocument':
        return P('M0,0 L' + f(w) + ',0 L' + f(w) + ',' + f(h * 0.8) + ' C' + f(w * 0.75) + ',' + f(h * 0.6) + ' ' + f(w * 0.45) + ',' + f(h * 1.08) + ' 0,' + f(h * 0.9) + ' Z')
      case 'flowChartManualInput':
        return P(poly([[0, h * 0.2], [w, 0], [w, h], [0, h]]))
      case 'flowChartDelay':
        return P('M0,0 L' + f(w / 2) + ',0 A' + f(w / 2) + ',' + f(h / 2) + ' 0 0 1 ' + f(w / 2) + ',' + f(h) + ' L0,' + f(h) + ' Z')
      case 'flowChartOffpageConnector':
        return P(poly([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]))
      case 'flowChartPunchedCard':
        return P(poly([[w * 0.2, 0], [w, 0], [w, h], [0, h], [0, h * 0.2]]))
      case 'flowChartCollate':
        return P(poly([[0, 0], [w, 0], [0, h], [w, h]]))
      case 'flowChartOnlineStorage':
        return P('M' + f(w / 6) + ',0 L' + f(w) + ',0 A' + f(w / 6) + ',' + f(h / 2) + ' 0 0 0 ' + f(w) + ',' + f(h) + ' L' + f(w / 6) + ',' + f(h) + ' A' + f(w / 6) + ',' + f(h / 2) + ' 0 0 1 ' + f(w / 6) + ',0 Z')
      case 'flowChartMultidocument':
        return P('M0,' + f(h * 0.15) + ' L' + f(w * 0.85) + ',' + f(h * 0.15) + ' L' + f(w * 0.85) + ',' + f(h * 0.85) + ' C' + f(w * 0.6) + ',' + f(h * 0.7) + ' ' + f(w * 0.4) + ',' + f(h * 1.05) + ' 0,' + f(h * 0.92) + ' Z', [
          { d: 'M' + f(w * 0.07) + ',' + f(h * 0.15) + ' L' + f(w * 0.07) + ',' + f(h * 0.07) + ' L' + f(w * 0.93) + ',' + f(h * 0.07) + ' L' + f(w * 0.93) + ',' + f(h * 0.77) + ' L' + f(w * 0.85) + ',' + f(h * 0.77), fill: false, stroke: true },
          { d: 'M' + f(w * 0.14) + ',' + f(h * 0.07) + ' L' + f(w * 0.14) + ',0 L' + f(w) + ',0 L' + f(w) + ',' + f(h * 0.7) + ' L' + f(w * 0.93) + ',' + f(h * 0.7), fill: false, stroke: true }
        ])
      case 'wedgeRectCallout':
      case 'wedgeRoundRectCallout':
        return callout(w, h, a('adj1', -20833), a('adj2', 62500), false)
      case 'wedgeEllipseCallout':
        return callout(w, h, a('adj1', -20833), a('adj2', 62500), true)
      case 'cloud':
      case 'cloudCallout':
        return P(cloud(w, h))
      case 'heart':
        return P('M' + f(w / 2) + ',' + f(h / 4) + ' C' + f(w / 2) + ',0 0,0 0,' + f(h / 4) + ' C0,' + f(h * 0.55) + ' ' + f(w / 2) + ',' + f(h * 0.75) + ' ' + f(w / 2) + ',' + f(h) + ' C' + f(w / 2) + ',' + f(h * 0.75) + ' ' + f(w) + ',' + f(h * 0.55) + ' ' + f(w) + ',' + f(h / 4) + ' C' + f(w) + ',0 ' + f(w / 2) + ',0 ' + f(w / 2) + ',' + f(h / 4) + ' Z')
      case 'lightningBolt':
        return P(
          poly(
            [[8472, 0], [12860, 6080], [11050, 6797], [16577, 12007], [14767, 12877], [21600, 21600], [10012, 14915], [12222, 13987], [5022, 9705], [7602, 8382], [0, 3890]].map(function (p) {
              return [(p[0] * w) / 21600, (p[1] * h) / 21600]
            })
          )
        )
      case 'moon':
        dx = (w * a('adj', 50000)) / 100000
        return P('M' + f(w) + ',0 A' + f(w) + ',' + f(h / 2) + ' 0 0 0 ' + f(w) + ',' + f(h) + ' A' + f(w - dx) + ',' + f(h / 2) + ' 0 0 1 ' + f(w) + ',0 Z')
      case 'sun':
        var rays = []
        for (var i2 = 0; i2 < 8; i2++) {
          var an3 = (i2 * Math.PI) / 4
          var p1 = [w / 2 + (w / 2) * Math.cos(an3), h / 2 + (h / 2) * Math.sin(an3)]
          var q1 = [w / 2 + w * 0.36 * Math.cos(an3 - 0.15), h / 2 + h * 0.36 * Math.sin(an3 - 0.15)]
          var q2 = [w / 2 + w * 0.36 * Math.cos(an3 + 0.15), h / 2 + h * 0.36 * Math.sin(an3 + 0.15)]
          rays.push(poly([p1, q1, q2]))
        }
        return P(ellipse(w / 2, h / 2, w * 0.25, h * 0.25) + ' ' + rays.join(' '))
      case 'smileyFace':
        return P(ellipse(w / 2, h / 2, w / 2, h / 2), [
          { d: ellipse(w * 0.35, h * 0.38, w * 0.05, h * 0.05) + ' ' + ellipse(w * 0.65, h * 0.38, w * 0.05, h * 0.05), fill: 'darken', stroke: true },
          { d: 'M' + f(w * 0.25) + ',' + f(h * 0.68) + ' Q' + f(w / 2) + ',' + f(h * 0.85) + ' ' + f(w * 0.75) + ',' + f(h * 0.68), fill: false, stroke: true }
        ])
      case 'teardrop':
        return P('M' + f(w) + ',0 L' + f(w) + ',' + f(h / 2) + ' A' + f(w / 2) + ',' + f(h / 2) + ' 0 1 1 ' + f(w / 2) + ',0 Z')
      case 'pie':
      case 'chord':
      case 'arc':
      case 'blockArc':
        var st = a('adj1', name === 'pie' ? 0 : name === 'blockArc' ? 10800000 : name === 'chord' ? 2700000 : 16200000) / 60000
        var en = a('adj2', name === 'pie' ? 16200000 : name === 'blockArc' ? 0 : name === 'chord' ? 16200000 : 0) / 60000
        var sw = (en - st + 360) % 360 || 360
        var s0 = arcPt(w / 2, h / 2, w / 2, h / 2, st)
        var e0 = arcPt(w / 2, h / 2, w / 2, h / 2, st + sw)
        var arcD = 'M' + f(s0[0]) + ',' + f(s0[1]) + ' A' + f(w / 2) + ',' + f(h / 2) + ' 0 ' + (sw > 180 ? 1 : 0) + ' 1 ' + f(e0[0]) + ',' + f(e0[1])
        if (name === 'pie') return P(arcD + ' L' + f(w / 2) + ',' + f(h / 2) + ' Z')
        if (name === 'chord') return P(arcD + ' Z')
        if (name === 'arc') return { paths: [{ d: arcD, fill: false, stroke: true }], text: null }
        dx = (ss * a('adj3', 25000)) / 100000
        var rx2 = w / 2 - dx, ry2 = h / 2 - dx
        var s1 = arcPt(w / 2, h / 2, rx2, ry2, st + sw)
        var e1 = arcPt(w / 2, h / 2, rx2, ry2, st)
        return P(arcD + ' L' + f(s1[0]) + ',' + f(s1[1]) + ' A' + f(rx2) + ',' + f(ry2) + ' 0 ' + (sw > 180 ? 1 : 0) + ' 0 ' + f(e1[0]) + ',' + f(e1[1]) + ' Z')
      case 'plaque':
        dx = (ss * a('adj', 16667)) / 100000
        return P('M' + f(dx) + ',0 L' + f(w - dx) + ',0 A' + f(dx) + ',' + f(dx) + ' 0 0 0 ' + f(w) + ',' + f(dx) + ' L' + f(w) + ',' + f(h - dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 0 ' + f(w - dx) + ',' + f(h) + ' L' + f(dx) + ',' + f(h) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 0 0,' + f(h - dx) + ' L0,' + f(dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 0 ' + f(dx) + ',0 Z')
      case 'foldedCorner':
        dx = (ss * a('adj', 16667)) / 100000
        return P(poly([[0, 0], [w, 0], [w, h - dx], [w - dx, h], [0, h]]), [{ d: poly([[w - dx, h], [w - dx * 0.8, h - dx * 0.8], [w, h - dx]]), fill: 'darken', stroke: true }])
      case 'bracketPair':
        dx = (ss * a('adj', 16667)) / 100000
        return {
          paths: [
            { d: rrect(0, 0, w, h, dx), fill: true, stroke: false },
            { d: 'M' + f(dx) + ',' + f(h) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 1 0,' + f(h - dx) + ' L0,' + f(dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(dx) + ',0 M' + f(w - dx) + ',0 A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(w) + ',' + f(dx) + ' L' + f(w) + ',' + f(h - dx) + ' A' + f(dx) + ',' + f(dx) + ' 0 0 1 ' + f(w - dx) + ',' + f(h), fill: false, stroke: true }
          ],
          text: null
        }
      case 'leftBracket':
      case 'rightBracket':
        dy = Math.min(h / 2, (ss * a('adj', 8333)) / 100000)
        d = 'M' + f(w) + ',' + f(h) + ' A' + f(w) + ',' + f(dy) + ' 0 0 1 0,' + f(h - dy) + ' L0,' + f(dy) + ' A' + f(w) + ',' + f(dy) + ' 0 0 1 ' + f(w) + ',0'
        if (name === 'rightBracket') d = 'M0,0 A' + f(w) + ',' + f(dy) + ' 0 0 1 ' + f(w) + ',' + f(dy) + ' L' + f(w) + ',' + f(h - dy) + ' A' + f(w) + ',' + f(dy) + ' 0 0 1 0,' + f(h)
        return { paths: [{ d: d, fill: false, stroke: true }], text: null }
      case 'leftBrace':
      case 'rightBrace':
      case 'bracePair':
        dy = Math.min(h / 4, (ss * a('adj1', 8333)) / 100000)
        var hw = name === 'bracePair' ? Math.min(w / 4, dy * 2) : w / 2
        var lb = function (x0, dir) {
          var x = x0 + dir * hw
          return 'M' + f(x + dir * hw) + ',' + f(h) + ' Q' + f(x) + ',' + f(h) + ' ' + f(x) + ',' + f(h - dy) + ' L' + f(x) + ',' + f(h / 2 + dy) + ' Q' + f(x) + ',' + f(h / 2) + ' ' + f(x0) + ',' + f(h / 2) + ' Q' + f(x) + ',' + f(h / 2) + ' ' + f(x) + ',' + f(h / 2 - dy) + ' L' + f(x) + ',' + f(dy) + ' Q' + f(x) + ',0 ' + f(x + dir * hw) + ',0'
        }
        if (name === 'leftBrace') d = lb(0, 1)
        else if (name === 'rightBrace') d = lb(w, -1)
        else d = lb(0, 1) + ' ' + lb(w, -1)
        return { paths: [{ d: d, fill: false, stroke: true }], text: null }
      case 'diagStripe':
        dx = (ss * a('adj', 50000)) / 100000
        return P(poly([[0, dx], [dx, 0], [w, 0], [0, h]]))
      case 'ribbon2':
      case 'ribbon':
      case 'ellipseRibbon':
      case 'ellipseRibbon2':
        return P(poly([[0, h * 0.25], [w * 0.15, h * 0.25], [w * 0.15, 0], [w * 0.85, 0], [w * 0.85, h * 0.25], [w, h * 0.25], [w * 0.9, h * 0.6], [w, h], [w * 0.15, h], [w * 0.15, h * 0.75], [0, h * 0.75], [w * 0.1, h * 0.5]]))
      case 'verticalScroll':
      case 'horizontalScroll':
        return P(rrect(0, 0, w, h, ss * 0.08))
    }
    if (STAR[name]) return P(regular(w, h, STAR[name][0], a('adj', STAR[name][1]) / 50000))
    if (POLY[name]) return P(regular(w, h, POLY[name], 0))
    return null
  }

  function callout(w, h, a1, a2, oval) {
    var tx = w / 2 + (w * a1) / 100000
    var ty = h / 2 + (h * a2) / 100000
    var inside = tx >= 0 && tx <= w && ty >= 0 && ty <= h
    var body = oval ? ellipse(w / 2, h / 2, w / 2, h / 2) : null
    if (inside) return { paths: [{ d: body || poly([[0, 0], [w, 0], [w, h], [0, h]]), fill: true, stroke: true }], text: null }
    var dxr = Math.abs(tx - w / 2) / w
    var dyr = Math.abs(ty - h / 2) / h
    var pts
    if (oval) {
      // 尾巴底边放在椭圆朝向尖端的一侧
      var an = Math.atan2((ty - h / 2) / h, (tx - w / 2) / w)
      var b1 = arcPt(w / 2, h / 2, w / 2, h / 2, ((an - 0.25) * 180) / Math.PI)
      var b2 = arcPt(w / 2, h / 2, w / 2, h / 2, ((an + 0.25) * 180) / Math.PI)
      return { paths: [{ d: body + ' ' + poly([b1, [tx, ty], b2, [w / 2, h / 2]]), fill: true, stroke: true }], text: { l: w * 0.146, t: h * 0.146, r: w * 0.146, b: h * 0.146 } }
    }
    if (dyr >= dxr) {
      var bx1 = tx < w / 2 ? w * 0.2 : w * 0.65
      var bx2 = bx1 + w * 0.15
      if (ty > h) pts = [[0, 0], [w, 0], [w, h], [bx2, h], [tx, ty], [bx1, h], [0, h]]
      else pts = [[0, 0], [bx1, 0], [tx, ty], [bx2, 0], [w, 0], [w, h], [0, h]]
    } else {
      var by1 = ty < h / 2 ? h * 0.2 : h * 0.65
      var by2 = by1 + h * 0.15
      if (tx > w) pts = [[0, 0], [w, 0], [w, by1], [tx, ty], [w, by2], [w, h], [0, h]]
      else pts = [[0, 0], [w, 0], [w, h], [0, h], [0, by2], [tx, ty], [0, by1]]
    }
    return { paths: [{ d: poly(pts), fill: true, stroke: true }], text: null }
  }

  function cloud(w, h) {
    var n = 11
    var pts = []
    for (var i = 0; i < n; i++) {
      var an = -Math.PI / 2 + (i * 2 * Math.PI) / n
      pts.push([w / 2 + w * 0.42 * Math.cos(an), h / 2 + h * 0.38 * Math.sin(an)])
    }
    var d = 'M' + f(pts[0][0]) + ',' + f(pts[0][1])
    for (var j = 1; j <= n; j++) {
      var p = pts[j % n]
      var q = pts[j - 1]
      var r = Math.hypot(p[0] - q[0], p[1] - q[1]) * 0.62
      d += ' A' + f(r) + ',' + f(r) + ' 0 0 1 ' + f(p[0]) + ',' + f(p[1])
    }
    return d + ' Z'
  }

  /** 自定义几何 */
  function custom(cg, w, h) {
    var out = []
    OX.kids(OX.path(cg, 'pathLst'), 'path').forEach(function (p) {
      var pw = OX.num(p, 'w', 0) || 0
      var ph = OX.num(p, 'h', 0) || 0
      var sx = pw ? w / pw : 1 / 9525
      var sy = ph ? h / ph : 1 / 9525
      var d = ''
      var cur = [0, 0]
      function pt(el) {
        return [OX.num(el, 'x', 0) * sx, OX.num(el, 'y', 0) * sy]
      }
      OX.kids(p).forEach(function (c) {
        var pts = OX.kids(c, 'pt').map(pt)
        switch (c.localName) {
          case 'moveTo':
            cur = pts[0]
            d += 'M' + f(cur[0]) + ',' + f(cur[1]) + ' '
            break
          case 'lnTo':
            cur = pts[0]
            d += 'L' + f(cur[0]) + ',' + f(cur[1]) + ' '
            break
          case 'cubicBezTo':
            if (pts.length === 3) {
              d += 'C' + pts.map(function (q) { return f(q[0]) + ',' + f(q[1]) }).join(' ') + ' '
              cur = pts[2]
            }
            break
          case 'quadBezTo':
            if (pts.length === 2) {
              d += 'Q' + pts.map(function (q) { return f(q[0]) + ',' + f(q[1]) }).join(' ') + ' '
              cur = pts[1]
            }
            break
          case 'arcTo':
            var wr = OX.num(c, 'wR', 0) * sx
            var hr = OX.num(c, 'hR', 0) * sy
            var st = (OX.num(c, 'stAng', 0) / 60000) * (Math.PI / 180)
            var sw = (OX.num(c, 'swAng', 0) / 60000) * (Math.PI / 180)
            var cx = cur[0] - wr * Math.cos(st)
            var cy = cur[1] - hr * Math.sin(st)
            var ex = cx + wr * Math.cos(st + sw)
            var ey = cy + hr * Math.sin(st + sw)
            if (Math.abs(sw) >= 2 * Math.PI - 1e-6) {
              var mx = cx + wr * Math.cos(st + Math.PI)
              var my = cy + hr * Math.sin(st + Math.PI)
              d += 'A' + f(wr) + ',' + f(hr) + ' 0 0 1 ' + f(mx) + ',' + f(my) + ' A' + f(wr) + ',' + f(hr) + ' 0 0 1 ' + f(ex) + ',' + f(ey) + ' '
            } else d += 'A' + f(wr) + ',' + f(hr) + ' 0 ' + (Math.abs(sw) > Math.PI ? 1 : 0) + ' ' + (sw > 0 ? 1 : 0) + ' ' + f(ex) + ',' + f(ey) + ' '
            cur = [ex, ey]
            break
          case 'close':
            d += 'Z '
            break
        }
      })
      out.push({ d: d.trim(), fill: OX.attr(p, 'fill', 'norm') !== 'none', stroke: OX.attr(p, 'stroke', '1') !== '0' && OX.attr(p, 'stroke', 'true') !== 'false' })
    })
    return { paths: out, text: null }
  }

  /** spPr → 几何。没有几何时返回 null（例如图片默认矩形） */
  function geometry(spPr, w, h) {
    var cg = OX.kid(spPr, 'custGeom')
    if (cg) return custom(cg, w, h)
    var pg = OX.kid(spPr, 'prstGeom')
    var name = pg ? OX.attr(pg, 'prst', 'rect') : 'rect'
    var av = {}
    OX.kids(OX.kid(pg, 'avLst'), 'gd').forEach(function (gd) {
      var m = /val\s+(-?\d+)/.exec(OX.attr(gd, 'fmla', ''))
      if (m) av[OX.attr(gd, 'name')] = Number(m[1])
    })
    return preset(name, w, h, av) || preset('rect', w, h, {})
  }

  window.Geom = { geometry: geometry, preset: preset, ellipse: ellipse, rrect: rrect }
})()
