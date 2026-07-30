export function parseAtoms(value: string, field = 'amount'): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${field} must be an integer string`);
  }
  return BigInt(value);
}

export function assertPositive(value: bigint, field = 'amount'): void {
  if (value <= 0n) throw new Error(`${field} must be positive`);
}

export function multiplyPriceQuantity(priceAtoms: bigint, quantity: bigint): bigint {
  assertPositive(priceAtoms, 'priceAtoms');
  assertPositive(quantity, 'quantity');
  return priceAtoms * quantity;
}

export function basisPointsCeil(amount: bigint, basisPoints: bigint): bigint {
  if (amount < 0n || basisPoints < 0n) {
    throw new Error('Fee inputs cannot be negative');
  }
  if (amount === 0n || basisPoints === 0n) return 0n;
  return (amount * basisPoints + 9_999n) / 10_000n;
}

export function formatMinorUnits(atoms: string | bigint, decimals = 2): string {
  const value = typeof atoms === 'bigint' ? atoms : BigInt(atoms);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
