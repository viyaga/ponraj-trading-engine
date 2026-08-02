import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV size

function getEncryptionKey(): Buffer {
  const secret = process.env.EXCHANGE_KEYS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('EXCHANGE_KEYS_ENCRYPTION_KEY is not defined in environment variables. Please add it to your .env file.');
  }
  // Hash the secret using sha256 to ensure we get a consistent 32-byte key
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Checks if a string matches our encryption format (ivHex:tagHex:encryptedHex)
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return parts.every(part => /^[0-9a-fA-F]+$/.test(part));
}

/**
 * Encrypts a string using AES-256-GCM
 */
export function encrypt(text: string): string {
  if (!text) return '';
  if (isEncrypted(text)) return text;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string using AES-256-GCM. Returns the original text if it's not encrypted.
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) return '';
  if (!isEncrypted(encryptedText)) {
    return encryptedText;
  }
  
  try {
    const [ivHex, tagHex, encryptedHex] = encryptedText.split(':');
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('Decryption failed:', error);
    return '';
  }
}
