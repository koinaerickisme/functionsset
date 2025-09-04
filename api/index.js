// Vercel serverless entrypoint inside the functions/ directory
const app = require('../index.js');

module.exports = (req, res) => app(req, res);


