/**
 * Simple XOR encryption utility with expiration functionality
 */

/**
 * Encrypts text using XOR with expiration functionality
 * @param {string} text - Text to encrypt
 * @param {string} key - Encryption key
 * @param {number} ttlInSeconds - Time to live in seconds
 * @returns {string} - URL-safe encrypted string
 */
function encrypt(text, key, ttlInSeconds) {
    // Create payload with timestamp and TTL
    const timestamp = Date.now();
    const payload = JSON.stringify({
      timestamp,
      ttl: ttlInSeconds,
      data: text
    });
    
    // Perform XOR encryption
    const encrypted = xorEncrypt(payload, key);
    
    // Convert to URL-safe Base64
    return toUrlSafeBase64(encrypted);
  }
  
  /**
   * Decrypts text and validates expiration
   * @param {string} encryptedText - Text to decrypt
   * @param {string} key - Encryption key
   * @returns {string} - Original text if not expired
   */
  function decrypt(encryptedText, key) {
    try {
      // Convert from URL-safe Base64
      const encrypted = fromUrlSafeBase64(encryptedText);
      
      // Decrypt with XOR
      const decrypted = xorEncrypt(encrypted, key); // XOR is its own inverse
      
      // Parse the payload
      const payload = JSON.parse(decrypted);
      
      // Check expiration
      const expirationTime = payload.timestamp + (payload.ttl * 1000);
      if (Date.now() > expirationTime) {
        throw new Error("Link expired and cannot be decrypted.");
      }
      
      // Return the original data
      return payload.data;
    } catch (error) {
      throw new Error("Decryption failed: " + error.message);
    }
  }
  
  /**
   * XOR encryption/decryption function
   * @param {string} text - Text to encrypt/decrypt
   * @param {string} key - Encryption key
   * @returns {string} - Result of XOR operation
   */
  function xorEncrypt(text, key) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
      // XOR each character with the corresponding character in the key
      const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      result += String.fromCharCode(charCode);
    }
    return result;
  }
  
  /**
   * Convert string to URL-safe Base64
   * @param {string} str - String to encode
   * @returns {string} - URL-safe Base64 string
   */
  function toUrlSafeBase64(str) {
    // Convert to Base64
    const base64 = btoa(str);
    // Make URL-safe
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  
  /**
   * Convert URL-safe Base64 to string
   * @param {string} base64 - URL-safe Base64 string
   * @returns {string} - Decoded string
   */
  function fromUrlSafeBase64(base64) {
    // Restore standard Base64
    const standardBase64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padding = standardBase64.length % 4;
    const paddedBase64 = padding ? 
      standardBase64 + '='.repeat(4 - padding) : 
      standardBase64;
    
    // Decode Base64
    return atob(paddedBase64);
  }
  
  // Export functions
  module.exports = { encrypt, decrypt };