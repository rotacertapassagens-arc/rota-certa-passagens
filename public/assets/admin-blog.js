// Editor dos Guias de viagem (painel admin): lista, edição em blocos, fotos reduzidas no navegador,
// rascunho, pré-visualização e publicação. Fala só com /api/admin/blog, que exige usuário master.
const $ = (id) => document.getElementById(id);
const cookie = (name) => document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
  if ((options.method || 'GET') !== 'GET') headers.set('x-csrf-token', cookie('rc_csrf'));
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'request_failed'), { status: response.status, body });
  return body;
}

const FIELD_MESSAGES = {
  title: 'O título precisa ter entre 3 e 140 letras.',
  summary: 'O resumo precisa ter entre 10 e 300 letras.',
  regionId: 'Escolha uma região.',
  titleHighlight: 'O trecho em dourado pode ter até 80 letras.',
  lede: 'A frase abaixo do título pode ter até 300 letras.',
  destination: 'O destino pode ter até 80 letras.',
  ctaTitle: 'A chamada final pode ter até 120 letras.',
  coverAlt: 'A descrição da foto de capa pode ter até 200 letras.',
  coverUrl: 'A foto de capa não é válida. Escolha a foto de novo.',
  coverUrlSmall: 'A foto de capa não é válida. Escolha a foto de novo.',
  slug: 'O endereço precisa ter pelo menos 3 letras.',
  body: 'Algum bloco do conteúdo ficou grande demais ou inválido. Confira os blocos e tente de novo.',
};
function errorMessage(error, fallback) {
  if (error.status === 401) return 'Sua sessão expirou. Entre de novo pela Área do cliente e volte para esta página.';
  if (error.status === 403) return 'Só usuários master podem editar os guias.';
  if (error.message === 'invalid_post' && error.body?.field) return FIELD_MESSAGES[error.body.field] || fallback;
  if (error.message === 'file_too_large') return 'A foto ficou grande demais mesmo depois de reduzida. Tente outra foto.';
  if (error.message === 'unsupported_type') return 'Formato de foto não aceito. Use JPG, PNG ou WebP.';
  if (error.message === 'formato') return 'Não consegui abrir esta foto. Se ela veio do iPhone (HEIC), salve como JPG e tente de novo.';
  return fallback;
}

const TYPES = { p: 'Parágrafo', h: 'Título de seção', ul: 'Lista', tip: 'Caixa de dicas', img: 'Foto', quote: 'Citação' };
const NEW_BLOCK = { p: () => ({ t: 'p', text: '' }), h: () => ({ t: 'h', label: '', text: '' }), ul: () => ({ t: 'ul', items: [] }), tip: () => ({ t: 'tip', title: 'Dicas práticas', items: [] }), img: () => ({ t: 'img', src: '', small: '', alt: '', caption: '' }), quote: () => ({ t: 'quote', text: '' }) };

let regions = [];
let posts = [];
let post = null;
let dirty = false;
let busy = false;
let currentHash = location.hash || '#/';

// ---------- fotos: reduzidas no navegador antes de subir ----------
function reduzir(bitmap, max, quality) {
  const scale = Math.min(1, max / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve({ blob, w, h }), 'image/jpeg', quality));
}
async function versao(bitmap, max) {
  for (const quality of [0.82, 0.72, 0.62]) {
    const out = await reduzir(bitmap, max, quality);
    if (out.blob && out.blob.size <= 1_300_000) return out;
  }
  return reduzir(bitmap, Math.round(max * 0.75), 0.6);
}
async function enviarFoto(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('formato'); }
  const g = await versao(bitmap, 1600);
  const m = await versao(bitmap, 900);
  const form = new FormData();
  form.set('g', g.blob, 'g.jpg'); form.set('m', m.blob, 'm.jpg');
  form.set('w', String(g.w)); form.set('h', String(g.h)); form.set('wm', String(m.w)); form.set('hm', String(m.h));
  return api('/api/admin/blog/media', { method: 'POST', body: form });
}
function escolherFoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

// ---------- mensagens e estado ----------
function setStatus(message, kind) {
  const box = $('editorStatus');
  box.textContent = message || '';
  box.className = `status${kind === 'error' ? ' alert-error' : kind === 'success' ? ' alert-success' : message ? ' alert-info' : ''}`;
}
function setDirty(value) {
  dirty = value;
  const state = $('saveState');
  state.textContent = value ? 'Alterações não salvas' : post?.id ? 'Tudo salvo' : '';
  state.classList.toggle('is-dirty', value);
}
function setBusy(value) {
  busy = value;
  for (const id of ['saveBtn', 'publishBtn', 'previewBtn', 'unpublishBtn', 'deleteBtn', 'coverBtn']) $(id).disabled = value;
}
function formatDate(value) {
  if (!value) return '';
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function showView(view) {
  $('listView').classList.toggle('hidden', view !== 'list');
  $('editorView').classList.toggle('hidden', view !== 'editor');
  window.scrollTo(0, 0);
}

// ---------- lista ----------
async function loadList() {
  const data = await api('/api/admin/blog');
  posts = data.posts || [];
  regions = data.regions || [];
}
function renderList() {
  const box = $('postList');
  if (!posts.length) { box.innerHTML = '<div class="ab-empty">Nenhum guia ainda. Clique em "Novo guia" para começar.</div>'; return; }
  box.innerHTML = posts.map((p) => {
    const img = p.cover_url_small || p.cover_url;
    const publicado = p.status === 'published';
    return `<article class="ab-item">
      ${img ? `<img class="ab-thumb" src="${esc(img)}" alt="">` : '<div class="ab-thumb ab-thumb-empty">sem foto</div>'}
      <div>
        <div class="ab-meta"><span class="tag ${publicado ? 'tag-paid' : 'tag-pending'}">${publicado ? 'Publicado' : 'Rascunho'}</span>${p.featured ? '<span class="tag tag-info">Destaque</span>' : ''}<span>${esc(p.region_name)}</span><span>Atualizado em ${esc(formatDate(p.updated_at))}</span></div>
        <h3>${esc(p.title)}</h3>
      </div>
      <div class="ab-item-actions">
        <a class="btn-primary" href="#/editar/${esc(p.id)}">Editar</a>
        <a class="btn-secondary" href="${publicado ? `/blog/${esc(p.slug)}` : `/blog/preview/${esc(p.id)}`}" target="_blank" rel="noopener">${publicado ? 'Ver no site' : 'Pré-visualizar'}</a>
      </div>
    </article>`;
  }).join('');
}
async function showList() {
  showView('list');
  $('postList').innerHTML = '<p class="muted">Carregando guias...</p>';
  try { await loadList(); renderList(); }
  catch (error) { $('postList').innerHTML = `<p class="status alert-error">${esc(errorMessage(error, 'Não foi possível carregar os guias agora.'))}</p>`; }
}

// ---------- editor ----------
const FIELDS = { fTitle: 'title', fHighlight: 'titleHighlight', fSummary: 'summary', fLede: 'lede', fDestination: 'destination', fCta: 'ctaTitle', fCoverAlt: 'coverAlt', fSlug: 'slug' };

function emptyPost() {
  return { id: null, status: 'draft', slug: '', title: '', titleHighlight: '', summary: '', lede: '', destination: '', ctaTitle: '', regionId: regions[0]?.id || '', coverUrl: '', coverUrlSmall: '', coverAlt: '', featured: false, body: [NEW_BLOCK.p()] };
}
function fillRegions() {
  const select = $('fRegion');
  select.innerHTML = regions.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('') + '<option value="__nova">+ Nova região…</option>';
  select.value = post.regionId || regions[0]?.id || '';
}
function renderCover() {
  const box = $('coverBox');
  const img = post.coverUrlSmall || post.coverUrl;
  box.innerHTML = img ? `<img src="${esc(img)}" alt="">` : '<span>Nenhuma foto escolhida</span>';
  $('coverBtn').textContent = img ? 'Trocar foto de capa' : 'Escolher foto de capa';
}
function updateStatusUi() {
  const publicado = post.status === 'published';
  $('statusTag').textContent = publicado ? 'Publicado' : 'Rascunho';
  $('statusTag').className = `tag ${publicado ? 'tag-paid' : 'tag-pending'}`;
  $('publishBtn').textContent = publicado ? 'Salvar e atualizar no site' : 'Publicar';
  $('saveBtn').classList.toggle('hidden', publicado);
  $('unpublishBtn').classList.toggle('hidden', !publicado);
  $('deleteBtn').classList.toggle('hidden', !post.id);
  $('editorTitle').textContent = post.title || 'Novo guia';
  $('publishedLink').innerHTML = publicado && post.slug ? `No ar em <a href="/blog/${esc(post.slug)}" target="_blank" rel="noopener">rotacertapassagens.com/blog/${esc(post.slug)}</a>` : '';
}
function fillForm() {
  for (const [id, field] of Object.entries(FIELDS)) $(id).value = post[field] || '';
  $('fFeatured').checked = Boolean(post.featured);
  fillRegions();
  renderCover();
  updateStatusUi();
}

function blockHtml(b, i) {
  const tools = `<div class="ab-block-tools">
      <button type="button" class="ab-tool" data-act="up" data-i="${i}" aria-label="Subir bloco" title="Subir">↑</button>
      <button type="button" class="ab-tool" data-act="down" data-i="${i}" aria-label="Descer bloco" title="Descer">↓</button>
      <button type="button" class="ab-tool" data-act="remove" data-i="${i}" aria-label="Remover bloco" title="Remover">✕</button>
    </div>`;
  const head = `<div class="ab-block-head"><span class="ab-block-type">${TYPES[b.t]}</span>${tools}</div>`;
  const fmt = `<div class="ab-format"><button type="button" data-fmt="bold" data-i="${i}">Negrito</button><button type="button" data-fmt="link" data-i="${i}">Link</button></div>`;
  const lines = (items) => esc((items || []).join('\n'));
  switch (b.t) {
    case 'p': return `<div class="ab-block" data-type="p">${head}<label>Texto do parágrafo<textarea data-i="${i}" data-field="text" rows="5" maxlength="5000" placeholder="Escreva o parágrafo...">${esc(b.text)}</textarea></label>${fmt}</div>`;
    case 'h': return `<div class="ab-block" data-type="h">${head}<div class="ab-row">
        <label>Rótulo <small>opcional, ex.: Dia 1 ou 01</small><input data-i="${i}" data-field="label" maxlength="40" value="${esc(b.label || '')}"></label>
        <label>Título da seção<input data-i="${i}" data-field="text" maxlength="160" value="${esc(b.text)}"></label></div></div>`;
    case 'ul': return `<div class="ab-block" data-type="ul">${head}<label>Itens da lista <small>um item por linha</small><textarea data-i="${i}" data-field="items" rows="5" placeholder="Primeiro item&#10;Segundo item">${lines(b.items)}</textarea></label>${fmt}</div>`;
    case 'tip': return `<div class="ab-block" data-type="tip">${head}
        <label>Título da caixa<input data-i="${i}" data-field="title" maxlength="80" value="${esc(b.title ?? 'Dicas práticas')}"></label>
        <label>Dicas <small>uma dica por linha</small><textarea data-i="${i}" data-field="items" rows="6" placeholder="**Quando ir:** primavera e outono.&#10;**Transporte:** ...">${lines(b.items)}</textarea></label>${fmt}</div>`;
    case 'img': return `<div class="ab-block" data-type="img">${head}<div class="ab-img-box">
        <div class="ab-img-preview">${b.small || b.src ? `<img src="${esc(b.small || b.src)}" alt="">` : 'Nenhuma foto escolhida'}</div>
        <div>
          <p><button type="button" class="btn-secondary" data-act="photo" data-i="${i}">${b.src ? 'Trocar foto' : 'Escolher foto'}</button></p>
          <label>Legenda <small>opcional, aparece embaixo da foto</small><input data-i="${i}" data-field="caption" maxlength="300" value="${esc(b.caption || '')}"></label>
          <label>Descrição da foto <small>o que aparece nela</small><input data-i="${i}" data-field="alt" maxlength="200" value="${esc(b.alt || '')}"></label>
        </div></div></div>`;
    case 'quote': return `<div class="ab-block" data-type="quote">${head}<label>Citação<textarea data-i="${i}" data-field="text" rows="3" maxlength="1000">${esc(b.text)}</textarea></label></div>`;
    default: return '';
  }
}
function renderBlocks(focusIndex) {
  const box = $('blocks');
  box.innerHTML = post.body.length ? post.body.map(blockHtml).join('') : '<div class="ab-empty">O conteúdo está vazio. Use os botões abaixo para adicionar parágrafos, títulos, listas, dicas e fotos.</div>';
  if (focusIndex !== undefined) box.querySelector(`[data-i="${focusIndex}"][data-field]`)?.focus();
}

async function openEditor(id) {
  showView('editor');
  setStatus('');
  try {
    if (!regions.length) await loadList();
    if (id) {
      setBusy(true);
      const data = await api(`/api/admin/blog/posts/${id}`);
      const p = data.post;
      post = { ...emptyPost(), ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v ?? ''])), featured: Boolean(p.featured), body: p.body || [] };
    } else {
      post = emptyPost();
    }
  } catch (error) {
    setStatus(errorMessage(error, 'Não foi possível abrir este guia.'), 'error');
    post = emptyPost();
  } finally { setBusy(false); }
  fillForm();
  renderBlocks();
  setDirty(false);
}

function cleanBody() {
  return post.body.map((b) => {
    if (b.t === 'ul' || b.t === 'tip') return { ...b, items: (b.items || []).map((x) => x.trim()).filter(Boolean) };
    return b;
  }).filter((b) => {
    if (b.t === 'p' || b.t === 'quote') return b.text?.trim();
    if (b.t === 'h') return b.text?.trim();
    if (b.t === 'ul' || b.t === 'tip') return b.items.length;
    if (b.t === 'img') return b.src;
    return false;
  }).map((b) => {
    const out = { ...b };
    for (const key of ['label', 'alt', 'caption', 'small', 'title']) if (out[key] === '') delete out[key];
    return out;
  });
}
function payload() {
  return {
    title: post.title, titleHighlight: post.titleHighlight, summary: post.summary, lede: post.lede, destination: post.destination, ctaTitle: post.ctaTitle,
    regionId: post.regionId, slug: post.slug, coverUrl: post.coverUrl || null, coverUrlSmall: post.coverUrlSmall || null, coverAlt: post.coverAlt,
    featured: Boolean(post.featured), body: cleanBody(),
  };
}
function localProblem() {
  if ((post.title || '').trim().length < 3) return 'Escreva o título do guia (pelo menos 3 letras).';
  if ((post.summary || '').trim().length < 10) return 'Escreva o resumo (pelo menos 10 letras). Ele aparece nos cartões e no Google.';
  if (!post.regionId || post.regionId === '__nova') return 'Escolha a região do guia.';
  return null;
}
async function save() {
  const problem = localProblem();
  if (problem) { setStatus(problem, 'error'); return false; }
  setBusy(true);
  setStatus('Salvando...');
  try {
    if (!post.id) {
      const created = await api('/api/admin/blog/posts', { method: 'POST', body: JSON.stringify(payload()) });
      post.id = created.id; post.slug = created.slug;
      history.replaceState(null, '', `#/editar/${created.id}`);
      currentHash = location.hash;
    } else {
      const updated = await api(`/api/admin/blog/posts/${post.id}`, { method: 'PUT', body: JSON.stringify(payload()) });
      post.slug = updated.slug;
    }
    $('fSlug').value = post.slug;
    setDirty(false);
    updateStatusUi();
    setStatus(post.status === 'published' ? 'Alterações salvas e já no ar.' : 'Rascunho salvo.', 'success');
    return true;
  } catch (error) {
    setStatus(errorMessage(error, 'Não foi possível salvar agora. Tente de novo.'), 'error');
    return false;
  } finally { setBusy(false); }
}
async function publish() {
  if (post.status === 'published') { await save(); return; }
  if (!(await save())) return;
  setBusy(true);
  try {
    await api(`/api/admin/blog/posts/${post.id}/publish`, { method: 'POST' });
    post.status = 'published';
    updateStatusUi();
    setStatus('Guia publicado! Ele já aparece em rotacertapassagens.com/blog.', 'success');
  } catch (error) {
    if (error.message === 'incomplete') {
      const falta = (error.body?.missing || []).map((m) => (m === 'coverUrl' ? 'a foto de capa' : m === 'body' ? 'o conteúdo' : m));
      setStatus(`Para publicar, falta: ${falta.join(' e ')}.`, 'error');
    } else setStatus(errorMessage(error, 'Não foi possível publicar agora.'), 'error');
  } finally { setBusy(false); }
}
async function unpublish() {
  if (!confirm('Tirar este guia do ar? Ele volta a ser rascunho e some do blog.')) return;
  setBusy(true);
  try {
    await api(`/api/admin/blog/posts/${post.id}/unpublish`, { method: 'POST' });
    post.status = 'draft';
    updateStatusUi();
    setStatus('Guia tirado do ar. Ele continua salvo como rascunho.', 'success');
  } catch (error) { setStatus(errorMessage(error, 'Não foi possível tirar do ar agora.'), 'error'); } finally { setBusy(false); }
}
async function remove() {
  if (!confirm('Excluir este guia para sempre? Isso não pode ser desfeito.')) return;
  setBusy(true);
  try {
    await api(`/api/admin/blog/posts/${post.id}`, { method: 'DELETE' });
    setDirty(false);
    location.hash = '#/';
  } catch (error) { setStatus(errorMessage(error, 'Não foi possível excluir agora.'), 'error'); } finally { setBusy(false); }
}
async function preview() {
  const win = window.open('about:blank', '_blank');
  if (dirty || !post.id) {
    if (!(await save())) { win?.close(); return; }
  }
  const url = `/blog/preview/${post.id}`;
  if (win) win.location.href = url; else location.href = url;
}

function wrapSelection(textarea, kind) {
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  const selected = value.slice(s, e);
  if (kind === 'bold') {
    textarea.setRangeText(`**${selected || 'texto em negrito'}**`, s, e, 'end');
  } else {
    const url = prompt('Endereço do link (comece com https://):', 'https://');
    if (!url) return;
    if (!/^(https?:\/\/|\/|mailto:)/i.test(url.trim())) { alert('O link precisa começar com https://, http:// ou /.'); return; }
    textarea.setRangeText(`[${selected || 'texto do link'}](${url.trim()})`, s, e, 'end');
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

// ---------- eventos ----------
for (const [id, field] of Object.entries(FIELDS)) {
  $(id).addEventListener('input', () => {
    post[field] = $(id).value;
    if (field === 'title') $('editorTitle').textContent = post.title || 'Novo guia';
    setDirty(true);
  });
}
$('fFeatured').addEventListener('change', () => { post.featured = $('fFeatured').checked; setDirty(true); });
$('fRegion').addEventListener('change', async () => {
  const select = $('fRegion');
  if (select.value !== '__nova') { post.regionId = select.value; setDirty(true); return; }
  const name = (prompt('Nome da nova região (ex.: Ásia, Américas, África):') || '').trim();
  if (!name) { select.value = post.regionId; return; }
  try {
    const data = await api('/api/admin/blog/regions', { method: 'POST', body: JSON.stringify({ name }) });
    if (!regions.some((r) => r.id === data.region.id)) regions.push(data.region);
    post.regionId = data.region.id;
    fillRegions();
    setDirty(true);
    setStatus(`Região "${data.region.name}" criada. Ela vira filtro no blog quando tiver um guia publicado.`, 'success');
  } catch (error) {
    select.value = post.regionId;
    setStatus(errorMessage(error, 'Não foi possível criar a região. Use um nome de 2 a 40 letras.'), 'error');
  }
});
$('coverBtn').addEventListener('click', async () => {
  const file = await escolherFoto();
  if (!file) return;
  $('coverBox').classList.add('is-loading');
  setStatus('Enviando a foto de capa...');
  setBusy(true);
  try {
    const foto = await enviarFoto(file);
    post.coverUrl = foto.src; post.coverUrlSmall = foto.small;
    renderCover();
    setDirty(true);
    setStatus('Foto de capa enviada. Não esqueça de salvar.', 'success');
  } catch (error) { setStatus(errorMessage(error, 'Não foi possível enviar a foto agora.'), 'error'); }
  finally { $('coverBox').classList.remove('is-loading'); setBusy(false); }
});

$('blocks').addEventListener('input', (event) => {
  const el = event.target.closest('[data-field]');
  if (!el) return;
  const b = post.body[Number(el.dataset.i)];
  if (!b) return;
  b[el.dataset.field] = el.dataset.field === 'items' ? el.value.split('\n') : el.value;
  setDirty(true);
});
$('blocks').addEventListener('click', async (event) => {
  const fmt = event.target.closest('[data-fmt]');
  if (fmt) { const area = fmt.closest('.ab-block').querySelector('textarea'); if (area) wrapSelection(area, fmt.dataset.fmt); return; }
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const act = btn.dataset.act;
  if (act === 'up' && i > 0) { [post.body[i - 1], post.body[i]] = [post.body[i], post.body[i - 1]]; renderBlocks(); setDirty(true); }
  if (act === 'down' && i < post.body.length - 1) { [post.body[i + 1], post.body[i]] = [post.body[i], post.body[i + 1]]; renderBlocks(); setDirty(true); }
  if (act === 'remove') {
    const b = post.body[i];
    const vazio = (b.t === 'img' && !b.src) || ((b.t === 'p' || b.t === 'quote' || b.t === 'h') && !b.text?.trim()) || ((b.t === 'ul' || b.t === 'tip') && !(b.items || []).join('').trim());
    if (!vazio && !confirm(`Remover este bloco (${TYPES[b.t]})?`)) return;
    post.body.splice(i, 1); renderBlocks(); setDirty(true);
  }
  if (act === 'photo') {
    const file = await escolherFoto();
    if (!file) return;
    setStatus('Enviando a foto...');
    setBusy(true);
    try {
      const foto = await enviarFoto(file);
      Object.assign(post.body[i], { src: foto.src, small: foto.small, w: foto.w, h: foto.h });
      renderBlocks();
      setDirty(true);
      setStatus('Foto enviada. Não esqueça de salvar.', 'success');
    } catch (error) { setStatus(errorMessage(error, 'Não foi possível enviar a foto agora.'), 'error'); } finally { setBusy(false); }
  }
});
document.querySelector('.ab-add').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-add]');
  if (!btn) return;
  post.body.push(NEW_BLOCK[btn.dataset.add]());
  const index = post.body.length - 1;
  renderBlocks(index);
  setDirty(true);
  if (btn.dataset.add === 'img') $('blocks').querySelector(`[data-act="photo"][data-i="${index}"]`)?.click();
});
$('saveBtn').addEventListener('click', save);
$('publishBtn').addEventListener('click', publish);
$('unpublishBtn').addEventListener('click', unpublish);
$('deleteBtn').addEventListener('click', remove);
$('previewBtn').addEventListener('click', preview);
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

function route() {
  const hash = location.hash || '#/';
  currentHash = hash;
  if (hash === '#/novo') return openEditor(null);
  const match = hash.match(/^#\/editar\/([0-9a-f-]{36})$/);
  if (match) return openEditor(match[1]);
  return showList();
}
window.addEventListener('hashchange', () => {
  if (dirty && !confirm('Há alterações não salvas neste guia. Sair mesmo assim?')) { history.replaceState(null, '', currentHash); return; }
  setDirty(false);
  route();
});

(async function init() {
  try {
    const session = await api('/api/auth/session');
    if (!session.user?.roles?.includes('master')) throw Object.assign(new Error('forbidden'), { status: 403 });
    $('accessMessage').classList.add('hidden');
    $('blogApp').classList.remove('hidden');
    await loadList();
    route();
  } catch (error) {
    $('accessText').textContent = error.status === 403 ? 'Esta área é só para usuários master.' : 'Entre primeiro pela Área do cliente com uma conta master e depois volte para esta página.';
    $('accessLogin').classList.remove('hidden');
  }
})();
