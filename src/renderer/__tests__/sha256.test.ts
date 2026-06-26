import { describe, it, expect } from 'vitest';

import { sha256Base64 } from '../sha256';

// Verified against `crypto.createHash('sha256').update(s,'utf8').digest('base64')`.
describe('sha256Base64 — NIST / known vectors', () => {
  it.each([
    ['abc', 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='],
    ['', '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='],
    ['The quick brown fox jumps over the lazy dog', '16j7swfXgJRpypq8sAguT41WUeRtPNt2LQLQvzfJ5ZI='],
    ['héllo™ 한글', 'VBFFjvOKblsJv3buTkZPSsT8WiomI6HqDNNcA7oX0Uc='],
  ])('hashes %j correctly', (input, expected) => {
    expect(sha256Base64(input)).toBe(expected);
  });

  it('handles a message that crosses the 55/56-byte padding boundary', () => {
    // 56 bytes forces an extra 64-byte block (length no longer fits the first).
    const s = 'a'.repeat(56);
    expect(sha256Base64(s)).toBe('s1Q5pKxvCUi21vnjxq8PX1kM4g8b3nCQ73lwaG7Gc4o=');
  });
});
