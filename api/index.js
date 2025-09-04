// Vercel serverless entrypoint inside functions/
const app = require('../index.js');

module.exports = (req, res) => app(req, res);


