// Import Cryptr
import Cryptr from 'cryptr';

// Fungsi untuk encrypt
export function encrypt(text, key, ttlInSeconds) {
    // Inisialisasi Cryptr dengan key
    const cryptr = new Cryptr(key);
    
    // Tambahkan timestamp (waktu saat ini) dan TTL ke dalam teks
    const timestamp = Date.now();
    const textWithTimestamp = `${timestamp}_*_${ttlInSeconds}_*_${text}`;

    // Enkripsi menggunakan Cryptr
    const encrypted = cryptr.encrypt(textWithTimestamp);
    
    // Encode hasil enkripsi ke URL-safe format
    return encodeURIComponent(encrypted);
}

// Fungsi untuk decrypt
export function decrypt(encryptedText, key) {
    // Inisialisasi Cryptr dengan key
    const cryptr = new Cryptr(key);
    
    try {
        // Decode dari URL-safe format
        const decoded = decodeURIComponent(encryptedText);
        
        // Dekripsi menggunakan Cryptr
        const decryptedWithTimestamp = cryptr.decrypt(decoded);

        // Pisahkan timestamp, TTL, dan teks asli
        const [timestamp, ttlInSeconds, text] = decryptedWithTimestamp.split("_*_");

        // Hitung waktu kedaluwarsa
        const expirationTime = parseInt(timestamp) + parseInt(ttlInSeconds) * 1000; // Konversi ke milidetik
        const currentTime = Date.now();

        // Periksa apakah data sudah kedaluwarsa
        if (currentTime > expirationTime) {
            throw new Error("Link expired and cannot be decrypted.");
        }

        // Jika belum kedaluwarsa, kembalikan teks asli
        return text;
    } catch (error) {
        if (error.message === "Link expired and cannot be decrypted.") {
            throw error;
        } else {
            throw new Error("Failed to decrypt data: " + error.message);
        }
    }
}