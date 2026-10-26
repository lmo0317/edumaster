'use strict';
const crypto = require('node:crypto');

// Only source fields belong to the version; caches and job progress must not change it.
const materialKey = (m) => crypto.createHash('sha256').update(JSON.stringify([
  m.subject, m.topic, m.problem, m.steps, m.images, m.solutionSource,
])).digest('hex');

function invalidateDerived(before, after) {
  if (materialKey(before) !== materialKey(after)) {
    delete after.frames;
    delete after.framesKey;
    delete after.analysisReview;
  }
  return after;
}

module.exports = { materialKey, invalidateDerived };
