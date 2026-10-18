/* RevIA – démo en ligne : ce service worker remplace le serveur Spring Boot par des réponses
   enregistrées sur une vraie instance de RevIA (fournisseur « demo », règles statiques). */
const BASE = new URL('./', self.location).pathname;
let etat = null;

const MSG_DEMO = "Version de démonstration en ligne : l'analyse fonctionne ici avec le code d'exemple " +
  "(bouton « Essayer avec un exemple »). Pour analyser votre propre code, RevIA s'installe sur votre serveur avec Docker.";
const MSG_ASSISTANT = "Dans la démo en ligne, l'assistant répond aux questions proposées sur la page d'accueil de l'assistant. " +
  "Une fois RevIA installé chez vous avec votre modèle d'IA (OpenAI, Claude, Gemini ou Ollama), il répond à toutes les questions.";

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(charger()); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function norm(s) { return String(s || '').replace(/\r\n/g, '\n').trim(); }

async function charger() {
  if (etat) return etat;
  const f = await (await fetch(BASE + 'fixtures.json', { cache: 'no-cache' })).json();
  // Décale toutes les dates pour que les données aient l'air récentes.
  const jour = 86400000;
  const enreg = new Date(f.recordedAt + 'T00:00:00Z').getTime();
  const auj = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const delta = Math.max(0, Math.round((auj - enreg) / jour)) * jour;
  const decaler = (v) => {
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) { const d = new Date(v); return isNaN(d) ? v : new Date(d.getTime() + delta).toISOString(); }
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { return new Date(new Date(v + 'T00:00:00Z').getTime() + delta).toISOString().slice(0, 10); }
      return v;
    }
    if (Array.isArray(v)) return v.map(decaler);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = decaler(v[k]); return o; }
    return v;
  };
  const F = decaler(f);
  etat = {
    F,
    me: F.get['/api/me'],
    liste: F.get['/api/revues?page=0&taille=200'].contenu.slice(),
    revues: Object.assign({}, F.revues),
    jetons: F.get['/api/jetons'].slice(),
    prochainId: 1 + Math.max(0, ...Object.keys(F.revues).map(Number)),
    prochainPb: 100000,
  };
  return etat;
}

function json(corps, status = 200) {
  return new Response(corps === undefined ? null : JSON.stringify(corps), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function erreur(status, message, code = 'DEMO') { return json({ code, message, status }, status); }

function sse(texte) {
  const blocs = texte.replace(/\r\n/g, '\n').split('\n\n').filter((b) => b.trim());
  const enc = new TextEncoder();
  const flux = new ReadableStream({
    async start(c) {
      for (const b of blocs) {
        c.enqueue(enc.encode(b + '\n\n'));
        await new Promise((r) => setTimeout(r, b.startsWith('event:fin') || b.startsWith('event: fin') ? 0 : 25));
      }
      c.close();
    },
  });
  return new Response(flux, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function sseTexte(texte, info) {
  const morceaux = texte.match(/[\s\S]{1,40}/g) || [];
  return morceaux.map((m) => 'event:morceau\ndata:' + JSON.stringify({ t: m })).join('\n\n') +
    '\n\nevent:fin\ndata:' + JSON.stringify(info) + '\n\n';
}

function infoFin(E) {
  for (const x of E.F.flux) {
    const m = x.sse.match(/event:\s*fin\s*\ndata:\s*(.*)/);
    if (m) { try { return JSON.parse(m[1]); } catch { /* suivant */ } }
  }
  return { outil: 'chat', langage: null, nbMasquages: 0, dureeMs: 12, fournisseur: 'demo', modele: 'revia-regles-statiques-1.0' };
}

function resume(d) {
  return { id: d.id, titre: d.titre, langage: d.langage, creeLe: d.creeLe, score: d.score,
    nbProblemes: d.problemes.filter((p) => !p.fauxPositif).length,
    nbCritiques: d.problemes.filter((p) => p.gravite === 'critique' && !p.fauxPositif).length, statut: d.statut };
}

function trouverProbleme(E, id) {
  for (const k in E.revues) {
    const p = E.revues[k].problemes.find((x) => x.id === id);
    if (p) return p;
  }
  return null;
}

function sarif(d) {
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
    runs: [{ tool: { driver: { name: 'RevIA', informationUri: 'https://nafissabridah.github.io/revia-demo/' } },
      results: d.problemes.filter((p) => !p.fauxPositif).map((p) => ({
        ruleId: p.owasp || p.categorie, level: p.gravite === 'critique' || p.gravite === 'majeure' ? 'error' : 'warning',
        message: { text: p.titre + ' – ' + p.explication },
        locations: [{ physicalLocation: { artifactLocation: { uri: d.titre }, region: { startLine: p.ligne } } }] })) }],
  }, null, 2);
}

function filtrer(E, q) {
  let l = E.liste.slice();
  const txt = (q.get('q') || '').toLowerCase();
  if (txt) l = l.filter((r) => r.titre.toLowerCase().includes(txt));
  if (q.get('langage')) l = l.filter((r) => r.langage === q.get('langage'));
  const min = q.get('scoreMin'), max = q.get('scoreMax');
  if (min !== null && min !== '') l = l.filter((r) => r.score >= +min);
  if (max !== null && max !== '') l = l.filter((r) => r.score <= +max);
  if (q.get('statut')) l = l.filter((r) => r.statut === q.get('statut'));
  const j = +(q.get('jours') || 0);
  if (j > 0) { const lim = Date.now() - j * 86400000; l = l.filter((r) => new Date(r.creeLe).getTime() >= lim); }
  const tri = q.get('tri') || '';
  if (/score.*(asc|croiss)/i.test(tri)) l.sort((a, b) => a.score - b.score);
  else if (/score/i.test(tri)) l.sort((a, b) => b.score - a.score);
  else if (/ancien|asc/i.test(tri)) l.sort((a, b) => a.creeLe.localeCompare(b.creeLe));
  else l.sort((a, b) => b.creeLe.localeCompare(a.creeLe));
  const page = +(q.get('page') || 0), taille = +(q.get('taille') || 8);
  return { contenu: l.slice(page * taille, (page + 1) * taille), page, taille, total: l.length, pages: Math.max(1, Math.ceil(l.length / taille)) };
}

async function repondre(req, url) {
  const E = await charger();
  const p = url.pathname, m = req.method, q = url.searchParams;
  let corps = null;
  if (m === 'POST' || m === 'PUT') { try { corps = await req.clone().json(); } catch { corps = {}; } }
  let r;

  if (m === 'POST' && (p === '/api/auth/login' || p === '/api/auth/register')) {
    const l = JSON.parse(JSON.stringify(E.F.login));
    l.utilisateur = E.me; l.token = 'demo-' + Date.now(); l.expireDansSecondes = 86400;
    return json(l);
  }
  if (p === '/api/me' && m === 'GET') return json(E.me);
  if (p === '/api/me' && m === 'PUT') { E.me = Object.assign({}, E.me, { nom: corps.nom || E.me.nom }); return json(E.me); }
  if (p === '/api/me/mot-de-passe') return new Response(null, { status: 204 });
  if (p === '/api/systeme/info') return json(req.headers.get('Authorization') ? E.F.get['/api/systeme/info'] : E.F.get['/api/systeme/info#anon']);
  if (p === '/api/tableau-de-bord') return json(E.F.get['/api/tableau-de-bord?jours=' + (q.get('jours') || '30')] || E.F.get['/api/tableau-de-bord?jours=30']);

  if (p === '/api/jetons' && m === 'GET') return json(E.jetons);
  if (p === '/api/jetons' && m === 'POST') {
    const c = JSON.parse(JSON.stringify(E.F.jetonCree));
    c.jeton.id = 9000 + E.jetons.length; c.jeton.nom = corps.nom || c.jeton.nom; c.jeton.creeLe = new Date().toISOString();
    E.jetons.push(c.jeton); return json(c, 201);
  }
  if ((r = p.match(/^\/api\/jetons\/(\d+)$/)) && m === 'DELETE') { E.jetons = E.jetons.filter((j) => j.id !== +r[1]); return new Response(null, { status: 204 }); }

  if (p === '/api/revues' && m === 'GET') return json(filtrer(E, q));
  if (p === '/api/revues/export.csv') return new Response(E.F.csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
  if ((r = p.match(/^\/api\/revues\/(\d+)\/sarif$/))) {
    const d = E.revues[r[1]]; if (!d) return erreur(404, 'Revue introuvable.', 'INTROUVABLE');
    return new Response(E.F.sarif[r[1]] || sarif(d), { headers: { 'Content-Type': 'application/sarif+json' } });
  }
  if ((r = p.match(/^\/api\/revues\/(\d+)$/))) {
    if (m === 'DELETE') { delete E.revues[r[1]]; E.liste = E.liste.filter((x) => x.id !== +r[1]); return new Response(null, { status: 204 }); }
    const d = E.revues[r[1]]; return d ? json(d) : erreur(404, 'Revue introuvable.', 'INTROUVABLE');
  }
  if (p === '/api/revues' && m === 'POST') {
    const c = norm(corps.code);
    const cands = E.F.soumettre.filter((s) => norm(s.code) === c);
    const s = cands.find((x) => x.mode === corps.mode && x.langage === corps.langage) || cands.find((x) => x.mode === corps.mode) || cands[0];
    if (!s) return erreur(422, MSG_DEMO);
    const d = JSON.parse(JSON.stringify(s.resp));
    d.id = E.prochainId++; d.titre = corps.titre || d.titre; d.creeLe = new Date().toISOString();
    d.problemes.forEach((x) => { x.id = E.prochainPb++; });
    E.revues[d.id] = d; E.liste.unshift(resume(d));
    E.me = Object.assign({}, E.me, { nbRevues: (E.me.nbRevues || 0) + 1, revuesDuJour: (E.me.revuesDuJour || 0) + 1 });
    return json(d, 201);
  }
  if (p === '/api/essai' && m === 'POST') {
    const s = E.F.essai.find((x) => norm(x.code) === norm(corps.code));
    return s ? json(s.resp) : erreur(422, MSG_DEMO);
  }
  if ((r = p.match(/^\/api\/problemes\/(\d+)\/(faux-positif|corrige|utile)$/))) {
    const pb = trouverProbleme(E, +r[1]); if (!pb) return erreur(404, 'Problème introuvable.', 'INTROUVABLE');
    pb[{ 'faux-positif': 'fauxPositif', corrige: 'corrige', utile: 'utile' }[r[2]]] = corps.valeur;
    return json(pb);
  }
  if ((r = p.match(/^\/api\/problemes\/(\d+)\/correction\/copie$/))) {
    const pb = trouverProbleme(E, +r[1]);
    if (!pb || !pb.correction) return erreur(404, 'Correction introuvable.', 'INTROUVABLE');
    pb.correction.copiee = true; return json({ code: pb.correction.codeApres });
  }
  if (p === '/api/assistant/chat/flux') {
    const msgs = (corps.messages || []).filter((x) => x.role === 'utilisateur');
    const der = norm(msgs.length ? msgs[msgs.length - 1].contenu : '');
    const s = E.F.flux.find((x) => x.url === p && norm(x.cle) === der);
    if (s) return sse(s.sse);
    if (corps.code) { const g = E.F.flux.find((x) => x.cle === '*generique*'); if (g) return sse(g.sse); }
    return sse(sseTexte(MSG_ASSISTANT, infoFin(E)));
  }
  if ((r = p.match(/^\/api\/assistant\/outils\/(\w+)\/flux$/))) {
    const cands = E.F.flux.filter((x) => x.url === p && norm(x.cle) === norm(corps.code));
    const s = cands.find((x) => (x.cible || null) === (corps.cible || null)) || cands[0];
    if (s) return sse(s.sse);
    return sse(sseTexte(MSG_DEMO.replace("l'analyse fonctionne", 'les outils fonctionnent'), Object.assign(infoFin(E), { outil: r[1] })));
  }
  if (p.startsWith('/api/admin')) return erreur(403, "L'administration n'est pas ouverte dans la démo en ligne.", 'INTERDIT');
  return erreur(404, 'Ressource indisponible dans la démo en ligne.', 'INTROUVABLE');
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    e.respondWith(repondre(e.request, url).catch(() => erreur(500, "Une erreur inattendue s'est produite dans la démo.")));
  }
});
