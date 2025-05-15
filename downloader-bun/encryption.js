// Import required Node.js crypto modules
import crypto from 'crypto';

/**
 * Derives a 32-byte key using SHA-256 (matches Go implementation)
 * @param {string} key - The secret key
 * @returns {Buffer} - 32-byte key
 */
function deriveKey(key) {
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypts data with TTL using AES-GCM
 * @param {string} plaintext - Text to encrypt
 * @param {string} key - Secret key
 * @param {number} ttlInSeconds - Time-to-live in seconds
 * @returns {string} - URL-safe base64 encoded encrypted string
 */
export function encrypt(plaintext, key, ttlInSeconds) {
  try {
    // Create data structure with timestamp and TTL (matches Go implementation)
    const data = {
      t: plaintext,                // Text
      ts: Math.floor(Date.now() / 1000), // Timestamp in seconds
      ttl: ttlInSeconds
    };
    
    // Convert to JSON
    const jsonData = JSON.stringify(data);
    
    // Derive key
    const keyBytes = deriveKey(key);
    
    // Create cipher
    const nonce = crypto.randomBytes(12); // 12 bytes for AES-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, nonce);
    
    // Encrypt
    let encrypted = cipher.update(jsonData, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Get auth tag
    const authTag = cipher.getAuthTag();
    
    // Combine nonce, encrypted data, and auth tag
    const result = Buffer.concat([nonce, authTag, encrypted]);
    
    // Convert to URL-safe base64 (matches Go implementation)
    return result.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Decrypts data and checks TTL
 * @param {string} encryptedText - Text to decrypt
 * @param {string} key - Secret key
 * @returns {string} - Decrypted plaintext
 */
export function decrypt(encryptedText, key) {
  try {
    // Convert from URL-safe base64
    const base64Fixed = encryptedText
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    
    // Decode base64
    const buffer = Buffer.from(base64Fixed, 'base64');
    
    // Extract nonce, auth tag, and encrypted data
    const nonce = buffer.slice(0, 12);
    const authTag = buffer.slice(12, 28); // 16 bytes for auth tag
    const encrypted = buffer.slice(28);
    
    // Derive key
    const keyBytes = deriveKey(key);
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, nonce);
    decipher.setAuthTag(authTag);
    
    // Decrypt
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    const jsonData = decrypted.toString('utf8');
    
    // Parse JSON
    const data = JSON.parse(jsonData);
    
    // Check TTL
    const currentTime = Math.floor(Date.now() / 1000);
    const expirationTime = data.ts + data.ttl;
    
    if (currentTime > expirationTime) {
      throw new Error("Link expired");
    }
    
    // Return the plaintext
    return data.t;
  } catch (error) {
    if (error.message === "Link expired") {
      throw error;
    } else {
      throw new Error(`Failed to decrypt data: ${error.message}`);
    }
  }
}

/**
 * Encrypts a data object
 * @param {Object} data - Data object to encrypt
 * @param {string} key - Secret key
 * @param {number} ttlInSeconds - Time-to-live in seconds
 * @returns {string} - URL-safe base64 encoded encrypted string
 */
export function encryptData(data, key, ttlInSeconds) {
  // Convert object to JSON string
  const jsonData = JSON.stringify(data);
  
  // Encrypt the JSON string
  return encrypt(jsonData, key, ttlInSeconds);
}

/**
 * Decrypts to a data object
 * @param {string} encryptedText - Text to decrypt
 * @param {string} key - Secret key
 * @returns {Object} - Decrypted data object
 */
export function decryptData(encryptedText, key) {
  // Decrypt the string
  const decrypted = decrypt(encryptedText, key);
  
  // Parse JSON to object
  return JSON.parse(decrypted);
}