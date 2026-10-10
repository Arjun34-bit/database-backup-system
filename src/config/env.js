'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim() || /^your_/i.test(value)) {
    throw new Error(`Configuration: set ${name} in .env`);
  }
  if (/[\r\n\0]/.test(value)) throw new Error(`Configuration: ${name} contains invalid characters`);
  return value;
}
function integer(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Configuration: ${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
module.exports = { root, required, integer };
