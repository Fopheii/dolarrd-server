const NodeCache = require('node-cache');

// TTL: 5 minutes. Sync runs every 10–30 min so this stays fresh enough.
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

module.exports = cache;
