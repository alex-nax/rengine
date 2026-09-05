/* ispec.js — the shared ispec state engine. Generated docs link this file
   instead of inlining the wiring (see references/html-boilerplate.md).
   Contract (ispec/v1, see references/json-contract.md):
   - <html data-ispec-name="kebab-name"> names the spec (saved as <name>.json).
   - Sections: <section class="item" data-section="section-id"> … </section>
   - Status buttons: <button class="st-btn" data-st="approved|rejected|needs-revision|deferred|selected">
   - Comment: <textarea data-comment> → sections[id].comment
   - Generic controls with data-key inside a section:
       checkbox → sections[id]["<key>.checked"], text/number/range/select/radio → sections[id][key]
       (range also mirrors into a sibling .val element)
   - Optional general section: <section class="item" data-section="general-comments"> with textareas keyed by data-key.
   - localStorage autosave/restore; summary chip #ispecSummary; JSON preview #ispecJsonPanel;
     buttons #ispecSave (download) and #ispecCopy (clipboard). */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const name = document.documentElement.dataset.ispecName || 'ispec-unnamed';
  const LS_KEY = 'ispec:' + name;
  const state = { sections: {} };
  let created = new Date().toISOString();

  // ---- restore ----
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved && saved.sections) {
      state.sections = saved.sections;
      created = saved.created || created;
    }
  } catch (e) { /* fresh */ }

  function secIdOf(el) { const s = el.closest('[data-section]'); return s ? s.dataset.section : null; }
  function entry(id) { return (state.sections[id] = state.sections[id] || {}); }

  function out() {
    const summary = { total: 0, approved: 0, rejected: 0, 'needs-revision': 0, deferred: 0, selected: 0 };
    for (const s of Object.values(state.sections)) {
      if (!s.status) continue;
      summary.total++;
      if (s.status in summary) summary[s.status]++;
      else summary[s.status] = 1;
    }
    return { $schema: 'ispec/v1', name, created, modified: new Date().toISOString(), sections: state.sections, summary };
  }

  function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify(out())); } catch (e) { /* full/blocked */ } }

  function render() {
    persist();
    const sections = $$('[data-section]');
    // Count only REVIEW sections (ones carrying status buttons); content-only
    // sections (e.g. general-comments) don't enter the tally.
    const reviewable = sections.filter((s) => $('.st-btn', s) !== null);
    const done = reviewable.filter((s) => {
      const e = state.sections[s.dataset.section];
      return e && e.status;
    }).length;
    const chip = $('#ispecSummary');
    if (chip) chip.textContent = done + ' / ' + reviewable.length + ' reviewed';
    const pre = $('#ispecJsonPanel pre');
    if (pre) pre.textContent = JSON.stringify(out(), null, 2);
  }

  function paintStatus(section) {
    const id = section.dataset.section;
    const st = (state.sections[id] || {}).status;
    $$('.st-btn', section).forEach((b) => {
      b.classList.toggle('active', b.dataset.st === st);
      if (b.dataset.st === st) b.classList.add(st);
      else b.classList.remove('approved', 'rejected', 'needs-revision', 'deferred', 'selected');
    });
  }

  function restoreUI() {
    $$('[data-section]').forEach((section) => {
      paintStatus(section);
      const id = section.dataset.section;
      const e = state.sections[id] || {};
      $$('[data-comment]', section).forEach((t) => { t.value = e.comment || ''; });
      $$('[data-key]', section).forEach((c) => {
        const k = c.dataset.key;
        if (c.type === 'checkbox') c.checked = !!e[k + '.checked'];
        else if (c.type === 'radio') c.checked = e[k] === c.value;
        else if (e[k] !== undefined) {
          c.value = e[k];
          const val = c.parentElement ? c.parentElement.querySelector('.val') : null;
          if (val) val.textContent = e[k];
        }
      });
    });
  }

  // ---- wiring ----
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('.st-btn');
    if (!b) return;
    const id = secIdOf(b);
    if (!id) return;
    entry(id).status = b.dataset.st;
    paintStatus(b.closest('[data-section]'));
    render();
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    const id = secIdOf(t);
    if (!id) return;
    if (t.hasAttribute('data-comment')) { entry(id).comment = t.value; render(); return; }
    const k = t.dataset.key;
    if (!k) return;
    if (t.type === 'checkbox') entry(id)[k + '.checked'] = t.checked;
    else if (t.type === 'radio') { if (t.checked) entry(id)[k] = t.value; }
    else {
      entry(id)[k] = t.type === 'number' || t.type === 'range' ? Number(t.value) : t.value;
      const val = t.parentElement ? t.parentElement.querySelector('.val') : null;
      if (val) val.textContent = t.value;
    }
    render();
  });

  document.addEventListener('DOMContentLoaded', () => {
    restoreUI();
    render();
    const panel = $('#ispecJsonPanel > header');
    if (panel) panel.addEventListener('click', () => {
      const box = $('#ispecJsonPanel');
      const pre = $('#ispecJsonPanel pre');
      if (!pre || !box) return;
      const collapsed = pre.hasAttribute('hidden');
      if (collapsed) { pre.removeAttribute('hidden'); } else { pre.setAttribute('hidden', ''); }
      box.classList.toggle('collapsed', !collapsed);
    });
    const save = $('#ispecSave');
    if (save) save.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(out(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '.json';
      a.click();
    });
    const copy = $('#ispecCopy');
    if (copy) copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(out(), null, 2)); copy.textContent = 'Copied!'; }
      catch (e) { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1500);
    });
  });
})();
