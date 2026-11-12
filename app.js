'use strict';
/* Office of the Head of State — a NationStates advisor dashboard.
   Everything is stored in this browser (localStorage). Nothing is sent anywhere
   except NationStates (to read data) and Google Gemini (for the advisors). */

const LS_KEY = 'nsadv.v1';
const DEFAULT_ADVISORS = [
  { role: 'Minister of Defense', persona: 'Blunt career officer. Force posture, readiness, logistics, military risk.' },
  { role: 'Foreign Minister', persona: 'Careful diplomat. Alliances, regional politics, treaties, how other players will react.' },
  { role: 'Intelligence Chief', persona: 'Skeptical analyst. Separates confirmed facts from claims, flags deception and unknowns.' },
  { role: 'Minister of the Economy', persona: 'Pragmatic economist. Budgets, trade, sanctions, domestic stability.' }
];
const TYPE_LABEL = { nation: 'NATION', region: 'REGION', thread: 'RP', paste: 'INTEL' };
const MAX_RAW = 400, MAX_SEEN = 3000, MAX_EVENTS = 300, CHUNK_CHARS = 120000;

/* ---------- state ---------- */
let state = load();
const busy = new Set();

function fresh() {
  return {
    settings: { nation: '', geminiKey: '', model: '', proxy: '', lore: '', advisors: DEFAULT_ADVISORS.map(a => ({ ...a })) },
    sources: [],
    overview: { briefs: [], options: [], chat: [] },
    selected: 'overview',
    workspaces: [], activeWs: null
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.settings) {
      const f = fresh();
      return migrateWs({ ...f, ...s, settings: { ...f.settings, ...s.settings }, overview: { ...f.overview, ...(s.overview || {}) } });
    }
  } catch (e) { /* fall through */ }
  return migrateWs(fresh());
}
/* Workspaces: one per nation or RP campaign. The active workspace's data lives at the top level of
   state (settings.nation/lore/advisors, sources, overview, selected, banner); the others are parked
   in state.workspaces[i].data. The Gemini key, model, proxy, factbooks and census are shared. */
function migrateWs(st) {
  if (!Array.isArray(st.workspaces) || !st.workspaces.length) {
    const id = Math.random().toString(36).slice(2, 10);
    st.workspaces = [{ id, name: st.settings.nation || 'My nation', data: null }];
    st.activeWs = id;
  }
  if (!st.workspaces.some(w => w.id === st.activeWs)) st.activeWs = st.workspaces[0].id;
  return st;
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch (e) { toast('This browser’s storage is full. Close an old file or clear its raw intel.'); }
}

const activeWs = () => state.workspaces.find(w => w.id === state.activeWs);
function packActive() {
  return {
    nation: state.settings.nation, lore: state.settings.lore, advisors: state.settings.advisors,
    sources: state.sources, overview: state.overview, selected: state.selected, banner: state.banner || null
  };
}
function unpack(d) {
  const f = fresh();
  state.settings.nation = d.nation || '';
  state.settings.lore = d.lore || '';
  state.settings.advisors = d.advisors?.length ? d.advisors : DEFAULT_ADVISORS.map(a => ({ ...a }));
  state.sources = d.sources || [];
  state.overview = { ...f.overview, ...(d.overview || {}) };
  state.selected = d.selected || 'overview';
  state.banner = d.banner || null;
}
function switchWs(id) {
  if (id === state.activeWs) return;
  const from = activeWs(), to = state.workspaces.find(w => w.id === id);
  if (!to) return;
  from.data = packActive();
  unpack(to.data || {});
  to.data = null;
  state.activeWs = id;
  uiPaste = null; uiDraft = null; uiStance = ''; openRanks.clear();
  save(); render(); loadBanner(false);
}
function createWs(name, nation) {
  const id = uid();
  state.workspaces.push({ id, name: name || nation || 'New workspace', data: { nation, lore: '', advisors: DEFAULT_ADVISORS.map(a => ({ ...a })), sources: [], selected: 'overview' } });
  switchWs(id);
}
function deleteWs(id) {
  if (state.workspaces.length < 2) { toast('You need at least one workspace.'); return; }
  const w = state.workspaces.find(x => x.id === id);
  if (!w || !confirm(`Delete the workspace “${w.name}” and all its files? This can’t be undone.`)) return;
  if (id === state.activeWs) switchWs(state.workspaces.find(x => x.id !== id).id);
  state.workspaces = state.workspaces.filter(x => x.id !== id);
  save(); renderWsMenu();
}
function wsInfo(w) {
  const d = w.id === state.activeWs ? packActive() : (w.data || {});
  return { flag: d.banner?.flag || '', nation: d.banner?.name || d.nation || '', files: (d.sources || []).length };
}
function renderWsMenu() {
  $('#wsList').innerHTML = state.workspaces.map(w => {
    const i = wsInfo(w), on = w.id === state.activeWs;
    return `<li><button class="ws-item ${on ? 'on' : ''}" data-ws="${w.id}" aria-current="${on}">
      ${i.flag ? `<img src="${esc(i.flag)}" alt="" class="ws-flag">` : '<span class="ws-flag blank" aria-hidden="true"></span>'}
      <span class="ws-text"><b>${esc(w.name)}</b><span>${esc(i.nation || 'No nation set')} · ${i.files} file${i.files === 1 ? '' : 's'}</span></span>
    </button></li>`;
  }).join('');
}

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');
const pretty = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function cleanNS(t) {
  return String(t || '')
    .replace(/@@([^@]+)@@/g, (_, n) => pretty(n))
    .replace(/%%([^%]+)%%/g, (_, n) => pretty(n))
    .replace(/\[\/?(b|i|u|s|color|size|spoiler|url|nation|region|quote|list|\*|hr|align|font|proposal|resolution)(=[^\]]*)?\]/gi, '')
    .trim();
}
let toastTimer;
function toast(msg, ms = 5000) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const current = () => state.sources.find(s => s.id === state.selected) || null;

/* ---------- network ---------- */
async function getText(url) {
  // Try directly first; fall back to the user's proxy if the browser blocks it (CORS).
  try {
    const r = await fetch(url);
    if (r.ok) return await r.text();
    throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  } catch (e) {
    const proxy = state.settings.proxy.trim();
    if (e.status && e.status !== 0 && !(e instanceof TypeError)) throw e;
    if (!proxy) throw Object.assign(new Error('blocked'), { blocked: true });
    const r = await fetch(proxy + encodeURIComponent(url));
    if (!r.ok) throw new Error('Proxy returned ' + r.status);
    return await r.text();
  }
}

let nsLast = 0;
async function nsApi(params) {
  const wait = Math.max(0, nsLast + 800 - Date.now()); // stay well under 50 requests / 30 s
  if (wait) await sleep(wait);
  nsLast = Date.now();
  const p = new URLSearchParams({ ...params, script: 'NS Advisor web app, run by ' + (state.settings.nation || 'unknown') });
  let txt;
  try { txt = await getText('https://www.nationstates.net/cgi-bin/api.cgi?' + p.toString()); }
  catch (e) {
    if (e.status === 404) throw new Error('NationStates couldn’t find that name.');
    if (e.status === 429) throw new Error('NationStates rate limit hit. Wait 30 seconds and try again.');
    if (e.blocked) throw new Error('Your browser blocked the NationStates request. Add a proxy in Settings.');
    throw e;
  }
  return new DOMParser().parseFromString(txt, 'text/xml');
}
const xt = (node, sel) => node.querySelector(sel)?.textContent ?? '';

/* ---------- pulling each kind of file ---------- */
async function pullNation(src) {
  const x = await nsApi({ nation: slug(src.target), q: 'fullname category region motto population happenings' });
  if (!x.querySelector('NATION')) throw new Error('NationStates couldn’t find that nation.');
  src.profile = `${xt(x, 'FULLNAME')} — ${xt(x, 'CATEGORY')}. Region: ${xt(x, 'REGION')}. Motto: “${xt(x, 'MOTTO')}”. Population: ${Number(xt(x, 'POPULATION')).toLocaleString()} million.`;
  return [...x.querySelectorAll('HAPPENINGS > EVENT')].map(e => {
    const time = +xt(e, 'TIMESTAMP') * 1000, text = cleanNS(xt(e, 'TEXT'));
    return { id: 'h' + (e.getAttribute('id') || time + text.slice(0, 30)), time, author: 'NationStates', text };
  });
}

async function pullRegion(src) {
  const x = await nsApi({ region: slug(src.target), q: 'name delegate numnations happenings messages', limit: 100 });
  if (!x.querySelector('REGION')) throw new Error('NationStates couldn’t find that region.');
  src.profile = `Region ${xt(x, 'NAME')}: ${xt(x, 'NUMNATIONS')} nations, WA delegate ${['', '0'].includes(xt(x, 'DELEGATE')) ? 'none' : pretty(xt(x, 'DELEGATE'))}.`;
  const posts = [...x.querySelectorAll('MESSAGES > POST')]
    .filter(p => !['2', '9'].includes(xt(p, 'STATUS')))
    .map(p => ({ id: 'm' + p.getAttribute('id'), time: +xt(p, 'TIMESTAMP') * 1000, author: pretty(xt(p, 'NATION')), text: cleanNS(xt(p, 'MESSAGE')) }));
  const haps = [...x.querySelectorAll('HAPPENINGS > EVENT')].map(e => {
    const time = +xt(e, 'TIMESTAMP') * 1000, text = cleanNS(xt(e, 'TEXT'));
    return { id: 'h' + (e.getAttribute('id') || time + text.slice(0, 30)), time, author: 'NationStates', text };
  });
  return [...posts, ...haps];
}

function threadUrl(src, start) {
  return `https://forum.nationstates.net/viewtopic.php?t=${src.topic}&start=${start}`;
}
// The NS forum shows post times like "» Fri Oct 16, 2026 8:14 pm" (board time, UTC for visitors).
function forumDate(text) {
  const m = String(text || '').match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (am|pm)/i);
  if (!m) return 0;
  const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3;
  let h = +m[4] % 12; if (/pm/i.test(m[6])) h += 12;
  return mon < 0 ? 0 : Date.UTC(+m[3], mon, +m[2], h, +m[5]);
}
function parseForum(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('h2.topic-title, h2 a, h3.first a')?.textContent?.trim() || '';
  const posts = [...doc.querySelectorAll('div.post')].map(el => {
    const content = el.querySelector('.content');
    if (!content) return null;
    content.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    content.querySelectorAll('blockquote').forEach(q => { q.textContent = '\n[quoting] ' + q.textContent.trim().slice(0, 300) + '\n'; });
    const author = (el.querySelector('.author .username, .author .username-coloured, .author strong, a.username, a.username-coloured')?.textContent || 'Unknown').trim();
    const dt = el.querySelector('.author time')?.getAttribute('datetime');
    return { id: 'p' + (el.id || '').replace(/\D/g, ''), time: dt ? Date.parse(dt) : forumDate(el.querySelector('.author')?.textContent), author, text: content.textContent.replace(/\n{3,}/g, '\n\n').trim() };
  }).filter(p => p && p.id !== 'p');
  return { title, posts };
}
async function pullThread(src) {
  if (!src.topic) {
    const u = new URL(src.target);
    src.topic = u.searchParams.get('t');
    if (!src.topic) {
      // A post link (?p=123): open it once and find the topic id.
      const html = await getText(src.target).catch(e => { throw e.blocked ? new Error('Reading the forum needs a proxy. Add one in Settings (see README).') : e; });
      const m = html.match(/viewtopic\.php\?[^"']*\bt=(\d+)/);
      if (!m) throw new Error('Couldn’t find the thread in that link. Use a link with t= in it.');
      src.topic = m[1];
    }
  }
  const out = [];
  let start = src.pageStart || 0, perPage = 0;
  for (let i = 0; i < 12; i++) {
    let html;
    try { html = await getText(threadUrl(src, start)); }
    catch (e) { throw e.blocked ? new Error('Reading the forum needs a proxy. Add one in Settings (see README).') : e; }
    const { title, posts } = parseForum(html);
    if (title && !src.threadTitle) src.threadTitle = title;
    if (!posts.length) break;
    out.push(...posts);
    perPage = perPage || posts.length;
    src.pageStart = start;
    if (posts.length < perPage) break;
    const next = start + perPage;
    if (i === 11) { toast('Long thread: read 12 pages. Request again to keep reading.'); break; }
    start = next;
    await sleep(600);
  }
  src.profile = src.threadTitle ? `Forum thread: ${src.threadTitle}` : 'Forum RP thread';
  return out;
}

async function syncSource(src) {
  if (src.type === 'paste') return 0;
  const items = src.type === 'nation' ? await pullNation(src) : src.type === 'region' ? await pullRegion(src) : await pullThread(src);
  const seen = new Set(src.seen);
  const fresh = items.filter(i => i.id && !seen.has(i.id)).sort((a, b) => a.time - b.time);
  fresh.forEach(i => { i.analyzed = false; src.raw.push(i); src.seen.push(i.id); });
  src.raw = src.raw.slice(-MAX_RAW);
  src.seen = src.seen.slice(-MAX_SEEN);
  src.lastSync = Date.now();
  return fresh.length;
}

/* ---------- Gemini ---------- */
async function fetchModels(key) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gemini: ' + (data.error?.message || r.status));
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name) && !/(image|tts|audio|live|embedding|vision)/i.test(m.name))
    .map(m => m.name.replace(/^models\//, ''));
}

async function gemini(prompt, retried) {
  const key = state.settings.geminiKey.trim();
  if (!key) throw new Error('Add your Gemini API key in Settings first.');
  if (!state.settings.model) {
    state.settings.model = pickDefaultModel(await fetchModels(key)); save();
  }
  try { return await geminiCall(key, state.settings.model.replace(/^models\//, ''), prompt); }
  catch (e) {
    // Google retires models over time. If ours is gone, switch to the newest flash model and retry once.
    if (retried || !e.modelGone) throw e;
    const models = await fetchModels(key);
    const suggested = (e.message.match(/models\/(gemini-[\w.-]+)/g) || []).map(s => s.replace('models/', '')).find(m => m !== state.settings.model && models.includes(m));
    const next = suggested || pickDefaultModel(models);
    if (!next || next === state.settings.model) throw e;
    state.settings.model = next; save();
    toast('Switched advisors to ' + next + ' (the old model was retired).');
    return gemini(prompt, true);
  }
}

async function geminiCall(key, model, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.6 }
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error?.message || String(r.status);
    throw Object.assign(new Error('Gemini: ' + msg), { modelGone: r.status === 404 || /no longer available|not found|deprecated|not supported for generateContent/i.test(msg) });
  }
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned nothing (it may have blocked the content). Try again.');
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch (e) { throw new Error('Gemini’s answer wasn’t readable. Try again.'); }
}

async function listModels() {
  const key = state.settings.geminiKey.trim() || $('#sKey').value.trim();
  if (!key) { toast('Enter your Gemini key first.'); return; }
  let models;
  try { models = await fetchModels(key); } catch (e) { toast(e.message, 8000); return; }
  const cur = $('#sModel').value;
  fillModelSelect(models, models.includes(cur) ? cur : pickDefaultModel(models));
  toast(models.length + ' models loaded. Newest flash model selected; press Save.');
}
function pickDefaultModel(models) {
  const flash = models.filter(m => /^gemini-[\d.]+-flash$/.test(m)).sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]));
  return flash[0] || models.find(m => /flash/.test(m) && !/lite|preview|exp/.test(m)) || models.find(m => /flash/.test(m)) || models[0] || '';
}
function fillModelSelect(models, selected) {
  const list = [...new Set([selected, ...models].filter(Boolean))];
  $('#sModel').innerHTML = list.map(m => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

/* ---------- prompts ---------- */
function councilBlock() {
  const s = state.settings;
  return `You are the advisory council of the nation "${s.nation || 'our nation'}" in NationStates, an online nation-simulation game where players also write collaborative roleplay (RP). The user is the nation's head of state.
Treat RP posts as real in-world events. Never invent events, numbers or claims that are not in the material. Separate what is confirmed from what is only claimed. Out-of-character (OOC) chatter is not an in-world event.

Council members:
${s.advisors.map(a => `- ${a.role}: ${a.persona}`).join('\n')}

What the leader wants you to always know about the nation (notes, lore, past chats):
${s.lore.trim().slice(0, 12000) || '(nothing given)'}
${profileText(s.nation, 'OUR NATION\u2019S DOSSIER (match its culture, institutions and tone in all advice)')}`;
}
const eventLine = e => `- ${e.title} (${e.tag}; ${e.actor}): ${e.detail}`;

const ASSESS_SHAPE = '{"threat":"low | elevated | high | critical","headline":"the situation in at most 12 words","points":["3 to 5 key points, each at most 12 words"],"watch":["2 or 3 things to watch next, each at most 10 words"]}';
function cleanAssessment(a) {
  if (!a || typeof a !== 'object') return null;
  const list = (x, n) => (Array.isArray(x) ? x : []).map(String).filter(Boolean).slice(0, n);
  return {
    threat: ['low', 'elevated', 'high', 'critical'].includes(String(a.threat).toLowerCase()) ? String(a.threat).toLowerCase() : 'elevated',
    headline: String(a.headline || ''), points: list(a.points, 5), watch: list(a.watch, 3), at: Date.now()
  };
}
async function assessOnly(src) {
  const out = await gemini(`${councilBlock()}

${src ? sourceContext(src, { noFactbooks: true }) : overviewContext()}

Write the leader's at-a-glance assessment${src ? ' of this case' : ' across every file'}. Be terse: short phrases, no full paragraphs.
Reply with JSON only: {"assessment":${ASSESS_SHAPE},"briefs":[{"role":"council role exactly as written above","brief":"one or two sentences, at most 30 words, in character"}],"options":["3 or 4 courses of action, 2-5 words each"]}`);
  const holder = src || state.overview;
  holder.assessment = cleanAssessment(out.assessment);
  if (Array.isArray(out.briefs) && out.briefs.length) holder.briefs = out.briefs.map(b => ({ role: String(b.role), brief: String(b.brief) }));
  if (Array.isArray(out.options) && out.options.length) holder.options = out.options.map(String).slice(0, 4);
}

function analysisPrompt(src, items) {
  return `${councilBlock()}

CASE FILE: "${src.name}" (${TYPE_LABEL[src.type]})
${src.profile ? 'Context: ' + src.profile + '\n' : ''}
Story so far (your running summary):
${src.summary || '(Nothing yet: this is the first report on this file.)'}

Most recent events already logged:
${src.events.slice(-10).map(eventLine).join('\n') || '(none)'}

NEW MATERIAL, oldest first:
${items.map(i => `[${i.time ? new Date(i.time).toISOString().slice(0, 16).replace('T', ' ') : 'pasted'}] ${i.author}: ${i.text}`).join('\n\n')}

Current military standings in this case (update these):
${militaryLines(src)}

Reply with JSON only, in exactly this shape:
{"military":[${MILITARY_SHAPE}],
"assessment":${ASSESS_SHAPE},
"events":[{"title":"headline, at most 10 words","detail":"one sentence, at most 25 words: what happened and why it matters to us","actor":"who did it","tag":"Escalation | Diplomacy | Intel | Military | Economy | Domestic | Ultimatum | Other"}],
"summary":"updated running summary of the whole case so far, at most 200 words; keep names, numbers, deadlines and open threats (this is your memory, the leader rarely reads it)",
"briefs":[{"role":"one of the council roles exactly as written above","brief":"one or two sentences, at most 30 words, in character, addressed to the leader"}],
"options":["3 or 4 possible courses of action, 2-5 words each"]}
The leader does not want to read long text: keep the assessment, events and briefs short and concrete. Break the new material into the distinct things that happened, in order. Merge repetitive chatter. If nothing of substance happened, return an empty events list but still update the assessment and briefs. Every council member gives a brief.
${militaryRules()}`;
}

const MILITARY_SHAPE = '{"nation":"nation name as used in the RP","strength":0-100,"assets":"key forces in under 12 words","trend":"up | down | steady","note":"one short sentence: why"}';
const STRENGTH_SCALE = 'Use one absolute 0-100 scale for everyone: 10 = token defense force, 30 = small but capable military, 50 = solid regional power, 70 = major power, 85 = great power, 95+ = superpower.';
const MILITARY_RULES = `Military standings: list every nation that is an actor in this case, including "${'${us}'}" (our nation). ${STRENGTH_SCALE}
Nations marked [FACTBOOK] are rated from their published factbook by a separate process: list them, but copy their strength unchanged.
Rate every other nation only from what the RP, the summary and the context say: posted force sizes, deployments, losses, alliances that commit troops. Keep a nation's previous strength when there is no new information. If a nation's forces are unknown, give your best estimate and say so in the note.`;

/* Ratings for nations with a factbook come only from the factbook. */
function fbSig(k) { return (state.factbooks?.[k] || []).filter(f => f.text).map(f => f.url + ':' + f.text.length).join('|'); }
function fbScore(nation) {
  const k = slug(nation), s = state.fbScores?.[k];
  return s && s.sig && s.sig === fbSig(k) ? s : null;
}
function withFactbookScores(list) {
  return (list || []).map(m => {
    const s = fbScore(m.nation);
    if (!s) return { ...m, basis: 'rp' };
    const trend = s.prev == null || s.prev === s.strength ? 'steady' : s.strength > s.prev ? 'up' : 'down';
    return { ...m, strength: s.strength, assets: s.assets, note: s.note, trend, basis: 'factbook' };
  });
}
async function scoreFactbooks(nations, force) {
  state.fbScores = state.fbScores || {};
  const todo = [...new Set(nations.map(slug))].filter(k => fbSig(k) && (force || state.fbScores[k]?.sig !== fbSig(k)));
  // Factbooks removed or emptied: drop their rating so the RP rating takes over again.
  Object.keys(state.fbScores).forEach(k => { if (!fbSig(k)) delete state.fbScores[k]; });
  if (!todo.length || !state.settings.geminiKey) { save(); return; }
  const names = todo.map(k => nations.find(n => slug(n) === k) || pretty(k));
  const out = await gemini(`You are a military analyst for a NationStates roleplay. Rate each nation's military strength using ONLY its published factbook below, as the nation describes itself. Ignore anything else you know.
${STRENGTH_SCALE}

${factbookBlock(names)}
Reply with JSON only: {"forces":[{"nation":"name exactly as given above","strength":0-100,"assets":"key forces in under 12 words","note":"one short sentence on what the rating rests on"}]}`);
  for (const f of Array.isArray(out.forces) ? out.forces : []) {
    const k = slug(f.nation);
    if (!todo.includes(k)) continue;
    const strength = Math.max(0, Math.min(100, Math.round(Number(f.strength))));
    if (Number.isNaN(strength)) continue;
    const old = state.fbScores[k];
    state.fbScores[k] = { strength, assets: String(f.assets || ''), note: String(f.note || ''), sig: fbSig(k), at: Date.now(), prev: old ? old.strength : null };
  }
  save();
}

function militaryLines(src) {
  const m = withFactbookScores(src.military);
  return m.length ? m.map(x => `- ${x.nation}${x.basis === 'factbook' ? ' [FACTBOOK]' : ''}: ${x.strength ?? '?'} (${x.assets || 'unknown'}; trend ${x.trend || 'steady'})`).join('\n') : '(none assessed yet)';
}
function militaryRules() { return MILITARY_RULES.replace('${us}', state.settings.nation || 'our nation'); }
function cleanMilitary(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(x => ({
    nation: String(x.nation || '').trim(), strength: Math.max(0, Math.min(100, Math.round(Number(x.strength)))),
    assets: String(x.assets || ''), trend: ['up', 'down', 'steady'].includes(x.trend) ? x.trend : 'steady', note: String(x.note || '')
  })).filter(x => x.nation && !Number.isNaN(x.strength) && !seen.has(slug(x.nation)) && seen.add(slug(x.nation)));
}

async function reassessMilitary(src) {
  const nations = (src.military || []).map(m => m.nation);
  await refreshFactbooks(nations);
  await scoreFactbooks(nations, true);
  const out = await gemini(`${councilBlock()}

${sourceContext(src, { noFactbooks: true })}

Recent raw material (newest last):
${src.raw.slice(-40).map(i => `${i.author}: ${i.text.slice(0, 1500)}`).join('\n\n') || '(none)'}

Current military standings in this case (update these):
${militaryLines(src)}

${militaryRules()}
Reply with JSON only: {"military":[${MILITARY_SHAPE}]}`);
  const m = cleanMilitary(out.military);
  if (m.length) { src.military = m; src.militaryAt = Date.now(); }
}

/* Military factbooks the leader attaches to a nation (kept per nation, shared by every file) */
const cleanBB = t => String(t || '').replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, '').replace(/\[\/?[a-z*][^\]]*\]/gi, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
function dispatchId(url) {
  const m = /nationstates\.net/i.test(url) && String(url).match(/(?:\bid=|dispatchid=)(\d+)/);
  return m ? m[1] : null;
}
async function fetchDispatch(fb) {
  const x = await nsApi({ q: 'dispatch', dispatchid: fb.dispatch });
  const text = cleanBB(cleanNS(xt(x, 'TEXT')));
  if (!text) throw new Error('that dispatch is empty or doesn’t exist');
  Object.assign(fb, { title: xt(x, 'TITLE') || fb.title, text, author: pretty(xt(x, 'AUTHOR')), kind: [xt(x, 'CATEGORY'), xt(x, 'SUBCATEGORY')].filter(Boolean).join(' › '), at: Date.now() });
}
async function addFactbook(nation) {
  const raw = prompt(`Factbook link for ${nation}\n(a NationStates dispatch link, or any other link):`);
  if (!raw || !raw.trim()) return;
  let url;
  try { url = new URL(raw.trim()); if (!/^https?:$/.test(url.protocol)) throw 0; }
  catch (e) { toast('That doesn’t look like a link.'); return; }
  state.factbooks = state.factbooks || {};
  const list = state.factbooks[slug(nation)] = state.factbooks[slug(nation)] || [];
  if (list.some(f => f.url === url.href)) { toast('That factbook is already attached.'); return; }
  const fb = { url: url.href, title: '', text: '', at: Date.now(), dispatch: dispatchId(url.href) };
  if (fb.dispatch) {
    toast('Reading the factbook…', 15000);
    try { await fetchDispatch(fb); }
    catch (e) { toast('Couldn’t read that dispatch: ' + e.message, 8000); return; }
  } else {
    const t = prompt('Your advisors can’t open that site directly. Paste the factbook text here so they can read it (or leave blank to keep just the link):');
    fb.text = cleanBB(t || '');
    fb.title = url.hostname.replace(/^www\./, '');
  }
  list.push(fb); save(); renderOrbat();
  if (!fb.text) { toast(`Link saved for ${nation}. Advisors can't read it, so ${nation} stays rated from the RP.`, 8000); return; }
  busy.add('mil'); renderOrbat(); toast(`Rating ${nation} from its factbook\u2026`, 30000);
  try { await scoreFactbooks([nation], true); toast(`${nation} is now rated from its factbook.`); }
  catch (e) { toast('Factbook saved, but rating failed: ' + e.message, 8000); }
  finally { busy.delete('mil'); renderOrbat(); }
}
async function refreshFactbooks(nations) {
  for (const n of nations) for (const fb of state.factbooks?.[slug(n)] || []) {
    if (fb.dispatch && Date.now() - (fb.at || 0) > 24 * 3600e3) { try { await fetchDispatch(fb); } catch (e) { /* keep the old copy */ } }
  }
  save();
  try { await scoreFactbooks(nations); } catch (e) { /* ratings retry next time */ }
}
function factbookBlock(nations) {
  let budget = 40000;
  const parts = [];
  for (const n of nations) for (const fb of state.factbooks?.[slug(n)] || []) {
    const body = fb.text ? fb.text.slice(0, Math.min(10000, budget)) : `(link only, not readable: ${fb.url})`;
    budget -= body.length;
    parts.push(`--- ${n}: “${fb.title || 'Factbook'}”${fb.kind ? ' (' + fb.kind + ')' : ''} ---\n${body}`);
    if (budget <= 0) break;
  }
  return parts.length ? `MILITARY FACTBOOKS the nations published about themselves. These are their own claims: use them for force sizes, equipment and doctrine, but they may be exaggerated or out of date, and what actually happens in the RP overrides them.\n${parts.join('\n\n')}\n` : '';
}


/* ---------- Nation dossiers ----------
   Built by Gemini from a nation's own dispatches, attached factbooks and the leader's pasted notes.
   Kept per nation (shared by every workspace) in state.profiles[slug]. */
const PROFILE_SECTIONS = ['Government & politics', 'Culture & society', 'Economy', 'Military & doctrine', 'Foreign policy', 'RP style'];
const CAT_ORDER = { factbook: 0, account: 1, meta: 2, bulletin: 3 };
function profileText(nation, label, compact) {
  const p = state.profiles?.[slug(nation)]?.profile;
  if (!p) return '';
  const secs = (p.sections || []).filter(x => !compact || /military|foreign|rp style/i.test(x.title));
  return `${label}:
${p.tagline || ''}
${secs.map(x => `${x.title}: ${(x.points || []).join('; ')}`).join('\n')}
${compact ? '' : `Key figures: ${(p.figures || []).map(f => f.name + ' (' + f.role + ')').join(', ') || 'none listed'}
Allies: ${(p.allies || []).join(', ') || 'none listed'} | Rivals: ${(p.rivals || []).join(', ') || 'none listed'}`}
Voice in RP posts: ${p.voice || 'unknown'}
`;
}
async function buildProfile(nation, isOurs, quiet) {
  const say = (m, ms) => { if (!quiet) toast(m, ms); };
  state.profiles = state.profiles || {};
  const k = slug(nation), old = state.profiles[k] || {};
  const rec = { ...old, name: nation, notes: old.notes || '' };
  const notesAtStart = (isOurs ? state.settings.lore : rec.notes || '').trim(); // read now: the workspace may change while we fetch
  let docs = [], budget = 90000;
  // 1. The nation's own dispatches, factbooks first.
  try {
    const x = await nsApi({ nation: k, q: 'name fullname type flag motto category region dispatchlist' });
    if (x.querySelector('NATION')) {
      Object.assign(rec, { name: xt(x, 'NAME') || nation, fullname: xt(x, 'FULLNAME'), flag: xt(x, 'FLAG'), motto: xt(x, 'MOTTO'), category: xt(x, 'CATEGORY'), region: xt(x, 'REGION'), ns: true });
      const list = [...x.querySelectorAll('DISPATCHLIST > DISPATCH')].map(d => ({ id: d.getAttribute('id'), title: xt(d, 'TITLE'), cat: xt(d, 'CATEGORY'), sub: xt(d, 'SUBCATEGORY') }))
        .sort((a, b) => (CAT_ORDER[a.cat.toLowerCase()] ?? 9) - (CAT_ORDER[b.cat.toLowerCase()] ?? 9)).slice(0, 12);
      for (let i = 0; i < list.length && budget > 0; i++) {
        say(`Reading ${rec.name}’s dispatches (${i + 1} of ${list.length})…`, 20000);
        try {
          const dx = await nsApi({ q: 'dispatch', dispatchid: list[i].id });
          const text = cleanBB(cleanNS(xt(dx, 'TEXT'))).slice(0, Math.min(9000, budget));
          if (text) { docs.push({ ...list[i], text, url: 'https://www.nationstates.net/page=dispatch/id=' + list[i].id }); budget -= text.length; }
        } catch (e) { /* skip unreadable dispatch */ }
      }
    }
  } catch (e) { rec.ns = false; /* not a NationStates nation: build from factbooks and notes */ }
  // 2. Factbooks attached by the leader (non-NS links with pasted text).
  for (const f of state.factbooks?.[k] || []) {
    if (f.text && !docs.some(d => d.id && d.id === f.dispatch)) docs.push({ title: f.title || 'Factbook', cat: 'Factbook', text: f.text.slice(0, 9000), url: f.url });
  }
  const notes = notesAtStart;
  if (!docs.length && !notes) {
    state.profiles[k] = { ...rec, failedAt: Date.now() }; save();
    throw new Error(`No dispatches, factbooks or notes found for ${nation}. Paste some notes first.`);
  }
  say(`Writing ${rec.name}’s dossier…`, 30000);
  const out = await gemini(`You are an analyst building a dossier on the NationStates nation "${rec.name}"${rec.fullname ? ' (' + rec.fullname + ')' : ''} for a roleplay advisory app.
Use ONLY the material below: the nation's own published dispatches and factbooks, and notes from its player. Do not invent facts. If a section has no information, give one point saying it is unknown.
Write short bullet points, never paragraphs. Each point at most 15 words.

${notes ? `NOTES FROM THE PLAYER (may include text pasted from earlier chats):\n${notes.slice(0, 15000)}\n` : ''}
${docs.map(d => `--- ${d.cat}${d.sub ? ' › ' + d.sub : ''}: “${d.title}” ---\n${d.text}`).join('\n\n')}

Reply with JSON only:
{"tagline":"who this nation is, at most 15 words",
"sections":[${PROFILE_SECTIONS.map(t => `{"title":"${t}","points":["2 to 4 points"]}`).join(',')}],
"figures":[{"name":"person","role":"their role"}],
"allies":["nation names"],"rivals":["nation names"],
"voice":"how this nation writes its RP posts: tone, register, formatting habits, recurring phrases; at most 40 words"}
"RP style" means how the player writes and roleplays this nation: post length, formality, in-character conventions, use of news reports or press releases, and so on.`);
  const list = (x, n) => (Array.isArray(x) ? x : []).map(String).filter(Boolean).slice(0, n);
  rec.profile = {
    tagline: String(out.tagline || ''),
    sections: (Array.isArray(out.sections) ? out.sections : []).map(x => ({ title: String(x.title || ''), points: list(x.points, 5) })).filter(x => x.title),
    figures: (Array.isArray(out.figures) ? out.figures : []).map(f => ({ name: String(f.name || ''), role: String(f.role || '') })).filter(f => f.name).slice(0, 8),
    allies: list(out.allies, 10), rivals: list(out.rivals, 10), voice: String(out.voice || '')
  };
  rec.sources = docs.map(d => ({ title: d.title, cat: d.cat, url: d.url }));
  rec.usedNotes = !!notes;
  rec.at = Date.now();
  state.profiles[k] = rec;
  save();
}

/* ---------- Reply drafter ---------- */
async function draftReply(src, stance, opts) {
  const recent = src.raw.slice(-12).map(i => `${i.author}: ${i.text.slice(0, 2500)}`).join('\n\n');
  const out = await gemini(`${councilBlock()}

${sourceContext(src, { noFactbooks: true })}

The most recent posts in this RP, oldest first:
${recent || '(none)'}

TASK: Write ${state.settings.nation || 'our nation'}'s next in-character (IC) post for this RP.
The leader's decision: "${stance}"
Rules:
- Write as the government/people of ${state.settings.nation || 'our nation'}, matching its voice and culture from the dossier and notes${state.profiles?.[slug(state.settings.nation)]?.profile?.voice ? ' (voice: ' + state.profiles[slug(state.settings.nation)].profile.voice + ')' : ''}.
- Respond to what the other nations actually posted. Use real names, numbers and places from the material.
- Never control other players' nations or decide outcomes for them (no godmodding). Only describe our own actions, statements and forces.
- Stay consistent with our factbooks and earlier posts. Do not invent major new assets.
- Length: ${opts.length === 'short' ? 'about 120 words' : opts.length === 'long' ? 'about 500 words' : 'about 250 words'}.
- Format: ${opts.bbcode ? 'NationStates forum BBCode ([b], [i], [u], [quote], [hr], [box] if suitable). No markdown.' : 'plain text, no markdown and no BBCode.'}
Reply with JSON only: {"post":"the full post text","note":"one short OOC note to the leader about choices you made, at most 20 words"}`);
  return { post: String(out.post || ''), note: String(out.note || ''), stance, at: Date.now(), ...opts };
}

/* Official NationStates "Defense Forces" census (scale 46), cached 12 h per nation */
async function loadCensus(names) {
  state.census = state.census || {};
  let changed = false;
  for (const n of names.slice(0, 15)) {
    const k = slug(n), c = state.census[k];
    if (c && Date.now() - c.at < 12 * 3600e3) continue;
    try {
      const x = await nsApi({ nation: k, q: 'census', scale: '46', mode: 'score rank' });
      state.census[k] = x.querySelector('NATION')
        ? { at: Date.now(), score: Number(xt(x, 'SCORE')), rank: Number(xt(x, 'RANK')) }
        : { at: Date.now(), missing: true };
    } catch (e) { state.census[k] = { at: Date.now(), missing: true }; }
    changed = true;
  }
  if (changed) { save(); renderOrbat(); }
}

function chatPrompt(ctx, msg) {
  return `${councilBlock()}

${ctx}

Recent conversation with the leader:
${ctx.chat.slice(-12).map(m => m.role === 'You' ? `LEADER: ${m.text}` : `${m.role}: ${m.text}`).join('\n') || '(none)'}

The leader now says: "${msg}"

Answer as the council. Only the 1-3 members with something useful to say should speak. They may disagree with each other when that is realistic. Be concrete and brief: each reply at most 50 words, no long paragraphs.
Reply with JSON only: {"replies":[{"role":"council role exactly as written above","text":"what they say"}],"options":["optional: up to 4 follow-up courses of action, 2-5 words each"]}`;
}
function sourceContext(src, opts = {}) {
  const c = `CASE FILE: "${src.name}" (${TYPE_LABEL[src.type]})
${src.profile ? 'Context: ' + src.profile + '\n' : ''}Running summary: ${src.summary || '(none yet)'}
Latest events:
${src.events.slice(-15).map(eventLine).join('\n') || '(none)'}
Your latest briefs: ${(src.briefs || []).map(b => b.role + ': ' + b.brief).join(' | ') || '(none)'}
Military standings:
${militaryLines(src)}
${opts.noFactbooks ? '' : factbookBlock((src.military || []).map(m => m.nation))}
${(src.military || []).filter(m => slug(m.nation) !== slug(state.settings.nation)).map(m => profileText(m.nation, 'DOSSIER: ' + m.nation, true)).filter(Boolean).join('\n')}`;
  return Object.assign(new String(c), { chat: src.chat });
}
function overviewContext() {
  const c = `ALL OPEN CASE FILES:
${state.sources.map(s => `== ${s.name} (${TYPE_LABEL[s.type]}) ==\n${s.summary || '(no analysis yet)'}\nLatest: ${s.events.slice(-3).map(e => e.title).join('; ') || 'none'}`).join('\n\n') || '(no files open)'}`;
  return Object.assign(new String(c), { chat: state.overview.chat });
}

/* ---------- actions ---------- */
async function analyze(src) {
  const pending = src.raw.filter(i => !i.analyzed);
  if (!pending.length) { toast('No new intel to analyze in this file.'); return; }
  await refreshFactbooks((src.military || []).map(m => m.nation));
  // Split very large backlogs so each request stays a sensible size.
  const chunks = []; let cur = [], size = 0;
  for (const i of pending) {
    const len = i.text.length + 60;
    if (size + len > CHUNK_CHARS && cur.length) { chunks.push(cur); cur = []; size = 0; }
    cur.push(i); size += len;
  }
  if (cur.length) chunks.push(cur);
  for (let n = 0; n < chunks.length; n++) {
    if (chunks.length > 1) toast(`Analyzing part ${n + 1} of ${chunks.length}…`, 60000);
    const out = await gemini(analysisPrompt(src, chunks[n]));
    const when = Math.max(...chunks[n].map(i => i.time || 0)) || Date.now();
    (out.events || []).forEach(e => src.events.push({
      id: uid(), title: String(e.title || 'Untitled'), detail: String(e.detail || ''), actor: String(e.actor || 'Unknown'),
      tag: String(e.tag || 'Other'), time: when, source: src.id
    }));
    src.events = src.events.slice(-MAX_EVENTS);
    if (out.summary) src.summary = String(out.summary);
    const a = cleanAssessment(out.assessment);
    if (a) src.assessment = a;
    if (Array.isArray(out.briefs) && out.briefs.length) src.briefs = out.briefs.map(b => ({ role: String(b.role), brief: String(b.brief) }));
    if (Array.isArray(out.options)) src.options = out.options.map(String).slice(0, 4);
    const mil = cleanMilitary(out.military);
    if (mil.length) { src.military = mil; src.militaryAt = Date.now(); }
    chunks[n].forEach(i => { i.analyzed = true; });
    save(); render();
  }
  toast('Report filed.');
  loadCensus((src.military || []).map(m => m.nation));
  autoDossiers();
}

async function syncAndAnalyze(src, { quiet } = {}) {
  if (busy.has(src.id)) return;
  busy.add(src.id); render();
  try {
    const n = await syncSource(src);
    save();
    if (n || src.raw.some(i => !i.analyzed)) {
      if (state.settings.geminiKey) await analyze(src);
      else if (!quiet) toast(`${n} new item${n === 1 ? '' : 's'} pulled. Add a Gemini key in Settings to get the event chain.`);
    } else if (!quiet) toast('Nothing new in ' + src.name + '.');
  } catch (e) {
    toast(src.name + ': ' + e.message, 8000);
  } finally { busy.delete(src.id); save(); render(); }
}

async function syncAll(auto) {
  const btn = $('#syncAll'); btn.disabled = true; btn.classList.add('spin');
  await loadBanner(!auto);
  for (const s of state.sources) await syncAndAnalyze(s, { quiet: true });
  btn.disabled = false; btn.classList.remove('spin');
  if (!auto) toast('All files updated.');
  autoDossiers();
}

async function sendDirective(text) {
  const src = current();
  const holder = src || state.overview;
  holder.chat = holder.chat || [];
  holder.chat.push({ role: 'You', text });
  save(); render();
  busy.add('chat'); render();
  try {
    const ctx = src ? sourceContext(src) : overviewContext();
    const out = await gemini(chatPrompt(ctx, text));
    (out.replies || []).forEach(r => holder.chat.push({ role: String(r.role), text: String(r.text) }));
    if (Array.isArray(out.options) && out.options.length) holder.options = out.options.map(String).slice(0, 4);
    holder.chat = holder.chat.slice(-60);
  } catch (e) { toast(e.message, 8000); }
  finally { busy.delete('chat'); save(); render(); }
}

async function overviewBrief() {
  if (!state.sources.length) { toast('Open a case file first.'); return; }
  busy.add('overview'); render();
  try { await assessOnly(null); }
  catch (e) { toast(e.message, 8000); }
  finally { busy.delete('overview'); save(); render(); }
}


/* ---------- Automatic upkeep ----------
   Builds dossiers for every nation that appears in your files (and refreshes them weekly),
   and pulls new reports every 15 minutes while the app is open. */
let autoRunning = false;
async function autoDossiers() {
  if (autoRunning || !state.settings.geminiKey) return;
  autoRunning = true;
  try {
    const names = new Map();
    if (state.settings.nation) names.set(slug(state.settings.nation), state.settings.nation);
    state.sources.forEach(src => (src.military || []).forEach(m => names.set(slug(m.nation), m.nation)));
    for (const [k, name] of names) {
      const rec = state.profiles?.[k];
      const stale = !rec?.profile ? !(rec?.failedAt && Date.now() - rec.failedAt < 24 * 3600e3) : Date.now() - (rec.at || 0) > 7 * 24 * 3600e3;
      if (!stale || busy.has('profile:' + k)) continue;
      busy.add('profile:' + k);
      try { await buildProfile(name, k === slug(state.settings.nation), true); } catch (e) { /* no material yet: retried tomorrow */ }
      finally { busy.delete('profile:' + k); }
      render();
    }
  } finally { autoRunning = false; }
}
async function autoRefresh() {
  if (state.settings.autoRefresh === false || document.hidden || !state.sources.length || $('#syncAll').disabled) return;
  if ([...busy].length) return;
  await syncAll(true);
}

/* ---------- rendering ---------- */
function render() {
  const last = Math.max(0, ...state.sources.map(s => s.lastSync || 0));
  $('#nationLine').textContent = !state.settings.nation ? 'SET YOUR NATION IN SETTINGS' : last ? 'SYNCED ' + fmtTime(last).toUpperCase() : 'NO REPORTS YET';
  renderBanner(); renderFiles(); renderSheet(); renderPanels(); renderCouncil(); renderOrbat();
}

/* Side panel tabs: Council | Order of battle */
let uiPanel = 'council';
let uiPaste = null;
function renderPanels() {
  document.querySelectorAll('.panel-tabs [data-panel]').forEach(b => {
    const on = b.dataset.panel === uiPanel;
    b.setAttribute('aria-selected', on); b.classList.toggle('on', on); b.tabIndex = on ? 0 : -1;
  });
  $('#panel-council').hidden = uiPanel !== 'council';
  $('#panel-forces').hidden = uiPanel !== 'forces';
}

/* Order of Battle: military ranking of every nation in the RP */
function orbatList() {
  const src = current();
  if (src) return { list: withFactbookScores(src.military), src };
  const merged = new Map();
  state.sources.slice().sort((a, b) => (a.militaryAt || 0) - (b.militaryAt || 0))
    .forEach(s => (s.military || []).forEach(m => merged.set(slug(m.nation), { ...m, file: s.name })));
  return { list: withFactbookScores([...merged.values()]), src: null };
}
const openRanks = new Set();
function renderOrbat() {
  const el = $('#orbat');
  const { list, src } = orbatList();
  const census = state.census || {};
  const us = [slug(state.settings.nation), slug(state.banner?.name)].filter(Boolean);
  const rows = list.slice().sort((a, b) => b.strength - a.strength || ((census[slug(b.nation)]?.score || 0) - (census[slug(a.nation)]?.score || 0)));
  const arrow = { up: '▲', down: '▼', steady: '–' };
  const trendWord = { up: 'rising', down: 'falling', steady: 'steady' };
  el.innerHTML = `
    <p class="dim orbat-sub">${src ? esc(src.name) : 'All files combined'} · tap a nation for details</p>
    ${rows.length ? `<ol class="ranks">${rows.map((m, i) => {
      const k = slug(m.nation), c = census[k];
      const ns = c && !c.missing && c.score ? `NS Defense ${Math.round(c.score).toLocaleString()} · #${c.rank.toLocaleString()} world` : c?.missing ? 'Not a NationStates nation' : '';
      const fbs = state.factbooks?.[k] || [];
      return `<li class="rank ${us.includes(k) ? 'us' : ''}">
        <details data-rank="${esc(k)}" ${openRanks.has(k) ? 'open' : ''}>
          <summary>
            <span class="rank-no">${i + 1}</span>
            <span class="rank-name">${esc(m.nation)}</span>
            <span class="basis ${m.basis}" title="${m.basis === 'factbook' ? 'Rated from its factbook' : 'Rated from RP posts'}">${m.basis === 'factbook' ? 'FB' : 'RP'}</span>
            <span class="trend ${m.trend}" aria-label="${trendWord[m.trend]}">${arrow[m.trend]}</span>
            <span class="score">${m.strength}</span>
            <span class="bar" aria-hidden="true"><span style="width:${m.strength}%"></span></span>
          </summary>
          <div class="rank-detail">
            ${m.assets ? `<div class="rank-meta">${esc(m.assets)}</div>` : ''}
            ${m.note ? `<div class="rank-note">${esc(m.note)}</div>` : ''}
            <div class="rank-ns mono">${m.basis === 'factbook' ? 'RATED FROM FACTBOOK' : 'RATED FROM RP POSTS'}${ns ? ' · ' + esc(ns) : ''}${m.file && !src ? ' · ' + esc(m.file) : ''}</div>
            <div class="fb-list">
              ${fbs.map((f, j) => `<span class="fb-chip">
                <a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.title || 'Factbook')}</a>${f.text ? '' : '<span class="fb-warn"> (link only)</span>'}
                <button class="fb-x" data-fbrm="${esc(k)}|${j}" aria-label="Remove factbook ${esc(f.title || '')}">×</button>
              </span>`).join('')}
              <button class="fb-add" data-fbadd="${esc(m.nation)}">+ Factbook</button>
              <button class="fb-add" data-profile="${esc(m.nation)}">Dossier</button>
            </div>
          </div>
        </details>
      </li>`;
    }).join('')}</ol>` : `<p class="empty">${src ? 'Rankings appear after the next analysis, or press Reassess.' : 'Rankings appear once a file has been analyzed.'}</p>`}
    ${src ? `<div class="row wrap orbat-actions">
      <button class="btn ghost small" data-act="reassess" ${busy.has('mil') ? 'disabled' : ''}>${busy.has('mil') ? '<span class="spin">Assessing</span>' : 'Reassess'}</button>
      <button class="btn ghost small" data-act="track">+ Nation</button>
    </div>` : ''}
    ${rows.some(m => !state.profiles?.[slug(m.nation)]?.profile) ? `<button class="btn ghost small" data-act="buildAll" ${busy.has('buildAll') ? 'disabled' : ''}>${busy.has('buildAll') ? '<span class="spin">Building dossiers</span>' : 'Build missing dossiers'}</button>` : ''}`;
}

/* NationStates-style banner for the leader's own nation */
async function loadBanner(force) {
  const n = state.settings.nation;
  if (!n) { state.banner = null; renderBanner(); return; }
  const b = state.banner;
  if (!force && b && b.for === slug(n) && Date.now() - b.at < 6 * 3600e3) return;
  try {
    const x = await nsApi({ nation: slug(n), q: 'name type fullname flag motto category region population influence' });
    if (!x.querySelector('NATION')) throw new Error('not found');
    state.banner = {
      for: slug(n), at: Date.now(), name: xt(x, 'NAME'), type: xt(x, 'TYPE'), flag: xt(x, 'FLAG'), motto: xt(x, 'MOTTO'),
      category: xt(x, 'CATEGORY'), region: xt(x, 'REGION'), population: xt(x, 'POPULATION'), influence: xt(x, 'INFLUENCE')
    };
    save(); renderBanner();
  } catch (e) { /* the banner is decoration; keep the app usable */ }
}
function renderBanner() {
  const b = state.banner, n = state.settings.nation;
  const flag = $('#flag');
  if (b && b.for === slug(n)) {
    $('#pretitle').textContent = b.type ? 'The ' + b.type + ' of' : 'Office of the Head of State';
    $('#nationName').textContent = b.name || n;
    $('#motto').textContent = b.motto ? '“' + b.motto + '”' : '';
    if (b.flag) { flag.src = b.flag; flag.alt = 'Flag of ' + (b.name || n); flag.hidden = false; } else flag.hidden = true;
    const pop = Number(b.population);
    $('#stats').textContent = [b.category, b.region, pop ? (pop >= 1000 ? (pop / 1000).toFixed(2) + 'B' : pop.toLocaleString() + 'M') + ' people' : '', b.influence].filter(Boolean).join('  ·  ');
  } else {
    $('#pretitle').textContent = 'Office of the Head of State';
    $('#nationName').textContent = n || 'Situation Room';
    $('#motto').textContent = ''; $('#stats').textContent = '';
    flag.hidden = true;
  }
}

function renderFiles() {
  const tabs = [{ id: 'dossier', name: 'Our nation', kind: 'DOSSIER' }, { id: 'overview', name: 'All files', kind: 'ALL' },
    ...state.sources.map(s => ({ id: s.id, name: s.name, kind: TYPE_LABEL[s.type], pending: s.raw.filter(i => !i.analyzed).length }))];
  $('#fileList').innerHTML = tabs.map(t => `
    <button class="file-tab ${state.selected === t.id ? 'on' : ''}" data-tab="${t.id}" aria-current="${state.selected === t.id}">
      <span class="ft-name">${esc(t.name)}${t.pending ? `<span class="new" aria-label="${t.pending} new">${t.pending}</span>` : ''}</span>
      <span class="kind">${busy.has(t.id) ? '<span class="spin">…</span>' : t.kind}</span>
    </button>`).join('');
}

function eventHTML(e, i, showSource) {
  const src = showSource ? state.sources.find(s => s.id === e.source) : null;
  return `<details class="event">
    <summary><span class="no">${i}</span><span class="title">${esc(e.title)}</span><span class="tag tag-${esc(String(e.tag).toLowerCase())}">${esc(e.tag)}</span></summary>
    <div class="event-more">${esc(e.detail)}<div class="meta">${esc(e.actor)}${e.time ? ' · ' + esc(fmtTime(e.time)) : ''}${src ? ' · ' + esc(src.name) : ''}</div></div>
  </details>`;
}


/* ---------- Dossier + drafter views ---------- */
let uiDraft = null, uiStance = '';
function dossierHTML(k, ours) {
  const rec = state.profiles?.[k] || {};
  const p = rec.profile;
  const name = ours ? (state.banner?.name || state.settings.nation || 'Your nation') : (rec.name || pretty(k));
  const flag = ours ? state.banner?.flag : rec.flag;
  const notes = ours ? state.settings.lore : (rec.notes || '');
  const building = busy.has('profile:' + k);
  if (ours && !state.settings.nation) return `<div class="sheet-head"><h2 class="typed">Our nation</h2></div><p class="empty">Set your nation in Settings first.</p>`;
  const chips = (label, items, cls) => items?.length ? `<div class="chip-row"><span class="chip-label">${label}</span>${items.map(x => `<span class="chip ${cls || ''}">${esc(x)}</span>`).join('')}</div>` : '';
  return `
    <div class="sheet-head">
      <div class="dossier-id">
        ${flag ? `<img src="${esc(flag)}" alt="Flag of ${esc(name)}" class="dossier-flag">` : ''}
        <div><h2 class="typed">${esc(name)}</h2><div class="muted">${p?.tagline ? esc(p.tagline) : ours ? 'Your nation’s dossier' : 'Nation dossier'}</div></div>
      </div>
      <div class="sheet-actions">
        <button class="btn red" data-act="buildProfile" data-nation="${esc(name)}" ${building ? 'disabled' : ''}>${building ? '<span class="spin">Reading dispatches</span>' : p ? 'Rebuild dossier' : 'Build dossier'}</button>
      </div>
    </div>
    ${p ? `
      <div class="dossier-grid">
        ${p.sections.map(x => `<section class="dcard ${/rp style/i.test(x.title) ? 'rp' : ''}"><h3>${esc(x.title)}</h3><ul>${x.points.map(pt => `<li>${esc(pt)}</li>`).join('')}</ul></section>`).join('')}
      </div>
      ${p.voice ? `<div class="voice-card"><span class="chip-label">RP voice</span><p>${esc(p.voice)}</p></div>` : ''}
      ${chips('Key figures', p.figures.map(f => f.name + (f.role ? ' — ' + f.role : '')))}
      ${chips('Allies', p.allies, 'ally')}
      ${chips('Rivals', p.rivals, 'rival')}
      <details class="sources"><summary>Built from ${rec.sources?.length || 0} dispatch${rec.sources?.length === 1 ? '' : 'es'}/factbook${rec.sources?.length === 1 ? '' : 's'}${rec.usedNotes ? ' + your notes' : ''} · ${esc(fmtTime(rec.at))}</summary>
        <ul>${(rec.sources || []).map(d => `<li>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.title)}</a>` : esc(d.title)} <span class="muted">${esc(d.cat || '')}</span></li>`).join('') || '<li>Your notes only</li>'}</ul>
      </details>` : `<p class="empty">No dossier yet. <b>Build dossier</b> reads ${esc(name)}’s dispatches and factbooks${notes ? ' and the notes below' : ''}, and turns them into a short profile your advisors use.</p>`}
    <section class="notes">
      <label for="notesBox"><b>Notes &amp; lore</b> <span class="muted">Paste anything: past chats, constitution, doctrine, history. ${ours ? 'Your advisors always read this.' : ''}</span></label>
      <textarea id="notesBox" rows="7" data-nation="${esc(k)}" data-ours="${ours}">${esc(notes)}</textarea>
      <div class="row end wrap">
        <span class="muted" id="notesCount">${notes.length.toLocaleString()} characters</span>
        <button class="btn ghost" data-act="saveNotes">Save notes</button>
        <button class="btn dark" data-act="saveNotesBuild" data-nation="${esc(name)}" ${building ? 'disabled' : ''}>Save &amp; rebuild</button>
      </div>
    </section>`;
}

function drafterHTML(src) {
  const d = src.draft;
  const busyD = busy.has('draft:' + src.id);
  return `<section class="drafter" aria-label="Draft my reply">
    <div class="drafter-head"><h3 class="label ink">Draft my reply</h3><button class="btn ghost small" data-act="draftToggle">Close</button></div>
    <label for="stance">What do you want to do?</label>
    ${(src.options || []).length ? `<div class="option-row">${src.options.map(o => `<button class="chip-btn" data-stance="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
    <textarea id="stance" rows="2" placeholder="e.g. Reject the ultimatum, but offer talks under regional mediation">${esc(uiStance)}</textarea>
    <div class="row wrap">
      <label class="inline" for="draftLen">Length</label>
      <select id="draftLen" class="small-select">
        <option value="short" ${d?.length === 'short' ? 'selected' : ''}>Short</option>
        <option value="medium" ${!d || d.length === 'medium' ? 'selected' : ''}>Medium</option>
        <option value="long" ${d?.length === 'long' ? 'selected' : ''}>Long</option>
      </select>
      <label class="check"><input type="checkbox" id="draftBB" ${d?.bbcode === false ? '' : 'checked'}> Forum formatting (BBCode)</label>
      <button class="btn red" data-act="draft" ${busyD ? 'disabled' : ''}>${busyD ? '<span class="spin">Writing</span>' : d ? 'Rewrite' : 'Write draft'}</button>
    </div>
    ${d?.post ? `
      <label for="draftOut">Draft <span class="muted">· edit freely, then copy</span></label>
      <textarea id="draftOut" rows="12" class="draft-out">${esc(d.post)}</textarea>
      <div class="row wrap">
        ${d.note ? `<span class="muted draft-note">${esc(d.note)}</span>` : ''}
        <button class="btn dark" data-act="copyDraft">Copy post</button>
      </div>` : ''}
  </section>`;
}

const THREAT_LABEL = { low: 'Low', elevated: 'Elevated', high: 'High', critical: 'Critical' };
function assessmentHTML(a, holderBusy, canAssess) {
  if (!a) {
    return canAssess ? `<section class="assess empty-assess">
      <p class="empty">No AI assessment yet.</p>
      <button class="btn red small" data-act="assess" ${holderBusy ? 'disabled' : ''}>${holderBusy ? '<span class="spin">Assessing</span>' : 'Get AI assessment'}</button>
    </section>` : '';
  }
  return `<section class="assess threat-${a.threat}" aria-label="AI assessment">
    <div class="assess-top">
      <span class="threat-pill">Threat: ${THREAT_LABEL[a.threat]}</span>
      <span class="muted">${a.at ? esc(fmtTime(a.at)) : ''}</span>
      <button class="btn ghost small" data-act="assess" ${holderBusy ? 'disabled' : ''}>${holderBusy ? '<span class="spin">…</span>' : 'Refresh'}</button>
    </div>
    ${a.headline ? `<p class="headline">${esc(a.headline)}</p>` : ''}
    ${a.points.length ? `<ul class="points">${a.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${a.watch.length ? `<div class="watch"><span class="watch-label">Watch</span>${a.watch.map(w => `<span class="watch-chip">${esc(w)}</span>`).join('')}</div>` : ''}
  </section>`;
}

function renderSheet() {
  const el = $('#file');
  const src = current();
  const hasKey = !!state.settings.geminiKey;
  if (state.selected === 'dossier') { el.innerHTML = dossierHTML(slug(state.settings.nation), true); return; }
  if (String(state.selected).startsWith('nation:')) { el.innerHTML = dossierHTML(state.selected.slice(7), false); return; }
  if (!src) {
    const all = state.sources.flatMap(s => s.events).sort((a, b) => (a.time || 0) - (b.time || 0)).slice(-40).reverse();
    el.innerHTML = `
      <div class="sheet-head"><div><h2 class="typed">Situation overview</h2><div class="muted">${esc(activeWs()?.name || '')} · ${state.sources.length} file${state.sources.length === 1 ? '' : 's'}</div></div></div>
      ${!state.sources.length ? `<p class="empty">No files yet. Set your nation and Gemini key in Settings, then add a <b>+ New file</b> for your nation, your region and each RP.</p>` : `
        ${assessmentHTML(state.overview.assessment, busy.has('overview'), hasKey)}
        <h3 class="label ink">Latest events</h3>
        ${all.length ? `<div class="chain">${all.map((e, i) => eventHTML(e, all.length - i, true)).join('')}</div>` : '<p class="empty">No events yet. Press <b>Request new reports</b>.</p>'}`}`;
    return;
  }
  const pending = src.raw.filter(i => !i.analyzed).length;
  const isBusy = busy.has(src.id);
  const events = src.events.slice().reverse();
  const showPaste = uiPaste === src.id || (src.type === 'paste' && !src.raw.length);
  el.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2 class="typed">${esc(src.name)}</h2>
        <div class="muted">${src.lastSync ? 'Read ' + esc(fmtTime(src.lastSync)) : src.type === 'paste' ? 'Pasted intel' : 'Not read yet'}${src.profile ? ' · ' + esc(src.profile) : ''}</div>
      </div>
      <div class="sheet-actions">
        ${src.type !== 'paste' ? `<button class="btn dark" data-act="sync" ${isBusy ? 'disabled' : ''}>${isBusy ? '<span class="spin">Reading</span>' : 'Pull intel'}</button>` : ''}
        ${pending ? `<button class="btn red" data-act="analyze" ${isBusy ? 'disabled' : ''}>Analyze ${pending}</button>` : ''}
        <button class="btn ${uiDraft === src.id ? 'dark' : 'ghost'}" data-act="draftToggle" aria-expanded="${uiDraft === src.id}">Draft reply</button>
        <details class="more">
          <summary class="btn ghost" aria-label="More actions">More</summary>
          <div class="menu">
            <button data-act="pasteToggle">Add intel by hand</button>
            <button data-act="rename">Rename</button>
            <button data-act="close">Close file</button>
          </div>
        </details>
      </div>
    </div>
    ${showPaste ? `<div class="paste">
      <label for="pasteBox"><b>Add intel by hand</b> <span class="muted">Discord messages, a dispatch, your own post</span></label>
      <textarea id="pasteBox" rows="4"></textarea>
      <div class="row end">${src.type !== 'paste' ? '<button class="btn ghost" data-act="pasteToggle">Cancel</button>' : ''}<button class="btn red" data-act="paste">File it</button></div>
    </div>` : ''}
    ${uiDraft === src.id ? drafterHTML(src) : ''}
    ${assessmentHTML(src.assessment, busy.has('assess:' + src.id), hasKey && (src.summary || src.events.length))}
    <h3 class="label ink">Event chain <span class="muted">· tap to expand</span></h3>
    ${events.length ? `<div class="chain">${events.map((e, i) => eventHTML(e, events.length - i)).join('')}</div>` : `<p class="empty">${pending ? 'Press Analyze to build the event chain.' : 'No events yet.'}</p>`}
    <div class="sheet-foot">
      ${src.summary ? `<details class="story"><summary>Full story so far</summary><div class="summary">${esc(src.summary)}</div></details>` : ''}
      <details class="raw"><summary>Raw intel (${src.raw.length})</summary>
        ${src.raw.slice().reverse().slice(0, 150).map(r => `<div class="raw-item"><span class="who">${esc(r.author)}</span> <span class="muted">${esc(fmtTime(r.time))}</span>\n${esc(r.text.slice(0, 2000))}</div>`).join('') || '<p class="empty">Nothing yet.</p>'}
      </details>
    </div>`;
}

function renderCouncil() {
  const src = current();
  const holder = src || state.overview;
  const briefs = holder.briefs || [];
  $('#briefs').innerHTML = briefs.length
    ? briefs.map(b => `<div class="memo"><div class="from">${esc(b.role)}</div><div class="text">${esc(b.brief)}</div></div>`).join('')
    : `<p class="empty">${src ? 'Your ministers write here after the first analysis.' : 'Press “Get AI assessment” for a briefing across all files.'}</p>`;
  $('#options').innerHTML = (holder.options || []).map((o, i) =>
    `<button class="btn ${i === 0 ? 'red' : 'ghost'} small" data-option="${esc(o)}">${esc(o)}</button>`).join('');
  $('#chat').innerHTML = (holder.chat || []).map(m => m.role === 'You'
    ? `<div class="msg-you">${esc(m.text)}</div>`
    : `<div class="memo"><div class="from">${esc(m.role)}</div><div class="text">${esc(m.text)}</div></div>`).join('')
    + (busy.has('chat') ? '<p class="dim spin">The cabinet is deliberating</p>' : '');
}

/* ---------- settings ---------- */
function openSettings() {
  const s = state.settings;
  $('#sNation').value = s.nation; $('#sAuto').checked = s.autoRefresh !== false; $('#sKey').value = s.geminiKey; $('#sLore').value = s.lore; $('#sProxy').value = s.proxy;
  fillModelSelect([], s.model);
  renderAdvisorEdit(s.advisors);
  $('#settingsDlg').showModal();
}
function renderAdvisorEdit(list) {
  $('#advisorEdit').innerHTML = list.map((a, i) => `
    <div class="adv" data-i="${i}">
      <div class="row"><label class="muted" for="advR${i}" style="position:absolute;left:-9999px">Advisor ${i + 1} title</label>
        <input id="advR${i}" class="advRole" value="${esc(a.role)}" placeholder="Title">
        <button type="button" class="btn ghost" data-rm="${i}" aria-label="Remove ${esc(a.role)}">Remove</button></div>
      <label class="muted" for="advP${i}" style="position:absolute;left:-9999px">Advisor ${i + 1} personality</label>
      <textarea id="advP${i}" class="advPersona" rows="2" placeholder="Personality and focus">${esc(a.persona)}</textarea>
    </div>`).join('');
}
function readAdvisorEdit() {
  return [...document.querySelectorAll('#advisorEdit .adv')].map(d => ({
    role: d.querySelector('.advRole').value.trim(), persona: d.querySelector('.advPersona').value.trim()
  })).filter(a => a.role);
}
function saveSettings() {
  const s = state.settings;
  const ws = activeWs(), newNation = $('#sNation').value.trim();
  if (newNation && (!ws.name || ws.name === s.nation || ws.name === 'My nation' || ws.name === 'New workspace')) ws.name = newNation;
  s.nation = newNation; s.geminiKey = $('#sKey').value.trim();
  s.model = $('#sModel').value; s.lore = $('#sLore').value; s.autoRefresh = $('#sAuto').checked; s.proxy = $('#sProxy').value.trim();
  const adv = readAdvisorEdit(); s.advisors = adv.length ? adv : DEFAULT_ADVISORS.map(a => ({ ...a }));
  save(); render(); toast('Settings saved.');
  loadBanner(true);
}
function exportSetup() {
  const copy = JSON.parse(JSON.stringify(state)); copy.settings.geminiKey = '';
  const blob = new Blob([JSON.stringify(copy)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'ns-advisor-setup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importSetup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.settings || !Array.isArray(data.sources)) throw new Error();
    const key = state.settings.geminiKey;
    state = migrateWs({ ...fresh(), ...data, settings: { ...fresh().settings, ...data.settings, geminiKey: data.settings.geminiKey || key } });
    save(); $('#settingsDlg').close(); render(); toast('Setup imported.');
  } catch (e) { toast('That file isn’t an exported setup.'); }
}

/* ---------- add / manage files ---------- */
const TARGET_LABEL = { nation: 'Nation name', region: 'Region name', thread: 'Thread link (forum.nationstates.net)', paste: '' };
function updateAddForm() {
  const t = $('#aType').value;
  $('#aTargetLabel').textContent = TARGET_LABEL[t];
  $('#aTargetLabel').style.display = $('#aTarget').style.display = t === 'paste' ? 'none' : '';
  $('#aTarget').placeholder = t === 'thread' ? 'https://forum.nationstates.net/viewtopic.php?t=…' : '';
}
function addFile() {
  const type = $('#aType').value, target = $('#aTarget').value.trim();
  let name = $('#aName').value.trim();
  if (type !== 'paste' && !target) { toast('Fill in the ' + TARGET_LABEL[type].toLowerCase() + '.'); return false; }
  if (type === 'thread') {
    try { const u = new URL(target); if (!/nationstates\.net$/.test(u.hostname)) throw 0; }
    catch (e) { toast('Use a forum.nationstates.net thread link.'); return false; }
  }
  if (!name) name = type === 'thread' ? 'RP thread' : type === 'paste' ? 'Pasted intel' : pretty(slug(target));
  const src = { id: uid(), type, target, name, raw: [], seen: [], events: [], summary: '', briefs: [], options: [], chat: [], profile: '', lastSync: 0 };
  state.sources.push(src); state.selected = src.id; save(); render();
  if (type !== 'paste') syncAndAnalyze(src);
  return true;
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const ptab = e.target.closest('[data-panel]');
  if (ptab) { uiPanel = ptab.dataset.panel; renderPanels(); return; }
  if (e.target.closest('.menu button')) e.target.closest('details.more')?.removeAttribute('open');
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.selected = tab.dataset.tab; save(); render(); $('#file').scrollIntoView({ block: 'nearest' }); return; }
  const opt = e.target.closest('[data-option]');
  if (opt) { if (!busy.has('chat')) sendDirective('I’m considering: ' + opt.dataset.option + '. Advise me.'); return; }
  const prof = e.target.closest('[data-profile]');
  if (prof) {
    const k = slug(prof.dataset.profile);
    state.profiles = state.profiles || {};
    state.profiles[k] = state.profiles[k] || { name: prof.dataset.profile, notes: '' };
    state.selected = k === slug(state.settings.nation) ? 'dossier' : 'nation:' + k;
    save(); render(); $('#file').scrollTop = 0; return;
  }
  const stanceBtn = e.target.closest('[data-stance]');
  if (stanceBtn) { uiStance = stanceBtn.dataset.stance; const t = $('#stance'); if (t) { t.value = uiStance; t.focus(); } return; }
  const fbAdd = e.target.closest('[data-fbadd]');
  if (fbAdd) { addFactbook(fbAdd.dataset.fbadd); return; }
  const fbRm = e.target.closest('[data-fbrm]');
  if (fbRm) {
    const [k, j] = fbRm.dataset.fbrm.split('|');
    const list = state.factbooks?.[k] || [];
    const f = list[+j];
    if (f && confirm(`Remove “${f.title || 'this factbook'}”?`)) { list.splice(+j, 1); save(); renderOrbat(); }
    return;
  }
  const rm = e.target.closest('[data-rm]');
  if (rm) { const list = readAdvisorEdit(); list.splice(+rm.dataset.rm, 1); renderAdvisorEdit(list); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const src = current();
  if (act === 'assess') {
    if (!src) { overviewBrief(); return; }
    const key = 'assess:' + src.id;
    if (busy.has(key)) return;
    busy.add(key); renderSheet(); renderCouncil();
    assessOnly(src).catch(err => toast(err.message, 8000)).finally(() => { busy.delete(key); save(); render(); });
    return;
  }
  if (act === 'overviewBrief') overviewBrief();
  if (act === 'buildAll') {
    if (!state.settings.geminiKey) { toast('Add your Gemini key in Settings first.'); return; }
    if (busy.has('buildAll')) return;
    const names = orbatList().list.map(m => m.nation).filter(n => !state.profiles?.[slug(n)]?.profile);
    busy.add('buildAll'); renderOrbat();
    (async () => {
      const failed = [];
      for (const n of names) { try { await buildProfile(n, slug(n) === slug(state.settings.nation)); } catch (err) { failed.push(n); } }
      toast(failed.length ? `Built ${names.length - failed.length}. No dispatches found for: ${failed.join(', ')} (paste notes on their dossier).` : `Built ${names.length} dossier${names.length === 1 ? '' : 's'}.`, 9000);
    })().finally(() => { busy.delete('buildAll'); render(); });
    return;
  }
  if (act === 'saveNotes' || act === 'saveNotesBuild') {
    const box = $('#notesBox');
    if (box) {
      if (box.dataset.ours === 'true') state.settings.lore = box.value;
      else { state.profiles = state.profiles || {}; const k = box.dataset.nation; state.profiles[k] = { ...(state.profiles[k] || { name: pretty(k) }), notes: box.value }; }
      save(); if (act === 'saveNotes') toast('Notes saved.');
    }
    if (act === 'saveNotes') return;
  }
  if (act === 'buildProfile' || act === 'saveNotesBuild') {
    const name = e.target.closest('[data-act]').dataset.nation;
    if (!state.settings.geminiKey) { toast('Add your Gemini key in Settings first.'); return; }
    const k = slug(name), ours = state.selected === 'dossier';
    if (busy.has('profile:' + k)) return;
    busy.add('profile:' + k); renderSheet();
    buildProfile(name, ours).then(() => toast(`${name}’s dossier is ready.`)).catch(err => toast(err.message, 9000))
      .finally(() => { busy.delete('profile:' + k); render(); });
    return;
  }
  if (!src) return;
  if (act === 'draftToggle') { uiDraft = uiDraft === src.id ? null : src.id; renderSheet(); if (uiDraft) $('#stance')?.focus(); return; }
  if (act === 'draft') {
    const stance = ($('#stance')?.value || '').trim();
    if (!stance) { toast('Say what you want to do first, or tap one of the options.'); return; }
    if (!state.settings.geminiKey) { toast('Add your Gemini key in Settings first.'); return; }
    uiStance = stance;
    const opts = { length: $('#draftLen').value, bbcode: $('#draftBB').checked };
    const key = 'draft:' + src.id;
    busy.add(key); renderSheet();
    draftReply(src, stance, opts).then(d => { src.draft = d; save(); }).catch(err => toast(err.message, 9000))
      .finally(() => { busy.delete(key); renderSheet(); });
    return;
  }
  if (act === 'copyDraft') {
    const t = $('#draftOut'); if (!t) return;
    if (src.draft) { src.draft.post = t.value; save(); }
    (navigator.clipboard?.writeText(t.value) || Promise.reject()).then(() => toast('Post copied. Paste it into the thread.'))
      .catch(() => { t.select(); document.execCommand('copy'); toast('Post copied.'); });
    return;
  }
  if (act === 'sync') syncAndAnalyze(src);
  if (act === 'analyze') { busy.add(src.id); render(); analyze(src).catch(err => toast(err.message, 8000)).finally(() => { busy.delete(src.id); render(); }); }
  if (act === 'reassess') {
    if (busy.has('mil')) return;
    busy.add('mil'); renderOrbat();
    reassessMilitary(src).then(() => { save(); loadCensus((src.military || []).map(m => m.nation)); })
      .catch(err => toast(err.message, 8000)).finally(() => { busy.delete('mil'); render(); });
  }
  if (act === 'track') {
    const n = prompt('Nation to add to the order of battle (its NationStates name):');
    if (n && n.trim()) {
      src.military = src.military || [];
      if (!src.military.some(m => slug(m.nation) === slug(n))) src.military.push({ nation: n.trim(), strength: 0, assets: 'Not assessed yet', trend: 'steady', note: 'Press Reassess forces to rate this nation.' });
      save(); render(); loadCensus([n.trim()]);
    }
  }
  if (act === 'pasteToggle') { uiPaste = uiPaste === src.id ? null : src.id; renderSheet(); if (uiPaste) $('#pasteBox')?.focus(); return; }
  if (act === 'rename') { const n = prompt('New name for this file:', src.name); if (n && n.trim()) { src.name = n.trim(); save(); render(); } }
  if (act === 'close') { if (confirm(`Close “${src.name}”? Its event chain will be removed from this device.`)) { state.sources = state.sources.filter(s => s !== src); state.selected = 'overview'; save(); render(); } }
  if (act === 'paste') {
    const text = $('#pasteBox').value.trim();
    if (!text) { toast('Paste something first.'); return; }
    const id = 'x' + uid();
    src.raw.push({ id, time: Date.now(), author: 'Pasted by the leader', text, analyzed: false }); src.seen.push(id);
    uiPaste = null;
    save(); render();
    if (!state.settings.geminiKey) { toast('Filed. Add a Gemini key in Settings to analyze it.'); return; }
    busy.add(src.id); render();
    analyze(src).catch(err => toast(err.message, 8000)).finally(() => { busy.delete(src.id); render(); });
  }
});

$('#syncAll').addEventListener('click', syncAll);
$('#openSettings').addEventListener('click', openSettings);
$('#loadModels').addEventListener('click', listModels);
$('#addAdvisor').addEventListener('click', () => { const l = readAdvisorEdit(); l.push({ role: '', persona: '' }); renderAdvisorEdit(l); });
$('#settingsForm').addEventListener('submit', e => { if (e.submitter?.value === 'save') saveSettings(); });
$('#exportBtn').addEventListener('click', exportSetup);
$('#importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importSetup(f); e.target.value = ''; });
$('#addFile').addEventListener('click', () => { $('#addForm').reset(); updateAddForm(); $('#addDlg').showModal(); });
$('#aType').addEventListener('change', updateAddForm);
$('#addForm').addEventListener('submit', e => { if (e.submitter?.value === 'add' && !addFile()) e.preventDefault(); });
$('#directiveForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#directive').value.trim();
  if (!v || busy.has('chat')) return;
  $('#directive').value = ''; sendDirective(v);
});

/* Workspace switcher */
function setWsMenu(open) {
  $('#wsMenu').hidden = !open;
  $('#wsBtn').setAttribute('aria-expanded', open);
  if (open) renderWsMenu();
}
$('#wsBtn').addEventListener('click', e => { e.stopPropagation(); setWsMenu($('#wsMenu').hidden); });
$('#wsMenu').addEventListener('click', e => {
  e.stopPropagation();
  const item = e.target.closest('[data-ws]');
  if (item) { switchWs(item.dataset.ws); setWsMenu(false); }
});
document.addEventListener('click', () => { if (!$('#wsMenu').hidden) setWsMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#wsMenu').hidden) { setWsMenu(false); $('#wsBtn').focus(); } });
$('#wsNew').addEventListener('click', () => { setWsMenu(false); $('#wsForm').reset(); $('#wsDlg').showModal(); });
$('#wsRename').addEventListener('click', () => {
  const w = activeWs(); const n = prompt('Rename this workspace:', w.name);
  if (n && n.trim()) { w.name = n.trim(); save(); renderWsMenu(); render(); }
});
$('#wsDelete').addEventListener('click', () => deleteWs(state.activeWs));
$('#wsForm').addEventListener('submit', e => {
  if (e.submitter?.value !== 'create') return;
  const name = $('#wsName').value.trim(), nation = $('#wsNation').value.trim();
  if (!name && !nation) { e.preventDefault(); toast('Give it a name or a nation.'); return; }
  createWs(name, nation);
  toast(`Switched to ${name || nation}.`);
});

document.addEventListener('input', e => {
  if (e.target.id === 'stance') uiStance = e.target.value;
  if (e.target.id === 'notesBox') { const c = $('#notesCount'); if (c) c.textContent = e.target.value.length.toLocaleString() + ' characters (unsaved)'; }
  if (e.target.id === 'draftOut') { const src = current(); if (src?.draft) src.draft.post = e.target.value; }
});

// Remember which nations are expanded in the Order of Battle across re-renders.
document.addEventListener('toggle', e => {
  const d = e.target;
  if (d.matches?.('details[data-rank]')) d.open ? openRanks.add(d.dataset.rank) : openRanks.delete(d.dataset.rank);
}, true);
// Close the "More" menu when clicking elsewhere.
document.addEventListener('click', e => {
  document.querySelectorAll('details.more[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});

render();
loadBanner(false);
setTimeout(autoDossiers, 4000);
setInterval(autoRefresh, 15 * 60e3);
document.addEventListener('visibilitychange', () => {
  // Coming back to the app after a while: catch up straight away.
  if (!document.hidden && Date.now() - Math.max(0, ...state.sources.map(s => s.lastSync || 0)) > 15 * 60e3) autoRefresh();
});
if (!state.settings.geminiKey && !state.sources.length) setTimeout(openSettings, 300);
