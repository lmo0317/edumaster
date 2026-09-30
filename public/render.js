'use strict';
// Minimal Markdown (paragraphs, **bold**, tables) + KaTeX math renderer shared by the app and the report.
(function () {
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Korean inside a formula would be typeset as math italics with its spaces dropped
  // ("전체기체의양"); wrap each Korean phrase in \text{} so it keeps the body font and spacing.
  // "\ " (escaped space) between Korean words is folded into the same \text{} run.
  function hangulAsText(tex) {
    return tex.replace(/[가-힣]+(?:(?:\s|\\ )+[가-힣]+)*/g, (run) => `\\text{${run.replace(/\\ /g, ' ')}}`);
  }

  // "\ce{A}(g)" leaves the state outside \ce, where it is set as an italic g; move it inside: "\ce{A(g)}".
  function statesInsideCe(tex) {
    return tex.replace(/\\ce\{([^{}]*)\}\s*\((g|l|s|aq)\)/g, '\\ce{$1($2)}');
  }

  function renderMath(tex, display) {
    if (!window.katex) return escape(display ? `$$${tex}$$` : `$${tex}$`);
    tex = hangulAsText(statesInsideCe(tex));
    try {
      return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' });
    } catch { return escape(tex); }
  }

  function inline(text, math) {
    let html = escape(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => math[Number(i)]);
  }

  function table(lines, math) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const isRule = (r) => r.every((c) => /^:?-{2,}:?$/.test(c));
    const head = rows.length > 1 && isRule(rows[1]) ? rows[0] : null;
    const body = head ? rows.slice(2) : rows.filter((r) => !isRule(r));
    return '<div class="table-wrap"><table>' +
      (head ? '<thead><tr>' + head.map((c) => `<th>${inline(c, math)}</th>`).join('') + '</tr></thead>' : '') +
      '<tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c, math)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
  }

  function toHtml(source) {
    const math = [];
    const keep = (html) => `\u0000${math.push(html) - 1}\u0000`;
    let text = String(source ?? '');
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(renderMath(t.trim(), true)))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => keep(renderMath(t.trim(), true)))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(renderMath(t.trim(), false)))
      .replace(/\$([^$\n]+?)\$/g, (_, t) => keep(renderMath(t.trim(), false)));
    const out = [];
    const lines = text.split(/\r?\n/);
    let para = [];
    const flush = () => { if (para.length) out.push('<p>' + para.map((l) => inline(l, math)).join('<br>') + '</p>'); para = []; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\|/.test(line)) {
        flush();
        const block = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
        i--;
        out.push(table(block, math));
      } else if (!line.trim()) flush();
      else if (/^\s*[-•]\s+/.test(line)) { flush(); out.push('<p class="bullet">• ' + inline(line.replace(/^\s*[-•]\s+/, ''), math) + '</p>'); }
      else para.push(line);
    }
    flush();
    return out.join('');
  }

  window.EM = window.EM || {};
  window.EM.escape = escape;
  window.EM.rich = toHtml;
  window.EM.circled = (n) => '①②③④⑤⑥⑦⑧⑨'[n - 1] || String(n);
})();
