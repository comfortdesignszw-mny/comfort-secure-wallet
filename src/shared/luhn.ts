function secureRandomInt(min: number, maxExclusive: number): number {
  const range = maxExclusive - min;
  if (range <= 0) {
    throw new Error('Invalid randomInt range');
  }
  const maxUnbiased = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    globalThis.crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= maxUnbiased);
  return min + (value % range);
}

/**
 * Compute the Luhn check digit for a numeric digit string (base digits without check digit).
 */
export function computeLuhnCheckDigit(digits: string): string {
  if (!/^\d+$/.test(digits)) {
    throw new Error('Luhn input must contain only ASCII digits');
  }
  let sum = 0;
  // Starting from the rightmost digit of the payload (which sits at position 2 from the right once check digit is appended)
  let doubleIt = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (doubleIt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleIt = !doubleIt;
  }
  const check = (10 - (sum % 10)) % 10;
  return String(check);
}

/**
 * Validate a 10-digit account number using Luhn mod-10.
 */
export function isValidLuhnAccountNumber(accountNumber: string): boolean {
  if (!/^\d{10}$/.test(accountNumber)) return false;
  const payload = accountNumber.slice(0, 9);
  const expected = computeLuhnCheckDigit(payload);
  return accountNumber[9] === expected;
}

/**
 * Generate a cryptographically random, non-sequential 10-digit account number
 * with a valid Luhn check digit. Leading digit is 1-9 so it never looks empty/truncated.
 */
export function generateLuhnAccountNumber(existingSet?: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = String(secureRandomInt(1, 10));
    let rest = '';
    for (let i = 0; i < 8; i++) {
      rest += String(secureRandomInt(0, 10));
    }
    const base9 = first + rest;
    const candidate = base9 + computeLuhnCheckDigit(base9);
    if (!existingSet || !existingSet.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to allocate unique 10-digit Luhn account number');
}

/**
 * Mask a recipient full name for transfer confirmation, e.g. "Tendai Moyo" -> "Te•••• Mo••".
 */
export function maskRecipientName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Verified Wallet User';
  return parts
    .map((part) => {
      if (part.length <= 2) return `${part[0]}•`;
      const visible = part.slice(0, 2);
      const masked = '•'.repeat(Math.min(4, Math.max(2, part.length - 2)));
      return `${visible}${masked}`;
    })
    .join(' ');
}
