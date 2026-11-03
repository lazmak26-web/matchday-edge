/* Coach Edge — football expert agent tab (sidebar). Talks to POST /api/agent/chat. */
(function () {
  'use strict';
  const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l3.8 2.8-1.4 4.4H9.6l-1.4-4.4z"/><path d="M12 3v4.5M20.6 9.6l-4.8.7M17.4 19l-3-4.3M6.6 19l3-4.3M3.4 9.6l4.8.7"/></svg>';
  const SEND = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const STR = {
    ar: { name: 'Coach Edge', sub: 'خبير الكرة · دارجة · عربية · FR · EN', ph: 'سول على أي فريق أو ماتش…', send: 'إرسال',
      left: n => n + ' سؤال باقي اليوم', think: 'كنقلب على آخر الأخبار…', foot: 'توقعات تقديرية، ماشي ضمان. العب بمسؤولية · +18',
      err: 'وقع مشكل، عاود حاول بعد شوية.', quota: 'سالات الأسئلة ديال اليوم. رجع غدا 👋', off: 'الـ Agent ما مفعلش بعد (ANTHROPIC_API_KEY ناقص ف السيرفر).',
      pro: 'هاد الميزة خاصة بحساب Pro.', login: 'سجّل الدخول باش تستعمل Coach Edge.', open: 'تسجيل الدخول', clear: 'محادثة جديدة', wait: 'بالراحة شوية، بزاف د الرسائل. عاود بعد دقيقة.',
      chips: ['شكون المصابين ف ريال مدريد؟', 'شنو التشكيلة المحتملة ديال برشلونة؟', 'عطيني توقع لماتش اليوم', 'شنو آخر أخبار الانتقالات؟', 'كيفاش كتلعب أسود الأطلس؟', 'واش Over 2.5 ف ماتش اليوم؟'] },
    en: { name: 'Coach Edge', sub: 'Football expert · Darija · AR · FR · EN', ph: 'Ask about any team or match…', send: 'Send',
      left: n => n + ' questions left today', think: 'Checking the latest news…', foot: 'Estimates, not guarantees. Play responsibly · 18+',
      err: 'Something went wrong, try again shortly.', quota: 'Daily question limit reached. Come back tomorrow 👋', off: 'The agent is not configured yet (ANTHROPIC_API_KEY missing on the server).',
      pro: 'This feature is for Pro accounts.', login: 'Log in to use Coach Edge.', open: 'Log in', clear: 'New chat', wait: 'Easy there, too many messages. Try again in a minute.',
      chips: ['Who is injured at Real Madrid?', 'Probable Barcelona line-up and formation?', 'Predict today\'s big match', 'Latest transfer news?', 'How do the Atlas Lions line up?', 'Over 2.5 in today\'s matches?'] },
    fr: { name: 'Coach Edge', sub: 'Expert foot · Darija · AR · FR · EN', ph: 'Pose ta question…', send: 'Envoyer',
      left: n => n + ' questions restantes aujourd\'hui', think: 'Je cherche les dernières infos…', foot: 'Estimations, pas des garanties. Jouez responsable · 18+',
      err: 'Un problème est survenu, réessaie bientôt.', quota: 'Limite quotidienne atteinte. Reviens demain 👋', off: 'L\'agent n\'est pas encore configuré (ANTHROPIC_API_KEY manquante).',
      pro: 'Fonction réservée aux comptes Pro.', login: 'Connecte-toi pour utiliser Coach Edge.', open: 'Connexion', clear: 'Nouvelle discussion', wait: 'Doucement, trop de messages. Réessaie dans une minute.',
      chips: ['Qui est blessé au Real Madrid ?', 'Composition probable du Barça ?', 'Pronostic du gros match du jour', 'Dernières infos mercato ?', 'Comment jouent les Lions de l\'Atlas ?', 'Over 2.5 aujourd\'hui ?'] }
  };
  const S = () => STR[document.documentElement.lang] || STR.ar;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Tiny safe markdown: escape first, then **bold**, `code`, lists, headings, paragraphs.
  function md(src) {
    const inline = t => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = []; let list = null;
    const close = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    for (const raw of String(src).split('\n')) {
      const l = raw.trim(); let m;
      if (!l) { close(); continue; }
      if ((m = l.match(/^#{1,4}\s+(.*)/))) { close(); out.push('<h4>' + inline(m[1]) + '</h4>'); }
      else if ((m = l.match(/^[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); }
      else if ((m = l.match(/^\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); }
      else { close(); out.push('<p>' + inline(l) + '</p>'); }
    }
    close(); return out.join('');
  }

  const state = { built: false, busy: false, history: [], left: null, off: false };
  let root;

  function token() { try { return localStorage.getItem('mde:token'); } catch (e) { return null; } }
  function build() {
    root = document.getElementById('view-agent');
    if (!root) return;
    root.innerHTML = '<div class="ag"><div class="ag-hero"><div class="ag-hrow"><div class="ag-av">' + ICON + '<i></i></div>' +
      '<div class="ag-ttl"><h2></h2><p></p></div><span class="ag-quota" hidden></span></div></div>' +
      '<div class="ag-chips" role="list"></div><div class="ag-log" role="log" aria-live="polite"></div>' +
      '<form class="ag-comp"><textarea class="ag-in" rows="1" maxlength="1500" aria-label="Message"></textarea>' +
      '<button class="ag-send" type="submit" aria-label="Send">' + SEND + '</button></form><p class="ag-foot"></p></div>';
    $('.ag-comp', root).addEventListener('submit', e => { e.preventDefault(); send(); });
    const ta = $('.ag-in', root);
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 130) + 'px'; });
    $('.ag-chips', root).addEventListener('click', e => { const b = e.target.closest('.ag-chip'); if (!b) return; if (b.dataset.new) return reset(); send(b.textContent); });
    state.built = true; paint();
  }
  function paint() {
    if (!root) return; const s = S();
    $('.ag-ttl h2', root).textContent = s.name; $('.ag-ttl p', root).textContent = s.sub;
    $('.ag-in', root).placeholder = s.ph; $('.ag-foot', root).textContent = s.foot;
    const chips = $('.ag-chips', root);
    chips.innerHTML = (state.history.length ? '<button class="ag-chip" data-new="1" type="button">↺ ' + esc(s.clear) + '</button>' : '') + s.chips.map(c => '<button class="ag-chip" type="button">' + esc(c) + '</button>').join('');
    quota();
  }
  function quota() {
    const q = $('.ag-quota', root); if (!q) return;
    if (state.left == null) { q.hidden = true; return; }
    q.hidden = false; q.textContent = S().left(state.left); q.classList.toggle('low', state.left <= 5);
  }
  function add(role, html, cls) {
    const log = $('.ag-log', root), d = document.createElement('div');
    d.className = 'ag-msg ' + (role === 'user' ? 'me' : 'bot');
    d.innerHTML = (role === 'user' ? '' : '<span class="mini"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l3.8 2.8-1.4 4.4H9.6l-1.4-4.4z"/></svg></span>') + '<div class="ag-b ' + (cls || '') + '">' + html + '</div>';
    log.appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' }); return d;
  }
  function reset() { state.history = []; $('.ag-log', root).innerHTML = ''; paint(); }

  async function gate() {
    const s = S(), tk = token();
    if (!tk) { $('.ag-log', root).innerHTML = '<div class="ag-gate">' + esc(s.login) + '<br><button class="btn-main" type="button" onclick="openAuthModal&&openAuthModal()">' + esc(s.open) + '</button></div>'; return false; }
    try {
      const r = await fetch('/api/agent/status', { headers: { Authorization: 'Bearer ' + tk } });
      if (r.status === 403) { $('.ag-log', root).innerHTML = '<div class="ag-gate">' + esc(s.pro) + '<br><button class="btn-main" type="button" onclick="switchTab(\'unlock\')">Unlock Access</button></div>'; return false; }
      if (!r.ok) return true;
      const j = await r.json(); state.left = j.left; state.off = !j.enabled; quota();
      if (state.off) { $('.ag-log', root).innerHTML = '<div class="ag-gate">' + esc(s.off) + '</div>'; return false; }
    } catch (e) { /* offline: let send() report */ }
    return true;
  }

  async function send(text) {
    const ta = $('.ag-in', root), msg = (text || ta.value).trim();
    if (!msg || state.busy) return;
    const s = S(), tk = token(); if (!tk) return gate();
    state.busy = true; $('.ag-send', root).disabled = true; ta.value = ''; ta.style.height = 'auto';
    const gateEl = $('.ag-gate', root); if (gateEl) gateEl.remove();
    add('user', esc(msg)).querySelector('.ag-b').style.whiteSpace = 'pre-wrap';
    state.history.push({ role: 'user', content: msg }); paint();
    const typing = add('bot', '<span class="ag-typing"><i></i><i></i><i></i><em>' + esc(s.think) + '</em></span>');
    try {
      const r = await fetch('/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
        body: JSON.stringify({ message: msg, history: state.history.slice(0, -1).slice(-6), lang: document.documentElement.lang }) });
      const j = await r.json().catch(() => ({}));
      typing.remove();
      if (r.ok && j.reply) {
        state.history.push({ role: 'assistant', content: j.reply }); if (typeof j.left === 'number') state.left = j.left;
        add('bot', md(j.reply)); quota();
      } else {
        state.history.pop();
        const m = j.error === 'quota' ? s.quota : j.error === 'agent_off' ? s.off : r.status === 403 ? s.pro : r.status === 429 ? s.wait : s.err;
        if (j.error === 'quota') { state.left = 0; quota(); }
        add('bot', esc(m), 'err');
      }
    } catch (e) { typing.remove(); state.history.pop(); add('bot', esc(s.err), 'err'); }
    state.busy = false; $('.ag-send', root).disabled = false; ta.focus({ preventScroll: true });
  }

  window.FootballAgent = {
    open() { if (!state.built) build(); else paint(); if (!state.history.length) gate(); },
    close() {},
    reset() { if (state.built) { state.history = []; state.left = null; $('.ag-log', root).innerHTML = ''; paint(); } }
  };
  new MutationObserver(() => { if (state.built) paint(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
