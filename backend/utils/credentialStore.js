// utils/credentialStore.js
// In-memory encrypted credential store (use a proper secrets manager in production)
const crypto = require('crypto');

const store = new Map();
const ALGORITHM = 'aes-256-gcm';

// Simple session-based key (in prod, use HSM / KMS)
const SESSION_KEY = crypto.randomBytes(32);

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, SESSION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(data) {
  const [ivHex, authTagHex, encryptedHex] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, SESSION_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

const credentialStore = {
  set(provider, creds) {
    const encrypted = encrypt(JSON.stringify(creds));
    store.set(provider, encrypted);
  },
  get(provider) {
    const enc = store.get(provider);
    if (!enc) return null;
    try {
      return JSON.parse(decrypt(enc));
    } catch {
      return null;
    }
  },
  delete(provider) {
    store.delete(provider);
  },
  has(provider) {
    return store.has(provider);
  },
  listProviders() {
    return Array.from(store.keys());
  }
};

module.exports = credentialStore;
