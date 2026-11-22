/**
 * 最小的 zip 读写（.pptx 就是 zip）。
 * 读：解析中央目录，按需用 DecompressionStream('deflate-raw') 解压。
 * 写：没改过的条目原样复制压缩数据；改过的用 CompressionStream 重新压缩。
 */
;(function () {
  'use strict'

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256)
    for (var n = 0; n < 256; n++) {
      var c = n
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()

  function crc32(bytes) {
    var c = 0xffffffff
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  async function pipe(bytes, stream) {
    var out = new Response(new Blob([bytes]).stream().pipeThrough(stream))
    return new Uint8Array(await out.arrayBuffer())
  }
  var inflate = function (b) {
    return pipe(b, new DecompressionStream('deflate-raw'))
  }
  var deflate = function (b) {
    return pipe(b, new CompressionStream('deflate-raw'))
  }

  var utf8 = new TextDecoder('utf-8')
  var cp437 = null

  /** 读取 zip，返回 [{ name, method, crc, size, raw(压缩数据), data()(解压后的 Promise<Uint8Array>) }] */
  function readZip(buf) {
    var u8 = new Uint8Array(buf)
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    var eocd = -1
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('not a zip')
    var count = dv.getUint16(eocd + 10, true)
    var cdOff = dv.getUint32(eocd + 16, true)
    // zip64
    if (cdOff === 0xffffffff || count === 0xffff) {
      var loc = eocd - 20
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        var z64 = Number(dv.getBigUint64(loc + 8, true))
        count = Number(dv.getBigUint64(z64 + 32, true))
        cdOff = Number(dv.getBigUint64(z64 + 48, true))
      }
    }
    var entries = []
    var p = cdOff
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory')
      var flags = dv.getUint16(p + 8, true)
      var method = dv.getUint16(p + 10, true)
      var crc = dv.getUint32(p + 16, true)
      var csize = dv.getUint32(p + 20, true)
      var usize = dv.getUint32(p + 24, true)
      var nlen = dv.getUint16(p + 28, true)
      var xlen = dv.getUint16(p + 30, true)
      var clen = dv.getUint16(p + 32, true)
      var lho = dv.getUint32(p + 42, true)
      var nameBytes = u8.subarray(p + 46, p + 46 + nlen)
      if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
        var x = p + 46 + nlen
        var xe = x + xlen
        while (x + 4 <= xe) {
          var id = dv.getUint16(x, true)
          var sz = dv.getUint16(x + 2, true)
          if (id === 1) {
            var q = x + 4
            if (usize === 0xffffffff) (usize = Number(dv.getBigUint64(q, true))), (q += 8)
            if (csize === 0xffffffff) (csize = Number(dv.getBigUint64(q, true))), (q += 8)
            if (lho === 0xffffffff) lho = Number(dv.getBigUint64(q, true))
          }
          x += 4 + sz
        }
      }
      var name
      if (flags & 0x800) name = utf8.decode(nameBytes)
      else {
        try {
          name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
        } catch (e) {
          if (!cp437) cp437 = new TextDecoder('ibm866')
          name = cp437.decode(nameBytes)
        }
      }
      p += 46 + nlen + xlen + clen
      if (flags & 1) throw new Error('encrypted')
      var dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true)
      entries.push(makeEntry(name, method, crc, usize, u8.subarray(dataStart, dataStart + csize)))
    }
    return entries
  }

  function makeEntry(name, method, crc, size, raw) {
    var cache = null
    return {
      name: name,
      method: method,
      crc: crc,
      size: size,
      raw: raw,
      data: function () {
        if (!cache) {
          if (method === 0) cache = Promise.resolve(raw)
          else if (method === 8) cache = inflate(raw)
          else cache = Promise.reject(new Error('unsupported zip method ' + method))
        }
        return cache
      }
    }
  }

  /**
   * 写 zip。files: [{ name, entry }（原样复制） | { name, data: Uint8Array }]
   */
  async function writeZip(files) {
    var enc = new TextEncoder()
    var parts = []
    var central = []
    var offset = 0
    var now = new Date()
    var dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
    var ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
    for (var i = 0; i < files.length; i++) {
      var f = files[i]
      var method, crc, size, body
      if (f.entry && (f.entry.method === 0 || f.entry.method === 8)) {
        method = f.entry.method
        crc = f.entry.crc
        size = f.entry.size
        body = f.entry.raw
      } else {
        var data = f.entry ? await f.entry.data() : f.data
        crc = crc32(data)
        size = data.length
        if (size > 64) {
          var d = await deflate(data)
          if (d.length < size) (method = 8), (body = d)
          else (method = 0), (body = data)
        } else (method = 0), (body = data)
      }
      var nameBytes = enc.encode(f.name)
      var lh = new DataView(new ArrayBuffer(30))
      lh.setUint32(0, 0x04034b50, true)
      lh.setUint16(4, 20, true)
      lh.setUint16(6, 0x0800, true)
      lh.setUint16(8, method, true)
      lh.setUint16(10, dtime, true)
      lh.setUint16(12, ddate, true)
      lh.setUint32(14, crc, true)
      lh.setUint32(18, body.length, true)
      lh.setUint32(22, size, true)
      lh.setUint16(26, nameBytes.length, true)
      parts.push(new Uint8Array(lh.buffer), nameBytes, body)
      var ch = new DataView(new ArrayBuffer(46))
      ch.setUint32(0, 0x02014b50, true)
      ch.setUint16(4, 20, true)
      ch.setUint16(6, 20, true)
      ch.setUint16(8, 0x0800, true)
      ch.setUint16(10, method, true)
      ch.setUint16(12, dtime, true)
      ch.setUint16(14, ddate, true)
      ch.setUint32(16, crc, true)
      ch.setUint32(20, body.length, true)
      ch.setUint32(24, size, true)
      ch.setUint16(28, nameBytes.length, true)
      ch.setUint32(42, offset, true)
      central.push(new Uint8Array(ch.buffer), nameBytes)
      offset += 30 + nameBytes.length + body.length
    }
    var cdSize = 0
    central.forEach(function (b) {
      cdSize += b.length
    })
    var end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, files.length, true)
    end.setUint16(10, files.length, true)
    end.setUint32(12, cdSize, true)
    end.setUint32(16, offset, true)
    var all = parts.concat(central, [new Uint8Array(end.buffer)])
    var total = 0
    all.forEach(function (b) {
      total += b.length
    })
    var out = new Uint8Array(total)
    var pos = 0
    all.forEach(function (b) {
      out.set(b, pos)
      pos += b.length
    })
    return out
  }

  window.Zip = { read: readZip, write: writeZip, crc32: crc32 }
})()
