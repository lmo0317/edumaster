// Display-only math: keep the source problem text intact for validation and editing.
(() => {
  const formulaPattern = /\\\((.+?)\\\)|\(([^()\n]{1,32})\)\s*\/\s*\(([^()\n]{1,32})\)|(?<![\w/.])(\d{1,4}(?:\.\d+)?)\/(\d{1,4}(?:\.\d+)?)(?![\w/.])/g;
  const images = new Map();
  const pending = new Map();
  let typesetQueue = Promise.resolve();

  function tokens(value) {
    const source = String(value ?? '');
    const parts = [];
    let start = 0;
    for (const match of source.matchAll(formulaPattern)) {
      if (match.index > start) parts.push({ text: source.slice(start, match.index) });
      const tex = match[1] ? match[1] : match[2] ? `\\frac{${match[2].trim()}}{${match[3].trim()}}` : `\\frac{${match[4]}}{${match[5]}}`;
      parts.push({ tex, fallback: match[0] });
      start = match.index + match[0].length;
    }
    if (start < source.length) parts.push({ text: source.slice(start) });
    return parts;
  }

  async function ready() {
    if (!window.MathJax?.startup?.promise) return false;
    await window.MathJax.startup.promise;
    return typeof window.MathJax.tex2svgPromise === 'function';
  }

  async function formulaImage(tex) {
    if (images.has(tex)) return images.get(tex);
    if (pending.has(tex)) return pending.get(tex);
    const task = (async () => {
      if (!await ready()) return null;
      const node = await window.MathJax.tex2svgPromise(tex, { display: false });
      const svg = node.querySelector('svg');
      if (!svg) return null;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        images.set(tex, image);
        return image;
      } finally {
        // A decoded Image retains its pixels after revoking the temporary URL.
        URL.revokeObjectURL(url);
      }
    })().catch(() => null).finally(() => pending.delete(tex));
    pending.set(tex, task);
    return task;
  }

  async function preloadProblem(problem) {
    const values = [problem?.body, problem?.title, problem?.answer, problem?.explanation,
      ...(problem?.choices || []), ...(problem?.steps || []),
      ...(problem?.choiceTable?.headers || []), ...(problem?.choiceTable?.rows || []).flat()];
    const expressions = new Set(values.flatMap(value => tokens(value).filter(part => part.tex).map(part => part.tex)));
    await Promise.all([...expressions].map(formulaImage));
  }

  function drawCanvasText(ctx, original, value, x, y, ...extra) {
    const parts = tokens(value);
    if (!parts.some(part => part.tex && images.has(part.tex))) return original(value, x, y, ...extra);
    const size = Number(ctx.font.match(/(\d+(?:\.\d+)?)px/)?.[1] || 16);
    const segments = parts.map(part => {
      const image = part.tex && images.get(part.tex);
      const height = size * 1.35;
      // MathJax SVG dimensions are expressed in ex; naturalWidth/Height retain their ratio.
      return image ? { image, width: height * image.naturalWidth / image.naturalHeight, height }
        : { text: part.text ?? part.fallback, width: ctx.measureText(part.text ?? part.fallback).width };
    });
    const width = segments.reduce((sum, part) => sum + part.width, 0);
    let left = ctx.textAlign === 'center' ? x - width / 2 : ctx.textAlign === 'right' || ctx.textAlign === 'end' ? x - width : x;
    for (const segment of segments) {
      if (segment.image) {
        const top = ctx.textBaseline === 'middle' ? y - segment.height / 2 : ctx.textBaseline === 'top' ? y : y - segment.height * .79;
        ctx.drawImage(segment.image, left, top, segment.width, segment.height);
      } else original(segment.text, left, y);
      left += segment.width;
    }
  }

  async function typeset(root) {
    if (!root || !await ready()) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('script,style,textarea,mjx-container') && tokens(node.nodeValue).some(part => part.tex)) nodes.push(node);
    }
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      for (const part of tokens(node.nodeValue)) fragment.append(document.createTextNode(part.tex ? `\\(${part.tex}\\)` : part.text));
      node.replaceWith(fragment);
    }
    if (nodes.length) await window.MathJax.typesetPromise([root]);
  }

  function schedule(root) { typesetQueue = typesetQueue.then(() => typeset(root)).catch(() => {}); }
  async function flush() { await typesetQueue; }
  window.EduMath = { tokens, preloadProblem, drawCanvasText, typeset, schedule, flush };
})();
