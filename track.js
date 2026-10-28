// BirdFrame site: waitlist dialog, first-party events and the Meta pixel.
// Event contract: BirdFrame/analytics/EVENTS.md ("Website"). Backend: analytics/website/waitlist.gs.
(() => {
  const ENDPOINT = 'https://script.google.com/macros/s/AKfycbxPtbFPqPdkhFrhk3cLJ2hblnX10RbqNf0tjJgeY8KeFnsjl_jLo36XIA6HU0cNGjmwdA/exec'; // Apps Script web app (analytics/website/waitlist.gs)
  const PIXEL_ID = '1664656798359783'; // Meta dataset "BirdFrame website" in the BirdFrame business portfolio
  const PT = '127908484'; // App Store Connect provider token (from the campaign links made in ASC, 26 Oct); enables campaign links (pt/ct)

  const ses = {
    get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
  };
  const local = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  // Where this visit came from: UTM tags, else the referring site. Kept for the browser session only.
  const q = new URLSearchParams(location.search);
  const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  let ref = '';
  try { ref = document.referrer ? new URL(document.referrer).host : ''; } catch (e) {}
  if (ref === location.host) ref = '';
  const tagged = {};
  UTM.forEach(k => { if (q.get(k)) tagged[k] = q.get(k).slice(0, 100); });
  if (Object.keys(tagged).length) ses.set('bf_touch', JSON.stringify(tagged));
  else if (ref && !ses.get('bf_touch')) ses.set('bf_touch', JSON.stringify({ utm_source: ref, utm_medium: 'referral' }));
  if (q.get('fbclid')) ses.set('bf_fb', '1');
  if (!ses.get('bf_sid')) ses.set('bf_sid', Math.random().toString(36).slice(2, 12));
  if (!ses.get('bf_land')) ses.set('bf_land', location.pathname);

  const ua = navigator.userAgent;
  const device = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ipad'
    : /iPhone|iPod/.test(ua) ? 'iphone' : /Android/.test(ua) ? 'android'
    : /Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other';
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '');

  function context() {
    let t = {};
    try { t = JSON.parse(ses.get('bf_touch') || '{}'); } catch (e) {}
    return Object.assign({}, t, {
      ref, page: location.pathname, device, tz, lang: navigator.language || '',
      fb: ses.get('bf_fb') || '', sid: ses.get('bf_sid'), first_touch: ses.get('bf_land'),
    });
  }

  function send(type, extra, wait) {
    if (!ENDPOINT) return Promise.resolve({ ok: false });
    const body = JSON.stringify(Object.assign({ type }, context(), extra || {}));
    const opts = { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true };
    if (!wait) return fetch(ENDPOINT, Object.assign(opts, { mode: 'no-cors' })).catch(() => {});
    // Apps Script occasionally stalls; after 12 s resend blind (the backend dedupes) rather than leave the form spinning.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    return fetch(ENDPOINT, Object.assign({}, opts, { signal: ctl.signal, keepalive: false }))
      .then(r => r.json())
      .catch(err => {
        if (err.name !== 'AbortError') throw err;
        return fetch(ENDPOINT, Object.assign(opts, { mode: 'no-cors' })).then(() => ({ ok: true }));
      })
      .finally(() => clearTimeout(timer));
  }

  // Meta pixel. Visitors in Europe (by time zone) are asked first; Global Privacy Control means no.
  const inEurope = /^Europe\//.test(tz);
  let adsChoice = navigator.globalPrivacyControl ? 'no' : local.get('bf_ads') || (inEurope ? '' : 'yes');
  function loadPixel() {
    if (!PIXEL_ID || window.fbq) return;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    fbq('init', PIXEL_ID);
    fbq('track', 'PageView');
  }
  const pixel = (...args) => { if (window.fbq) fbq(...args); };
  if (adsChoice === 'yes') loadPixel();
  else if (adsChoice === '' && PIXEL_ID) {
    const bar = document.createElement('div');
    bar.className = 'consent';
    bar.innerHTML = '<span>Allow Meta to measure our ads on this site?</span><button class="btn ghost" data-v="no">No thanks</button><button class="btn" data-v="yes">Allow</button>';
    bar.addEventListener('click', e => {
      const v = e.target.dataset && e.target.dataset.v;
      if (!v) return;
      local.set('bf_ads', v);
      adsChoice = v;
      bar.remove();
      if (v === 'yes') loadPixel();
    });
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));
  }

  if (!ses.get('bf_visit')) { ses.set('bf_visit', '1'); send('visit'); }

  // App Store links: add campaign tags when we have a provider token, and count clicks.
  function storeLink(href) {
    if (!PT) return href;
    const t = context();
    const ct = [t.utm_source || 'direct', t.utm_campaign, t.utm_content].filter(Boolean).join('-').replace(/[^\w.-]/g, '_').slice(0, 40);
    const u = new URL(href);
    u.searchParams.set('pt', PT); u.searchParams.set('ct', ct); u.searchParams.set('mt', '8');
    return u.toString();
  }
  window.bfStoreLink = storeLink;
  window.bfSend = send;
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="https://apps.apple.com"]');
    if (!a) return;
    // A link that names its own campaign (e.g. ct=ja-site on /ja/) keeps it; other links get one from this visit.
    if (!/[?&]ct=/.test(a.href)) a.href = storeLink(a.href.split('?')[0]);
    const target = a.dataset.cta || (a.closest('nav') ? 'nav' : a.closest('.hero') ? 'hero' : a.closest('#pricing') ? 'pricing' : 'other');
    send('app_store_click', { target });
    pixel('trackCustom', 'AppStoreClick', { placement: target });
  }, true);

  // Waitlist: any element with data-waitlist="windows" or "mac_link" opens the dialog;
  // a form with data-waitlist-form="…" signs up inline.
  const JA = document.documentElement.lang === 'ja'; // the Japanese page (/ja/) gets Japanese dialog text
  const COPY = JA ? {
    windows: { h: 'Windows 版は準備中です', p: 'メールアドレスを登録すると、公開したときにお知らせします。お送りするのはその1通だけです。', b: '登録する', done: '登録しました。公開したらメールでお知らせします。' },
    mac_link: { h: 'Mac 用のリンクを受け取る', p: 'Mac で開けるダウンロードリンクをメールでお送りします。', b: 'リンクを送る', done: '送信しました。Mac でメールを確認してください。' },
  } : {
    windows: { h: 'BirdFrame for Windows is coming soon', p: 'Leave your email and we\'ll tell you when it\'s out. One email, nothing else.', b: 'Notify me', done: 'You\'re on the list. We\'ll email you when it\'s out.' },
    mac_link: { h: 'Get the link on your Mac', p: 'We\'ll email you the download link to open on your Mac.', b: 'Email me the link', done: 'Sent. Check your inbox on your Mac.' },
  };
  const ERR = JA ? { email: 'メールアドレスを確認してください。', other: '送信できませんでした。birdframe.app@gmail.com までメールでご連絡ください。' }
    : { email: 'That email doesn\'t look right.', other: 'Something went wrong. Please email birdframe.app@gmail.com instead.' };
  function formHTML(list) {
    const c = COPY[list];
    return '<input type="email" name="email" required autocomplete="email" placeholder="you@example.com" aria-label="Email">' +
      '<input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<button class="btn" type="submit">' + c.b + '</button><p class="wl-msg" role="status"></p>';
  }
  function wire(form, list) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      const msg = form.querySelector('.wl-msg');
      const email = form.email.value.trim();
      btn.disabled = true; msg.textContent = '';
      send('signup', { list, email, website: form.website.value }, true)
        .then(r => {
          if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
          pixel('track', 'Lead', { content_name: list });
          form.classList.add('done');
          msg.textContent = COPY[list].done;
        })
        .catch(err => {
          btn.disabled = false;
          msg.textContent = err.message === 'email' ? ERR.email : ERR.other;
        });
    });
  }
  let dialog;
  function open(list) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'wl';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    }
    const c = COPY[list];
    dialog.innerHTML = '<button class="wl-x" aria-label="Close" type="button">×</button><h3>' + c.h + '</h3><p>' + c.p + '</p><form class="wl-form">' + formHTML(list) + '</form>';
    dialog.querySelector('.wl-x').onclick = () => dialog.close();
    wire(dialog.querySelector('form'), list);
    dialog.showModal();
    dialog.querySelector('input[type=email]').focus();
    send('waitlist_open', { target: list });
  }
  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-waitlist]');
    if (!t || !ENDPOINT || !COPY[t.dataset.waitlist] || typeof HTMLDialogElement !== 'function') return; // no backend: the mailto link still works
    e.preventDefault();
    open(t.dataset.waitlist);
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form[data-waitlist-form]').forEach(f => {
      const list = f.dataset.waitlistForm;
      f.innerHTML = formHTML(list);
      wire(f, list);
    });
    // Windows visitors can't use the Mac app yet: lead with the Windows list.
    if (device === 'windows') document.querySelectorAll('[data-windows-swap]').forEach(a => {
      a.removeAttribute('href');
      a.setAttribute('role', 'button');
      a.dataset.waitlist = 'windows';
      a.textContent = a.dataset.windowsSwap;
    });
    if (q.get('waitlist') && COPY[q.get('waitlist')]) open(q.get('waitlist'));
  });
})();
