import base64
import time
import json
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
from urllib.parse import quote, unquote


def encrypt(text, key, ttl_in_seconds):
    """
    Encrypt text with AES, adding timestamp and TTL for expiration check
    """
    timestamp = int(time.time() * 1000)  # Current time in milliseconds
    text_with_timestamp = f"{timestamp}_*_{ttl_in_seconds}_*_{text}"
    
    # Convert key to bytes if it's not already
    if isinstance(key, str):
        key = key.encode('utf-8')
    
    # Ensure key is appropriate length for AES (16, 24, or 32 bytes)
    if len(key) not in [16, 24, 32]:
        key = pad(key, 16)[:32]  # Pad and use first 32 bytes
    
    # Create cipher and encrypt
    cipher = AES.new(key, AES.MODE_CBC)
    ct_bytes = cipher.encrypt(pad(text_with_timestamp.encode('utf-8'), AES.block_size))
    
    # Combine IV and ciphertext for storage/transmission
    iv = cipher.iv
    ct_with_iv = iv + ct_bytes
    
    # Encode to base64
    encrypted_b64 = base64.b64encode(ct_with_iv).decode('utf-8')
    
    # URL encode for safe transmission
    return quote(encrypted_b64)


def decrypt(encrypted_text, key):
    """
    Decrypt text and check if it has expired based on timestamp and TTL
    """
    try:
        # URL decode
        decoded_text = unquote(encrypted_text)
        
        # Base64 decode
        encrypted_bytes = base64.b64decode(decoded_text)
        
        # Extract IV (first 16 bytes) and ciphertext
        iv = encrypted_bytes[:16]
        ct = encrypted_bytes[16:]
        
        # Convert key to bytes if it's not already
        if isinstance(key, str):
            key = key.encode('utf-8')
        
        # Ensure key is appropriate length for AES
        if len(key) not in [16, 24, 32]:
            key = pad(key, 16)[:32]  # Pad and use first 32 bytes
        
        # Decrypt
        cipher = AES.new(key, AES.MODE_CBC, iv)
        decrypted_padded = cipher.decrypt(ct)
        decrypted = unpad(decrypted_padded, AES.block_size).decode('utf-8')
        
        # Split timestamp, TTL and original text
        timestamp_str, ttl_str, original_text = decrypted.split("_*_")
        timestamp = int(timestamp_str)
        ttl = int(ttl_str)
        
        # Check expiration
        expiration_time = timestamp + (ttl * 1000)  # Convert to milliseconds
        current_time = int(time.time() * 1000)
        
        if current_time > expiration_time:
            raise ValueError("Link expired and cannot be decrypted.")
            
        return original_text
        
    except Exception as e:
        raise ValueError(f"Decryption failed: {str(e)}")