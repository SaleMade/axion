// AUDIO GRAVADO NO PAINEL VIRA OGG/OPUS (05/11/2026, item novo do vendedor).
//
// O Chromium grava webm no MediaRecorder, e todo audio do roteiro e ogg/opus: e o formato da nota de
// voz do WhatsApp, e o agente le a duracao dele pra dar tempo do lead ouvir. Webm de MediaRecorder
// nao diz a duracao (vem Infinity), entao o item seguinte do funil cairia na espera curta.
//
// E O MESMO CONVERSOR DA DASH (axion-produtor/src/lib/wa.js: muxOggOpus + audioToOpusOgg), copiado
// sem mudar a conta: decodifica, reamostra pra 48 kHz mono, codifica em Opus pelo WebCodecs e monta
// o ogg na mao. Devolve null quando nao da (sem WebCodecs, arquivo ja e ogg/opus, ou a conferencia
// final falhou) e quem chamou manda o arquivo original.
;(function () {
  function muxOggOpus(packets, opts) {
    var channels = opts.channels || 1, preSkip = (opts.preSkip != null ? opts.preSkip : 312), serial = 0x1a2b3c4d
    var T = muxOggOpus._t || (muxOggOpus._t = (function () { var t = new Uint32Array(256); for (var i = 0; i < 256; i++) { var r = i << 24; for (var j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t[i] = r >>> 0 } return t })())
    function crc(b) { var c = 0; for (var i = 0; i < b.length; i++) c = ((c << 8) ^ T[((c >>> 24) ^ b[i]) & 0xff]) >>> 0; return c >>> 0 }
    function lace(len) { var s = []; while (len >= 255) { s.push(255); len -= 255 } s.push(len); return s }
    function samples(pkt) { if (!pkt.length) return 0; var toc = pkt[0], config = toc >> 3, c = toc & 3, fs; if (config < 12) { var a = [480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880]; fs = a[config] } else if (config < 16) { var b = [480, 960, 480, 960]; fs = b[config - 12] } else { var d = [120, 240, 480, 960]; fs = d[(config - 16) & 3] } var fr; if (c === 0) fr = 1; else if (c === 1 || c === 2) fr = 2; else fr = pkt.length > 1 ? (pkt[1] & 0x3f) : 1; return fs * fr }
    var seq = 0, pages = []
    function page(headerType, granule, data) {
      var sizes = lace(data.length), nseg = sizes.length
      var pg = new Uint8Array(27 + nseg + data.length), dv = new DataView(pg.buffer)
      pg[0] = 79; pg[1] = 103; pg[2] = 103; pg[3] = 83; pg[4] = 0; pg[5] = headerType
      dv.setBigInt64(6, BigInt(granule), true); dv.setUint32(14, serial >>> 0, true); dv.setUint32(18, seq >>> 0, true); dv.setUint32(22, 0, true)
      pg[26] = nseg; for (var i = 0; i < nseg; i++) pg[27 + i] = sizes[i]; pg.set(data, 27 + nseg)
      dv.setUint32(22, crc(pg) >>> 0, true); seq++; return pg
    }
    var head = new Uint8Array(19), hv = new DataView(head.buffer)
    head.set([79, 112, 117, 115, 72, 101, 97, 100], 0); head[8] = 1; head[9] = channels; hv.setUint16(10, preSkip, true); hv.setUint32(12, 48000, true); hv.setInt16(16, 0, true); head[18] = 0
    pages.push(page(2, 0, head))
    var vend = new TextEncoder().encode('SellWave')
    var tags = new Uint8Array(8 + 4 + vend.length + 4), tv = new DataView(tags.buffer)
    tags.set([79, 112, 117, 115, 84, 97, 103, 115], 0); tv.setUint32(8, vend.length, true); tags.set(vend, 12); tv.setUint32(12 + vend.length, 0, true)
    pages.push(page(0, 0, tags))
    var granule = 0
    for (var i = 0; i < packets.length; i++) { granule += samples(packets[i]); pages.push(page(i === packets.length - 1 ? 4 : 0, granule + preSkip, packets[i])) }
    var total = 0; for (var k = 0; k < pages.length; k++) total += pages[k].length
    var out = new Uint8Array(total), o = 0; for (var m = 0; m < pages.length; m++) { out.set(pages[m], o); o += pages[m].length }
    return out
  }

  async function paraOgg(file) {
    try {
      if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC || !window.OfflineAudioContext) return null
      var buf = await file.arrayBuffer()
      try { var h = new Uint8Array(buf.slice(0, 64)), s = String.fromCharCode.apply(null, h); if (s.indexOf('OggS') === 0 && s.indexOf('OpusHead') >= 0) return null } catch (_) { /* segue */ }
      var dctx = new AC(); var decoded = await dctx.decodeAudioData(buf.slice(0)); try { dctx.close() } catch (_) { /* ok */ }
      var dur = decoded.duration; if (!dur || dur <= 0) return null
      var off = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * 48000)), 48000)
      var src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start()
      var rendered = await off.startRendering(); var pcm = rendered.getChannelData(0)
      var cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 }
      try { var sup = await AudioEncoder.isConfigSupported(cfg); if (!sup || !sup.supported) return null } catch (_) { return null }
      var packets = []
      var enc = new AudioEncoder({ output: function (chunk) { var u = new Uint8Array(chunk.byteLength); chunk.copyTo(u); packets.push(u) }, error: function () { } })
      enc.configure(cfg)
      var frame = 960, ts = 0
      for (var i = 0; i < pcm.length; i += frame) { var n = Math.min(frame, pcm.length - i); var dat = new Float32Array(n); dat.set(pcm.subarray(i, i + n)); var ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 1, timestamp: ts, data: dat }); enc.encode(ad); ad.close(); ts += Math.round(n / 48000 * 1e6) }
      await enc.flush(); try { enc.close() } catch (_) { /* ok */ }
      if (!packets.length) return null
      var ogg = muxOggOpus(packets, { channels: 1, preSkip: 312 })
      var blob = new Blob([ogg], { type: 'audio/ogg' })
      try { var vc = new AC(); await vc.decodeAudioData(await blob.arrayBuffer()); try { vc.close() } catch (_) { /* ok */ } } catch (_) { return null }
      return blob
    } catch (_) { return null }
  }

  window.SWOgg = { paraOgg: paraOgg }
})()
