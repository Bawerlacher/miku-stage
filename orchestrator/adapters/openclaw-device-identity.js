/**
 * Device identity storage + signing helpers for OpenClaw gateway device-auth handshake.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Loads a persisted device identity or creates a new one when missing/invalid.
 * @param {string} filePath Absolute path to the device identity JSON file.
 * @returns {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }} Device identity bundle.
 */
export function loadOrCreateDeviceIdentity(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        }
      }
    }
  } catch {
    // Regenerate identity when parsing/loading fails.
  }

  const generated = generateDeviceIdentity()
  persistDeviceIdentity(filePath, generated)
  return generated
}

/**
 * Produces a base64url raw public-key value from a PEM-encoded Ed25519 public key.
 * @param {string} publicKeyPem PEM public key.
 * @returns {string} Base64url-encoded raw public key bytes.
 */
export function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem))
}

/**
 * Signs an auth payload string with the device private key.
 * @param {string} privateKeyPem PEM private key.
 * @param {string} payload Auth payload string to sign.
 * @returns {string} Base64url signature string.
 */
export function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem)
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key)
  return base64UrlEncode(signature)
}

/**
 * Generates a fresh Ed25519 device identity.
 * @returns {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }} Generated identity.
 */
function generateDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const deviceId = crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex')
  return {
    deviceId,
    publicKeyPem,
    privateKeyPem,
  }
}

/**
 * Writes a device identity JSON file with restricted permissions.
 * @param {string} filePath Absolute destination path.
 * @param {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }} identity Identity to persist.
 * @returns {void} Nothing.
 */
function persistDeviceIdentity(filePath, identity) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      version: 1,
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
      createdAtMs: Date.now(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  )
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Ignore chmod failures on unsupported filesystems.
  }
}

/**
 * Extracts raw Ed25519 key bytes from PEM/SPKI public key.
 * @param {string} publicKeyPem PEM public key.
 * @returns {Buffer} Raw Ed25519 public key bytes.
 */
function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem)
  const spki = key.export({ type: 'spki', format: 'der' })
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  }
  return spki
}

/**
 * Encodes bytes into base64url form.
 * @param {Buffer} value Byte buffer.
 * @returns {string} Base64url string.
 */
function base64UrlEncode(value) {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}
