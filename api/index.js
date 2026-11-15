'use strict';
const { app, bootstrap } = require('../server/index');

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = bootstrap().catch((err) => {
      console.error('Serverless bootstrap error:', err);
    });
  }
  return readyPromise;
}

module.exports = async (req, res) => {
  await ensureReady();
  // Ensure the route starts with /api for Express routing if stripped by rewrites
  if (req.url && !req.url.startsWith('/api') && !req.url.startsWith('/app')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
};
