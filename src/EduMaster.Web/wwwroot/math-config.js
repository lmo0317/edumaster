window.MathJax = {
  loader: { paths: { mathjax: 'vendor/mathjax' }, load: ['[tex]/mhchem'] },
  tex: { inlineMath: [['\\(', '\\)']], packages: { '[+]': ['mhchem'] } },
  svg: { fontCache: 'none' },
  startup: { typeset: false }
};
