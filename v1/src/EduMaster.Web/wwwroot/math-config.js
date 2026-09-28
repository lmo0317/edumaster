window.MathJax = {
  loader: { paths: { mathjax: new URL('vendor/mathjax', document.currentScript.src).href }, load: ['[tex]/mhchem'] },
  tex: { inlineMath: [['\\(', '\\)']], packages: { '[+]': ['mhchem'] } },
  svg: { fontCache: 'none' },
  startup: { typeset: false }
};
