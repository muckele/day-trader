'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const schema = JSON.parse(readFileSync(join(__dirname, '../contracts/schema.json'), 'utf8'));
const validated = new WeakSet();
function invalid() { const error = new Error('INVALID_FRAME'); error.code = 'INVALID_FRAME'; throw error; }
// Parse bounded input before constructing an object; decoded keys must be unique.
function parse(text) {
  let i = 0;
  const ws = () => { while (' \t\n\r'.includes(text[i]) && i < text.length) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') {
        const value = JSON.parse(text.slice(start, i));
        for (let n = 0; n < value.length; n++) {
          const x = value.charCodeAt(n);
          if (x >= 0xd800 && x <= 0xdbff) { const y = value.charCodeAt(++n); if (!(y >= 0xdc00 && y <= 0xdfff)) invalid(); }
          else if (x >= 0xdc00 && x <= 0xdfff) invalid();
        }
        return value;
      }
      if (c === '\\') { if (i >= text.length) invalid(); i++; }
    }
    invalid();
  }
  function value(depth) {
    ws(); const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      if (depth >= schema.maxDepth) invalid();
      i++; ws(); const object = c === '{'; const end = object ? '}' : ']';
      const result = object ? Object.create(null) : []; const keys = new Set();
      if (text[i] === end) { i++; return result; }
      while (true) {
        ws(); let key;
        if (object) { if (text[i] !== '"') invalid(); key = string(); if (keys.has(key)) invalid(); keys.add(key); ws(); if (text[i++] !== ':') invalid(); }
        const item = value(depth + 1); if (object) result[key] = item; else result.push(item);
        ws(); if (text[i] === end) { i++; return result; } if (text[i++] !== ',') invalid();
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(token, i)) { i += token.length; return result; }
    const match = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)/.exec(text.slice(i));
    if (!match) invalid(); i += match[0].length;
    const result = Number(match[0]); if (!Number.isSafeInteger(result)) invalid(); return result;
  }
  const result = value(0); ws(); if (i !== text.length) invalid(); return result;
}
function check(value, rule, depth = 0) {
  if (depth > 16) invalid();
  if (rule.ref) return check(value, schema.definitions[rule.ref], depth + 1);
  switch (rule.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(rule.fields).length) invalid();
      for (const [key, field] of Object.entries(rule.fields)) { if (!Object.hasOwn(value, key)) invalid(); check(value[key], field, depth + 1); } break;
    case 'array': if (!Array.isArray(value) || value.length < rule.min || value.length > rule.max) invalid(); for (const item of value) check(item, rule.item, depth + 1); break;
    case 'union': if (!value || !Object.hasOwn(rule.variants, value[rule.tag])) invalid(); check(value, rule.variants[value[rule.tag]], depth + 1); break;
    case 'enum': if (!rule.values.some(v => typeof v === typeof value && v === value)) invalid(); break;
    case 'string': if (typeof value !== 'string' || value.length > rule.max || !new RegExp(`^(?:${rule.pattern})$`).test(value)) invalid(); break;
    case 'integer': if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < rule.min || value > rule.max) invalid(); break;
    case 'boolean': if (typeof value !== 'boolean') invalid(); break;
    default: invalid();
  }
}
function semantics(frame) {
  const p = frame.payload;
  if (frame.kind === 'CONTROL' && !schema.phaseEvents[p.phase].includes(p.event)) invalid();
  if ('issuedAt' in p && p.expiresAt <= p.issuedAt) invalid();
  const unique = xs => { if (new Set(xs).size !== xs.length) invalid(); };
  if (frame.kind === 'RELEASE_RECEIPT') { if (p.origins.FRONTEND === p.origins.BACKEND) invalid(); unique(p.expectedInstances); }
  if (frame.kind === 'RESTART_RECEIPT') { unique(p.preInstances.map(x => x.id)); unique(p.postInstances.map(x => x.id)); }
  if (frame.kind === 'ASSET_MANIFEST') { unique(p.entries.map(x => x.path)); }
  if (frame.kind === 'LEDGER_RECEIPT') for (const key of ['PAPER', 'stock']) { const a = p[key]; const sum = a.historicalCharged + a.unresolved + a.fullRunReserved; if (!Number.isSafeInteger(sum) || sum > a.ceiling || a.remaining !== a.ceiling - sum) invalid(); }
}
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function decodeFrame(bytes, kind) {
  try {
    if (!Buffer.isBuffer(bytes) || !Object.hasOwn(schema.frames, kind) || bytes.length > schema.frames[kind].maxBytes) invalid();
    const frame = parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    check(frame, schema.frames[kind].schema); semantics(frame); freeze(frame); validated.add(frame); return frame;
  } catch { invalid(); }
}
function encode(value) {
  if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + encode(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function canonicalBytes(frame) { if (!validated.has(frame)) invalid(); return Buffer.from(encode(frame), 'utf8'); }
// Only a fully validated receipt can reach the signature-free canonical encoder.
function receiptSigningBytes(frame) {
  if (!validated.has(frame) || !['RELEASE_RECEIPT','RESTART_RECEIPT','LEDGER_RECEIPT','MAINTENANCE_RECEIPT','DB_RECEIPT'].includes(frame.kind)) invalid();
  const payload = { ...frame.payload }; delete payload.signature;
  return Buffer.from(`acceptance:v1:${frame.kind}\0` + encode({ ...frame, payload }), 'utf8');
}
class PublicRunBudget {
  #usedBytes = 0;
  get usedBytes() { return this.#usedBytes; }
  append(frame) { if (!validated.has(frame) || frame.kind !== 'PUBLIC_RECORD') invalid(); const size = canonicalBytes(frame).length; if (size > schema.publicRunMaxBytes - this.#usedBytes) invalid(); this.#usedBytes += size; }
}
module.exports = { decodeFrame, canonicalBytes, receiptSigningBytes, PublicRunBudget };
