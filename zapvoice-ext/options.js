// ZapVoice Nosso — opções (só gerenciar os áudios do atendente; sem login)
const $ = (id) => document.getElementById(id);
const STAGES = ['F1 Abertura', 'F2 Garantia COD', 'F4 Dor', 'F5 Produto', 'F6 Prova social', 'F7 Checagem', 'F9 Oferta', 'F11 Fechamento', 'Outro'];

function load() {
  STAGES.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; $('itStage').appendChild(o); });
  chrome.storage.local.get(['zv_items'], (r) => renderItems(r.zv_items || []));
}

function fileToB64(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).replace(/^data:[^;]+;base64,/, ''));
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

async function addAudio() {
  const f = $('itFile').files[0];
  if (!f) { setIt('Escolha um arquivo', 'err'); return; }
  setIt('Carregando...', '');
  try {
    const b64 = await fileToB64(f);
    const kind = f.type.startsWith('video') ? 'video' : (f.type.startsWith('image') ? 'image' : 'audio');
    addItem({ kind, label: $('itLabel').value.trim() || f.name, stage: $('itStage').value, mime: f.type || 'audio/ogg', sizeKB: Math.round(f.size / 1024), b64 });
    $('itFile').value = ''; $('itLabel').value = '';
  } catch (e) { setIt('Falha ao ler arquivo: ' + e.message, 'err'); }
}

function addVideoUrl() {
  const url = $('vidUrl').value.trim();
  if (!url) { setIt('Cole a URL do vídeo', 'err'); return; }
  addItem({ kind: 'video', label: $('vidLabel').value.trim() || 'Vídeo prova social', stage: 'F6 Prova social', mime: 'video/mp4', b64: url });
  $('vidUrl').value = ''; $('vidLabel').value = '';
}

function addItem(it) {
  chrome.storage.local.get(['zv_items'], (r) => {
    const arr = r.zv_items || []; arr.push(it);
    chrome.storage.local.set({ zv_items: arr }, () => {
      if (chrome.runtime.lastError) { setIt('Erro ao salvar (arquivo grande?): ' + chrome.runtime.lastError.message, 'err'); return; }
      renderItems(arr); setIt('Adicionado', 'ok');
    });
  });
}
function delItem(i) {
  chrome.storage.local.get(['zv_items'], (r) => {
    const arr = r.zv_items || []; arr.splice(i, 1);
    chrome.storage.local.set({ zv_items: arr }, () => renderItems(arr));
  });
}
function renderItems(arr) {
  const box = $('items');
  if (!arr.length) { box.innerHTML = '<div class="muted">Nenhum item ainda.</div>'; return; }
  box.innerHTML = '';
  arr.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'item';
    row.innerHTML = '<span class="tag">' + esc(it.stage || it.kind) + '</span><span class="lbl">' + esc(it.label) + '</span>';
    const b = document.createElement('button'); b.textContent = 'remover'; b.onclick = () => delItem(i); row.appendChild(b);
    box.appendChild(row);
  });
}
function setIt(m, k) { const el = $('itStatus'); el.textContent = m; el.className = 'status ' + (k || ''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('addAudio').onclick = addAudio;
  $('addVideoUrl').onclick = addVideoUrl;
});
