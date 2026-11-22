/**
 * 新建空白演示文稿（16:9）：1 个母版、6 个版式、Office 主题、1 张标题幻灯片。
 * 文件为空（IDE 里“新建演示文稿”）时用它生成内容。
 */
;(function () {
  'use strict'
  var D = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
  var NSA = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  var NSR = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  var NSP = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  var NS3 = NSA + ' ' + NSR + ' ' + NSP
  var CT_PML = 'application/vnd.openxmlformats-officedocument.presentationml.'
  var REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  var TREE_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

  function xfrm(x, y, w, h) {
    return '<a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm>'
  }
  /** 占位符形状 */
  function ph(id, name, type, idx, box, opts) {
    opts = opts || {}
    var phAttr = (type ? ' type="' + type + '"' : '') + (opts.sz ? ' sz="' + opts.sz + '"' : '') + (idx != null ? ' idx="' + idx + '"' : '')
    var spPr = box ? '<p:spPr>' + xfrm(box[0], box[1], box[2], box[3]) + (opts.geom ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : '') + '</p:spPr>' : '<p:spPr/>'
    var body = opts.bodyXml || '<a:bodyPr' + (opts.bodyPr || '') + '/>'
    var lst = opts.lst ? '<a:lstStyle>' + opts.lst + '</a:lstStyle>' : '<a:lstStyle/>'
    var paras = opts.text
      ? opts.text
          .map(function (t, i) {
            var lvl = opts.levels && i > 0 ? '<a:pPr lvl="' + i + '"/>' : ''
            return '<a:p>' + lvl + '<a:r><a:rPr lang="zh-CN" altLang="en-US"/><a:t>' + esc(t) + '</a:t></a:r></a:p>'
          })
          .join('')
      : opts.field
        ? '<a:p>' + (opts.algn ? '<a:pPr algn="' + opts.algn + '"/>' : '') + '<a:fld id="' + opts.field[0] + '" type="' + opts.field[1] + '"><a:rPr lang="zh-CN" altLang="en-US"/><a:t>' + opts.field[2] + '</a:t></a:fld><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>'
        : '<a:p>' + (opts.algn ? '<a:pPr algn="' + opts.algn + '"/>' : '') + '<a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>'
    return (
      '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + esc(name) + '"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph' + phAttr + '/></p:nvPr></p:nvSpPr>' +
      spPr + '<p:txBody>' + body + lst + paras + '</p:txBody></p:sp>'
    )
  }

  var W = 12192000, H = 6858000
  var DT_ID = '{B8C3F1A2-6F51-4C5E-9E0A-6E2D8E5F0A11}'
  var NUM_ID = '{C7D2E4B3-1A62-4D7F-8B1C-5F3E9D6A2B22}'

  function footers(start) {
    return (
      ph(start, 'Date Placeholder ' + start, 'dt', 10, null, { sz: 'half' }) +
      ph(start + 1, 'Footer Placeholder ' + (start + 1), 'ftr', 11, null, { sz: 'quarter' }) +
      ph(start + 2, 'Slide Number Placeholder ' + (start + 2), 'sldNum', 12, null, { sz: 'quarter' })
    )
  }

  function lvl(n, marL, sz, bu) {
    return (
      '<a:lvl' + n + 'pPr marL="' + marL + '" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="' + (n === 1 ? 1000 : 500) + '"/></a:spcBef>' +
      '<a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="' + bu + '"/><a:defRPr sz="' + sz + '" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl' + n + 'pPr>'
    )
  }
  function plainLvl(n) {
    return '<a:lvl' + n + 'pPr marL="' + (n - 1) * 457200 + '" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl' + n + 'pPr>'
  }
  function plainLevels() {
    var s = ''
    for (var i = 1; i <= 9; i++) s += plainLvl(i)
    return s
  }

  function master(t) {
    var title = ph(2, 'Title Placeholder 1', 'title', null, [838200, 365125, 10515600, 1325563], { geom: 1, bodyXml: '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr>', text: [t('单击此处编辑母版标题样式', 'Click to edit Master title style')] })
    var body = ph(3, 'Text Placeholder 2', 'body', 1, [838200, 1825625, 10515600, 4351338], { geom: 1, levels: 1, text: [t('编辑母版文本样式', 'Edit Master text styles'), t('第二级', 'Second level'), t('第三级', 'Third level'), t('第四级', 'Fourth level'), t('第五级', 'Fifth level')] }).replace('<a:bodyPr/>', '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr>')
    var small = '<a:lvl1pPr algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>'
    var dt = ph(4, 'Date Placeholder 3', 'dt', 2, [838200, 6356350, 2743200, 365125], { sz: 'half', geom: 1, lst: small, field: [DT_ID, 'datetimeFigureOut', '2026/1/1'] }).replace('<a:bodyPr/>', '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/>')
    var ftr = ph(5, 'Footer Placeholder 4', 'ftr', 3, [4038600, 6356350, 4114800, 365125], { sz: 'quarter', geom: 1, lst: small.replace('algn="l"', 'algn="ctr"') }).replace('<a:bodyPr/>', '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/>')
    var num = ph(6, 'Slide Number Placeholder 5', 'sldNum', 4, [8610600, 6356350, 2743200, 365125], { sz: 'quarter', geom: 1, lst: small.replace('algn="l"', 'algn="r"'), field: [NUM_ID, 'slidenum', '‹#›'] }).replace('<a:bodyPr/>', '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/>')
    var ids = ''
    for (var i = 0; i < 6; i++) ids += '<p:sldLayoutId id="' + (2147483649 + i) + '" r:id="rId' + (i + 1) + '"/>'
    var titleStyle =
      '<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>' +
      '<a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>'
    var bodyStyle = '<p:bodyStyle>' + lvl(1, 228600, 2800, '•') + lvl(2, 685800, 2400, '•') + lvl(3, 1143000, 2000, '•') + lvl(4, 1600200, 1800, '•') + lvl(5, 2057400, 1800, '•') + lvl(6, 2514600, 1800, '•') + lvl(7, 2971800, 1800, '•') + lvl(8, 3429000, 1800, '•') + lvl(9, 3886200, 1800, '•') + '</p:bodyStyle>'
    return (
      D + '<p:sldMaster ' + NS3 + '><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>' + TREE_HEAD + title + body + dt + ftr + num + '</p:spTree></p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst>' + ids + '</p:sldLayoutIdLst><p:txStyles>' + titleStyle + bodyStyle + '<p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr>' + plainLevels() + '</p:otherStyle></p:txStyles></p:sldMaster>'
    )
  }

  function layout(type, name, shapes) {
    return D + '<p:sldLayout ' + NS3 + ' type="' + type + '" preserve="1"><p:cSld name="' + esc(name) + '"><p:spTree>' + TREE_HEAD + shapes + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  }

  function layouts(t) {
    var T = t('单击此处编辑母版标题样式', 'Click to edit Master title style')
    var B = [t('编辑母版文本样式', 'Edit Master text styles'), t('第二级', 'Second level'), t('第三级', 'Third level'), t('第四级', 'Fourth level'), t('第五级', 'Fifth level')]
    return [
      layout(
        'title',
        t('标题幻灯片', 'Title Slide'),
        ph(2, 'Title 1', 'ctrTitle', null, [1524000, 1122363, 9144000, 2387600], { bodyPr: ' anchor="b"', lst: '<a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr>', text: [T] }) +
          ph(3, 'Subtitle 2', 'subTitle', 1, [1524000, 3602038, 9144000, 1655762], { lst: '<a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr>', text: [t('单击此处编辑母版副标题样式', 'Click to edit Master subtitle style')] }) +
          footers(4)
      ),
      layout('obj', t('标题和内容', 'Title and Content'), ph(2, 'Title 1', 'title', null, null, { text: [T] }) + ph(3, 'Content Placeholder 2', null, 1, null, { levels: 1, text: B }) + footers(4)),
      layout(
        'secHead',
        t('节标题', 'Section Header'),
        ph(2, 'Title 1', 'title', null, [831850, 1709738, 10515600, 2852737], { bodyPr: ' anchor="b"', lst: '<a:lvl1pPr><a:defRPr sz="6000"/></a:lvl1pPr>', text: [T] }) +
          ph(3, 'Text Placeholder 2', 'body', 1, [831850, 4589463, 10515600, 1500187], { lst: '<a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>', text: [B[0]] }) +
          footers(4)
      ),
      layout(
        'twoObj',
        t('两栏内容', 'Two Content'),
        ph(2, 'Title 1', 'title', null, null, { text: [T] }) +
          ph(3, 'Content Placeholder 2', null, 1, [838200, 1825625, 5181600, 4351338], { sz: 'half', levels: 1, text: B }) +
          ph(4, 'Content Placeholder 3', null, 2, [6172200, 1825625, 5181600, 4351338], { sz: 'half', levels: 1, text: B }) +
          footers(5)
      ),
      layout('titleOnly', t('仅标题', 'Title Only'), ph(2, 'Title 1', 'title', null, null, { text: [T] }) + footers(3)),
      layout('blank', t('空白', 'Blank'), footers(2))
    ]
  }

  function theme() {
    var c = function (n, hex) {
      return '<a:' + n + '><a:srgbClr val="' + hex + '"/></a:' + n + '>'
    }
    var fonts = function (kind, latin, ea) {
      return '<a:' + kind + 'Font><a:latin typeface="' + latin + '" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="' + ea + '"/></a:' + kind + 'Font>'
    }
    var ph = '<a:schemeClr val="phClr"/>'
    var grad = function (a, b, c2) {
      return '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr">' + a + '</a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr">' + b + '</a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr">' + c2 + '</a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
    }
    var ln = function (w) {
      return '<a:ln w="' + w + '" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>' + ph + '</a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'
    }
    return (
      D + '<a:theme ' + NSA + ' name="Office Theme"><a:themeElements><a:clrScheme name="Office">' +
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
      c('dk2', '0E2841') + c('lt2', 'E8E8E8') + c('accent1', '156082') + c('accent2', 'E97132') + c('accent3', '196B24') + c('accent4', '0F9ED5') + c('accent5', 'A02B93') + c('accent6', '4EA72E') + c('hlink', '467886') + c('folHlink', '96607D') +
      '</a:clrScheme><a:fontScheme name="Office">' + fonts('major', 'Aptos Display', '等线 Light') + fonts('minor', 'Aptos', '等线') + '</a:fontScheme>' +
      '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill>' + ph + '</a:solidFill>' +
      grad('<a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/>', '<a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/>', '<a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/>') +
      grad('<a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/>', '<a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/>', '<a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/>') +
      '</a:fillStyleLst><a:lnStyleLst>' + ln(12700) + ln(19050) + ln(25400) + '</a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
      '<a:bgFillStyleLst><a:solidFill>' + ph + '</a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>' +
      grad('<a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/>', '<a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/>', '<a:shade val="63000"/><a:satMod val="120000"/>') +
      '</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
    )
  }

  function slide1() {
    return (
      D + '<p:sld ' + NS3 + '><p:cSld><p:spTree>' + TREE_HEAD +
      ph(2, 'Title 1', 'ctrTitle', null, null) + ph(3, 'Subtitle 2', 'subTitle', 1, null) +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )
  }

  function rels(list) {
    return (
      D + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list
        .map(function (r, i) {
          return '<Relationship Id="rId' + (i + 1) + '" Type="' + (r[0].indexOf('http') === 0 ? r[0] : REL + r[0]) + '" Target="' + r[1] + '"/>'
        })
        .join('') +
      '</Relationships>'
    )
  }

  /** 返回 Map<路径, XML 字符串> */
  function blank(t) {
    var files = new Map()
    var ov = function (p, type) {
      return '<Override PartName="/' + p + '" ContentType="' + type + '"/>'
    }
    var lay = layouts(t)
    var ct =
      D + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      ov('ppt/presentation.xml', CT_PML + 'presentation.main+xml') + ov('ppt/slideMasters/slideMaster1.xml', CT_PML + 'slideMaster+xml') +
      lay
        .map(function (_, i) {
          return ov('ppt/slideLayouts/slideLayout' + (i + 1) + '.xml', CT_PML + 'slideLayout+xml')
        })
        .join('') +
      ov('ppt/slides/slide1.xml', CT_PML + 'slide+xml') + ov('ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml') +
      ov('ppt/presProps.xml', CT_PML + 'presProps+xml') + ov('ppt/viewProps.xml', CT_PML + 'viewProps+xml') + ov('ppt/tableStyles.xml', 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml') +
      ov('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') + ov('docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml') +
      '</Types>'
    files.set('[Content_Types].xml', ct)
    files.set('_rels/.rels', rels([['officeDocument', 'ppt/presentation.xml'], ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['extended-properties', 'docProps/app.xml']]))
    var now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    files.set(
      'docProps/core.xml',
      D + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator></dc:creator><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>'
    )
    files.set('docProps/app.xml', D + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Infinite Studio</Application><Slides>1</Slides><PresentationFormat>Widescreen</PresentationFormat></Properties>')
    files.set(
      'ppt/presentation.xml',
      D + '<p:presentation ' + NS3 + ' saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
        '<p:sldSz cx="' + W + '" cy="' + H + '"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr>' + plainLevels() + '</p:defaultTextStyle></p:presentation>'
    )
    files.set('ppt/_rels/presentation.xml.rels', rels([['slideMaster', 'slideMasters/slideMaster1.xml'], ['slide', 'slides/slide1.xml'], ['presProps', 'presProps.xml'], ['viewProps', 'viewProps.xml'], ['theme', 'theme/theme1.xml'], ['tableStyles', 'tableStyles.xml']]))
    files.set('ppt/presProps.xml', D + '<p:presentationPr ' + NS3 + '/>')
    files.set('ppt/viewProps.xml', D + '<p:viewPr ' + NS3 + '><p:normalViewPr horzBarState="maximized"><p:restoredLeft sz="15987" autoAdjust="0"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>')
    files.set('ppt/tableStyles.xml', D + '<a:tblStyleLst ' + NSA + ' def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>')
    files.set('ppt/theme/theme1.xml', theme())
    files.set('ppt/slideMasters/slideMaster1.xml', master(t))
    files.set(
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels(
        lay
          .map(function (_, i) {
            return ['slideLayout', '../slideLayouts/slideLayout' + (i + 1) + '.xml']
          })
          .concat([['theme', '../theme/theme1.xml']])
      )
    )
    lay.forEach(function (x, i) {
      files.set('ppt/slideLayouts/slideLayout' + (i + 1) + '.xml', x)
      files.set('ppt/slideLayouts/_rels/slideLayout' + (i + 1) + '.xml.rels', rels([['slideMaster', '../slideMasters/slideMaster1.xml']]))
    })
    files.set('ppt/slides/slide1.xml', slide1())
    files.set('ppt/slides/_rels/slide1.xml.rels', rels([['slideLayout', '../slideLayouts/slideLayout1.xml']]))
    return files
  }

  window.Blank = { files: blank }
})()
