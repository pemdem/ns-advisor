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
    selected: 'overview'
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.settings) {
      const f = fresh();
      return { ...f, ...s, settings: { ...f.settings, ...s.settings }, overview: { ...f.overview, ...(s.overview || {}) } };
    }
  } catch (e) { /* fall through */ }
  return fresh();
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch (e) { toast('This browser’s storage is full. Close an old file or clear its raw intel.'); }
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
    return { id: 'p' + (el.id || '').replace(/\D/g, ''), time: dt ? Date.parse(dt) : 0, author, text: content.textContent.replace(/\n{3,}/g, '\n\n').trim() };
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
async function gemini(prompt) {
  const key = state.settings.geminiKey.trim();
  if (!key) throw new Error('Add your Gemini API key in Settings first.');
  const model = (state.settings.model || 'gemini-2.5-flash').replace(/^models\//, '');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.6 }
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gemini: ' + (data.error?.message || r.status));
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text) throw new Error('Gemini returned nothing (it may have blocked the content). Try again.');
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch (e) { throw new Error('Gemini’s answer wasn’t readable. Try again.'); }
}

async function listModels() {
  const key = state.settings.geminiKey.trim() || $('#sKey').value.trim();
  if (!key) { toast('Enter your Gemini key first.'); return; }
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast('Gemini: ' + (data.error?.message || r.status)); return; }
  const models = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/.test(m.name) && !/(image|tts|audio|live|embedding|vision)/i.test(m.name))
    .map(m => m.name.replace(/^models\//, ''));
  fillModelSelect(models, $('#sModel').value || pickDefaultModel(models));
  toast(models.length + ' models loaded.');
}
function pickDefaultModel(models) {
  const flash = models.filter(m => /^gemini-[\d.]+-flash$/.test(m)).sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]));
  return flash[0] || models.find(m => /flash/.test(m)) || models[0] || 'gemini-2.5-flash';
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

What the leader wants you to always know about the nation:
${s.lore.trim() || '(nothing given)'}`;
}
const eventLine = e => `- ${e.title} (${e.tag}; ${e.actor}): ${e.detail}`;

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
"events":[{"title":"short headline","detail":"1-2 sentences: what happened and why it matters to us","actor":"who did it","tag":"Escalation | Diplomacy | Intel | Military | Economy | Domestic | Ultimatum | Other"}],
"summary":"updated running summary of the whole case so far, at most 250 words; keep names, numbers, deadlines and open threats",
"briefs":[{"role":"one of the council roles exactly as written above","brief":"2-3 sentences of advice in character, addressed to the leader"}],
"options":["3 or 4 possible courses of action, 2-5 words each"]}
Break the new material into the distinct things that happened, in order. Merge repetitive chatter. If nothing of substance happened, return an empty events list but still update briefs. Every council member gives a brief.
${militaryRules()}`;
}

const MILITARY_SHAPE = '{"nation":"nation name as used in the RP","strength":0-100,"assets":"key forces in under 12 words","trend":"up | down | steady","note":"one short sentence: why"}';
const MILITARY_RULES = `Military standings: list every nation that is an actor in this case, including "${'${us}'}" (our nation), ranked by current military strength in the RP (100 = overwhelming). Judge only from what the RP, the summary and the context say: posted force sizes, deployments, losses, alliances that commit troops. Keep a nation's previous strength when there is no new information. If a nation's forces are unknown, give your best estimate and say so in the note.`;
function militaryLines(src) {
  const m = src.military || [];
  return m.length ? m.map(x => `- ${x.nation}: ${x.strength ?? '?'} (${x.assets || 'unknown'}; trend ${x.trend || 'steady'})`).join('\n') : '(none assessed yet)';
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
  const out = await gemini(`${councilBlock()}

${sourceContext(src)}

Recent raw material (newest last):
${src.raw.slice(-40).map(i => `${i.author}: ${i.text.slice(0, 1500)}`).join('\n\n') || '(none)'}

Current military standings in this case (update these):
${militaryLines(src)}

${militaryRules()}
Reply with JSON only: {"military":[${MILITARY_SHAPE}]}`);
  const m = cleanMilitary(out.military);
  if (m.length) { src.military = m; src.militaryAt = Date.now(); }
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

Answer as the council. Only the 1-3 members with something useful to say should speak. They may disagree with each other when that is realistic. Be concrete and brief (each reply under 90 words).
Reply with JSON only: {"replies":[{"role":"council role exactly as written above","text":"what they say"}],"options":["optional: up to 4 follow-up courses of action, 2-5 words each"]}`;
}
function sourceContext(src) {
  const c = `CASE FILE: "${src.name}" (${TYPE_LABEL[src.type]})
${src.profile ? 'Context: ' + src.profile + '\n' : ''}Running summary: ${src.summary || '(none yet)'}
Latest events:
${src.events.slice(-15).map(eventLine).join('\n') || '(none)'}
Your latest briefs: ${(src.briefs || []).map(b => b.role + ': ' + b.brief).join(' | ') || '(none)'}`;
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
    if (Array.isArray(out.briefs) && out.briefs.length) src.briefs = out.briefs.map(b => ({ role: String(b.role), brief: String(b.brief) }));
    if (Array.isArray(out.options)) src.options = out.options.map(String).slice(0, 4);
    const mil = cleanMilitary(out.military);
    if (mil.length) { src.military = mil; src.militaryAt = Date.now(); }
    chunks[n].forEach(i => { i.analyzed = true; });
    save(); render();
  }
  toast('Report filed.');
  loadCensus((src.military || []).map(m => m.nation));
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

async function syncAll() {
  const btn = $('#syncAll'); btn.disabled = true; btn.classList.add('spin');
  await loadBanner(true);
  for (const s of state.sources) await syncAndAnalyze(s, { quiet: true });
  btn.disabled = false; btn.classList.remove('spin');
  toast('All files updated.');
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
  try {
    const out = await gemini(`${councilBlock()}

${overviewContext()}

Give the leader a morning briefing across every file: what matters most right now and what to watch.
Reply with JSON only: {"briefs":[{"role":"council role exactly as written above","brief":"2-4 sentences in character"}],"options":["3 or 4 priorities, 2-6 words each"]}`);
    state.overview.briefs = (out.briefs || []).map(b => ({ role: String(b.role), brief: String(b.brief) }));
    state.overview.options = (out.options || []).map(String).slice(0, 4);
  } catch (e) { toast(e.message, 8000); }
  finally { busy.delete('overview'); save(); render(); }
}

/* ---------- rendering ---------- */
function render() {
  const last = Math.max(0, ...state.sources.map(s => s.lastSync || 0));
  $('#nationLine').textContent = !state.settings.nation ? 'SET YOUR NATION IN SETTINGS' : last ? 'LAST SYNC ' + fmtTime(last).toUpperCase() : 'NO REPORTS YET';
  renderBanner(); renderFiles(); renderSheet(); renderCouncil(); renderOrbat();
}

/* Order of Battle: military ranking of every nation in the RP */
function orbatList() {
  const src = current();
  if (src) return { list: src.military || [], src };
  const merged = new Map();
  state.sources.slice().sort((a, b) => (a.militaryAt || 0) - (b.militaryAt || 0))
    .forEach(s => (s.military || []).forEach(m => merged.set(slug(m.nation), { ...m, file: s.name })));
  return { list: [...merged.values()], src: null };
}
function renderOrbat() {
  const el = $('#orbat');
  const { list, src } = orbatList();
  const census = state.census || {};
  const us = [slug(state.settings.nation), slug(state.banner?.name)].filter(Boolean);
  const rows = list.slice().sort((a, b) => b.strength - a.strength || ((census[slug(b.nation)]?.score || 0) - (census[slug(a.nation)]?.score || 0)));
  const arrow = { up: '▲', down: '▼', steady: '■' };
  const trendWord = { up: 'rising', down: 'falling', steady: 'steady' };
  el.innerHTML = `
    <h2 class="label">Order of battle</h2>
    <p class="dim orbat-sub">${src ? 'Military strength in ' + esc(src.name) : 'All RPs combined'}</p>
    ${rows.length ? `<ol class="ranks">${rows.map((m, i) => {
      const c = census[slug(m.nation)];
      const ns = c && !c.missing && c.score ? `NS Defense ${Math.round(c.score).toLocaleString()} · #${c.rank.toLocaleString()} world` : c?.missing ? 'Not a NationStates nation' : '';
      return `<li class="rank-row ${us.includes(slug(m.nation)) ? 'us' : ''}">
        <span class="rank-no">${i + 1}</span>
        <div class="rank-body">
          <div class="rank-top"><b>${esc(m.nation)}</b><span class="trend ${m.trend}" title="${trendWord[m.trend]}" aria-label="${trendWord[m.trend]}">${arrow[m.trend]}</span><span class="score">${m.strength}</span></div>
          <div class="bar" aria-hidden="true"><span style="width:${m.strength}%"></span></div>
          ${m.assets ? `<div class="rank-meta">${esc(m.assets)}</div>` : ''}
          ${m.note ? `<div class="rank-note">${esc(m.note)}</div>` : ''}
          ${ns ? `<div class="rank-ns mono">${esc(ns)}</div>` : ''}
          ${m.file && !src ? `<div class="rank-ns mono">FILE: ${esc(m.file)}</div>` : ''}
        </div>
      </li>`;
    }).join('')}</ol>` : `<p class="dim orbat-sub">${src ? 'Your advisors rank the forces after the next analysis, or press Reassess.' : 'Rankings appear once an RP file has been analyzed.'}</p>`}
    ${src ? `<div class="row wrap">
      <button class="btn ghost small" data-act="reassess" ${busy.has('mil') ? 'disabled' : ''}>${busy.has('mil') ? '<span class="spin">Assessing</span>' : 'Reassess forces'}</button>
      <button class="btn ghost small" data-act="track">+ Track a nation</button>
    </div>` : ''}`;
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
    const stats = [['Category', b.category], ['Region', b.region], ['Population', pop ? (pop >= 1000 ? (pop / 1000).toFixed(2) + ' billion' : pop.toLocaleString() + ' million') : ''], ['Influence', b.influence]].filter(s => s[1]);
    $('#statbar').innerHTML = stats.map(([k, v]) => `<span>${esc(k.toUpperCase())} <b>${esc(v)}</b></span>`).join('');
    $('#statbar').hidden = !stats.length;
  } else {
    $('#pretitle').textContent = 'Office of the Head of State';
    $('#nationName').textContent = n || 'Situation Room';
    $('#motto').textContent = '';
    flag.hidden = true; $('#statbar').hidden = true;
  }
}

function renderFiles() {
  const tabs = [{ id: 'overview', name: 'All files', kind: 'OVERVIEW' },
    ...state.sources.map(s => ({ id: s.id, name: s.name, kind: TYPE_LABEL[s.type], pending: s.raw.filter(i => !i.analyzed).length }))];
  $('#fileList').innerHTML = tabs.map(t => `
    <button class="file-tab ${state.selected === t.id ? 'on' : ''}" data-tab="${t.id}" aria-current="${state.selected === t.id}">
      <span>${esc(t.name)}${t.pending ? `<span class="new">${t.pending} new</span>` : ''}</span>
      <span class="kind">${busy.has(t.id) ? '<span class="spin">reading</span>' : t.kind}</span>
    </button>`).join('');
}

function eventHTML(e, i, showSource) {
  const src = showSource ? state.sources.find(s => s.id === e.source) : null;
  return `<div class="event">
    <div class="no">No. ${i}</div>
    <div class="body">
      <div class="title">${esc(e.title)}</div>
      <div class="detail">${esc(e.detail)}</div>
      <div class="meta">${esc(e.actor)} · ${esc(e.tag)}${e.time ? ' · ' + esc(fmtTime(e.time)) : ''}${src ? ' · file: ' + esc(src.name) : ''}</div>
    </div>
  </div>`;
}

function renderSheet() {
  const el = $('#file');
  const src = current();
  if (!src) {
    const all = state.sources.flatMap(s => s.events).sort((a, b) => (a.time || 0) - (b.time || 0)).slice(-30).reverse();
    el.innerHTML = `
      <div class="sheet-head"><h2 class="typed">Situation overview</h2>
        <div class="sheet-actions"><button class="btn red" data-act="overviewBrief" ${busy.has('overview') ? 'disabled' : ''}>${busy.has('overview') ? '<span class="spin">Convening</span>' : 'Brief me on everything'}</button></div></div>
      ${!state.sources.length ? `<p class="empty">No case files yet. Start with Settings (your nation and Gemini key), then <b>+ Open a new file</b> for your nation, your region, and each RP thread you’re in.</p>` :
        all.length ? all.map((e, i) => eventHTML(e, all.length - i, true)).join('') : '<p class="empty">No events logged yet. Press <b>Request new reports</b>.</p>'}`;
    return;
  }
  const pending = src.raw.filter(i => !i.analyzed).length;
  const isBusy = busy.has(src.id);
  const events = src.events.slice().reverse();
  el.innerHTML = `
    <div class="sheet-head">
      <h2 class="typed">Re: ${esc(src.name)}</h2>
      <span class="muted">${src.lastSync ? 'Last read ' + esc(fmtTime(src.lastSync)) : 'Not read yet'}${pending ? ' · ' + pending + ' unanalyzed' : ''}</span>
    </div>
    ${src.profile ? `<p class="profile">${esc(src.profile)}</p>` : ''}
    <div class="sheet-actions">
      ${src.type !== 'paste' ? `<button class="btn dark" data-act="sync" ${isBusy ? 'disabled' : ''}>${isBusy ? '<span class="spin">Reading</span>' : 'Pull new intel'}</button>` : ''}
      ${pending ? `<button class="btn red" data-act="analyze" ${isBusy ? 'disabled' : ''}>Analyze ${pending} item${pending === 1 ? '' : 's'}</button>` : ''}
      <button class="btn ghost" data-act="rename">Rename</button>
      <button class="btn ghost" data-act="close">Close file</button>
    </div>
    <details class="paste" ${src.type === 'paste' && !src.raw.length ? 'open' : ''}>
      <summary><b>Add intel by hand</b> (Discord messages, a dispatch, your own post)</summary>
      <label for="pasteBox" class="muted">Paste text. Your advisors will add it to this file.</label>
      <textarea id="pasteBox" rows="5"></textarea>
      <div class="row end"><button class="btn red" data-act="paste">File it and analyze</button></div>
    </details>
    ${src.summary ? `<div><b>Story so far</b><div class="summary">${esc(src.summary)}</div></div>` : ''}
    <div><b>Event chain</b> <span class="muted">(newest first)</span></div>
    ${events.length ? events.map((e, i) => eventHTML(e, events.length - i)).join('') : '<p class="empty">No events yet.</p>'}
    <details class="raw"><summary>Raw intel (${src.raw.length})</summary>
      ${src.raw.slice().reverse().slice(0, 150).map(r => `<div class="raw-item"><span class="who">${esc(r.author)}</span> <span class="muted">${esc(fmtTime(r.time))}</span>\n${esc(r.text.slice(0, 2000))}</div>`).join('') || '<p class="empty">Nothing yet.</p>'}
    </details>`;
}

function renderCouncil() {
  const src = current();
  const holder = src || state.overview;
  const briefs = holder.briefs || [];
  $('#briefs').innerHTML = briefs.length
    ? briefs.map(b => `<div class="memo"><div class="from">From: ${esc(b.role)}</div><div class="text">${esc(b.brief)}</div></div>`).join('')
    : `<p class="empty">${src ? 'Your ministers will write here after the first analysis.' : 'Press “Brief me on everything” for a cabinet briefing across all files.'}</p>`;
  $('#options').innerHTML = (holder.options || []).map((o, i) =>
    `<button class="btn ${i === 0 ? 'red' : 'ghost'}" data-option="${esc(o)}">${esc(o)}</button>`).join('');
  $('#chat').innerHTML = (holder.chat || []).map(m => m.role === 'You'
    ? `<div class="msg-you">${esc(m.text)}</div>`
    : `<div class="memo"><div class="from">From: ${esc(m.role)}</div><div class="text">${esc(m.text)}</div></div>`).join('')
    + (busy.has('chat') ? '<p class="muted spin">The cabinet is deliberating</p>' : '');
}

/* ---------- settings ---------- */
function openSettings() {
  const s = state.settings;
  $('#sNation').value = s.nation; $('#sKey').value = s.geminiKey; $('#sLore').value = s.lore; $('#sProxy').value = s.proxy;
  fillModelSelect([], s.model || 'gemini-2.5-flash');
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
  s.nation = $('#sNation').value.trim(); s.geminiKey = $('#sKey').value.trim();
  s.model = $('#sModel').value; s.lore = $('#sLore').value; s.proxy = $('#sProxy').value.trim();
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
    state = { ...fresh(), ...data, settings: { ...fresh().settings, ...data.settings, geminiKey: data.settings.geminiKey || key } };
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
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.selected = tab.dataset.tab; save(); render(); $('#file').scrollIntoView({ block: 'nearest' }); return; }
  const opt = e.target.closest('[data-option]');
  if (opt) { if (!busy.has('chat')) sendDirective('I’m considering: ' + opt.dataset.option + '. Advise me.'); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) { const list = readAdvisorEdit(); list.splice(+rm.dataset.rm, 1); renderAdvisorEdit(list); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const src = current();
  if (act === 'overviewBrief') overviewBrief();
  if (!src) return;
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
  if (act === 'rename') { const n = prompt('New name for this file:', src.name); if (n && n.trim()) { src.name = n.trim(); save(); render(); } }
  if (act === 'close') { if (confirm(`Close “${src.name}”? Its event chain will be removed from this device.`)) { state.sources = state.sources.filter(s => s !== src); state.selected = 'overview'; save(); render(); } }
  if (act === 'paste') {
    const text = $('#pasteBox').value.trim();
    if (!text) { toast('Paste something first.'); return; }
    const id = 'x' + uid();
    src.raw.push({ id, time: Date.now(), author: 'Pasted by the leader', text, analyzed: false }); src.seen.push(id);
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

render();
loadBanner(false);
if (!state.settings.geminiKey && !state.sources.length) setTimeout(openSettings, 300);
