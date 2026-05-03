use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// Derive a 256-bit AES key from a machine-specific passphrase using SHA-256.
fn derive_key(passphrase: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(passphrase.as_bytes());
    // Fixed application salt — change this value to invalidate all stored secrets.
    hasher.update(b"eaicoding-desktop-salt-2024");
    hasher.finalize().into()
}

/// Build a machine-specific seed from environment variables so that secrets
/// encrypted on one machine cannot be decrypted on another.
fn get_machine_seed() -> String {
    // Windows: COMPUTERNAME / Linux & macOS: HOSTNAME
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "eaicoding-default".to_string());

    // Windows: USERNAME / Unix: USER
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "default-user".to_string());

    format!("{}-{}", host, user)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Encrypt `plaintext` with AES-256-GCM using a machine-specific key.
///
/// The returned string is `base64(nonce ‖ ciphertext+tag)` where `nonce` is a
/// randomly generated 96-bit (12-byte) value prepended to the ciphertext.
#[tauri::command]
pub fn encrypt_secret(plaintext: String) -> Result<String, String> {
    let key_bytes = derive_key(&get_machine_seed());
    let cipher =
        Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| format!("cipher init error: {}", e))?;

    // Generate a fresh random 96-bit nonce for every encryption call
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("encrypt error: {}", e))?;

    // Layout: [ 12-byte nonce | ciphertext+tag ]
    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);

    Ok(B64.encode(combined))
}

/// Decrypt a value previously produced by [`encrypt_secret`].
///
/// Expects `base64(nonce ‖ ciphertext+tag)` as produced by `encrypt_secret`.
#[tauri::command]
pub fn decrypt_secret(encrypted: String) -> Result<String, String> {
    let key_bytes = derive_key(&get_machine_seed());
    let cipher =
        Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| format!("cipher init error: {}", e))?;

    let combined = B64
        .decode(&encrypted)
        .map_err(|e| format!("base64 decode error: {}", e))?;

    // Minimum valid length: 12-byte nonce + 16-byte GCM authentication tag = 28 bytes
    if combined.len() < 28 {
        return Err("Invalid encrypted data: payload too short".to_string());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt error: {}", e))?;

    String::from_utf8(plaintext).map_err(|e| format!("utf8 error: {}", e))
}
