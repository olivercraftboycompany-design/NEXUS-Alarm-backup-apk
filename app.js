/* NEXUS Alarm - alarms, reminders, timer, stopwatch. Data lives on this phone only (localStorage nxalarm_*). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('nxalarm_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('nxalarm_' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MISS_MS = 10 * 60 * 1000;          // ring if we're up to 10 min late (e.g. app reopened)
  var NTFY_WINDOW = 70 * 3600 * 1000;    // ntfy holds scheduled messages up to 3 days
  var APP_URL = location.href.split('?')[0].split('#')[0];

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function now() { return Date.now(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function h12(h) { return (h % 12) || 12; }
  function ap(h) { return h < 12 ? 'AM' : 'PM'; }
  function fmtTime(d) { return h12(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + ap(d.getHours()); }
  function fmtHM(h, m) { return h12(h) + ':' + pad(m) + ' ' + ap(h); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function dayWord(ts) {
    var d = new Date(ts), t = new Date(), tm = new Date(); tm.setDate(tm.getDate() + 1);
    if (sameDay(d, t)) return 'Today';
    if (sameDay(d, tm)) return 'Tomorrow';
    var diff = (ts - now()) / 86400000;
    if (diff > 0 && diff < 6) return DAYN[d.getDay()];
    return DAYN[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate();
  }
  function fmtWhen(ts) { return dayWord(ts) + ' ' + fmtTime(new Date(ts)); }
  function fmtIn(ms) {
    if (ms < 0) ms = 0;
    var m = Math.ceil(ms / 60000);
    if (m < 1) return 'less than a minute';
    var d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + mm + 'm';
    return mm + ' min';
  }
  var toastT;
  function toast(msg, ms) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, ms || 2600); }

  /* ---------------- state ---------------- */
  var alarms = LS.get('alarms', []);
  var reminders = LS.get('reminders', []);
  var settings = LS.get('settings', {});
  if (!settings.topic) {
    var a = new Uint8Array(10); crypto.getRandomValues(a);
    settings.topic = 'nxalarm-' + Array.prototype.map.call(a, function (b) { return pad2h(b); }).join('');
  }
  function pad2h(b) { return (b < 16 ? '0' : '') + b.toString(16); }
  if (settings.wake == null) settings.wake = true;
  if (settings.vol == null) settings.vol = 100;
  if (settings.ntfy == null) settings.ntfy = false;
  LS.set('settings', settings);
  var timer = LS.get('timer', { dur: 300000, end: 0, left: 300000, running: false });
  var sw = LS.get('stopwatch', { start: 0, acc: 0, running: false, laps: [] });
  function saveAlarms() { LS.set('alarms', alarms); }
  function renderAll() { renderAlarms(); renderClock(); }
  function saveRems() { LS.set('reminders', reminders); }
  function saveSettings() { LS.set('settings', settings); }
  function saveTimer() { LS.set('timer', timer); }
  function saveSw() { LS.set('stopwatch', sw); }

  /* ---------------- alarm math ---------------- */
  function nextOcc(al, from) {
    var base = new Date(from);
    for (var i = 0; i < 8; i++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, al.h, al.m, 0, 0);
      if (d.getTime() <= from) continue;
      if (!al.days || !al.days.length || al.days.indexOf(d.getDay()) >= 0) return d.getTime();
    }
    return null;
  }
  function occsWithin(al, from, until) {
    var out = [], t = from;
    if (!al.days || !al.days.length) { if (al.armedAt && al.armedAt > from && al.armedAt <= until) out.push(al.armedAt); return out; }
    for (var i = 0; i < 6; i++) { var n = nextOcc(al, t); if (!n || n > until) break; out.push(n); t = n; }
    return out;
  }
  function arm(al) { al.armedAt = al.enabled ? nextOcc(al, now()) : null; }
  function repeatText(al) {
    var d = al.days || [];
    if (!d.length) return 'Once';
    if (d.length === 7) return 'Every day';
    var s = d.slice().sort().join('');
    if (s === '12345') return 'Weekdays';
    if (s === '06') return 'Weekends';
    var order = [1, 2, 3, 4, 5, 6, 0];
    return order.filter(function (x) { return d.indexOf(x) >= 0; }).map(function (x) { return DAYN[x]; }).join(' ');
  }
  function nextAlarm() {
    var best = null;
    alarms.forEach(function (al) {
      if (!al.enabled && !al.snoozeAt) return;
      var t = al.snoozeAt || (al.enabled ? al.armedAt : null);
      if (t && (!best || t < best.t)) best = { t: t, al: al };
    });
    return best;
  }

  /* ---------------- audio ---------------- */
  var ctx = null, master = null;
  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC(); master = ctx.createGain(); master.gain.value = 1;
      var comp = ctx.createDynamicsCompressor(); comp.threshold.value = -6;
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function unlock() { var c = audio(); if (c) { var o = c.createOscillator(), g = c.createGain(); g.gain.value = 0.0001; o.connect(g); g.connect(master); o.start(); o.stop(c.currentTime + 0.05); } }
  document.addEventListener('pointerdown', function first() { unlock(); document.removeEventListener('pointerdown', first, true); }, true);

  function note(dest, t, f, dur, type, vol, opts) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(f, t);
    if (opts && opts.to) o.frequency.linearRampToValueAtTime(opts.to, t + dur);
    var v = vol == null ? 0.5 : vol, atk = (opts && opts.atk) || 0.008, dec = opts && opts.decay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + atk);
    if (dec) g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    else { g.gain.setValueAtTime(v, t + dur - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
  }
  var SOUNDS = {
    classic: { name: 'Classic beep', len: 1.0, play: function (d, t) { for (var i = 0; i < 4; i++) note(d, t + i * 0.14, 2000, 0.08, 'square', 0.35); } },
    digital: { name: 'Digital', len: 0.8, play: function (d, t) { note(d, t, 1050, 0.1, 'square', 0.32); note(d, t + 0.15, 1250, 0.1, 'square', 0.32); note(d, t + 0.3, 1050, 0.1, 'square', 0.32); note(d, t + 0.45, 1250, 0.1, 'square', 0.32); } },
    rise: { name: 'Rise and shine', len: 1.6, play: function (d, t) { [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5].forEach(function (f, i) { note(d, t + i * 0.18, f, 0.3, 'triangle', 0.6, { decay: true }); }); } },
    chime: { name: 'Chime', len: 2.2, play: function (d, t) { [[1318.5, 0], [987.77, 0.5], [1174.7, 1.0]].forEach(function (p) { note(d, t + p[1], p[0], 1.2, 'sine', 0.6, { decay: true }); note(d, t + p[1], p[0] * 2.01, 0.6, 'sine', 0.15, { decay: true }); }); } },
    siren: { name: 'Siren (loud)', len: 1.4, play: function (d, t) { note(d, t, 650, 0.7, 'sawtooth', 0.28, { to: 1300 }); note(d, t + 0.7, 1300, 0.7, 'sawtooth', 0.28, { to: 650 }); } },
    radar: { name: 'Radar', len: 1.2, play: function (d, t) { for (var i = 0; i < 3; i++) note(d, t + i * 0.2, 1568, 0.16, 'sine', 0.6, { decay: true }); } },
    pulse: { name: 'Deep pulse', len: 0.9, play: function (d, t) { note(d, t, 440, 0.25, 'triangle', 0.7); note(d, t + 0.35, 440, 0.25, 'triangle', 0.7); } }
  };
  var loop = null;
  function startTone(key, opts) {
    var c = audio(); if (!c) return;
    stopTone();
    var snd = SOUNDS[key] || SOUNDS.classic;
    var bus = c.createGain(); bus.connect(master);
    var vol = (settings.vol || 100) / 100;
    if (opts && opts.ramp) { bus.gain.setValueAtTime(vol * 0.15, c.currentTime); bus.gain.linearRampToValueAtTime(vol, c.currentTime + 30); }
    else bus.gain.value = vol;
    var next = c.currentTime + 0.05, until = opts && opts.seconds ? c.currentTime + opts.seconds : Infinity;
    function pump() {
      while (next < c.currentTime + 0.6 && next < until) { snd.play(bus, next); next += snd.len + 0.25; }
      if (next >= until && c.currentTime > until) stopTone();
    }
    pump();
    loop = { iv: setInterval(pump, 150), bus: bus };
  }
  function stopTone() {
    if (!loop) return;
    clearInterval(loop.iv);
    try { loop.bus.gain.cancelScheduledValues(ctx.currentTime); loop.bus.gain.setValueAtTime(0, ctx.currentTime); loop.bus.disconnect(); } catch (e) {}
    loop = null;
  }

  /* ---------------- ringing screen ---------------- */
  var ringingNow = null, ringQueue = [], vibeIv = null, ringAuto = null;
  function ring(item) {
    if (ringingNow) { ringQueue.push(item); return; }
    ringingNow = item;
    $('rTime').textContent = fmtTime(new Date());
    $('rTitle').textContent = item.title;
    $('rSub').textContent = item.sub || '';
    $('rSnooze').textContent = item.snoozeLabel || 'Snooze';
    $('rSnooze').hidden = !item.onSnooze;
    $('rStop').textContent = item.stopLabel || 'Stop';
    $('ringing').hidden = false;
    startTone(item.sound || 'classic', { ramp: item.kind === 'alarm' && settings.ramp });
    if (item.vibe !== false && navigator.vibrate) {
      navigator.vibrate([700, 300, 700, 300, 700]);
      vibeIv = setInterval(function () { navigator.vibrate([700, 300, 700, 300, 700]); }, 3200);
    }
    notify(item.title, item.sub || fmtTime(new Date()), item.tag);
    clearTimeout(ringAuto);
    ringAuto = setTimeout(function () { if (ringingNow === item) endRing('auto'); }, 10 * 60 * 1000); // stop after 10 min
    document.title = '\u23F0 ' + item.title;
  }
  function endRing(how) {
    var item = ringingNow; if (!item) return;
    stopTone(); clearInterval(vibeIv); clearTimeout(ringAuto); if (navigator.vibrate) navigator.vibrate(0);
    $('ringing').hidden = true; ringingNow = null; document.title = 'NEXUS Alarm';
    if (how === 'snooze' && item.onSnooze) item.onSnooze();
    else if (item.onStop) item.onStop(how);
    if (ringQueue.length) setTimeout(function () { ring(ringQueue.shift()); }, 400);
  }
  $('rStop').addEventListener('click', function () { endRing('stop'); });
  $('rSnooze').addEventListener('click', function () { endRing('snooze'); });

  function ringAlarm(al) {
    ring({
      kind: 'alarm', tag: 'a' + al.id, title: al.label || 'Alarm', sub: fmtHM(al.h, al.m) + (al.days && al.days.length ? ' \u00B7 ' + repeatText(al) : ''),
      sound: al.sound, vibe: al.vibe !== false, snoozeLabel: 'Snooze ' + (al.snooze || 9) + ' min',
      onSnooze: function () { al.snoozeAt = now() + (al.snooze || 9) * 60000; saveAlarms(); renderAll(); ntfySync(); toast('Snoozed ' + (al.snooze || 9) + ' min'); },
      onStop: function () { al.snoozeAt = null; saveAlarms(); renderAll(); ntfySync(); }
    });
  }
  function ringReminder(r) {
    ring({
      kind: 'rem', tag: 'r' + r.id, title: r.note || 'Reminder', sub: 'Reminder \u00B7 ' + fmtTime(new Date(r.at)), sound: 'chime',
      stopLabel: 'Done', snoozeLabel: 'Remind me in 10 min',
      onSnooze: function () { r.at = now() + 600000; r.fired = false; saveRems(); renderRems(); ntfySync(); toast('Okay, in 10 min'); },
      onStop: function (how) { if (how !== 'auto') { r.done = true; r.doneAt = now(); } saveRems(); renderRems(); renderClock(); ntfySync(); }
    });
  }

  /* ---------------- notifications ---------------- */
  function notify(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var opts = { body: body, tag: tag || 'nxalarm', renotify: true, requireInteraction: true, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', vibrate: [500, 200, 500] };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (reg) { return reg.showNotification(title, opts); }).catch(function () { try { new Notification(title, opts); } catch (e) {} });
    } else { try { new Notification(title, opts); } catch (e) {} }
  }

  /* ---------------- tick ---------------- */
  function tick() {
    var t = now(), changed = false;
    alarms.forEach(function (al) {
      if (al.snoozeAt && t >= al.snoozeAt) {
        var late = t - al.snoozeAt; al.snoozeAt = null; changed = true;
        if (late < MISS_MS) ringAlarm(al);
      }
      if (!al.enabled) return;
      if (al.armedAt && t >= al.armedAt) {
        var lateBy = t - al.armedAt; changed = true;
        if (!al.days || !al.days.length) { al.enabled = false; al.armedAt = null; } else al.armedAt = nextOcc(al, t);
        if (lateBy < MISS_MS) ringAlarm(al); else toast('Missed alarm: ' + (al.label || fmtHM(al.h, al.m)), 5000);
      }
      if (al.enabled && !al.armedAt) { arm(al); changed = true; }
    });
    if (changed) { saveAlarms(); renderAlarms(); ntfySync(); }
    var rc = false;
    reminders.forEach(function (r) {
      if (!r.done && !r.fired && t >= r.at) { r.fired = true; rc = true; if (t - r.at < 6 * 3600000) ringReminder(r); }
    });
    if (rc) { saveRems(); renderRems(); }
    if (timer.running && t >= timer.end) {
      timer.running = false; timer.left = 0; timer.end = 0; saveTimer(); renderTimer();
      ring({ kind: 'timer', tag: 'timer', title: 'Timer done', sub: fmtDur(timer.dur) + ' timer', sound: 'digital', stopLabel: 'Stop', snoozeLabel: '+1 minute',
        onSnooze: function () { timer.dur = 60000; timer.left = 60000; timer.end = now() + 60000; timer.running = true; saveTimer(); renderTimer(); ntfySync(); },
        onStop: function () { timer.left = timer.dur; saveTimer(); renderTimer(); ntfySync(); } });
    }
    renderClock();
    if (timer.running) renderTimer();
  }

  /* ---------------- render: clock ---------------- */
  var lastMin = -1;
  function renderClock() {
    var d = new Date(), h = d.getHours();
    $('cTime').textContent = h12(h) + ':' + pad(d.getMinutes());
    $('cSec').textContent = pad(d.getSeconds());
    $('cAmpm').textContent = ap(h);
    $('cDate').textContent = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ', ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()] + ' ' + d.getDate();
    var n = nextAlarm();
    var main = n ? 'Alarm in ' + fmtIn(n.t - now()) : 'No alarms on';
    var sub = n ? (n.al.snoozeAt ? 'Snoozed \u00B7 ' : '') + fmtWhen(n.t) + (n.al.label ? ' \u00B7 ' + n.al.label : '') : 'Tap to add one';
    $('nextMain').textContent = main; $('nextSub').textContent = sub;
    $('alarmCountdown').textContent = n ? main : '';
    var up = reminders.filter(function (r) { return !r.done; }).sort(function (a, b) { return a.at - b.at; });
    if (up.length) { $('nextRemMain').textContent = up[0].note || 'Reminder'; $('nextRemSub').textContent = (up[0].at < now() ? 'Due ' : 'In ' + fmtIn(up[0].at - now()) + ' \u00B7 ') + fmtWhen(up[0].at) + (up.length > 1 ? ' \u00B7 +' + (up.length - 1) + ' more' : ''); }
    else { $('nextRemMain').textContent = 'No reminders'; $('nextRemSub').textContent = 'Tap to add one'; }
    if (!$('night').hidden) {
      $('nTime').textContent = h12(h) + ':' + pad(d.getMinutes()); $('nAmpm').textContent = ap(h);
      $('nDate').textContent = $('cDate').textContent;
      $('nNext').textContent = n ? '\u23F0 ' + fmtWhen(n.t) + ' \u00B7 in ' + fmtIn(n.t - now()) : 'No alarm set';
    }
    if (d.getMinutes() !== lastMin) { lastMin = d.getMinutes(); if (!$('view-reminders').hidden) renderRems(); }
  }
  try { $('cTz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' '); } catch (e) {}

  /* ---------------- render: alarms ---------------- */
  function renderAlarms() {
    var list = $('alarmList');
    var sorted = alarms.slice().sort(function (a, b) { return (a.h * 60 + a.m) - (b.h * 60 + b.m); });
    list.innerHTML = sorted.map(function (al) {
      var nxt = (al.enabled || al.snoozeAt) ? (al.snoozeAt ? 'Snoozed till ' + fmtTime(new Date(al.snoozeAt)) : (al.armedAt ? 'in ' + fmtIn(al.armedAt - now()) : '')) : 'Off';
      return '<div class="card alarm' + (al.enabled ? '' : ' off') + '" data-id="' + al.id + '">' +
        '<div class="a-main"><div class="a-time">' + h12(al.h) + ':' + pad(al.m) + '<small>' + ap(al.h) + '</small></div>' +
        '<div class="a-meta">' + esc(al.label || 'Alarm') + ' \u00B7 ' + repeatText(al) + ' \u00B7 <b>' + nxt + '</b></div></div>' +
        '<input type="checkbox" class="sw" aria-label="Alarm on" ' + (al.enabled ? 'checked' : '') + '></div>';
    }).join('');
    $('alarmEmpty').hidden = alarms.length > 0;
    $('alarmHint').textContent = alarms.length ? (settings.ntfy ? 'Closed-app alerts are on (ntfy).' : 'Tip: keep NEXUS Alarm open in Nightstand mode so it can ring. Turn on closed-app alerts in Settings as a backup.') : '';
    renderClock();
  }
  $('alarmList').addEventListener('click', function (e) {
    var card = e.target.closest('.alarm'); if (!card) return;
    var al = alarms.find(function (a) { return a.id === card.dataset.id; }); if (!al) return;
    if (e.target.classList.contains('sw')) {
      al.enabled = e.target.checked; al.snoozeAt = null; arm(al); saveAlarms(); renderAlarms(); ntfySync();
      if (al.enabled) toast('Alarm in ' + fmtIn(al.armedAt - now()));
      return;
    }
    openEditor(al);
  });

  /* ---------------- alarm editor ---------------- */
  var editing = null, eDays = [];
  Object.keys(SOUNDS).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = SOUNDS[k].name; $('eSound').appendChild(o); });
  function paintDays() { Array.prototype.forEach.call($('eDays').children, function (b) { b.classList.toggle('on', eDays.indexOf(+b.dataset.d) >= 0); }); paintIn(); }
  function paintIn() {
    var v = $('eTime').value.split(':'); if (v.length < 2) return;
    var t = nextOcc({ h: +v[0], m: +v[1], days: eDays }, now());
    $('eIn').textContent = t ? 'Rings ' + fmtWhen(t) + ' (in ' + fmtIn(t - now()) + ')' : '';
  }
  function openEditor(al) {
    editing = al || null;
    var d = new Date(now() + 60000);
    var src = al || { h: 7, m: 0, label: '', days: [], sound: 'classic', snooze: 9, vibe: true };
    $('editTitle').textContent = al ? 'Edit alarm' : 'New alarm';
    $('eTime').value = pad(src.h) + ':' + pad(src.m);
    $('eLabel').value = src.label || '';
    eDays = (src.days || []).slice();
    $('eSound').value = src.sound || 'classic';
    $('eSnooze').value = String(src.snooze || 9);
    $('eVibe').checked = src.vibe !== false;
    $('eDelete').hidden = !al;
    paintDays();
    $('editBg').hidden = false;
  }
  function closeEditor() { $('editBg').hidden = true; stopTone(); editing = null; }
  $('eTime').addEventListener('input', paintIn);
  $('eDays').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var d = +b.dataset.d, i = eDays.indexOf(d); if (i >= 0) eDays.splice(i, 1); else eDays.push(d); paintDays(); });
  $('eDayPresets').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; eDays = { once: [], wk: [1, 2, 3, 4, 5], we: [0, 6], all: [0, 1, 2, 3, 4, 5, 6] }[b.dataset.p].slice(); paintDays(); });
  var previewing = false;
  $('ePreview').addEventListener('click', function () { if (previewing) { stopTone(); previewing = false; return; } startTone($('eSound').value, { seconds: 3 }); previewing = true; setTimeout(function () { previewing = false; }, 3000); });
  $('editCancel').addEventListener('click', closeEditor);
  $('editBg').addEventListener('click', function (e) { if (e.target === $('editBg')) closeEditor(); });
  $('editSave').addEventListener('click', function () {
    var v = $('eTime').value.split(':'); if (v.length < 2) { toast('Pick a time'); return; }
    var al = editing || { id: uid(), created: now() };
    al.h = +v[0]; al.m = +v[1]; al.label = $('eLabel').value.trim(); al.days = eDays.slice().sort();
    al.sound = $('eSound').value; al.snooze = +$('eSnooze').value; al.vibe = $('eVibe').checked;
    al.enabled = true; al.snoozeAt = null; arm(al);
    if (!editing) alarms.push(al);
    saveAlarms(); closeEditor(); renderAlarms(); ntfySync(); askNotif();
    toast('Alarm set for ' + fmtIn(al.armedAt - now()) + ' from now');
  });
  $('eDelete').addEventListener('click', function () {
    if (!editing) return;
    var id = editing.id; alarms = alarms.filter(function (a) { return a.id !== id; });
    saveAlarms(); closeEditor(); renderAlarms(); ntfySync(); toast('Alarm deleted');
  });
  $('addAlarm').addEventListener('click', function () { openEditor(null); });
  $('qAlarm').addEventListener('click', function () { go('alarms'); openEditor(null); });

  /* ---------------- reminders ---------------- */
  var remPick = null; // {at} chosen by chip
  function parseNote(txt) {
    var s = ' ' + txt.toLowerCase() + ' ', m, at = null, clean = txt;
    if ((m = s.match(/\bin (\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/))) {
      var n = parseFloat(m[1]), u = m[2][0]; at = now() + n * (u === 'h' ? 3600000 : u === 'd' ? 86400000 : 60000);
      clean = txt.replace(new RegExp('\\s*in ' + m[1] + '\\s*' + m[2] + '\\b', 'i'), '');
    } else if ((m = s.match(/\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/))) {
      var h = +m[1], mi = +(m[2] || 0), mer = m[3];
      if (h <= 24 && mi < 60) {
        if (mer) { if (mer[0] === 'p' && h < 12) h += 12; if (mer[0] === 'a' && h === 12) h = 0; }
        else if (h < 12) { var cand = new Date(); cand.setHours(h, mi, 0, 0); if (cand.getTime() <= now()) h += 12; }
        var d = new Date(); d.setHours(h % 24, mi, 0, 0);
        if (/\btomorrow\b/.test(s) || d.getTime() <= now()) d.setDate(d.getDate() + 1);
        at = d.getTime();
        clean = txt.replace(/\s*\bat \d{1,2}(:\d{2})?\s*(am|pm|a|p)?\b/i, '').replace(/\s*\btomorrow\b/i, '');
      }
    } else if (/\btomorrow\b/.test(s)) {
      var t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); at = t.getTime(); clean = txt.replace(/\s*\btomorrow\b/i, '');
    }
    clean = clean.replace(/^\s*(remind me to|remind me|to)\s+/i, '').trim();
    return { at: at, note: clean || txt.trim() };
  }
  function chipTime(b) {
    if (b.dataset.in) return now() + (+b.dataset.in) * 60000;
    var d = new Date();
    if (b.dataset.at === 'tonight') { d.setHours(20, 0, 0, 0); if (d.getTime() <= now()) d.setDate(d.getDate() + 1); return d.getTime(); }
    if (b.dataset.at === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }
    return null;
  }
  function remPreview() {
    var p = parseNote($('remNote').value), at = remPick ? (remPick.custom ? whenVal() : remPick.at) : p.at;
    $('remPreview').textContent = at ? 'Reminds you ' + fmtWhen(at) : 'Tip: type "in 10 min" or "at 7:30 pm" in the note';
  }
  function whenVal() { var v = $('remWhen').value; if (!v) return null; var t = new Date(v).getTime(); return isNaN(t) ? null : t; }
  $('remChips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    var was = b.classList.contains('on');
    Array.prototype.forEach.call($('remChips').children, function (c) { c.classList.remove('on'); });
    $('remCustom').hidden = true;
    if (was) { remPick = null; remPreview(); return; }
    b.classList.add('on');
    if (b.dataset.at === 'custom') {
      $('remCustom').hidden = false; remPick = { custom: true };
      if (!$('remWhen').value) { var d = new Date(now() + 3600000); d.setMinutes(0, 0, 0); $('remWhen').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    } else remPick = { at: chipTime(b) };
    remPreview();
  });
  $('remNote').addEventListener('input', remPreview);
  $('remWhen').addEventListener('input', remPreview);
  $('remForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var raw = $('remNote').value.trim(), p = parseNote(raw);
    var at = remPick ? (remPick.custom ? whenVal() : remPick.at) : p.at;
    if (!raw) { toast('Type what to remind you about'); $('remNote').focus(); return; }
    if (!at) { toast('Pick a time (or type "in 10 min")'); return; }
    if (at <= now()) { toast('That time already passed'); return; }
    reminders.push({ id: uid(), note: remPick ? raw : p.note, at: at, done: false, created: now() });
    saveRems();
    $('remNote').value = ''; remPick = null; $('remCustom').hidden = true;
    Array.prototype.forEach.call($('remChips').children, function (c) { c.classList.remove('on'); });
    remPreview(); renderRems(); renderClock(); ntfySync(); askNotif();
    toast('Reminder set for ' + fmtWhen(at));
  });
  function remRow(r) {
    var diff = r.at - now(), cls = r.done ? '' : (diff < 0 ? ' late' : diff < 3600000 ? ' soon' : '');
    var when = r.done ? 'Done' : (diff < 0 ? 'Due ' + fmtWhen(r.at) : fmtWhen(r.at) + ' \u00B7 in ' + fmtIn(diff));
    return '<div class="card rem' + (r.done ? ' done' : '') + '" data-id="' + r.id + '">' +
      '<button class="chk" aria-label="Mark done"><svg class="ico"><use href="#i-check"/></svg></button>' +
      '<div class="r-main"><div class="r-note">' + esc(r.note) + '</div><div class="r-when' + cls + '">' + when + '</div></div>' +
      '<button class="del" aria-label="Delete"><svg class="ico"><use href="#i-trash"/></svg></button></div>';
  }
  function renderRems() {
    var up = reminders.filter(function (r) { return !r.done; }).sort(function (a, b) { return a.at - b.at; });
    var dn = reminders.filter(function (r) { return r.done; }).sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); }).slice(0, 30);
    $('remList').innerHTML = up.map(remRow).join('');
    $('remEmpty').hidden = up.length > 0;
    $('doneWrap').hidden = !dn.length;
    $('doneList').innerHTML = dn.map(remRow).join('');
  }
  function remClick(e) {
    var card = e.target.closest('.rem'); if (!card) return;
    var r = reminders.find(function (x) { return x.id === card.dataset.id; }); if (!r) return;
    if (e.target.closest('.chk')) { r.done = !r.done; r.doneAt = r.done ? now() : null; if (!r.done && r.at <= now()) r.fired = true; saveRems(); renderRems(); renderClock(); ntfySync(); }
    else if (e.target.closest('.del')) { reminders = reminders.filter(function (x) { return x !== r; }); saveRems(); renderRems(); renderClock(); ntfySync(); toast('Reminder deleted'); }
  }
  $('remList').addEventListener('click', remClick);
  $('doneList').addEventListener('click', remClick);
  $('clearDone').addEventListener('click', function () { reminders = reminders.filter(function (r) { return !r.done; }); saveRems(); renderRems(); });
  $('qRem').addEventListener('click', function () { go('reminders'); setTimeout(function () { $('remNote').focus(); }, 50); });

  /* ---------------- timer ---------------- */
  function fmtDur(ms) { var s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(x); }
  function timerLeft() { return timer.running ? Math.max(0, timer.end - now()) : timer.left; }
  function renderTimer() {
    var left = timerLeft();
    $('tDisp').textContent = fmtDur(Math.ceil(left / 1000) * 1000);
    var frac = timer.dur ? left / timer.dur : 0;
    $('tRing').style.strokeDashoffset = String(553 * (1 - frac));
    $('tStart').textContent = timer.running ? 'Pause' : (left < timer.dur && left > 0 ? 'Resume' : 'Start');
    $('tEnds').textContent = timer.running ? 'Ends ' + fmtTime(new Date(timer.end)) : '';
    $('tSet').style.opacity = timer.running ? '.4' : '1';
  }
  function setFromInputs() {
    var ms = ((+$('tH').value || 0) * 3600 + (+$('tM').value || 0) * 60 + (+$('tS').value || 0)) * 1000;
    if (!timer.running) { timer.dur = ms; timer.left = ms; saveTimer(); renderTimer(); }
  }
  ['tH', 'tM', 'tS'].forEach(function (id) { $(id).addEventListener('input', setFromInputs); });
  $('tPresets').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b || timer.running) return;
    var s = +b.dataset.s; $('tH').value = Math.floor(s / 3600); $('tM').value = Math.floor((s % 3600) / 60); $('tS').value = s % 60; setFromInputs();
  });
  $('tStart').addEventListener('click', function () {
    unlock();
    if (timer.running) { timer.left = Math.max(0, timer.end - now()); timer.running = false; timer.end = 0; }
    else {
      if (!timer.left || timer.left <= 0) timer.left = timer.dur;
      if (!timer.left) { toast('Set a time first'); return; }
      timer.end = now() + timer.left; timer.running = true;
    }
    saveTimer(); renderTimer(); ntfySync();
  });
  $('tReset').addEventListener('click', function () { timer.running = false; timer.end = 0; setFromInputs(); timer.left = timer.dur; saveTimer(); renderTimer(); ntfySync(); });
  function initTimerInputs() { var s = Math.round(timer.dur / 1000); $('tH').value = Math.floor(s / 3600); $('tM').value = Math.floor((s % 3600) / 60); $('tS').value = s % 60; }

  /* ---------------- stopwatch ---------------- */
  function swElapsed() { return sw.acc + (sw.running ? now() - sw.start : 0); }
  function fmtSw(ms) { var cs = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return { main: (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(x), cs: '.' + pad(cs) }; }
  var swRaf = null;
  function renderSw() {
    var f = fmtSw(swElapsed());
    $('swDisp').innerHTML = f.main + '<span class="cs">' + f.cs + '</span>';
    $('swStart').textContent = sw.running ? 'Stop' : (sw.acc ? 'Resume' : 'Start');
    $('swLap').textContent = sw.running ? 'Lap' : 'Reset';
    $('swLap').disabled = !sw.running && !sw.acc;
    if (sw.running && !swRaf) { (function loopSw() { if (!sw.running || $('view-stopwatch').hidden) { swRaf = null; return; } var g = fmtSw(swElapsed()); $('swDisp').innerHTML = g.main + '<span class="cs">' + g.cs + '</span>'; swRaf = requestAnimationFrame(loopSw); })(); }
  }
  function renderLaps() {
    if (!sw.laps.length) { $('lapList').innerHTML = ''; return; }
    var splits = sw.laps.map(function (t, i) { return t - (i ? sw.laps[i - 1] : 0); });
    var mx = Math.max.apply(null, splits), mn = Math.min.apply(null, splits);
    $('lapList').innerHTML = splits.map(function (s, i) { var f = fmtSw(s), tt = fmtSw(sw.laps[i]); return '<div class="lap' + (splits.length > 2 && s === mn ? ' best' : splits.length > 2 && s === mx ? ' worst' : '') + '"><span>Lap ' + (i + 1) + '</span><b>' + f.main + f.cs + '</b><span>' + tt.main + tt.cs + '</span></div>'; }).reverse().join('');
  }
  $('swStart').addEventListener('click', function () {
    if (sw.running) { sw.acc += now() - sw.start; sw.running = false; } else { sw.start = now(); sw.running = true; }
    saveSw(); renderSw();
  });
  $('swLap').addEventListener('click', function () {
    if (sw.running) { sw.laps.push(swElapsed()); } else { sw.acc = 0; sw.laps = []; }
    saveSw(); renderSw(); renderLaps();
  });

  /* ---------------- tabs ---------------- */
  function go(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.hidden = v.dataset.view !== tab; });
    Array.prototype.forEach.call($('tabs').children, function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    if (tab === 'reminders') renderRems();
    if (tab === 'stopwatch') renderSw();
    if (tab === 'timer') renderTimer();
    if (tab === 'alarms') renderAlarms();
    window.scrollTo(0, 0);
    try { history.replaceState(null, '', tab === 'clock' ? location.pathname : '#' + tab); } catch (e) {}
  }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) go(b.dataset.tab); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (el) { el.addEventListener('click', function () { go(el.dataset.go); }); });

  /* ---------------- nightstand ---------------- */
  var wakeLock = null;
  function wakeStatus(t) { $('nWake').textContent = t; }
  async function getWake() {
    if (!settings.wake) { wakeStatus('Screen may turn off (keep-awake is off in Settings)'); return; }
    if (!('wakeLock' in navigator)) { wakeStatus('This browser can\'t keep the screen on. Plug in and set screen timeout to max.'); return; }
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeStatus('Screen will stay on \u00B7 plug in your charger'); wakeLock.addEventListener('release', function () { wakeLock = null; }); }
    catch (e) { wakeStatus('Couldn\'t keep the screen on (' + (e.name || 'blocked') + ')'); }
  }
  function enterNight() {
    unlock(); askNotif();
    $('night').hidden = false; renderClock(); getWake();
    try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {}); } catch (e) {}
    LS.set('night', true);
  }
  function exitNight() {
    $('night').hidden = true; LS.set('night', false);
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
  }
  $('nightBtn').addEventListener('click', enterNight);
  $('qNight').addEventListener('click', enterNight);
  $('nExit').addEventListener('click', exitNight);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { tick(); if (!$('night').hidden && !wakeLock) getWake(); ntfySync(); }
  });

  /* ---------------- ntfy (closed-app alerts) ---------------- */
  var NTFY = 'https://ntfy.sh';
  var sched = LS.get('ntfy', {}); // key -> {id, at}
  function saveSched() { LS.set('ntfy', sched); }
  function wanted() {
    var w = {}, t = now(), until = t + NTFY_WINDOW;
    alarms.forEach(function (al) {
      if (al.snoozeAt && al.snoozeAt > t + 15000) w['s:' + al.id + ':' + al.snoozeAt] = { at: al.snoozeAt, title: (al.label || 'Alarm') + ' (snoozed)', msg: 'Snooze is over', tags: 'alarm_clock' };
      if (!al.enabled) return;
      occsWithin(al, t + 15000, until).forEach(function (at) { w['a:' + al.id + ':' + at] = { at: at, title: (al.label || 'Alarm') , msg: '\u23F0 ' + fmtHM(al.h, al.m) + ' \u00B7 open NEXUS Alarm', tags: 'alarm_clock' }; });
    });
    reminders.forEach(function (r) {
      if (r.done || r.at <= t + 15000 || r.at > until) return;
      w['r:' + r.id + ':' + r.at] = { at: r.at, title: 'Reminder', msg: r.note || 'Reminder', tags: 'bell' };
    });
    if (timer.running && timer.end > t + 15000) w['t:' + timer.end] = { at: timer.end, title: 'Timer done', msg: fmtDur(timer.dur) + ' timer is up', tags: 'hourglass' };
    return w;
  }
  function ntfyPost(o) {
    var body = { topic: settings.topic, title: o.title, message: o.msg, priority: 5, tags: o.tags ? [o.tags] : [], click: APP_URL };
    if (o.at) body.delay = String(Math.floor(o.at / 1000));
    var ac = new AbortController(), tm = setTimeout(function () { ac.abort(); }, 12000);
    return fetch(NTFY + '/', { method: 'POST', body: JSON.stringify(body), signal: ac.signal }).then(function (r) { clearTimeout(tm); if (!r.ok) throw new Error('ntfy ' + r.status); return r.json(); });
  }
  function ntfyDelete(id) {
    var ac = new AbortController(), tm = setTimeout(function () { ac.abort(); }, 12000);
    return fetch(NTFY + '/' + settings.topic + '/' + id, { method: 'DELETE', signal: ac.signal }).then(function (r) { clearTimeout(tm); return r.ok || r.status === 404; });
  }
  var syncing = false, again = false, syncT = null;
  function ntfySync() { clearTimeout(syncT); syncT = setTimeout(doSync, 600); }
  async function doSync() {
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      var t = now(), w = settings.ntfy ? wanted() : {};
      var keys = Object.keys(sched);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], s = sched[k];
        if (s.at <= t) { delete sched[k]; continue; }
        if (!w[k]) { try { if (await ntfyDelete(s.id)) delete sched[k]; } catch (e) { /* offline: try later */ } }
      }
      var wk = Object.keys(w);
      for (var j = 0; j < wk.length; j++) {
        if (sched[wk[j]]) continue;
        try { var res = await ntfyPost(w[wk[j]]); sched[wk[j]] = { id: res.id, at: w[wk[j]].at }; } catch (e) { break; }
      }
      saveSched();
      settings.lastSync = now(); saveSettings(); paintNtfy();
    } finally { syncing = false; if (again) { again = false; ntfySync(); } }
  }
  function topicLinks() {
    var topic = settings.topic;
    ['setupTopic', 'sTopic'].forEach(function (id) { $(id).textContent = topic; });
    ['setupOpen', 'sOpen'].forEach(function (id) { $(id).href = 'ntfy://ntfy.sh/' + topic; });
    $('sWeb').href = NTFY + '/' + topic;
  }
  function paintNtfy() {
    $('sNtfy').checked = !!settings.ntfy;
    var n = Object.keys(sched).length;
    $('sNtfyInfo').textContent = settings.ntfy ? (n + ' alert' + (n === 1 ? '' : 's') + ' scheduled in ntfy' + (settings.lastSync ? ' \u00B7 synced ' + fmtTime(new Date(settings.lastSync)) : '')) : 'Off. Turn it on after you subscribe in the ntfy app.';
    $('setupCard').hidden = !!(settings.ntfy || settings.setupLater);
  }
  function copyTopic() {
    var t = settings.topic;
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('Topic copied'); }).catch(function () {
      var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Topic copied'); } catch (e) { toast(t); } ta.remove();
    });
  }
  function sendTest() {
    toast('Sending test...');
    ntfyPost({ title: 'NEXUS Alarm test', msg: 'It works! Your alarms will show up here when the app is closed.', tags: 'white_check_mark' })
      .then(function () { toast('Test sent. Check the ntfy app.'); })
      .catch(function () { toast('Couldn\'t reach ntfy. Are you online?'); });
  }
  $('setupCopy').addEventListener('click', copyTopic);
  $('sCopy').addEventListener('click', copyTopic);
  $('setupTest').addEventListener('click', sendTest);
  $('sTest').addEventListener('click', sendTest);
  $('setupOn').addEventListener('click', function () { settings.ntfy = true; saveSettings(); paintNtfy(); renderAlarms(); ntfySync(); askNotif(); toast('Closed-app alerts on'); });
  $('setupLater').addEventListener('click', function () { settings.setupLater = true; saveSettings(); paintNtfy(); toast('You can turn it on later in Settings'); });
  $('sNtfy').addEventListener('change', function () { settings.ntfy = $('sNtfy').checked; saveSettings(); paintNtfy(); renderAlarms(); ntfySync(); });

  /* ---------------- settings ---------------- */
  function paintNotif() {
    var b = $('sNotif');
    if (!('Notification' in window)) { b.textContent = 'Not supported'; b.disabled = true; return; }
    b.textContent = Notification.permission === 'granted' ? 'Allowed' : Notification.permission === 'denied' ? 'Blocked' : 'Allow';
    b.disabled = Notification.permission !== 'default';
  }
  var asked = false;
  function askNotif() { if (asked || !('Notification' in window) || Notification.permission !== 'default') return; asked = true; try { Notification.requestPermission().then(paintNotif); } catch (e) {} }
  $('sNotif').addEventListener('click', function () { asked = false; askNotif(); });
  $('setBtn').addEventListener('click', function () { paintNtfy(); paintNotif(); $('sWake').checked = !!settings.wake; $('sRamp').checked = !!settings.ramp; $('sVol').value = settings.vol; $('setBg').hidden = false; });
  $('setClose').addEventListener('click', function () { $('setBg').hidden = true; stopTone(); });
  $('setBg').addEventListener('click', function (e) { if (e.target === $('setBg')) { $('setBg').hidden = true; stopTone(); } });
  $('sWake').addEventListener('change', function () { settings.wake = $('sWake').checked; saveSettings(); });
  $('sRamp').addEventListener('change', function () { settings.ramp = $('sRamp').checked; saveSettings(); });
  $('sVol').addEventListener('change', function () { settings.vol = +$('sVol').value; saveSettings(); startTone('classic', { seconds: 1.2 }); });

  /* ---------------- install + sw ---------------- */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', function () { if (!deferred) return; deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; $('installBtn').hidden = true; }); });
  window.addEventListener('appinstalled', function () { $('installBtn').hidden = true; toast('Installed!'); });
  if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); }); }

  /* ---------------- boot ---------------- */
  // re-arm on load: anything past due by more than MISS_MS is reported as missed by tick()
  alarms.forEach(function (al) { if (al.enabled && !al.armedAt) arm(al); });
  saveAlarms();
  topicLinks(); initTimerInputs(); paintNtfy(); paintNotif();
  renderAlarms(); renderRems(); renderTimer(); renderSw(); renderLaps(); renderClock();
  var start = (location.hash || '').slice(1);
  var params = new URLSearchParams(location.search);
  if (params.get('open')) start = params.get('open');
  if (['alarms', 'reminders', 'timer', 'stopwatch'].indexOf(start) >= 0) go(start);
  if (params.get('new') === 'alarm') { go('alarms'); openEditor(null); }
  if (LS.get('night', false)) { $('night').hidden = false; getWake(); }
  tick();
  setInterval(tick, 500);
  setInterval(ntfySync, 30 * 60 * 1000);
  ntfySync();
  window.NXAlarm = { alarms: function () { return alarms; }, reminders: function () { return reminders; }, sched: function () { return sched; }, sync: doSync, ring: ring, settings: settings };
})();
